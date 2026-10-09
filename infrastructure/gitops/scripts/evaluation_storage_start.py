"""Review, request or observe the first Argo start of the two storage services."""

import argparse
import copy
import hashlib
import json
import os
import tempfile
from pathlib import Path

import evaluation_dormant_status as dormant
import evaluation_network_probe as network
import evaluation_storage_http as storage_http

release = dormant.release
COMPONENTS = ("prefect", "ops-artifacts")
ANNOTATION = "ai.govbiz/evaluation-storage-start-sha256"


def transition(root, plan, helm):
    """Render the published chart; change only the two storage service replicas."""
    resources = release.registration_resources(plan)
    started = copy.deepcopy(resources)
    values = {}
    for app in started[1:]:
        source = app["spec"]["source"]
        name = source["helm"]["releaseName"]
        value = source["helm"]["valuesObject"]
        if type(value.get("replicas")) is not int or value["replicas"] != 0:
            raise ValueError("Storage start requires a fully dormant plan")
        if name in COMPONENTS:
            value["replicas"] = 1
        values[name] = value
    files = release.tracked_files(root, plan["sourceSha"], (release.CHART,))
    with tempfile.TemporaryDirectory(prefix="govbiz-storage-start-") as directory:
        checkout = Path(directory)
        release.write_files(checkout, files)
        rendered = release.render_bundle(
            values, release.NAMESPACE, helm, chart=checkout / release.CHART
        )
    if set(rendered) != set(values):
        raise ValueError("Storage start rendered components changed")
    # A chart can branch on replicas. Normalize just that field and require the
    # entire output to match the already verified dormant publication.
    for name, rows in copy.deepcopy(rendered).items():
        deployments = [row for row in rows if row["kind"] == "Deployment"]
        if (
            len(deployments) != 1
            or deployments[0]["spec"].get("replicas") != values[name]["replicas"]
        ):
            raise ValueError("Storage start rendered replicas differ from the request")
        deployments[0]["spec"]["replicas"] = 0
        if release.digest(release.encoded(rows)) != plan["renderedSha256"][name]:
            raise ValueError("Storage start changes rendered resources beyond replicas")
    policies = {}
    for name in COMPONENTS:
        rows = [row for row in rendered[name] if row["kind"] == "NetworkPolicy"]
        if len(rows) != 1:
            raise ValueError("Published storage policy is missing or ambiguous")
        policies[name] = hashlib.sha256(
            json.dumps(rows[0]["spec"], sort_keys=True).encode()
        ).hexdigest()
    fingerprint = release.digest(release.encoded(started))
    for app in started[1:]:
        if app["spec"]["source"]["helm"]["releaseName"] in COMPONENTS:
            app["metadata"]["annotations"][ANNOTATION] = fingerprint
    return resources, started, fingerprint, policies, rendered


def require_observed(actual, expected, uid):
    # Previous dormant sync history is expected. Active operations are checked by
    # the caller; immutable identity, full spec and restore binding still apply.
    if (
        release.require_registered_resource(
            {**actual, "status": {}, "operation": None}, expected
        )
        != uid
    ):
        raise ValueError("Evaluation Argo ownership changed")


