"""Publish tested EKS manifests to Git; observe Argo CD without changing workloads."""

# CLI entry point imports the existing deployment tools from their source directories.

import argparse
import copy
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "infrastructure/eks"))
import deploy
import release

sys.path.insert(0, str(ROOT / "infrastructure/gitops/scripts"))
from check_evaluation import LANGFUSE_ORIGIN, render_bundle
from check_msa import policy_errors
from deployment_candidate import (
    HELM_VERSION,
    KUBE_VERSION,
    PREFIX,
    encoded,
    git_bytes,
    tracked_files,
    write_files,
)
from local_release import deployment_hooks, merge, publish_tag, runtime_patches
from repository import Fork

NAME = "govbiz-eks"
TAG_PREFIX = "govbiz-eks/"
WORKLOADS = tuple(name for _, name, _ in deploy.TARGETS)
SOURCE_PATHS = (
    PREFIX + "charts/govbiz-service",
    PREFIX + "charts/govbiz-evaluation",
    PREFIX + "environments/portfolio",
    PREFIX + "environments/in-cluster",
    PREFIX + "environments/evaluation",
    "infrastructure/eks/gitops-values.yaml",
)
DOCUMENT_JOBS_FLAG = "APPLICATION_DOCUMENT_JOBS_ENABLED"
OPS_TRACES_RUNTIME_ERROR = (
    "Ops trace runtime configuration is missing or invalid; prepare LANGFUSE_BASE_URL "
    "and ops-langfuse key references in the API, sync and both release hook environment patches"
)


def failure_diagnostic(stage, error, resource=None):
    """Report only fixed codes and numeric metadata, never exception/command text."""
    details = {
        "event": "eks_gitops_error",
        "stage": stage,
        "error_type": type(error).__name__,
        "code": "UNEXPECTED_ERROR",
    }
    if resource is not None:
        details["resource"] = resource
    if isinstance(error, subprocess.TimeoutExpired):
        details["code"] = "COMMAND_TIMEOUT"
    elif isinstance(error, subprocess.CalledProcessError):
        details["code"] = "COMMAND_FAILED"
        if type(error.returncode) is int:
            details["exit_code"] = error.returncode
    elif isinstance(error, json.JSONDecodeError):
        details["code"] = "INVALID_JSON"
    elif isinstance(error, yaml.YAMLError):
        details["code"] = "INVALID_YAML"
    elif isinstance(error, KeyError):
        details["code"] = "MISSING_FIELD"
    elif isinstance(error, TypeError):
        details["code"] = "INVALID_TYPE"
    elif isinstance(error, OSError):
        details["code"] = "OS_ERROR"
        if type(error.errno) is int:
            details["errno"] = error.errno
    elif isinstance(error, ValueError):
        details["code"] = {
            OPS_TRACES_RUNTIME_ERROR: "OPS_TRACES_RUNTIME_CONFIG_MISSING",
            "Missing GitOps revision": "INVALID_RECEIPT_REVISION",
            "Source superseded while waiting for Argo CD": "SOURCE_SUPERSEDED",
            "Source superseded; deploy the latest tested main": "SOURCE_SUPERSEDED",
            "Main changed during CI verification": "SOURCE_SUPERSEDED",
            "Argo sync failed; inspect hooks before retrying": "ARGO_SYNC_FAILED",
            "Argo sync timed out; Vercel promotion is blocked": "ARGO_SYNC_TIMEOUT",
        }.get(str(error), "VALIDATION_REJECTED")
        prefix = "Required CI is not ready: "
        if str(error).startswith(prefix):
            details["code"] = "REQUIRED_CI_NOT_READY"
            reason, _, workflow = str(error)[len(prefix):].partition(":")
            if reason in {
                "ci_run_missing", "ci_run_not_successful_or_untrusted",
                "ci_jobs_not_successful_or_incomplete", "ci_run_changed",
            } and workflow in release.gate.WORKFLOWS:
                details.update(reason=reason, workflow=workflow)
    if isinstance(error, (subprocess.CalledProcessError, subprocess.TimeoutExpired)):
        # Select an executable name, not its arguments (which may contain tokens).
        command = error.cmd
        tool = None
        if isinstance(command, (list, tuple)) and command and isinstance(command[0], str):
            tool = Path(command[0]).name
        if tool in {"gh", "kubectl", "aws", "git", "helm"}:
            details["tool"] = tool
        if isinstance(error, subprocess.CalledProcessError):
            stderr = error.stderr or ""
            if isinstance(stderr, bytes):
                stderr = stderr.decode("utf-8", errors="replace")
            status = None
            if tool == "gh":
                match = re.search(r"\(HTTP ([45][0-9]{2})\)", stderr)
                status = int(match[1]) if match else None
            elif tool == "kubectl":
                match = re.search(
                    r"Error from server \((Unauthorized|Forbidden|NotFound|TooManyRequests|ServiceUnavailable)\)",
                    stderr,
                )
                if match:
                    status = {
                        "Unauthorized": 401, "Forbidden": 403, "NotFound": 404,
                        "TooManyRequests": 429, "ServiceUnavailable": 503,
                    }[match[1]]
            if status is not None:
                details["http_status"] = status
                details["code"] = "HTTP_ERROR"
                if status == 429:
                    details["code"] = "RATE_LIMITED"
                elif status in (401, 403):
                    details["code"] = "ACCESS_DENIED"
                elif status >= 500:
                    details["code"] = "REMOTE_SERVER_ERROR"
            if tool == "gh" and "api rate limit exceeded" in stderr.lower():
                details["code"] = "RATE_LIMITED"
    return details


