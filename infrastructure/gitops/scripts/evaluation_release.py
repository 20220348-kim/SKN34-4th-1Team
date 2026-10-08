"""Verify evaluation releases, register Argo declarations and request dormant sync."""

import argparse
import io
import json
import os
import re
import tempfile
import zipfile
from pathlib import Path
from urllib.parse import quote

import evaluation_pvc_restore as pvc_restore
import fork_cluster
import yaml
from check_evaluation import COMPONENTS, render_bundle
from deployment import source_checks, verified_release
from deployment_candidate import (
    KUBE_VERSION,
    digest,
    encoded,
    git_bytes,
    tracked_files,
    write_files,
)
from fork_cluster import verify_pull_rights
from promote_image import UniqueLoader
from publish import RUNNER, RUNNER_PATHS, RUNNER_RELEASE, runner_input_key
from repository import from_origin
from sync_images import api, select_release, valid_run

WORKFLOW = ".github/workflows/evaluation-images.yml"
ARTIFACT = "evaluation-image-evaluation-runner"
REPORTS = {
    "evaluation-package-preflight",
    "evaluation-publication-evaluation-runner",
    "evaluation-publication-result",
}
CHART = "infrastructure/gitops/charts/govbiz-evaluation"
VALUES = "infrastructure/gitops/environments/evaluation"
NAMESPACE = "govbiz-evaluation"
PROJECT = "govbiz-evaluation"


def select_runner_release(fork, get=api):
    """Do not fall back past a failed, pending or malformed newer publisher."""
    runs = get(
        f"repos/{fork.repository}/actions/workflows/evaluation-images.yml/runs"
        f"?branch={quote(fork.branch, safe='')}&per_page=100"
    )["workflow_runs"]
    for run in sorted(runs, key=lambda row: row["id"], reverse=True):
        if run.get("status") != "completed" or run.get("conclusion") not in {
            "success",
            "skipped",
        }:
            return None
        if run["conclusion"] == "skipped":
            continue
        if not valid_run(
            run,
            run.get("head_sha"),
            WORKFLOW,
            {"workflow_run", "workflow_dispatch"},
            fork,
        ) or any(
            type(run.get(key)) is not int or run[key] <= 0
            for key in ("id", "run_attempt")
        ):
            raise ValueError("Untrusted evaluation publisher")
        repository_id = run["repository"].get("id")
        if type(repository_id) is not int or repository_id <= 0:
            raise ValueError("Missing publisher repository identity")
        response = get(
            f"repos/{fork.repository}/actions/runs/{run['id']}/artifacts?per_page=100"
        )
        artifacts = response["artifacts"]
        if response.get("total_count") != len(artifacts):
            raise ValueError("Incomplete publisher artifacts")
        receipts = [row for row in artifacts if row.get("name") not in REPORTS]
        if not receipts:  # successful gate-only run; reports are not image receipts
            continue
        if len(receipts) != 1 or receipts[0].get("name") != ARTIFACT:
            raise ValueError("Exactly one evaluation runner receipt is required")
        artifact = receipts[0]
        origin = artifact.get("workflow_run", {})
        if (
            artifact.get("expired") is not False
            or type(artifact.get("id")) is not int
            or artifact["id"] <= 0
            or type(artifact.get("size_in_bytes")) is not int
            or not 0 < artifact["size_in_bytes"] < 16384
            or origin.get("id") != run["id"]
            or origin.get("head_sha") != run["head_sha"]
            or origin.get("head_branch") != fork.branch
            or origin.get("repository_id") != repository_id
            or origin.get("head_repository_id") != repository_id
        ):
            raise ValueError("Invalid, expired or cross-repository runner artifact")
        return run, artifact
    return None


