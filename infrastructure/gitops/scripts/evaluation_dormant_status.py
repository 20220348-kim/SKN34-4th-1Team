"""Read Argo completion and replica-zero evaluation resources without activating them."""

import argparse
import copy
import ipaddress
import json
import os
import tempfile
from contextlib import nullcontext
from pathlib import Path

import evaluation_release as release
import evaluation_retained_data
import evaluation_secrets
import network_status
from gitops_runtime import probe_settings, resource_settings
from gitops_service import service_settings


def deployment_spec(spec):
    """Normalize only defaults used by this evaluation chart; retain unknown fields."""
    result = copy.deepcopy(spec)
    template = result["template"]
    if template["metadata"].get("creationTimestamp") is None:
        template["metadata"].pop("creationTimestamp", None)
    pod = template["spec"]
    for field, value in (
        ("dnsPolicy", "ClusterFirst"),
        ("restartPolicy", "Always"),
        ("schedulerName", "default-scheduler"),
    ):
        pod.setdefault(field, value)
    for field in ("containers", "initContainers"):
        for container in pod.setdefault(field, []):
            container.setdefault("terminationMessagePath", "/dev/termination-log")
            container.setdefault("terminationMessagePolicy", "File")
            container["resources"] = resource_settings(container.get("resources", {}))
            for port in container.get("ports", []):
                port.setdefault("protocol", "TCP")
            for env in container.get("env", []):
                if "valueFrom" not in env:
                    env.setdefault("value", "")
            for mount in container.get("volumeMounts", []):
                mount.setdefault("readOnly", False)
            for probe in ("startupProbe", "readinessProbe", "livenessProbe"):
                if probe in container:
                    container[probe] = probe_settings(container[probe])
    for volume in pod.get("volumes", []):
        if "persistentVolumeClaim" in volume:
            volume["persistentVolumeClaim"].setdefault("readOnly", False)
    return result


def policy_spec(spec):
    result = copy.deepcopy(spec)
    for field in ("ingress", "egress"):
        result.setdefault(field, [])
    return result


def resource_key(row):
    return row["kind"], row["metadata"]["name"]


def argo_inventory(rows):
    """Compare exact managed identities, rejecting duplicate and prunable resources."""
    keys = []
    for row in rows:
        if (
            row.get("status") != "Synced"
            or row.get("requiresPruning")
            or row.get("hook")
        ):
            raise ValueError("Evaluation dormant Argo inventory is not synchronized")
        keys.append((row.get("group", ""), row["kind"], row["namespace"], row["name"]))
    if len(keys) != len(set(keys)):
        raise ValueError("Evaluation dormant Argo inventory is ambiguous")
    return set(keys)