class GitOpsDiagnosticError(ValueError):
    def __init__(self, stage, error, resource=None):
        self.details = failure_diagnostic(stage, error, resource)
        super().__init__(json.dumps(self.details, sort_keys=True))


@contextmanager
def diagnostic_stage(stage, resource=None):
    try:
        yield
    except GitOpsDiagnosticError:
        raise
    except Exception as error:
        raise GitOpsDiagnosticError(stage, error, resource) from None


def document_jobs_patches(patches):
    """Enable only document generation in the private Core environment patch."""
    patches = copy.deepcopy(patches)
    environments = [
        op
        for patch in patches
        if patch.get("target") == {
            "kind": "Deployment", "name": "core-service", "namespace": "govbiz-msa"
        }
        for op in json.loads(patch["patch"])
        if op.get("path") == "/spec/template/spec/containers/0/env"
    ]
    release.require(len(environments) == 1, "Review the single Core environment patch before enabling document jobs")
    for patch in patches:
        if patch.get("target") != {
            "kind": "Deployment", "name": "core-service", "namespace": "govbiz-msa"
        }:
            continue
        operations = json.loads(patch["patch"])
        for op in operations:
            if op.get("path") == "/spec/template/spec/containers/0/env":
                release.require(isinstance(op.get("value"), list), "Core environment must be an array")
                op["value"] = [item for item in op["value"] if item.get("name") != DOCUMENT_JOBS_FLAG]
                op["value"].append({"name": DOCUMENT_JOBS_FLAG, "value": "true"})
        patch["patch"] = json.dumps(operations)
    return patches


def check_ops_trace_patches(patches):
    """Reject preserved environment arrays that would erase the trace connection."""
    targets = (
        ("Deployment", "ops-service", 0),
        ("Deployment", "ops-service", 1),
        ("Job", "ops-service-release-prepare", 0),
        ("Job", "ops-service-release-resume", 0),
    )
    literal_targets = [
        {"kind": "Deployment", "name": name, "namespace": namespace}
        for namespace, name, _ in deploy.TARGETS
    ] + [
        {"kind": "Job", "name": name, "namespace": "govbiz-msa"}
        for kind, name, _ in targets if kind == "Job"
    ]
    for patch in patches:
        if any(op.get("path", "").endswith("/env") for op in json.loads(patch["patch"])):
            # A later regex/selector patch could otherwise erase a valid Ops environment.
            release.require(patch.get("target") in literal_targets, OPS_TRACES_RUNTIME_ERROR)
    expected = [
        {"name": "LANGFUSE_BASE_URL", "value": LANGFUSE_ORIGIN},
        *[
            {"name": key, "valueFrom": {"secretKeyRef": {"name": "ops-langfuse", "key": key}}}
            for key in ("LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY")
        ],
    ]
    for kind, name, index in targets:
        environments = [
            op.get("value")
            for patch in patches
            if patch.get("target") == {"kind": kind, "name": name, "namespace": "govbiz-msa"}
            for op in json.loads(patch["patch"])
            if op.get("path") == f"/spec/template/spec/containers/{index}/env"
        ]
        release.require(
            len(environments) == 1 and isinstance(environments[0], list),
            OPS_TRACES_RUNTIME_ERROR,
        )
        environment = environments[0]
        release.require(all(isinstance(item, dict) for item in environment), OPS_TRACES_RUNTIME_ERROR)
        for entry in expected:
            release.require(
                [item for item in environment if item.get("name") == entry["name"]] == [entry],
                OPS_TRACES_RUNTIME_ERROR,
            )