def checked_runner_receipt(root, fork, sha, release, get=api):
    """Bind v3 provenance to actual committed inputs, including manifest bytes."""
    run, artifact = release
    if run["head_sha"] != sha:
        raise ValueError("Runner and Ops publications must use the same source SHA")
    payload = get(
        f"repos/{fork.repository}/actions/artifacts/{artifact['id']}/zip", binary=True
    )
    if (
        len(payload) != artifact["size_in_bytes"]
        or len(payload) >= 16384
        or "sha256:" + digest(payload) != artifact.get("digest")
    ):
        raise ValueError("Runner receipt archive checksum or size mismatch")
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        members = archive.infolist()
        if (
            len(members) != 1
            or members[0].filename != RUNNER + ".json"
            or members[0].file_size > 8192
        ):
            raise ValueError("Unexpected runner receipt archive contents")
        receipt = json.loads(archive.read(members[0]))
    keys = {
        "schemaVersion",
        "service",
        "repository",
        "digest",
        "tag",
        "platform",
        "verifiedRevision",
        "inputKey",
        "visibility",
        "sourceInputs",
        "publisherTree",
        "executionReleaseSha256",
    }
    if (
        not isinstance(receipt, dict)
        or set(receipt) != keys
        or type(receipt["schemaVersion"]) is not int
        or receipt["schemaVersion"] != 3
        or receipt["service"] != RUNNER
        or receipt["repository"] != fork.image(RUNNER)
        or receipt["platform"] != "linux/amd64"
        or receipt["visibility"] != "public"
        or receipt["verifiedRevision"] != sha
        or not isinstance(receipt["digest"], str)
        or not re.fullmatch(r"sha256:[a-f0-9]{64}", receipt["digest"])
    ):
        raise ValueError("A matching public v3 runner receipt is required")
    paths = (*RUNNER_PATHS, "infrastructure/release")
    identities = (
        git_bytes(root, "rev-parse", *(sha + ":" + path for path in paths))
        .decode()
        .splitlines()
    )
    inputs = dict(zip(paths, identities, strict=True))
    publisher = inputs.pop("infrastructure/release")
    key = runner_input_key(inputs, publisher)
    manifest = tracked_files(root, sha, (RUNNER_RELEASE,))[RUNNER_RELEASE]
    if (
        receipt["sourceInputs"] != inputs
        or receipt["publisherTree"] != publisher
        or receipt["inputKey"] != key
        or receipt["tag"] != "src-" + key
        or receipt["executionReleaseSha256"] != digest(manifest)
    ):
        raise ValueError(
            "Runner receipt differs from committed inputs or execution release"
        )
    return receipt


def argo_plan(fork, sha, values):
    destination = {"server": "https://kubernetes.default.svc", "namespace": NAMESPACE}
    resources = [
        {
            "apiVersion": "argoproj.io/v1alpha1",
            "kind": "AppProject",
            "metadata": {"name": PROJECT, "namespace": "argocd"},
            "spec": {
                "sourceRepos": [fork.url],
                "destinations": [destination],
                "clusterResourceWhitelist": [],
                "namespaceResourceWhitelist": [
                    {"group": "apps", "kind": "Deployment"},
                    {"group": "", "kind": "Service"},
                    {"group": "networking.k8s.io", "kind": "NetworkPolicy"},
                ],
            },
        }
    ]
    for name in COMPONENTS:
        resources.append(
            {
                "apiVersion": "argoproj.io/v1alpha1",
                "kind": "Application",
                "metadata": {"name": PROJECT + "-" + name, "namespace": "argocd"},
                "spec": {
                    "project": PROJECT,
                    "destination": destination,
                    "source": {
                        "repoURL": fork.url,
                        "targetRevision": sha,
                        "path": CHART,
                        "helm": {
                            "releaseName": name,
                            "kubeVersion": KUBE_VERSION,
                            "valuesObject": values[name],
                        },
                    },
                    "syncPolicy": {
                        "automated": {
                            "enabled": False,
                            "prune": False,
                            "selfHeal": False,
                        },
                        "retry": {"limit": 0},
                        "syncOptions": ["FailOnSharedResource=true"],
                    },
                },
            }
        )
    return resources


