"""Publish tested EKS manifests to Git; observe Argo CD without changing workloads."""

# CLI entry point imports the existing deployment tools from their source directories.

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
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
        replica_bounds(settings)

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
    patches = runtime_patches(
        runtime, WORKLOADS, preserve_placement=True, replica_bounds=bounds
    )
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
    for patch in source.get("kustomize", {}).get("patches", []):
        for op in json.loads(patch["patch"]):
            release.require(
                op.get("op") in {"add", "replace"} and allowed.fullmatch(op.get("path", "")),
                "Argo runtime patch must not override release images or commands",
            )
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
    record = json.loads(receipt.read_text())
    validate_record(record, sha)
    release.require(
        re.fullmatch(r"[a-f0-9]{40}", record.get("gitopsRevision", "")), "Missing GitOps revision"
    )
    connect()
    release.check(sha)
    settings = read_settings(ROOT, sha)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        release.require(
            release.gate.api(f"repos/{release.SOURCE}/git/ref/heads/main")["object"]["sha"] == sha,
            "Source superseded while waiting for Argo CD",
        )
        app = kube("argocd", "application", NAME)
        deployments = {name: kube(ns, "deployment", name) for ns, name, _ in deploy.TARGETS}
        if synced(app, record, deployments, settings):
            release.check(sha)
            print("Argo CD synced the exact release; both hooks and all six Deployments succeeded.")
            return
        time.sleep(15)
    raise ValueError("Argo sync timed out; Vercel promotion is blocked")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("application", "preflight", "publish", "wait"))
    parser.add_argument("--sha")
    parser.add_argument("--receipt", type=Path)
    parser.add_argument("--runtime", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.command == "application":
        resources = application(json.loads(args.runtime.read_text()))
        fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as out:
            yaml.safe_dump_all(resources, out, sort_keys=False)
        print("Prepared private Argo adoption configuration; cluster unchanged.")
    elif args.command == "preflight":
        preflight()
    elif args.command == "publish":
        connect()
        publish(args.sha, args.receipt)
    else:
        wait(args.sha, args.receipt)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.SubprocessError):
        # Captured command output/configuration may contain private environment values.
        sys.exit("EKS GitOps operation failed; inspect the phase and protected configuration.")