def document_jobs_patch(app):
    """Prepare a version-checked merge patch; do not contact or change the cluster."""
    release.require(
        not app.get("operation")
        and app.get("status", {}).get("operationState", {}).get("phase") != "Running",
        "Finish the existing Argo operation before enabling document jobs",
    )
    version = app.get("metadata", {}).get("resourceVersion")
    release.require(bool(version), "Export the current Argo Application with its resourceVersion")
    updated = copy.deepcopy(app)
    source = updated["spec"]["source"]
    source["kustomize"]["patches"] = document_jobs_patches(source["kustomize"]["patches"])
    check_application(updated)
    return {
        "metadata": {"resourceVersion": version},
        "spec": {"source": {"kustomize": {"patches": source["kustomize"]["patches"]}}},
    }


def read_settings(root=None, sha=None):
    path = "infrastructure/eks/gitops-values.yaml"
    root = root or ROOT
    contents = git_bytes(root, "show", f"{sha}:{path}") if sha else (root / path).read_bytes()
    return yaml.safe_load(contents)


def replica_bounds(settings):
    """Only opted-in stateless services delegate replica ownership to HPA."""
    bounds = {}
    for name, value in settings["services"].items():
        scaling = value.get("autoscaling", {})
        enabled = scaling.get("enabled", False)
        release.require(type(enabled) is bool, "Autoscaling enabled must be a boolean")
        if not enabled:
            continue
        minimum = scaling.get("minReplicas", 1)
        maximum = scaling.get("maxReplicas", 3)
        target = scaling.get("targetCPUUtilizationPercentage", 70)
        release.require(
            name in ("core-service", "ai-service")
            and all(type(n) is int for n in (minimum, maximum, target))
            and 1 <= minimum <= maximum <= 10
            and 1 <= target <= 100,
            "Autoscaling requires a supported stateless service and bounded replicas/CPU target",
        )
        bounds[name] = (minimum, maximum)
    return bounds


def replica_ignores(settings):
    return [
        {
            "group": "apps",
            "kind": "Deployment",
            "namespace": "govbiz-msa",
            "name": name,
            "jsonPointers": ["/spec/replicas"],
        }
        for name in sorted(replica_bounds(settings))
    ]


def node_selector(settings, name):
    if name in replica_bounds(settings) and "httpNodeSelector" in settings:
        selector = settings["httpNodeSelector"]
        release.require(
            selector == {"govbiz.io/http-pool": "shared"},
            "Autoscaled HTTP services require the shared HTTP node label",
        )
        return selector
    return {"govbiz.io/workload-pool": settings["placement"][name]}


def running_replicas(row, bounds):
    desired = row["spec"].get("replicas")
    minimum, maximum = bounds.get(row["metadata"]["name"], (1, 1))
    return type(desired) is int and minimum <= desired <= maximum


def deployment_ready(row, bounds):
    status = row.get("status", {})
    return (
        running_replicas(row, bounds)
        and status.get("observedGeneration", 0) >= row["metadata"]["generation"]
        and all(
            status.get(key) == row["spec"]["replicas"]
            for key in ("replicas", "readyReplicas", "updatedReplicas", "availableReplicas")
        )
    )


def validate_record(record, sha, env=os.environ):
    deploy.validate(record, env)
    release.require(record["sourceSha"] == sha, "Receipt source does not match the tested checkout")


def release_tag(run_id, attempt):
    release.require(
        all(type(n) is int and n > 0 for n in (run_id, attempt)), "Invalid run identity"
    )
    return f"{TAG_PREFIX}v1.{run_id}.{attempt}"