def plan(
    root,
    fork,
    *,
    node,
    prefect_claim,
    results_claim,
    langfuse_url,
    ops_api_url="http://ops-service.govbiz-msa.svc.cluster.local:8000",
    helm="helm",
    get=api,
):
    """Read-only preparation. Existing storage, Secrets and runtime are unverified."""
    msa_release = select_release(fork, get)
    record, _, sha = verified_release(
        root, fork, helm, get, verify_public_manifests=True
    )
    checks = source_checks(fork, sha, get)
    release = select_runner_release(fork, get)
    if release is None:
        raise ValueError("No complete evaluation runner publication")
    receipt = checked_runner_receipt(root, fork, sha, release, get)
    runner_image = receipt["repository"] + "@" + receipt["digest"]
    verify_pull_rights(None, None, {"images": {RUNNER: runner_image}})
    files = tracked_files(root, sha, (CHART, VALUES))
    values = {
        name: yaml.load(files[VALUES + "/" + name + ".yaml"], Loader=UniqueLoader)
        for name in COMPONENTS
    }
    for name, value in values.items():
        value.update(replicas=0, allowLocalImages=False, imagePullSecrets=[])
        value["storage"] = {
            "existingClaim": prefect_claim if name == "prefect" else results_claim,
            "node": node,
        }
    values[RUNNER]["image"] = runner_image
    values[RUNNER]["runner"] = {"opsApiUrl": ops_api_url, "langfuseUrl": langfuse_url}
    values["ops-artifacts"].update(
        image=record["images"]["ops-service"], evidenceImage=runner_image
    )
    with tempfile.TemporaryDirectory(
        prefix="govbiz-evaluation-publication-"
    ) as directory:
        checkout = Path(directory)
        write_files(checkout, files)
        metadata = yaml.load(files[CHART + "/Chart.yaml"], Loader=UniqueLoader)
        if metadata.get("dependencies"):
            raise ValueError("Evaluation chart cannot fetch untracked dependencies")
        rendered = render_bundle(values, NAMESPACE, helm, chart=checkout / CHART)
    if set(rendered) != set(COMPONENTS):
        raise ValueError("All evaluation releases must be rendered")
    for name, rows in rendered.items():
        expected = (
            ["Deployment", "NetworkPolicy"]
            if name == RUNNER
            else ["Deployment", "NetworkPolicy", "Service"]
        )
        if sorted(row["kind"] for row in rows) != expected:
            raise ValueError("Evaluation chart exceeds its project resource scope")
        for row in rows:
            if (
                row["metadata"]["namespace"] != NAMESPACE
                or row["metadata"]["name"] != name
            ):
                raise ValueError("Evaluation chart exceeds its resource identity")
            if (
                row["apiVersion"]
                != {
                    "Deployment": "apps/v1",
                    "Service": "v1",
                    "NetworkPolicy": "networking.k8s.io/v1",
                }[row["kind"]]
            ):
                raise ValueError("Evaluation chart exceeds its project API scope")
            if row["kind"] == "NetworkPolicy":
                peers = [
                    {
                        "namespaceSelector": {
                            "matchLabels": {"kubernetes.io/metadata.name": "govbiz-msa"}
                        },
                        "podSelector": {
                            "matchLabels": {"app.kubernetes.io/name": "ops-service"}
                        },
                    }
                ]
                if name == "prefect":
                    peers.append(
                        {
                            "podSelector": {
                                "matchLabels": {"app.kubernetes.io/name": RUNNER}
                            }
                        }
                    )
                expected_policy = {
                    "podSelector": {"matchLabels": {"app.kubernetes.io/name": name}},
                    "policyTypes": ["Ingress"],
                    "ingress": []
                    if name == RUNNER
                    else [
                        {
                            "from": peers,
                            "ports": [
                                {
                                    "protocol": "TCP",
                                    "port": 4200 if name == "prefect" else 8010,
                                }
                            ],
                        }
                    ],
                }
                if (
                    row["spec"] != expected_policy
                    or row["metadata"]
                    .get("annotations", {})
                    .get("argocd.argoproj.io/sync-wave")
                    != "-1"
                ):
                    raise ValueError(
                        "Evaluation ingress must only allow the expected Ops and runner peers"
                    )
            if row["kind"] == "Deployment":
                pod = row["spec"]["template"]["spec"]
                if row["spec"].get("replicas") != 0 or [
                    container["image"] for container in pod["containers"]
                ] != [values[name]["image"]]:
                    raise ValueError(
                        "Evaluation plan must stay dormant on verified images"
                    )
                expected_init = {
                    "prefect": [values["prefect"]["image"]],
                    RUNNER: [],
                    "ops-artifacts": [runner_image],
                }[name]
                if [c["image"] for c in pod.get("initContainers", [])] != expected_init:
                    raise ValueError(
                        "Evaluation init images differ from verified inputs"
                    )
                if name == RUNNER:
                    entries = pod["containers"][0]["env"]
                    env = {row["name"]: row.get("value") for row in entries}
                    if (
                        len(env) != len(entries)
                        or any(
                            env.get(flag) != "false"
                            for flag in (
                                "LLMOPS_LIVE_ENABLED",
                                "LLMOPS_RAG_LIVE_ENABLED",
                                "LLMOPS_SCHEDULES_ENABLED",
                            )
                        )
                        or env.get("OPENAI_API_KEY") != ""
                    ):
                        raise ValueError(
                            "Evaluation runner must keep paid calls and schedules disabled"
                        )
    resources = argo_plan(fork, sha, values)
    # Recheck both independently published bundles and CI after rendering/registry I/O.
    if select_runner_release(fork, get) != release:
        raise ValueError("Evaluation publication changed during validation")
    if select_release(fork, get) != msa_release:
        raise ValueError("Ops publication changed during validation")
    if source_checks(fork, sha, get) != checks:
        raise ValueError("Required source checks changed during validation")
    return {
        "schema": "evaluation-gitops-plan-v1",
        "status": "PLANNED",
        "repository": fork.repository,
        "branch": fork.branch,
        "sourceSha": sha,
        "msaPublisherRunId": record["runId"],
        "runnerPublisherRunId": release[0]["id"],
        "runnerPublisherRunAttempt": release[0]["run_attempt"],
        "runnerArtifactId": release[1]["id"],
        "runnerArtifactSha256": release[1]["digest"],
        "executionReleaseSha256": receipt["executionReleaseSha256"],
        "images": {name: value["image"] for name, value in values.items()},
        "resources": resources,
        "resourcesSha256": digest(encoded(resources)),
        "renderedSha256": {
            name: digest(encoded(rows)) for name, rows in rendered.items()
        },
        "receiptsVerified": True,
        "helmPolicyVerified": True,
        "publicGHCRManifestsVerified": True,
        "prefectRegistryVerified": False,
        "layersDownloaded": False,
        "automaticSyncEnabled": False,
        "clusterChanged": False,
        "storageRestored": False,
        "retainedStorageIdentityVerified": False,
        "runtimeVerified": False,
        "deploymentAuthorized": False,
    }