def observe(kube, ak, plan, report, rendered, *, started_resources=None):
    """Capture stable identities/spec hashes, never export live environment or errors."""
    storage = release.pvc_restore.inspect_retained_storage(
        kube, plan["retainedStorage"]["node"], report
    )
    resources = (
        started_resources
        if started_resources is not None
        else release.registration_resources(plan)
    )
    replicas = {
        name: int(
            started_resources is not None and name in ("prefect", "ops-artifacts")
        )
        for name in release.COMPONENTS
    }
    for name, rows in rendered.items():
        deployment = [row for row in rows if row["kind"] == "Deployment"]
        if (
            len(deployment) != 1
            or deployment[0]["spec"].get("replicas") != replicas[name]
        ):
            raise ValueError(
                "Evaluation observation mode differs from rendered replicas"
            )
    project = release.pvc_restore.run(
        ak + ["get", "appproject", release.PROJECT, "-o", "json"]
    )
    project_uid = release.require_registered_resource(project, resources[0])
    expected_apps = {row["metadata"]["name"]: row for row in resources[1:]}
    applications = release.pvc_restore.run(
        kube + ["get", "applications.argoproj.io", "--all-namespaces", "-o", "json"]
    )["items"]
    observed_apps = {}
    for app in applications:
        meta, spec = app["metadata"], app.get("spec", {})
        name = meta["name"]
        if not (
            spec.get("project") == release.PROJECT
            or spec.get("destination", {}).get("namespace") == release.NAMESPACE
            or (meta.get("namespace") == "argocd" and name in expected_apps)
        ):
            continue
        if (
            meta.get("namespace") != "argocd"
            or name not in expected_apps
            or name in observed_apps
        ):
            raise ValueError("Evaluation namespace has another Argo owner")
        expected = expected_apps[name]
        uid = release.require_registered_resource({**app, "status": {}}, expected)
        status = app.get("status", {})
        sync, operation = status.get("sync", {}), status.get("operationState", {})
        source = expected["spec"]["source"]
        if (
            sync.get("status") != "Synced"
            or sync.get("revision") != plan["sourceSha"]
            or sync.get("comparedTo")
            != {"source": source, "destination": expected["spec"]["destination"]}
            or status.get("health", {}).get("status") != "Healthy"
            or status.get("conditions")
            or operation.get("phase") != "Succeeded"
            or not operation.get("finishedAt")
            or operation.get("syncResult", {}).get("revision") != plan["sourceSha"]
            or operation.get("syncResult", {}).get("source") != source
        ):
            raise ValueError("Evaluation dormant Argo completion is not verified")
        component = source["helm"]["releaseName"]
        identities = {
            (
                row["apiVersion"].split("/")[0] if "/" in row["apiVersion"] else "",
                row["kind"],
                release.NAMESPACE,
                component,
            )
            for row in rendered[component]
        }
        if argo_inventory(status.get("resources", [])) != identities:
            raise ValueError("Evaluation dormant Argo resources differ from the chart")
        observed_apps[name] = {
            "uid": uid,
            "specSha256": release.digest(release.encoded(spec)),
            "finishedAt": operation["finishedAt"],
        }
    if set(observed_apps) != set(expected_apps):
        raise ValueError("Evaluation dormant Applications are missing")

    expected_rows = {
        resource_key(row): row for rows in rendered.values() for row in rows
    }
    expected_rows[("NetworkPolicy", "deny-all")] = {
        "apiVersion": "networking.k8s.io/v1",
        "kind": "NetworkPolicy",
        "metadata": {"name": "deny-all", "namespace": release.NAMESPACE},
        "spec": {"podSelector": {}, "policyTypes": ["Ingress", "Egress"]},
    }
    live = release.pvc_restore.run(
        kube
        + [
            "-n",
            release.NAMESPACE,
            "get",
            "deployments,services,networkpolicies,pods,replicasets,statefulsets,daemonsets,replicationcontrollers,jobs,cronjobs,horizontalpodautoscalers",
            "-o",
            "json",
        ]
    )["items"]
    dynamic_kinds = (
        {"ReplicaSet", "Pod"} if started_resources is not None else {"ReplicaSet"}
    )
    actual_rows = {
        resource_key(row): row for row in live if row["kind"] not in dynamic_kinds
    }
    if len(actual_rows) != sum(row["kind"] not in dynamic_kinds for row in live) or set(
        actual_rows
    ) != set(expected_rows):
        raise ValueError(
            "Evaluation dormant namespace has missing or unexpected resources"
        )
    observed_rows = {}
    for key, expected in expected_rows.items():
        actual = actual_rows[key]
        meta = actual["metadata"]
        if (
            not meta.get("uid")
            or meta.get("deletionTimestamp")
            or meta.get("ownerReferences")
            or meta.get("namespace") != release.NAMESPACE
            or actual.get("apiVersion") != expected["apiVersion"]
        ):
            raise ValueError("Evaluation dormant resource identity is invalid")
        group = (
            expected["apiVersion"].split("/")[0]
            if "/" in expected["apiVersion"]
            else ""
        )
        if (
            key != ("NetworkPolicy", "deny-all")
            and meta.get("annotations", {}).get("argocd.argoproj.io/tracking-id")
            != f"{release.PROJECT}-{key[1]}:{group}/{key[0]}:{release.NAMESPACE}/{key[1]}"
        ):
            raise ValueError("Evaluation dormant resource has another Argo owner")
        spec, reference = actual["spec"], expected["spec"]
        if key[0] == "Deployment":
            status = actual.get("status", {})
            count = replicas[key[1]]
            if (
                type(meta.get("generation")) is not int
                or status.get("observedGeneration") != meta["generation"]
                or type(spec.get("replicas")) is not int
                or spec["replicas"] != count
                or any(
                    status.get(field, 0) != count
                    for field in (
                        "replicas",
                        "readyReplicas",
                        "availableReplicas",
                        "updatedReplicas",
                    )
                )
                or any(
                    status.get(field, 0) != 0
                    for field in ("unavailableReplicas", "terminatingReplicas")
                )
                or deployment_spec(spec) != deployment_spec(reference)
            ):
                raise ValueError(
                    "Evaluation Deployment differs or rollout is incomplete"
                )
        elif key[0] == "Service":
            address = ipaddress.ip_address(spec["clusterIP"])
            if address.is_unspecified or spec.get("clusterIPs") != [str(address)]:
                raise ValueError("Evaluation dormant Service address is not allocated")
            normalized = service_settings(spec)
            for field in ("clusterIP", "clusterIPs", "ipFamilies"):
                normalized.pop(field, None)
            if normalized != service_settings(reference):
                raise ValueError("Evaluation dormant Service differs from the chart")
        elif policy_spec(spec) != policy_spec(reference):
            raise ValueError("Evaluation dormant NetworkPolicy differs from the chart")
        observed_rows[key[0] + "/" + key[1]] = {
            "uid": meta["uid"],
            "specSha256": release.digest(release.encoded(spec)),
        }
    # Deployment controllers may create a ReplicaSet even with desired replicas 0.
    active_sets = {}
    for row in (row for row in live if row["kind"] == "ReplicaSet"):
        meta, spec, status = row["metadata"], row["spec"], row.get("status", {})
        owners = meta.get("ownerReferences", [])
        if (
            len(owners) != 1
            or owners[0].get("kind") != "Deployment"
            or owners[0].get("controller") is not True
            or ("Deployment", owners[0].get("name")) not in actual_rows
        ):
            raise ValueError("Evaluation dormant ReplicaSet has an unexpected owner")
        owner = actual_rows[("Deployment", owners[0]["name"])]["metadata"]
        count = spec.get("replicas")
        if (
            not meta.get("uid")
            or meta.get("deletionTimestamp")
            or meta.get("namespace") != release.NAMESPACE
            or owners[0].get("uid") != owner["uid"]
            or type(spec.get("replicas")) is not int
            or count not in range(replicas[owner["name"]] + 1)
            or type(meta.get("generation")) is not int
            or status.get("observedGeneration") != meta["generation"]
            or any(
                status.get(field, 0) != count
                for field in (
                    "replicas",
                    "readyReplicas",
                    "availableReplicas",
                    "fullyLabeledReplicas",
                )
            )
            or status.get("terminatingReplicas", 0) != 0
        ):
            raise ValueError("Evaluation dormant ReplicaSet is not stopped")
        if count:
            template = copy.deepcopy(spec["template"])
            pod_hash = (
                template["metadata"].get("labels", {}).pop("pod-template-hash", None)
            )
            expected_template = actual_rows[("Deployment", owner["name"])]["spec"][
                "template"
            ]
            expected_selector = copy.deepcopy(
                actual_rows[("Deployment", owner["name"])]["spec"]["selector"]
            )
            expected_selector["matchLabels"]["pod-template-hash"] = pod_hash
            if (
                not pod_hash
                or spec.get("selector") != expected_selector
                or owner["name"] in active_sets
                or deployment_spec({"template": template})
                != deployment_spec({"template": expected_template})
            ):
                raise ValueError(
                    "Evaluation active ReplicaSet differs from the Deployment"
                )
            active_sets[owner["name"]] = row
        identity = "ReplicaSet/" + meta["name"]
        if identity in observed_rows:
            raise ValueError("Evaluation dormant ReplicaSet identity is duplicated")
        observed_rows[identity] = {
            "uid": meta["uid"],
            "specSha256": release.digest(release.encoded(spec)),
        }
    result = {
        "storage": storage,
        "projectUid": project_uid,
        "applications": observed_apps,
        "resources": observed_rows,
    }
    if started_resources is not None:
        result["storageWorkloads"] = storage_workloads(
            kube, live, active_sets, plan["retainedStorage"]["node"]
        )
    return result