def bundle(root, record, tag, helm="helm"):
    """Use only tested Git blobs and pinned ECR images; never include live environment values."""
    sha = record["sourceSha"]
    source = tracked_files(root, sha, SOURCE_PATHS)
    files = {}
    with tempfile.TemporaryDirectory(prefix="govbiz-eks-render-") as directory:
        checkout = Path(directory).resolve()
        write_files(checkout, source)
        gitops = checkout / PREFIX
        settings = read_settings(checkout)
        bounds = replica_bounds(settings)
        release.require(
            all(minimum >= 2 for minimum, _ in bounds.values()),
            "EKS distributed HTTP services require at least two replicas for rolling updates",
        )

        def values(path):
            return yaml.safe_load((gitops / path).read_text())

        for name in release.COMPONENTS[:-1]:
            value = merge(
                values(f"environments/portfolio/{name}.yaml"),
                values(f"environments/in-cluster/{name}.yaml"),
            )
            value = merge(value, settings["services"][name])
            repository, digest = record["images"][name].split("@")
            value.update(
                image={
                    "repository": repository,
                    "digest": digest,
                    "tag": "",
                    "pullPolicy": "IfNotPresent",
                },
                imagePullSecrets=[],
                localMode=False,
            )
            path = checkout / "values.yaml"
            path.write_text(yaml.safe_dump(value))
            output = subprocess.check_output(
                [
                    helm,
                    "template",
                    name,
                    str(gitops / "charts/govbiz-service"),
                    "--namespace",
                    "govbiz-msa",
                    "--kube-version",
                    KUBE_VERSION,
                    "-f",
                    str(path),
                ],
                timeout=30,
                stderr=subprocess.PIPE,
            )
            rows = [r for r in yaml.safe_load_all(output) if r]
            errors = policy_errors(
                name,
                rows,
                ops_sync_enabled=name == "ops-service",
                autoscaling=value.get("autoscaling"),
            )
            release.require(not errors, "EKS service policy failed: " + "; ".join(errors))
            if name == "ops-service":
                migration = next(r for r in rows if r["kind"] == "Job")
                rows.remove(migration)
                rows.extend(deployment_hooks(migration, tag, "argo_release"))
            files[name] = rows
        evaluation = {
            name: merge(
                values(f"environments/evaluation/{name}.yaml"),
                settings["evaluation"].get(name, {}),
            )
            for name in ("prefect", "evaluation-runner", "ops-artifacts")
        }
        for name, value in evaluation.items():
            value["replicas"] = 1
            value["storage"]["node"] = "eks-render-placeholder"
            if name != "prefect":
                value["storage"]["existingClaim"] = settings["resultsClaim"]
        runner = record["images"]["evaluation-runner"]
        evaluation["evaluation-runner"]["image"] = runner
        evaluation["evaluation-runner"]["runner"]["langfuseUrl"] = LANGFUSE_ORIGIN
        evaluation["ops-artifacts"].update(
            image=record["images"]["ops-service"], evidenceImage=runner
        )
        rendered = render_bundle(
            evaluation, "govbiz-evaluation", helm, chart=gitops / "charts/govbiz-evaluation"
        )
        files.update({name: rendered[name] for name in ("evaluation-runner", "ops-artifacts")})
        for name, rows in files.items():
            for row in rows:
                if row["kind"] in ("Deployment", "Job"):
                    row["spec"]["template"]["spec"]["nodeSelector"] = node_selector(
                        settings, name
                    )
                    row["spec"]["template"].setdefault("metadata", {}).setdefault(
                        "annotations", {}
                    )["govbiz.io/source-sha"] = sha
                    if row["kind"] == "Deployment" and name in bounds:
                        # EKS keeps one replica of each HTTP service per host. Drop
                        # one old replica before replacing it so a full three-node
                        # pool does not need a fourth host just for a rolling update.
                        row["spec"]["strategy"] = {
                            "type": "RollingUpdate",
                            "rollingUpdate": {"maxSurge": 0, "maxUnavailable": 1},
                        }
                        pod = row["spec"]["template"]["spec"]
                        pod.pop("topologySpreadConstraints", None)
                        pod["affinity"] = {
                            "podAntiAffinity": {
                                "requiredDuringSchedulingIgnoredDuringExecution": [
                                    {
                                        "labelSelector": row["spec"]["selector"],
                                        "namespaces": [row["metadata"]["namespace"]],
                                        "topologyKey": "kubernetes.io/hostname",
                                    }
                                ]
                            }
                        }
                    if row["kind"] == "Deployment" and name in (
                        "catalog-service", "ops-service"
                    ):
                        # Keep singleton writers with their database so they cannot
                        # strand a temporary HTTP node behind a singleton PDB.
                        database = {
                            "catalog-service": "catalog-mysql",
                            "ops-service": "ops-mysql",
                        }[name]
                        row["spec"]["template"]["spec"]["affinity"] = {
                            "podAffinity": {
                                "requiredDuringSchedulingIgnoredDuringExecution": [
                                    {
                                        "labelSelector": {
                                            "matchLabels": {"app.kubernetes.io/name": database}
                                        },
                                        "namespaces": [row["metadata"]["namespace"]],
                                        "topologyKey": "kubernetes.io/hostname",
                                    }
                                ]
                            }
                        }
                    if name in ("evaluation-runner", "ops-artifacts"):
                        # A node-group replacement may temporarily have two nodes.
                        # The two RWO consumers must stay on the same host, not only pool.
                        template = row["spec"]["template"]
                        labels = {"govbiz.io/evaluation-volume": "shared"}
                        template["metadata"].setdefault("labels", {}).update(labels)
                        template["spec"]["affinity"] = {
                            "podAffinity": {
                                "requiredDuringSchedulingIgnoredDuringExecution": [
                                    {
                                        "labelSelector": {"matchLabels": labels},
                                        "topologyKey": "kubernetes.io/hostname",
                                    }
                                ]
                            }
                        }
    result = {
        f"release/{name}.yaml": yaml.safe_dump_all(rows, sort_keys=False).encode()
        for name, rows in files.items()
    }
    result["release/kustomization.yaml"] = yaml.safe_dump(
        {
            "apiVersion": "kustomize.config.k8s.io/v1beta1",
            "kind": "Kustomization",
            "resources": [name + ".yaml" for name in WORKLOADS],
        }
    ).encode()
    result["release-record.json"] = encoded({**record, "tag": tag})
    return result