def plan_from_restore(root, fork, *, state, restore_report, **options):
    """Bind a dormant plan to observed storage, without trusting report contents as proof."""
    with Path(restore_report).open("rb") as stream:
        raw = stream.read(65537)
    if len(raw) > 65536:
        raise ValueError("Retained restore report is too large")
    report = json.loads(raw)
    if report.get(
        "cross_store_business_links_verified"
    ) is not True or not re.fullmatch(
        r"[a-f0-9]{64}", report.get("archive_sha256", "")
    ):
        raise ValueError("Retained archive restore report is required")
    settings = fork_cluster.load_settings(state)
    if (
        settings["repository"].lower() != fork.repository.lower()
        or settings["branch"] != fork.branch
    ):
        raise ValueError("Retained cluster and release repository differ")
    kube, _, _ = fork_cluster.commands(state, settings)
    fork_cluster.verify_context(kube, settings, timeout=15)
    node = settings["cluster"] + "-control-plane"
    storage = pvc_restore.inspect_retained(kube, node, report)
    result = plan(
        root,
        fork,
        node=node,
        prefect_claim="prefect",
        results_claim="results",
        **options,
    )
    # Image/CI/Helm checks can take time. Do not return a plan based only on the
    # earlier cluster observation; neither observation authorizes activation.
    fork_cluster.verify_context(kube, settings, timeout=15)
    if pvc_restore.inspect_retained(kube, node, report) != storage:
        raise ValueError("Retained storage changed during release planning")
    return {
        **result,
        "retainedStorageIdentityVerified": True,
        "retainedStorage": storage,
        "restoreReportSha256": digest(raw),
        "reportedArchiveSha256": report["archive_sha256"],
        "restoreReportAuthenticated": False,
    }


