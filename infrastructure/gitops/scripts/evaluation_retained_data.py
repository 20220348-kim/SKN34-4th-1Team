"""Inspect retained PVC bytes with one disposable, non-root, read-only Pod."""

import re
from uuid import uuid4

import evaluation_pvc_restore as pvc


def recheck(kube, node, report, stores, image, progress):
    """Caller verifies dormant workloads and frozen source before and after this probe."""
    if not re.fullmatch(r"[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}", image):
        raise ValueError(
            "Retained data recheck needs a verified immutable helper image"
        )
    if set(stores) != {"prefect", "results"}:
        raise ValueError("Both authenticated stores are required")
    for entries in stores.values():
        pvc.snapshot.files.validate(entries)
    storage = pvc.inspect_retained_storage(kube, node, report)
    namespace = pvc.MIGRATION_NAMESPACE
    nk = kube + ["-n", namespace]
    if pvc.run(nk + ["get", "pods", "-o", "json"])["items"]:
        raise ValueError("Retained data inspection requires an inactive namespace")
    token = uuid4().hex
    name = "data-recheck-" + token[:12]
    resource = pvc.pod(namespace, token, name, node, image, reader=True)
    resource["spec"]["activeDeadlineSeconds"] = 300
    resource["spec"]["containers"][0]["command"][-1] = "import time; time.sleep(300)"
    for mount in resource["spec"]["containers"][0]["volumeMounts"]:
        if mount["name"] != "tmp":
            mount["readOnly"] = True
    for volume in resource["spec"]["volumes"]:
        if "persistentVolumeClaim" in volume:
            volume["persistentVolumeClaim"]["readOnly"] = True
        else:
            volume["emptyDir"]["sizeLimit"] = "256Mi"
    progress.update(
        name=name, creationAttempted=False, created=False, cleanupComplete=False
    )
    uid = None
    result = None
    try:
        progress["creationAttempted"] = True
        created = pvc.run(nk + ["create", "-f", "-", "-o", "json"], value=resource)
        progress["created"] = True
        uid = pvc.require_owner(created, name, token)
        pvc.snapshot.storage.run(
            [
                str(p)
                for p in nk
                + ["wait", "--for=condition=Ready", "pod/" + name, "--timeout=90s"]
            ],
            timeout=105,
        )
        current = pvc.run(nk + ["get", "pod", name, "-o", "json"])
        pvc.require_owner(current, name, token, uid)
        spec = current["spec"]
        # Reject security-relevant admission changes before sending private bytes.
        container = spec["containers"][0]
        if (
            current["metadata"].get("deletionTimestamp")
            or current["metadata"].get("labels") != resource["metadata"]["labels"]
            or spec.get("automountServiceAccountToken") is not False
            or spec.get("hostNetwork")
            or spec.get("hostPID")
            or spec.get("hostIPC")
            or spec.get("initContainers")
            or spec.get("ephemeralContainers")
            or len(spec["containers"]) != 1
            or spec.get("securityContext") != resource["spec"]["securityContext"]
            or spec.get("nodeSelector") != resource["spec"]["nodeSelector"]
            or spec.get("volumes") != resource["spec"]["volumes"]
            or container.get("env")
            or container.get("envFrom")
            or container.get("image") != image
            or container.get("name") != "probe"
            or container.get("command") != resource["spec"]["containers"][0]["command"]
            or container.get("args")
            or spec.get("nodeName") != node
            or container.get("securityContext")
            != resource["spec"]["containers"][0]["securityContext"]
            or container.get("volumeMounts")
            != resource["spec"]["containers"][0]["volumeMounts"]
            or pvc.inspect_retained_storage(kube, node, report) != storage
        ):
            raise ValueError("Retained probe mounts, security or storage changed")
        result = pvc.run(
            nk
            + [
                "exec",
                "-i",
                name,
                "-c",
                "probe",
                "--",
                "python",
                "-B",
                "-c",
                pvc.BOOTSTRAP,
            ],
            value={
                "program": pvc.helper_program(),
                "action": "recheck",
                "stores": stores,
            },
            timeout=120,
        )
        expected = {
            "status": "VERIFIED",
            "archive_content_matched": True,
            "sqlite_integrity": True,
            "prefect_logical_data_matched": True,
            "runtime_permissions_verified": True,
            "retained_data_unchanged": True,
            "runtime_uid": 10001,
            "runtime_gid": 10001,
            "model_api_calls": 0,
        }
        if result != expected or any(
            type(result[key]) is not type(value) for key, value in expected.items()
        ):
            raise ValueError("Retained data proof is incomplete")
    finally:
        if progress["creationAttempted"]:
            # Recover response loss by our random name/label. Delete only this Pod,
            # with an API UID precondition; never delete namespace, PVC or PV.
            if pvc.inspect_retained_storage(kube, node, report) != storage:
                raise ValueError("Retained storage changed before probe cleanup")
            current = pvc.run(
                nk + ["get", "pod", name, "--ignore-not-found", "-o", "json"]
            )
            if current:
                uid = pvc.require_owner(current, name, token, uid)
                pvc.run(
                    kube
                    + [
                        "delete",
                        "--raw",
                        f"/api/v1/namespaces/{namespace}/pods/{name}",
                        "-f",
                        "-",
                    ],
                    value={
                        "apiVersion": "v1",
                        "kind": "DeleteOptions",
                        "preconditions": {"uid": uid},
                    },
                )
                pvc.snapshot.storage.run(
                    [
                        str(p)
                        for p in nk
                        + ["wait", "--for=delete", "pod/" + name, "--timeout=45s"]
                    ],
                    timeout=50,
                )
            if pvc.run(nk + ["get", "pods", "-o", "json"])["items"]:
                raise ValueError(
                    "Retained probe cleanup or workload absence is unconfirmed"
                )
            progress["cleanupComplete"] = True
    if pvc.inspect_retained_storage(kube, node, report) != storage:
        raise ValueError("Retained storage changed after inspection")
    return {**result, "cleanup_complete": True}