def application(runtime, settings=None):
    """Adopt current settings privately, with no image/command overrides or data ownership."""
    release.require(
        runtime.get("cluster") == "govbiz-eks.ap-southeast-2.eksctl.io",
        "Export the selected Sydney cluster, not a local cluster",
    )
    settings = read_settings() if settings is None else settings
    bounds = replica_bounds(settings)
    ignores = replica_ignores(settings)
    rows = runtime["items"]
    release.require(len(rows) == len(WORKLOADS), "Export only the six application Deployments")
    for row in rows:
        name = row["metadata"]["name"]
        release.require(name in WORKLOADS, "Unexpected workload")
        annotations = row["metadata"].get("annotations", {})
        release.require(
            not any(k.startswith("argocd.argoproj.io/") for k in annotations),
            "Existing Argo ownership requires an explicit handoff",
        )
        release.require(
            not annotations.get("govbiz.io/release-in-progress"),
            "Recover the unfinished direct deployment before adoption",
        )
        labels = {"app.kubernetes.io/name": name}
        if name in release.COMPONENTS[:-1]:
            labels["app.kubernetes.io/instance"] = name
        release.require(
            row["spec"]["selector"] == {"matchLabels": labels},
            "Immutable selector differs from the Helm contract",
        )
        release.require(
            row["spec"]["template"]["spec"].get("nodeSelector")
            == node_selector(settings, name),
            "Unexpected EKS workload placement",
        )
    patches = document_jobs_patches(runtime_patches(
        runtime, WORKLOADS, preserve_placement=True, replica_bounds=bounds
    ))
    check_ops_trace_patches(patches)
    return [
        {
            "apiVersion": "argoproj.io/v1alpha1",
            "kind": "AppProject",
            "metadata": {"name": NAME, "namespace": "argocd"},
            "spec": {
                "sourceRepos": [Fork(release.SOURCE).url],
                "destinations": [
                    {"server": "https://kubernetes.default.svc", "namespace": n}
                    for n in ("govbiz-msa", "govbiz-evaluation")
                ],
                "clusterResourceWhitelist": [],
                "namespaceResourceWhitelist": [
                    {"group": g, "kind": k}
                    for g, k in (
                        ("apps", "Deployment"),
                        ("", "Service"),
                        ("batch", "Job"),
                        ("networking.k8s.io", "NetworkPolicy"),
                        ("autoscaling", "HorizontalPodAutoscaler"),
                    )
                ],
            },
        },
        {
            "apiVersion": "argoproj.io/v1alpha1",
            "kind": "Application",
            "metadata": {"name": NAME, "namespace": "argocd"},
            "spec": {
                "project": NAME,
                **({"ignoreDifferences": ignores} if ignores else {}),
                "destination": {
                    "server": "https://kubernetes.default.svc",
                    "namespace": "govbiz-msa",
                },
                "source": {
                    "repoURL": Fork(release.SOURCE).url,
                    "path": "release",
                    "tagPrefix": TAG_PREFIX,
                    "targetRevision": ">=1.0.0 <2.0.0",
                    "kustomize": {"patches": patches},
                },
                "syncPolicy": {
                    "automated": {"enabled": True, "prune": False, "selfHeal": False},
                    "syncOptions": ["FailOnSharedResource=true"]
                    + (["RespectIgnoreDifferences=true"] if ignores else []),
                    "retry": {
                        "limit": 5,
                        "backoff": {"duration": "30s", "factor": 2, "maxDuration": "5m"},
                    },
                },
            },
        },
    ]