def require_registered_resource(actual, expected):
    """Resume only our exact dormant declaration, never adopt or update a resource."""
    metadata = actual.get("metadata", {})
    wanted = expected["metadata"]
    if (
        actual.get("apiVersion") != expected["apiVersion"]
        or actual.get("kind") != expected["kind"]
        or any(metadata.get(key) != wanted[key] for key in ("name", "namespace"))
        or not metadata.get("uid")
        or metadata.get("deletionTimestamp")
        or metadata.get("ownerReferences")
        or metadata.get("finalizers")
        or any(
            metadata.get("annotations", {}).get(key) != value
            for key, value in wanted["annotations"].items()
        )
        or encoded(actual.get("spec")) != encoded(expected["spec"])
        or actual.get("operation")
        or actual.get("status", {}).get("operationState")
        or actual.get("status", {}).get("history")
    ):
        raise ValueError("Evaluation Argo resource differs or has been synchronized")
    return metadata["uid"]


def registration_resources(result):
    # Bind retry ownership to this restore and declaration, not merely their names.
    resources = json.loads(encoded(result["resources"]))
    annotations = {
        "ai.govbiz/evaluation-namespace-uid": result["retainedStorage"][
            "namespace_uid"
        ],
        "ai.govbiz/evaluation-plan-sha256": result["resourcesSha256"],
        "ai.govbiz/evaluation-restore-sha256": result["restoreReportSha256"],
    }
    for resource in resources:
        resource["metadata"]["annotations"] = dict(annotations)
    return resources


def registered_resources(kube, ak, resources):
    applications = pvc_restore.run(
        kube + ["get", "applications.argoproj.io", "--all-namespaces", "-o", "json"]
    )["items"]
    expected = {row["metadata"]["name"]: row for row in resources[1:]}
    found = {}
    for application in applications:
        metadata = application["metadata"]
        spec = application.get("spec", {})
        name = metadata["name"]
        if (
            spec.get("project") == PROJECT
            or spec.get("destination", {}).get("namespace") == NAMESPACE
            or (metadata.get("namespace") == "argocd" and name in expected)
        ):
            if metadata.get("namespace") != "argocd" or name not in expected:
                raise ValueError("Evaluation namespace has another Argo owner")
            require_registered_resource(application, expected[name])
            found[("Application", name)] = application
    project = pvc_restore.run(
        ak + ["get", "appproject", PROJECT, "--ignore-not-found", "-o", "json"]
    )
    if project:
        require_registered_resource(project, resources[0])
        found[("AppProject", PROJECT)] = project
    return found