def request(
    root,
    fork,
    *,
    state,
    restore_report,
    archive,
    key_file,
    langfuse_url,
    helm="helm",
    start=False,
    progress,
):
    options = {"langfuse_url": langfuse_url, "helm": helm}
    verified = dormant.verify(
        root,
        fork,
        state=state,
        restore_report=restore_report,
        archive=archive,
        key_file=key_file,
        verify_storage=start,
        storage_progress=progress["storageProbe"],
        **options,
    )
    if any(
        verified.get(key) is not True
        for key in (
            "syncCompleted",
            "podsAbsent",
            "sourceQuiescenceVerified",
            "archiveFreshnessVerified",
            "preparedSecretsVerified",
        )
    ) or (start and verified.get("storageDataReverified") is not True):
        raise ValueError("Dormant storage prerequisites are incomplete")
    settings = release.fork_cluster.load_settings(state)
    kube, _, ak = release.fork_cluster.commands(state, settings)
    kube, ak = kube + ["--request-timeout=15s"], ak + ["--request-timeout=15s"]
    node = settings["cluster"] + "-control-plane"
    report, report_sha = release.read_restore_report(restore_report)
    plan = release.plan(
        root,
        fork,
        node=node,
        prefect_claim="prefect",
        results_claim="results",
        **options,
    )
    if (
        plan["sourceSha"] != verified["sourceSha"]
        or report_sha != verified["restoreReportSha256"]
    ):
        raise ValueError("Storage start source or restore report changed")
    bound = {
        **plan,
        "retainedStorage": verified["observation"]["storage"],
        "restoreReportSha256": report_sha,
    }
    initial, started, fingerprint, policies, _ = transition(root, bound, helm)
    for app in initial[1:]:
        observed = verified["observation"]["applications"][app["metadata"]["name"]]
        if observed["specSha256"] != release.digest(release.encoded(app["spec"])):
            raise ValueError("Published plan differs from verified Argo declarations")
    result = {
        "schema": "evaluation-storage-start-v1",
        "status": "STORAGE_START_PLANNED",
        "sourceSha": plan["sourceSha"],
        "restoreReportSha256": report_sha,
        "storageStartSha256": fingerprint,
        "desiredReplicas": {"prefect": 1, "ops-artifacts": 1, "evaluation-runner": 0},
        "images": plan["images"],
        "progress": progress,
        "syncRequested": False,
        "syncCompleted": False,
        "runtimeVerified": False,
        "runnerActivationRequested": False,
        "opsRoutingChanged": False,
        "clusterChanged": False,
    }
    if not start:
        return result
    # Fresh synthetic tests must exercise the same two policies we will expose.
    # Runner/Langfuse egress and real endpoint authentication remain a later step.
    progress["networkProbeAttempted"] = True
    traffic = network.exercise(kube, node, helm=helm)
    progress["networkProbe"] = traffic
    if (
        traffic.get("status") != "ENFORCED"
        or traffic.get("cleanupComplete") is not True
        or traffic.get("networkPolicyEnforcementVerified") is not True
        or traffic.get("serviceDnsVerified") is not True
        or traffic.get("serviceClusterIPVerified") is not True
        or any(
            traffic.get("chartPolicySpecSha256", {}).get(name) != digest
            for name, digest in policies.items()
        )
    ):
        raise ValueError("Published storage service policy enforcement is unverified")
    # Data and network probes have finished; require all dormant identities and
    # current source credentials again before any Argo change.
    again = dormant.verify(
        root,
        fork,
        state=state,
        restore_report=restore_report,
        archive=archive,
        key_file=key_file,
        **options,
    )
    for key in ("sourceSha", "restoreReportSha256", "observation", "sourceHandoff"):
        if again[key] != verified[key]:
            raise ValueError("Dormant evidence changed before storage start")
    operation = {
        "sync": {
            "revision": plan["sourceSha"],
            "prune": False,
            "syncStrategy": {"apply": {"force": False}},
            "syncOptions": ["FailOnSharedResource=true"],
        },
        "retry": {"limit": 0},
    }
    originals = {app["metadata"]["name"]: app for app in initial[1:]}
    desired = {app["metadata"]["name"]: app for app in started[1:]}

    def guard():
        if release.fork_cluster.load_settings(state) != settings:
            raise ValueError("Storage start cluster settings changed")
        release.fork_cluster.verify_context(kube, settings, timeout=15)
        if release.read_restore_report(restore_report) != (report, report_sha):
            raise ValueError("Retained restore report changed")
        if (
            release.plan(
                root,
                fork,
                node=node,
                prefect_claim="prefect",
                results_claim="results",
                **options,
            )
            != plan
        ):
            raise ValueError("Storage start publication changed")
        if (
            dormant.evaluation_secrets.verify_handoff(
                state, archive, key_file, report, bound["retainedStorage"]
            )
            != verified["sourceHandoff"]
        ):
            raise ValueError("Storage start source or credentials changed")
        project = release.pvc_restore.run(
            ak + ["get", "appproject", release.PROJECT, "-o", "json"]
        )
        if (
            release.require_registered_resource(project, initial[0])
            != verified["observation"]["projectUid"]
        ):
            raise ValueError("Evaluation Argo project ownership changed")
        rows = release.pvc_restore.run(
            kube + ["get", "applications.argoproj.io", "--all-namespaces", "-o", "json"]
        )["items"]
        found = {}
        for app in rows:
            meta, spec = app["metadata"], app.get("spec", {})
            name = meta["name"]
            if not (
                spec.get("project") == release.PROJECT
                or spec.get("destination", {}).get("namespace") == release.NAMESPACE
                or name in originals
            ):
                continue
            if (
                meta.get("namespace") != "argocd"
                or name not in originals
                or name in found
            ):
                raise ValueError("Evaluation namespace has another Argo owner")
            wanted = (
                desired[name] if name in progress["acknowledged"] else originals[name]
            )
            require_observed(
                app, wanted, verified["observation"]["applications"][name]["uid"]
            )
            if app.get("operation") and (
                name not in progress["acknowledged"] or app["operation"] != operation
            ):
                raise ValueError("Unexpected evaluation Argo operation")
            status = app.get("status", {})
            completed = status.get("operationState", {})
            if status.get("conditions") or completed.get("phase") in (
                "Failed",
                "Error",
                "Terminating",
            ):
                raise ValueError(
                    "Evaluation Argo reports a failed or interrupted operation"
                )
            if name not in progress["acknowledged"]:
                source = wanted["spec"]["source"]
                sync = status.get("sync", {})
                if (
                    completed.get("phase") != "Succeeded"
                    or completed.get("finishedAt")
                    != verified["observation"]["applications"][name]["finishedAt"]
                    or completed.get("syncResult", {}).get("revision")
                    != plan["sourceSha"]
                    or completed.get("syncResult", {}).get("source") != source
                    or sync.get("status") != "Synced"
                    or sync.get("revision") != plan["sourceSha"]
                    or sync.get("comparedTo")
                    != {"source": source, "destination": wanted["spec"]["destination"]}
                    or status.get("health", {}).get("status") != "Healthy"
                ):
                    raise ValueError(
                        "Unrequested evaluation application is no longer dormant"
                    )
            found[name] = app
        if set(found) != set(originals):
            raise ValueError("Evaluation Argo declaration is missing")
        connections = release.pvc_restore.run(
            kube
            + ["-n", release.NAMESPACE, "get", "services,networkpolicies", "-o", "json"]
        )["items"]
        expected_connections = {
            name: evidence
            for name, evidence in verified["observation"]["resources"].items()
            if name.startswith(("Service/", "NetworkPolicy/"))
        }
        observed_connections = {}
        for row in connections:
            identity = row["kind"] + "/" + row["metadata"]["name"]
            if identity in observed_connections or row["metadata"].get(
                "deletionTimestamp"
            ):
                raise ValueError("Storage service or policy identity changed")
            observed_connections[identity] = {
                "uid": row["metadata"].get("uid"),
                "specSha256": release.digest(release.encoded(row["spec"])),
            }
        if observed_connections != expected_connections:
            raise ValueError("Storage service or network policy changed")
        runner = release.pvc_restore.run(
            kube
            + [
                "-n",
                release.NAMESPACE,
                "get",
                "deployment",
                "evaluation-runner",
                "-o",
                "json",
            ]
        )
        runner_evidence = verified["observation"]["resources"][
            "Deployment/evaluation-runner"
        ]
        if (
            type(runner["spec"].get("replicas")) is not int
            or runner["spec"]["replicas"] != 0
            or runner["metadata"].get("uid") != runner_evidence["uid"]
            or runner["metadata"].get("deletionTimestamp")
            or type(runner["metadata"].get("generation")) is not int
            or release.digest(release.encoded(runner["spec"]))
            != runner_evidence["specSha256"]
            or runner.get("status", {}).get("observedGeneration")
            != runner["metadata"].get("generation")
            or any(
                runner.get("status", {}).get(key, 0) != 0
                for key in (
                    "replicas",
                    "readyReplicas",
                    "availableReplicas",
                    "updatedReplicas",
                    "unavailableReplicas",
                    "terminatingReplicas",
                )
            )
        ):
            raise ValueError("Evaluation runner is no longer dormant")
        pods = release.pvc_restore.run(
            kube
            + [
                "-n",
                release.NAMESPACE,
                "get",
                "pods",
                "-l",
                "app.kubernetes.io/name=evaluation-runner",
                "-o",
                "json",
            ]
        )
        if pods["items"]:
            raise ValueError("Evaluation runner Pod is present")
        return found

    def patch(app, dry_run):
        meta = app["metadata"]
        name = meta["name"]
        if (
            not isinstance(meta.get("resourceVersion"), str)
            or not meta["resourceVersion"]
        ):
            raise ValueError("Argo resource version is missing")
        target = desired[name]
        patch = [
            {"op": "test", "path": "/metadata/uid", "value": meta["uid"]},
            {
                "op": "test",
                "path": "/metadata/resourceVersion",
                "value": meta["resourceVersion"],
            },
            {"op": "test", "path": "/spec", "value": app["spec"]},
            {
                "op": "test",
                "path": "/metadata/annotations",
                "value": meta["annotations"],
            },
            {"op": "replace", "path": "/spec", "value": target["spec"]},
            {
                "op": "add",
                "path": "/metadata/annotations/ai.govbiz~1evaluation-storage-start-sha256",
                "value": fingerprint,
            },
            {"op": "add", "path": "/operation", "value": operation},
        ]
        command = ak + [
            "patch",
            "application",
            name,
            "--type=json",
            "--patch-file=/dev/stdin",
            "-o",
            "json",
        ]
        if dry_run:
            command += ["--dry-run=server"]
        else:
            progress["attempted"].append(name)
        admitted = release.pvc_restore.run(command, value=patch, timeout=30)
        require_observed(admitted, target, meta["uid"])
        if admitted.get("operation") != operation:
            raise ValueError("Storage start admission changed the operation")
        if not dry_run:
            progress["acknowledged"].append(name)

    found = guard()
    names = [release.PROJECT + "-" + component for component in COMPONENTS]
    for name in names:
        patch(found[name], True)
    for name in names:
        patch(guard()[name], False)
    guard()
    return {
        **result,
        "status": "STORAGE_START_REQUESTED",
        "syncRequested": True,
        "syncCompleted": None,
        "clusterChanged": True,
        "storagePolicyEnforcementVerified": True,
    }