def kube(namespace, *args):
    return json.loads(
        release.run(
            "kubectl",
            "--request-timeout=20s",
            "-n",
            namespace,
            "get",
            *args,
            "-o",
            "json",
            capture_output=True,
        ).stdout
    )


def connect():
    release.authority()
    _, region, cluster = release.settings()
    release.require(bool(os.environ.get("KUBECONFIG")), "Use a dedicated release kubeconfig")
    release.run(
        "aws",
        "eks",
        "update-kubeconfig",
        "--name",
        cluster,
        "--region",
        region,
        "--kubeconfig",
        os.environ["KUBECONFIG"],
        capture_output=True,
    )


def check_application(app, settings=None):
    settings = read_settings() if settings is None else settings
    ignores = replica_ignores(settings)
    spec = app["spec"]
    source = spec.get("source", {})
    release.require(
        not spec.get("sources")
        and set(source) <= {"repoURL", "path", "tagPrefix", "targetRevision", "kustomize"}
        and set(source.get("kustomize", {})) <= {"patches"},
        "Argo source overrides must not replace the tested Git inputs",
    )
    release.require(
        app["metadata"]["name"] == NAME
        and spec.get("project") == NAME
        and spec.get("destination")
        == {"server": "https://kubernetes.default.svc", "namespace": "govbiz-msa"},
        "Unexpected Argo application target",
    )
    release.require(
        source.get("repoURL") == Fork(release.SOURCE).url
        and source.get("path") == "release"
        and source.get("tagPrefix") == TAG_PREFIX
        and source.get("targetRevision") == ">=1.0.0 <2.0.0",
        "Unexpected Argo source",
    )
    release.require(
        spec.get("syncPolicy", {}).get("automated")
        == {"enabled": True, "prune": False, "selfHeal": False}
        and spec.get("syncPolicy", {}).get("syncOptions")
        == ["FailOnSharedResource=true"] + (["RespectIgnoreDifferences=true"] if ignores else [])
        and spec.get("ignoreDifferences", []) == ignores,
        "Unexpected Argo sync policy",
    )
    # Preserve only installation-time environment, placement and claim references.
    allowed = re.compile(
        r"/spec/template/spec/(?:containers/[01]/env|nodeSelector|volumes/0/persistentVolumeClaim/claimName)"
    )
    document_jobs = []
    for patch in source.get("kustomize", {}).get("patches", []):
        for op in json.loads(patch["patch"]):
            release.require(
                op.get("op") in {"add", "replace"} and allowed.fullmatch(op.get("path", "")),
                "Argo runtime patch must not override release images or commands",
            )
            if patch.get("target") == {
                "kind": "Deployment", "name": "core-service", "namespace": "govbiz-msa"
            } and op["path"] == "/spec/template/spec/containers/0/env":
                document_jobs.extend(item for item in op["value"] if item.get("name") == DOCUMENT_JOBS_FLAG)
            if op["path"] == "/spec/template/spec/nodeSelector":
                target = patch.get("target", {})
                name = target.get("name")
                if target.get("kind") == "Deployment" and name in WORKLOADS:
                    permitted = [node_selector(settings, name)]
                elif target.get("kind") == "Job" and name in (
                    "ops-service-release-prepare", "ops-service-release-resume"
                ):
                    permitted = [
                        node_selector(settings, "ops-service"),
                        {"govbiz.io/workload-pool": "observability"},
                    ]
                else:
                    permitted = []
                release.require(
                    op.get("value") in permitted,
                    "Argo node selector must preserve the configured workload boundary",
                )
    check_ops_trace_patches(source.get("kustomize", {}).get("patches", []))
    release.require(
        document_jobs == [{"name": DOCUMENT_JOBS_FLAG, "value": "true"}],
        "Enable document jobs in the preserved Core environment before publishing; use enable-document-jobs",
    )