def storage_workloads(kube, live, active_sets, node):
    """Observe two Ready storage Pods and their exact Service destinations; no traffic."""
    if set(active_sets) != {"prefect", "ops-artifacts"}:
        raise ValueError(
            "Both storage ReplicaSets must be ready; runner must stay stopped"
        )
    pods = [row for row in live if row["kind"] == "Pod"]
    if len(pods) != 2:
        raise ValueError("Only the two storage Pods may be present")
    observed = {}
    for pod in pods:
        meta, spec, status = pod["metadata"], pod["spec"], pod.get("status", {})
        name = meta.get("labels", {}).get("app.kubernetes.io/name")
        replica_set = active_sets.get(name)
        if replica_set is None or name in observed:
            raise ValueError("Unexpected evaluation Pod")
        owner = replica_set["metadata"]
        references = meta.get("ownerReferences", [])
        if (
            not meta.get("uid")
            or meta.get("namespace") != release.NAMESPACE
            or len(references) != 1
            or references[0].get("apiVersion") != "apps/v1"
            or references[0].get("kind") != "ReplicaSet"
            or references[0].get("name") != owner["name"]
            or references[0].get("uid") != owner["uid"]
            or references[0].get("controller") is not True
            or not network_status.pod_ready(pod)
            or spec.get("nodeName") != node
            or meta.get("labels")
            != replica_set["spec"]["template"]["metadata"].get("labels")
        ):
            raise ValueError(
                "Storage Pod is not Ready on its owned node and ReplicaSet"
            )
        expected = deployment_spec(replica_set["spec"])["template"]["spec"]
        actual = deployment_spec({"template": {"metadata": {}, "spec": spec}})[
            "template"
        ]["spec"]
        actual.pop("nodeName", None)
        # Only these admission/scheduler defaults may be absent from the template.
        for field, default in (
            ("serviceAccount", "default"),
            ("serviceAccountName", "default"),
            ("enableServiceLinks", True),
            ("priority", 0),
            ("preemptionPolicy", "PreemptLowerPriority"),
        ):
            if field not in expected and actual.get(field) == default:
                actual.pop(field)
        if "tolerations" not in expected and "tolerations" in actual:
            allowed = [
                {
                    "key": "node.kubernetes.io/" + key,
                    "operator": "Exists",
                    "effect": "NoExecute",
                    "tolerationSeconds": 300,
                }
                for key in ("not-ready", "unreachable")
            ]
            if (
                sorted(actual["tolerations"], key=lambda row: row.get("key", ""))
                == allowed
            ):
                actual.pop("tolerations")
        if actual != expected:
            raise ValueError(
                "Storage Pod configuration differs from the verified template"
            )
        identities = {}
        for field, state_field in (
            ("containers", "containerStatuses"),
            ("initContainers", "initContainerStatuses"),
        ):
            containers = expected.get(field, [])
            states = status.get(state_field, [])
            if len(states) != len(containers) or {row["name"] for row in states} != {
                row["name"] for row in containers
            }:
                raise ValueError("Storage container observation is incomplete")
            for row in states:
                if (
                    not row.get("imageID")
                    or not row.get("containerID")
                    or type(row.get("restartCount")) is not int
                ):
                    raise ValueError("Storage container execution identity is missing")
                if field == "containers":
                    if row.get("ready") is not True or not row.get("state", {}).get(
                        "running"
                    ):
                        raise ValueError("Storage container is not ready")
                elif row.get("state", {}).get("terminated", {}).get("exitCode") != 0:
                    raise ValueError("Storage initialization did not succeed")
                identities[row["name"]] = {
                    key: row[key] for key in ("imageID", "containerID", "restartCount")
                }
        observed[name] = {
            "name": meta["name"],
            "uid": meta["uid"],
            "replicaSetUid": owner["uid"],
            "specSha256": release.digest(release.encoded(spec)),
            "containers": identities,
            "podIPs": status.get("podIPs", []),
        }
    slices = release.pvc_restore.run(
        kube
        + [
            "-n",
            release.NAMESPACE,
            "get",
            "endpointslices.discovery.k8s.io",
            "-o",
            "json",
        ]
    )
    if slices.get("metadata", {}).get("continue"):
        raise ValueError("Incomplete EndpointSlice observation")
    resources = {
        resource_key(row): row for row in live if row["kind"] in ("Service", "Pod")
    }
    endpoints = {}
    for row in slices["items"]:
        meta = row["metadata"]
        key = resource_key(row)
        if (
            key in resources
            or row["kind"] != "EndpointSlice"
            or not meta.get("uid")
            or meta.get("namespace") != release.NAMESPACE
            or meta.get("labels", {}).get(network_status.SERVICE_LABEL)
            not in active_sets
        ):
            raise ValueError("Unexpected storage EndpointSlice")
        resources[key] = row
        endpoints[meta["name"]] = {
            "uid": meta["uid"],
            "sha256": release.digest(
                release.encoded(
                    {
                        key: row.get(key)
                        for key in ("addressType", "ports", "endpoints", "metadata")
                    }
                )
            ),
        }
    services = [
        network_status.service_status(name, resources, release.NAMESPACE)
        for name in sorted(active_sets)
    ]
    if any(
        row["status"] != "PASS" or row["selected_pod_count"] != 1 for row in services
    ):
        raise ValueError("Storage Service does not point to its sole Ready Pod")
    return {"pods": observed, "endpoints": endpoints, "services": services}


