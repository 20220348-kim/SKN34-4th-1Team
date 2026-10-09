"""Read Argo completion and replica-zero evaluation resources without activating them."""

import argparse
import copy
import ipaddress
import json
import tempfile
from pathlib import Path

import evaluation_release as release
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


def observe(kube, ak, plan, report, rendered):
    """Capture stable identities/spec hashes, never export live environment or errors."""
    storage = release.pvc_restore.inspect_retained_storage(
        kube, plan["retainedStorage"]["node"], report
    )
    resources = release.registration_resources(plan)
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
    actual_rows = {
        resource_key(row): row for row in live if row["kind"] != "ReplicaSet"
    }
    if len(actual_rows) != sum(row["kind"] != "ReplicaSet" for row in live) or set(
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
            if (
                type(meta.get("generation")) is not int
                or status.get("observedGeneration") != meta["generation"]
                or type(spec.get("replicas")) is not int
                or spec["replicas"] != 0
                or any(
                    status.get(field, 0) != 0
                    for field in (
                        "replicas",
                        "readyReplicas",
                        "availableReplicas",
                        "updatedReplicas",
                        "unavailableReplicas",
                        "terminatingReplicas",
                    )
                )
                or deployment_spec(spec) != deployment_spec(reference)
            ):
                raise ValueError(
                    "Evaluation dormant Deployment differs or is not stopped"
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
        if (
            not meta.get("uid")
            or meta.get("deletionTimestamp")
            or meta.get("namespace") != release.NAMESPACE
            or owners[0].get("uid") != owner["uid"]
            or type(spec.get("replicas")) is not int
            or spec["replicas"] != 0
            or type(meta.get("generation")) is not int
            or status.get("observedGeneration") != meta["generation"]
            or any(
                status.get(field, 0) != 0
                for field in (
                    "replicas",
                    "readyReplicas",
                    "availableReplicas",
                    "fullyLabeledReplicas",
                    "terminatingReplicas",
                )
            )
        ):
            raise ValueError("Evaluation dormant ReplicaSet is not stopped")
        identity = "ReplicaSet/" + meta["name"]
        if identity in observed_rows:
            raise ValueError("Evaluation dormant ReplicaSet identity is duplicated")
        observed_rows[identity] = {
            "uid": meta["uid"],
            "specSha256": release.digest(release.encoded(spec)),
        }
    return {
        "storage": storage,
        "projectUid": project_uid,
        "applications": observed_apps,
        "resources": observed_rows,
    }


def verify(root, fork, *, state, restore_report, **options):
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
        "clusterChanged": False,
        "storageDataReverified": False,
        "sourceQuiescenceVerified": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--restore-report", type=Path, required=True)
    parser.add_argument("--langfuse-url", required=True)
    parser.add_argument(
        "--ops-api-url", default="http://ops-service.govbiz-msa.svc.cluster.local:8000"
    )
    parser.add_argument("--helm", default="helm")
    parser.add_argument("--branch")
    args = parser.parse_args()
    try:
        root = Path(__file__).resolve().parents[3]
        fork = release.from_origin(root, branch=args.branch).require_personal_publish()
        result = verify(
            root,
            fork,
            state=args.state_dir,
            restore_report=args.restore_report,
            langfuse_url=args.langfuse_url,
            ops_api_url=args.ops_api_url,
            helm=args.helm,
        )
    except Exception as error:  # noqa: BLE001 - live resource and endpoint text stays private
        print(
            json.dumps(
                {
                    "schema": "evaluation-dormant-status-v1",
                    "status": "BLOCKED",
                    "errorType": type(error).__name__,
                    "clusterChanged": False,
                    "syncCompleted": None,
                    "runtimeVerified": False,
                    "activationAuthorized": False,
                }
            )
        )
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