def preflight():
    connect()
    settings = read_settings()
    bounds = replica_bounds(settings)
    app = kube("argocd", "application", NAME)
    check_application(app, settings)
    release.require(
        not app.get("operation")
        and app.get("status", {}).get("operationState", {}).get("phase") != "Running",
        "Finish the existing Argo operation before publishing another release",
    )
    forbidden = []
    for namespace, name, _ in deploy.TARGETS:
        row = kube(namespace, "deployment", name)
        release.require(
            running_replicas(row, bounds),
            "A stopped or out-of-bounds workload must not be changed by a release",
        )
        if name == "core-service":
            release.require(
                [item for item in row["spec"]["template"]["spec"]["containers"][0].get("env", [])
                 if item.get("name") == DOCUMENT_JOBS_FLAG]
                == [{"name": DOCUMENT_JOBS_FLAG, "value": "true"}],
                "Wait for Core document jobs to be enabled before publishing",
            )
        release.require(
            not row["metadata"].get("annotations", {}).get("govbiz.io/release-in-progress"),
            "Recover the unfinished direct deployment before GitOps",
        )
        for verb in ("patch", "update", "delete"):
            forbidden.extend(
                (namespace, verb, "deployment/" + name, subresource)
                for subresource in (None, "scale")
            )
    for namespace in ("govbiz-msa", "govbiz-evaluation"):
        forbidden.extend(
            [(namespace, "create", "jobs", None), (namespace, "create", "pods", "exec")]
        )
    forbidden.extend(
        ("argocd", verb, "applications.argoproj.io/" + NAME, None)
        for verb in ("patch", "update", "delete")
    )
    for namespace, verb, resource, subresource in forbidden:
        # kubectl exits 1 for a denied request, which is the required result here.
        result = subprocess.run(
            [
                "kubectl",
                "--request-timeout=20s",
                "-n",
                namespace,
                "auth",
                "can-i",
                verb,
                resource,
                *(["--subresource=" + subresource] if subresource else []),
            ],
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
        release.require(
            result.returncode == 1 and result.stdout.strip() == "no",
            "Remove the CodeBuild workload write permissions before GitOps activation",
        )


def publish(sha, receipt, helm="helm"):
    checks = []
    release.check(sha, evidence=checks)
    release.require(
        os.environ.get("GITHUB_ACTIONS") == "true"
        and git_bytes(ROOT, "rev-parse", "HEAD").decode().strip() == sha,
        "Publish from the tested Actions checkout",
    )
    version = subprocess.check_output([helm, "version", "--short"], text=True).strip()
    release.require(version.split("+")[0] == HELM_VERSION, "Pinned Helm is required")
    record = json.loads(receipt.read_text())
    validate_record(record, sha)
    tag = release_tag(int(os.environ["GITHUB_RUN_ID"]), int(os.environ["GITHUB_RUN_ATTEMPT"]))
    files = bundle(ROOT, record, tag, helm)
    files["source-checks.json"] = encoded(checks)

    def recheck():
        confirmed = []
        release.check(sha, evidence=confirmed)
        release.require(confirmed == checks, "Required CI evidence changed before tag publication")
        for name in release.COMPONENTS:
            release.require(
                record["images"][name].endswith(
                    "@" + str(release.digest("govbiz-demo/" + name, "git-" + sha))
                ),
                "ECR receipt differs from the published immutable image",
            )
        check_application(kube("argocd", "application", NAME), read_settings(ROOT, sha))

    revision = publish_tag(
        ROOT, Fork(release.SOURCE), sha, tag, files, recheck, tag_prefix=TAG_PREFIX
    )
    receipt.write_text(
        json.dumps({**record, "tag": tag, "gitopsRevision": revision}, indent=2) + "\n"
    )
    print("Published immutable EKS release: " + tag)


def synced(app, record, deployments, settings=None):
    settings = read_settings() if settings is None else settings
    bounds = replica_bounds(settings)
    check_application(app, settings)
    status = app.get("status", {})
    revision = record["gitopsRevision"]
    operation = status.get("operationState", {})
    if operation.get("syncResult", {}).get("revision") == revision and operation.get("phase") in {
        "Failed",
        "Error",
    }:
        raise ValueError("Argo sync failed; inspect hooks before retrying")
    if (
        status.get("sync", {}).get("status") != "Synced"
        or status.get("sync", {}).get("revision") != revision
        or status.get("health", {}).get("status") != "Healthy"
        or app.get("operation")
        or operation.get("phase") != "Succeeded"
        or operation.get("syncResult", {}).get("revision") != revision
    ):
        return False
    hooks = {
        r.get("name"): r
        for r in operation["syncResult"].get("resources", [])
        if r.get("kind") == "Job"
    }
    if any(
        hooks.get("ops-service-release-" + phase, {}).get("hookPhase") != "Succeeded"
        for phase in ("prepare", "resume")
    ):
        return False
    for _, name, mapping in deploy.TARGETS:
        row = deployments[name]
        if not deployment_ready(row, bounds):
            return False
        pod = row["spec"]["template"]
        if (
            pod.get("metadata", {}).get("annotations", {}).get("govbiz.io/source-sha")
            != record["sourceSha"]
        ):
            return False
        images = {c["name"]: c["image"] for c in pod["spec"]["containers"]}
        if name == "core-service" and [
            item for item in pod["spec"]["containers"][0].get("env", [])
            if item.get("name") == DOCUMENT_JOBS_FLAG
        ] != [{"name": DOCUMENT_JOBS_FLAG, "value": "true"}]:
            return False
        if any(images.get(c) != record["images"][image] for c, image in mapping.items()):
            return False
        if name == "ops-artifacts":
            initializers = pod["spec"].get("initContainers", [])
            if (
                len(initializers) != 1
                or initializers[0]["image"] != record["images"]["evaluation-runner"]
            ):
                return False
    return True


def wait(sha, receipt, timeout=1200):
    with diagnostic_stage("wait.receipt"):
        record = json.loads(receipt.read_text())
        validate_record(record, sha)
        release.require(
            re.fullmatch(r"[a-f0-9]{40}", record.get("gitopsRevision", "")), "Missing GitOps revision"
        )
    with diagnostic_stage("wait.connect"):
        connect()
    with diagnostic_stage("wait.initial_ci"):
        release.check(sha)
    with diagnostic_stage("wait.settings"):
        settings = read_settings(ROOT, sha)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with diagnostic_stage("wait.source"):
            release.require(
                release.gate.api(f"repos/{release.SOURCE}/git/ref/heads/main")["object"]["sha"] == sha,
                "Source superseded while waiting for Argo CD",
            )
        with diagnostic_stage("wait.application", NAME):
            app = kube("argocd", "application", NAME)
        deployments = {}
        for ns, name, _ in deploy.TARGETS:
            with diagnostic_stage("wait.deployment", name):
                deployments[name] = kube(ns, "deployment", name)
        with diagnostic_stage("wait.verify"):
            ready = synced(app, record, deployments, settings)
        if ready:
            print(
                json.dumps({"event": "eks_gitops_checkpoint", "stage": "wait.argo_verified"}),
                flush=True,
            )
            with diagnostic_stage("wait.final_ci"):
                release.check(sha)
            print("Argo CD synced the exact release; both hooks and all six Deployments succeeded.")
            return
        time.sleep(15)
    with diagnostic_stage("wait.timeout"):
        raise ValueError("Argo sync timed out; Vercel promotion is blocked")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("application", "enable-document-jobs", "preflight", "publish", "wait"))
    parser.add_argument("--sha")
    parser.add_argument("--receipt", type=Path)
    parser.add_argument("--runtime", type=Path)
    parser.add_argument("--application", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    with diagnostic_stage(args.command):
        if args.command == "application":
            resources = application(json.loads(args.runtime.read_text()))
            fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as out:
                yaml.safe_dump_all(resources, out, sort_keys=False)
            print("Prepared private Argo adoption configuration; cluster unchanged.")
        elif args.command == "enable-document-jobs":
            if not args.application or not args.output:
                parser.error("enable-document-jobs requires --application and --output")
            patch = document_jobs_patch(json.loads(args.application.read_text(encoding="utf-8")))
            fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as out:
                json.dump(patch, out)
            print("Prepared private document-jobs patch; cluster unchanged.")
        elif args.command == "preflight":
            preflight()
        elif args.command == "publish":
            connect()
            publish(args.sha, args.receipt)
        else:
            wait(args.sha, args.receipt)


def cli():
    try:
        main()
    except GitOpsDiagnosticError as error:
        print(str(error), file=sys.stderr, flush=True)
        return 1
    except Exception as error:
        print(json.dumps(failure_diagnostic("cli", error), sort_keys=True), file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(cli())