def verify_started(
    root,
    fork,
    *,
    state,
    restore_report,
    archive,
    key_file,
    langfuse_url,
    helm="helm",
    verify_http=False,
):
    """Observe rollout before/after optional HTTP reads; never activate the runner."""
    report, report_sha = release.read_restore_report(restore_report)
    settings = release.fork_cluster.load_settings(state)
    if (
        settings["mode"] != "gitops"
        or settings["repository"].lower() != fork.repository.lower()
        or settings["branch"] != fork.branch
    ):
        raise ValueError(
            "Storage rollout verification requires the matching GitOps cluster"
        )
    kube, _, ak = release.fork_cluster.commands(state, settings)
    forward_kube = kube  # A long-lived port-forward must not inherit request timeouts.
    kube, ak = kube + ["--request-timeout=15s"], ak + ["--request-timeout=15s"]
    release.fork_cluster.verify_context(kube, settings, timeout=15)
    node = settings["cluster"] + "-control-plane"
    storage = release.pvc_restore.inspect_retained_storage(kube, node, report)
    options = {
        "node": node,
        "prefect_claim": "prefect",
        "results_claim": "results",
        "langfuse_url": langfuse_url,
        "helm": helm,
    }
    plan = release.plan(root, fork, **options)
    bound = {**plan, "retainedStorage": storage, "restoreReportSha256": report_sha}
    _, started, fingerprint, _, rendered = transition(root, bound, helm)
    before = dormant.observe(
        kube, ak, bound, report, rendered, started_resources=started
    )
    if before["storage"] != storage:
        raise ValueError("Storage identity changed before rollout verification")
    handoff = dormant.evaluation_secrets.verify_handoff(
        state, archive, key_file, report, storage
    )
    proof = None
    if verify_http:
        secrets = dormant.evaluation_secrets
        connection = secrets.ops_runtime.read_connection(
            Path(state) / secrets.ops_runtime.BRIDGE, settings
        )
        payload, archive_hash, keys, source = secrets.bound_archive(
            settings, connection, archive, key_file, report
        )
        if archive_hash != handoff["archiveSha256"]:
            raise ValueError("Storage HTTP archive changed")
        snapshot = secrets.snapshot
        namespaced, frozen = snapshot.database.frozen_source(state, settings)
        if frozen != source:
            raise ValueError(
                "Storage HTTP source is no longer the frozen archive source"
            )
        command = [
            *namespaced,
            "exec",
            "-i",
            "ops-mysql-0",
            "-c",
            "mysql",
            "--",
            *snapshot.storage.AUTH,
        ]
        entries = payload["stores"]["results"]["entries"]
        # The handoff check bound the frozen DB dump to this archive. Only read
        # completed records; the common post-check below also covers HTTP reads.
        expected = snapshot.completed_evidence(command, entries)
        proof = storage_http.verify(
            forward_kube,
            before["storageWorkloads"]["pods"],
            expected,
            entries,
            keys["keys"]["artifact"],
        )
    if release.plan(root, fork, **options) != plan:
        raise ValueError("Storage rollout publication changed")
    if (
        dormant.evaluation_secrets.verify_handoff(
            state, archive, key_file, report, storage
        )
        != handoff
    ):
        raise ValueError("Storage rollout source or credentials changed")
    if (
        release.read_restore_report(restore_report) != (report, report_sha)
        or release.fork_cluster.load_settings(state) != settings
    ):
        raise ValueError("Storage rollout verification inputs changed")
    release.fork_cluster.verify_context(kube, settings, timeout=15)
    after = dormant.observe(
        kube, ak, bound, report, rendered, started_resources=started
    )
    if before != after:
        raise ValueError("Storage rollout resources changed during verification")
    result = {
        "schema": "evaluation-storage-start-v1",
        "status": "STORAGE_ROLLOUT_VERIFIED",
        "sourceSha": plan["sourceSha"],
        "restoreReportSha256": report_sha,
        "storageStartSha256": fingerprint,
        "observation": after,
        "desiredReplicas": {"prefect": 1, "ops-artifacts": 1, "evaluation-runner": 0},
        "syncCompleted": True,
        "storagePodsReady": True,
        "serviceEndpointsVerified": True,
        "runnerStopped": True,
        "sourceQuiescenceVerified": True,
        "archiveFreshnessVerified": True,
        "preparedSecretsVerified": True,
        "sourceHandoff": handoff,
        "clusterChanged": False,
        "syncRequested": False,
        "runtimeVerified": False,
        "httpTrafficVerified": False,
        "networkPolicyEnforcementVerified": False,
        "storageDataReverified": False,
        "runnerActivationRequested": False,
        "opsRoutingChanged": False,
    }
    if proof is not None:
        result.update(
            status="STORAGE_HTTP_VERIFIED",
            httpTrafficVerified=True,
            httpVerification=proof,
            clusterServiceTrafficVerified=False,
        )
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("state-dir", "restore-report", "archive", "key-file"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--langfuse-url", required=True)
    parser.add_argument("--helm", default="helm")
    parser.add_argument("--branch")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--request-start", action="store_true")
    mode.add_argument(
        "--verify-started",
        action="store_true",
        help="Read Argo rollout, storage Pods and Service endpoints without changing resources",
    )
    mode.add_argument(
        "--verify-http",
        action="store_true",
        help="GET completed Prefect history and authenticated reports through temporary Pod loopback forwards",
    )
    args = parser.parse_args()
    if os.name != "posix":
        parser.error("Run inside WSL/Linux")
    progress = {
        "storageProbe": {},
        "networkProbeAttempted": False,
        "attempted": [],
        "acknowledged": [],
    }
    try:
        root = Path(__file__).resolve().parents[3]
        fork = release.from_origin(root, branch=args.branch).require_personal_publish()
        with release.fork_cluster.locked(args.state_dir):
            action = (
                verify_started if args.verify_started or args.verify_http else request
            )
            extra = (
                {"verify_http": args.verify_http}
                if args.verify_started or args.verify_http
                else {"start": args.request_start, "progress": progress}
            )
            result = action(
                root,
                fork,
                state=args.state_dir,
                restore_report=args.restore_report,
                archive=args.archive,
                key_file=args.key_file,
                langfuse_url=args.langfuse_url,
                helm=args.helm,
                **extra,
            )
    except Exception as error:  # noqa: BLE001 - Never export private archive or API diagnostics.
        result = {
            "schema": "evaluation-storage-start-v1",
            "status": "BLOCKED",
            "errorType": type(error).__name__,
            "progress": progress,
            "syncRequested": True
            if progress["acknowledged"]
            else (None if progress["attempted"] else False),
            "syncCompleted": None,
            "runtimeVerified": False,
            "httpTrafficVerified": False,
            "runnerActivationRequested": False,
            "opsRoutingChanged": False,
            "clusterChanged": True
            if progress["storageProbe"].get("created") or progress["acknowledged"]
            else (
                None
                if progress["storageProbe"].get("creationAttempted")
                or progress["networkProbeAttempted"]
                or progress["attempted"]
                else False
            ),
        }
    print(json.dumps(result, sort_keys=True))
    return int(result["status"] == "BLOCKED")


if __name__ == "__main__":
    raise SystemExit(main())