def register_from_restore(root, fork, *, state, restore_report, progress, **options):
    """Create only the project and inactive Applications; never request a sync."""
    result = plan_from_restore(
        root, fork, state=state, restore_report=restore_report, **options
    )
    settings = fork_cluster.load_settings(state)
    if settings["mode"] != "gitops":
        raise ValueError("Evaluation registration requires existing GitOps mode")
    kube, _, ak = fork_cluster.commands(state, settings)
    resources = registration_resources(result)

    def inspect():
        return registered_resources(kube, ak, resources)

    fork_cluster.verify_context(kube, settings, timeout=15)
    existing = inspect()  # Reject every collision before the first write.
    for resource in resources:
        key = (resource["kind"], resource["metadata"]["name"])
        if key not in existing:
            admitted = pvc_restore.run(
                ak + ["create", "--dry-run=server", "-f", "-", "-o", "json"],
                value=resource,
            )
            # Admission must not enable automation or broaden the project.
            require_registered_resource(
                {**admitted, "metadata": {**admitted["metadata"], "uid": "dry-run"}},
                resource,
            )
    # Remote validation and admission can take time. Recompute, do not consume a
    # previously saved plan as deployment authority.
    if (
        plan_from_restore(
            root, fork, state=state, restore_report=restore_report, **options
        )
        != result
    ):
        raise ValueError("Evaluation registration plan changed before creation")
    for resource in resources:
        fork_cluster.verify_context(kube, settings, timeout=15)
        current = inspect()
        for key, previous in existing.items():
            if (
                key not in current
                or current[key]["metadata"]["uid"] != previous["metadata"]["uid"]
            ):
                raise ValueError("Evaluation Argo identity changed during registration")
        key = (resource["kind"], resource["metadata"]["name"])
        if key not in current:
            # Record before the request: a timeout can still leave a created object.
            progress["creationAttempts"].append({"kind": key[0], "name": key[1]})
            actual = pvc_restore.run(
                ak + ["create", "-f", "-", "-o", "json"], value=resource
            )
            progress["created"].append({"kind": key[0], "name": key[1]})
            require_registered_resource(actual, resource)
            current[key] = actual
        existing = current
    # A manual sync, storage replacement or CI change during registration is an
    # error. Leave the named objects in place for inspection; never auto-delete.
    if (
        plan_from_restore(
            root, fork, state=state, restore_report=restore_report, **options
        )
        != result
    ):
        raise ValueError("Evaluation registration plan changed after creation")
    current = inspect()
    registered = []
    for resource in resources:
        key = (resource["kind"], resource["metadata"]["name"])
        actual = current.get(key, {})
        uid = require_registered_resource(actual, resource)
        if uid != existing[key]["metadata"]["uid"]:
            raise ValueError("Evaluation Argo identity changed during registration")
        registered.append({"kind": key[0], "name": key[1], "uid": uid})
    return {
        **result,
        "status": "REGISTERED_NOT_SYNCED",
        "clusterChanged": bool(progress["created"]),
        "registration": progress,
        "registeredResources": registered,
        "syncRequested": False,
        "runtimeStarted": False,
    }