def verify(
    root,
    fork,
    *,
    state,
    restore_report,
    archive=None,
    key_file=None,
    verify_storage=False,
    storage_progress=None,
    **options,
):
    if (archive is None) != (key_file is None):
        raise ValueError("Both the retained archive and its key file are required")
    if verify_storage and archive is None:
        raise ValueError(
            "Retained data verification requires the authenticated archive"
        )
    if storage_progress is None:
        storage_progress = {}
    report, report_sha = release.read_restore_report(restore_report)
    settings = release.fork_cluster.load_settings(state)
    if (
        settings["mode"] != "gitops"
        or settings["repository"].lower() != fork.repository.lower()
        or settings["branch"] != fork.branch
    ):
        raise ValueError(
            "Evaluation dormant verification requires the matching GitOps cluster"
        )
    kube, _, ak = release.fork_cluster.commands(state, settings)
    kube, ak = kube + ["--request-timeout=15s"], ak + ["--request-timeout=15s"]
    release.fork_cluster.verify_context(kube, settings, timeout=15)
    node = settings["cluster"] + "-control-plane"
    storage = release.pvc_restore.inspect_retained_storage(kube, node, report)
    plan = release.plan(
        root,
        fork,
        node=node,
        prefect_claim="prefect",
        results_claim="results",
        **options,
    )
    bound = {**plan, "retainedStorage": storage, "restoreReportSha256": report_sha}
    files = release.tracked_files(root, plan["sourceSha"], (release.CHART,))
    with tempfile.TemporaryDirectory(prefix="govbiz-dormant-review-") as directory:
        checkout = Path(directory)
        release.write_files(checkout, files)
        values = {
            r["spec"]["source"]["helm"]["releaseName"]: r["spec"]["source"]["helm"][
                "valuesObject"
            ]
            for r in plan["resources"][1:]
        }
        rendered = release.render_bundle(
            values,
            release.NAMESPACE,
            options.get("helm", "helm"),
            chart=checkout / release.CHART,
        )
    if {
        name: release.digest(release.encoded(rows)) for name, rows in rendered.items()
    } != plan["renderedSha256"]:
        raise ValueError("Evaluation dormant rendered chart changed")
    before = observe(kube, ak, bound, report, rendered)
    if before["storage"] != storage:
        raise ValueError("Evaluation dormant storage changed")
    handoff = None
    if archive is not None:
        handoff = evaluation_secrets.verify_handoff(
            state, archive, key_file, report, storage
        )
    data = None
    if verify_storage:
        connection = evaluation_secrets.ops_runtime.read_connection(
            Path(state) / evaluation_secrets.ops_runtime.BRIDGE, settings
        )
        payload, _, _, _ = evaluation_secrets.bound_archive(
            settings, connection, archive, key_file, report
        )
        data = evaluation_retained_data.recheck(
            kube,
            node,
            report,
            {name: row["entries"] for name, row in payload["stores"].items()},
            values["prefect"]["image"],
            storage_progress,
        )
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
        raise ValueError("Evaluation dormant publication changed")
    if (
        archive is not None
        and evaluation_secrets.verify_handoff(state, archive, key_file, report, storage)
        != handoff
    ):
        raise ValueError(
            "Evaluation handoff source or credentials changed between checks"
        )
    if (
        release.read_restore_report(restore_report) != (report, report_sha)
        or release.fork_cluster.load_settings(state) != settings
    ):
        raise ValueError("Evaluation dormant verification inputs changed")
    release.fork_cluster.verify_context(kube, settings, timeout=15)
    after = observe(kube, ak, bound, report, rendered)
    if after != before:
        raise ValueError("Evaluation dormant resources changed during verification")
    return {
        "schema": "evaluation-dormant-status-v1",
        "status": "DORMANT_SYNC_VERIFIED",
        "sourceSha": plan["sourceSha"],
        "restoreReportSha256": report_sha,
        "observation": after,
        "syncCompleted": True,
        "desiredReplicas": 0,
        "podsAbsent": True,
        "runtimeVerified": False,
        "activationAuthorized": False,
        "networkPolicyEnforcementVerified": False,
        "clusterChanged": bool(storage_progress.get("created")),
        "storageDataReverified": data is not None,
        "storageData": data,
        "storageProbe": storage_progress,
        "sourceQuiescenceVerified": handoff is not None,
        "archiveFreshnessVerified": handoff is not None,
        "preparedSecretsVerified": handoff is not None,
        "sourceVerificationScope": "before_and_after_dormant_verification"
        if handoff is not None
        else "not_checked",
        "sourceHandoff": handoff,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--restore-report", type=Path, required=True)
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--key-file", type=Path)
    parser.add_argument(
        "--verify-storage",
        action="store_true",
        help="With archive inputs, inspect retained data using a temporary read-only Pod",
    )
    parser.add_argument("--langfuse-url", required=True)
    parser.add_argument(
        "--ops-api-url", default="http://ops-service.govbiz-msa.svc.cluster.local:8000"
    )
    parser.add_argument("--helm", default="helm")
    parser.add_argument("--branch")
    parser.add_argument(
        "--publication", type=int, nargs=2, metavar=("MSA_RUN", "RUNNER_RUN")
    )
    args = parser.parse_args()
    if (args.archive is None) != (args.key_file is None):
        parser.error("--archive and --key-file must be provided together")
    if args.archive is not None and os.name != "posix":
        parser.error("Run archive and frozen source verification inside WSL/Linux")
    if args.verify_storage and args.archive is None:
        parser.error("--verify-storage requires --archive and --key-file")
    storage_progress = {}
    try:
        root = Path(__file__).resolve().parents[3]
        fork = release.from_origin(root, branch=args.branch).require_personal_publish()
        with (
            release.fork_cluster.locked(args.state_dir)
            if args.archive is not None
            else nullcontext()
        ):
            result = verify(
                root,
                fork,
                state=args.state_dir,
                restore_report=args.restore_report,
                archive=args.archive,
                key_file=args.key_file,
                verify_storage=args.verify_storage,
                storage_progress=storage_progress,
                langfuse_url=args.langfuse_url,
                ops_api_url=args.ops_api_url,
                helm=args.helm,
                **(
                    {"publication": args.publication}
                    if args.publication is not None
                    else {}
                ),
            )
    except Exception as error:  # noqa: BLE001 - live resource and endpoint text stays private
        print(
            json.dumps(
                {
                    "schema": "evaluation-dormant-status-v1",
                    "status": "BLOCKED",
                    "errorType": type(error).__name__,
                    "clusterChanged": True
                    if storage_progress.get("created")
                    else (None if storage_progress.get("creationAttempted") else False),
                    "storageProbe": storage_progress,
                    "storageDataReverified": False,
                    "syncCompleted": None,
                    "runtimeVerified": False,
                    "activationAuthorized": False,
                    "sourceQuiescenceVerified": False,
                    "archiveFreshnessVerified": False,
                    "preparedSecretsVerified": False,
                }
            )
        )
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