def request_dormant_sync(root, fork, *, state, restore_report, progress, **options):
    """Request only the first replica-zero sync. Never retry an uncertain operation."""
    result = plan_from_restore(
        root, fork, state=state, restore_report=restore_report, **options
    )
    settings = fork_cluster.load_settings(state)
    if settings["mode"] != "gitops":
        raise ValueError("Evaluation registration requires existing GitOps mode")
    kube, _, ak = fork_cluster.commands(state, settings)
    resources = registration_resources(result)
    fork_cluster.verify_context(kube, settings, timeout=15)
    initial = registered_resources(kube, ak, resources)
    if set(initial) != {(r["kind"], r["metadata"]["name"]) for r in resources}:
        raise ValueError("Evaluation sync requires all four registered declarations")
    operation = {
        "sync": {
            "revision": result["sourceSha"],
            "prune": False,
            "syncStrategy": {"apply": {"force": False}},
            "syncOptions": ["FailOnSharedResource=true"],
        },
        "retry": {"limit": 0},
    }

    def require_unused_targets(names):
        rows = pvc_restore.run(
            kube
            + [
                "-n",
                NAMESPACE,
                "get",
                "deployments,services,networkpolicies",
                "-o",
                "json",
            ]
        )["items"]
        if any(row["metadata"]["name"] in names for row in rows):
            raise ValueError(
                "Evaluation sync target already exists; no adoption is allowed"
            )

    def patch_request(expected, actual, *, dry_run):
        name = expected["metadata"]["name"]
        metadata = actual["metadata"]
        if (
            require_registered_resource(actual, expected)
            != initial[("Application", name)]["metadata"]["uid"]
            or not isinstance(metadata.get("resourceVersion"), str)
            or not metadata["resourceVersion"]
        ):
            raise ValueError("Evaluation Argo identity changed before sync")
        patch = [
            {"op": "test", "path": "/metadata/uid", "value": metadata["uid"]},
            {
                "op": "test",
                "path": "/metadata/resourceVersion",
                "value": metadata["resourceVersion"],
            },
            {"op": "test", "path": "/spec", "value": expected["spec"]},
            {"op": "add", "path": "/operation", "value": operation},
        ]
        command = ak + [
            "patch",
            "application",
            name,
            "--type=json",
            "--patch-file=/dev/stdin",
            "--request-timeout=15s",
            "-o",
            "json",
        ]
        if dry_run:
            command += ["--dry-run=server"]
        else:
            progress["attempted"].append({"name": name, "uid": metadata["uid"]})
        admitted = pvc_restore.run(command, value=patch, timeout=30)
        if (
            admitted.get("operation") != operation
            or require_registered_resource({**admitted, "operation": None}, expected)
            != metadata["uid"]
        ):
            raise ValueError("Evaluation sync admission changed the request")
        if not dry_run:
            progress["acknowledged"].append({"name": name, "uid": metadata["uid"]})

    require_unused_targets(set(COMPONENTS))
    for resource in resources[1:]:
        name = resource["metadata"]["name"]
        patch_request(resource, initial[("Application", name)], dry_run=True)
    # Revalidate source, receipts, CI and the still-empty retained namespace after
    # admission checks, before requesting any controller action.
    if (
        plan_from_restore(
            root, fork, state=state, restore_report=restore_report, **options
        )
        != result
    ):
        raise ValueError("Evaluation sync plan changed before request")
    project_uid = initial[("AppProject", PROJECT)]["metadata"]["uid"]
    for resource in resources[1:]:
        if fork_cluster.load_settings(state) != settings:
            raise ValueError("Evaluation sync cluster settings changed")
        fork_cluster.verify_context(kube, settings, timeout=15)
        project = pvc_restore.run(ak + ["get", "appproject", PROJECT, "-o", "json"])
        if require_registered_resource(project, resources[0]) != project_uid:
            raise ValueError("Evaluation Argo identity changed before sync")
        name = resource["metadata"]["name"]
        actual = pvc_restore.run(ak + ["get", "application", name, "-o", "json"])
        require_unused_targets({resource["spec"]["source"]["helm"]["releaseName"]})
        patch_request(resource, actual, dry_run=False)
    # Workloads may now exist at replica zero, so initial-handoff storage inspection
    # is intentionally not reused. Recheck publication without claiming runtime state.
    fresh = plan(
        root,
        fork,
        node=result["retainedStorage"]["node"],
        prefect_claim="prefect",
        results_claim="results",
        **options,
    )
    # plan_from_restore overrides this one fact after observing retained PVCs;
    # publication-only planning cannot repeat the empty-namespace check now.
    if any(
        result.get(key) != value
        for key, value in fresh.items()
        if key != "retainedStorageIdentityVerified"
    ):
        raise ValueError("Evaluation sync plan changed after request")
    return {
        **result,
        "status": "DORMANT_SYNC_REQUESTED",
        "clusterChanged": True,
        "synchronization": progress,
        "syncRequested": True,
        "syncCompleted": None,
        "desiredReplicas": 0,
        "activationRequested": False,
        "runtimeStarted": None,
        "runtimeVerified": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--branch", help="Origin's default branch when omitted")
    parser.add_argument("--helm", default="helm")
    parser.add_argument("--node")
    parser.add_argument("--prefect-claim")
    parser.add_argument("--results-claim")
    parser.add_argument("--restore-report", type=Path)
    parser.add_argument("--state-dir", type=Path)
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument(
        "--register-argo",
        action="store_true",
        help="Create dormant Argo declarations from a newly verified retained-storage plan",
    )
    actions.add_argument(
        "--request-dormant-sync",
        action="store_true",
        help="WSL/Linux: request the first manual sync of registered replica-zero Applications",
    )
    parser.add_argument("--langfuse-url", required=True)
    parser.add_argument(
        "--ops-api-url", default="http://ops-service.govbiz-msa.svc.cluster.local:8000"
    )
    args = parser.parse_args()
    if (args.register_argo or args.request_dormant_sync) and not args.restore_report:
        parser.error("Argo actions require --restore-report and --state-dir")
    if args.request_dormant_sync and os.name != "posix":
        parser.error("Run the sync request inside WSL/Linux")
    manual = (args.node, args.prefect_claim, args.results_claim)
    if args.restore_report:
        if not args.state_dir or any(manual):
            parser.error(
                "Use --restore-report with --state-dir and no manual node/claims"
            )
    elif args.state_dir or not all(manual):
        parser.error(
            "Use --node, --prefect-claim and --results-claim, or a restore report with state"
        )
    progress = {"creationAttempts": [], "created": []}
    sync_progress = {"attempted": [], "acknowledged": []}
    try:
        root = Path(__file__).resolve().parents[3]
        fork = from_origin(root, branch=args.branch).require_personal_publish()
        options = {
            "helm": args.helm,
            "langfuse_url": args.langfuse_url,
            "ops_api_url": args.ops_api_url,
        }
        if args.request_dormant_sync:
            report = request_dormant_sync(
                root,
                fork,
                state=args.state_dir,
                restore_report=args.restore_report,
                progress=sync_progress,
                **options,
            )
        elif args.register_argo:
            report = register_from_restore(
                root,
                fork,
                state=args.state_dir,
                restore_report=args.restore_report,
                progress=progress,
                **options,
            )
        elif args.restore_report:
            report = plan_from_restore(
                root,
                fork,
                state=args.state_dir,
                restore_report=args.restore_report,
                **options,
            )
        else:
            report = plan(
                root,
                fork,
                node=args.node,
                prefect_claim=args.prefect_claim,
                results_claim=args.results_claim,
                **options,
            )
    except Exception as error:  # noqa: BLE001 - do not expose registry or endpoint credentials
        reasons = {
            "No complete verified publication": "msa_publication_not_available",
            "No complete evaluation runner publication": "runner_publication_not_available",
            "Source advanced": "source_not_current",
            "Deployment source blocked": "required_source_checks_not_verified",
            "Runner and Ops publications": "publication_source_mismatch",
            "A matching public v3 runner receipt": "runner_receipt_invalid",
            "Runner receipt differs": "runner_inputs_mismatch",
            "Evaluation publication changed": "runner_publication_changed",
            "Ops publication changed": "msa_publication_changed",
            "Required source checks changed": "ci_evidence_changed",
            "Retained": "retained_storage_not_verified",
            "Evaluation registration requires": "gitops_mode_required",
            "Evaluation namespace has another": "argo_namespace_conflict",
            "Evaluation Argo resource differs": "argo_resource_conflict",
            "Evaluation Argo identity changed": "argo_identity_changed",
            "Evaluation registration plan changed": "registration_plan_changed",
            "Evaluation sync": "dormant_sync_not_verified",
        }
        print(
            json.dumps(
                {
                    "schema": "evaluation-gitops-plan-v1",
                    "status": "BLOCKED",
                    "reason": next(
                        (
                            code
                            for prefix, code in reasons.items()
                            if str(error).startswith(prefix)
                        ),
                        "verification_failed",
                    ),
                    "errorType": type(error).__name__,
                    "clusterChanged": True
                    if progress["created"] or sync_progress["acknowledged"]
                    else (
                        None
                        if progress["creationAttempts"] or sync_progress["attempted"]
                        else False
                    ),
                    **(
                        {
                            "synchronization": sync_progress,
                            "syncRequested": True
                            if sync_progress["acknowledged"]
                            else (None if sync_progress["attempted"] else False),
                            "syncCompleted": None,
                            "activationRequested": False,
                        }
                        if args.request_dormant_sync
                        else {}
                    ),
                    **(
                        {"registration": progress, "syncRequested": False}
                        if args.register_argo
                        else {}
                    ),
                    "deploymentAuthorized": False,
                }
            )
        )
        return 1
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
