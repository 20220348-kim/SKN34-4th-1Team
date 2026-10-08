"""Restore an encrypted evaluation backup on NEW dedicated kind PVCs.

The CLI never stops writers, restores an existing PVC, starts an API/runner, or
changes Ops routing. The internal context also supports the disposable runtime
CI. By default all copies are removed. --retain-for-migration keeps verified
storage in a new govbiz-evaluation namespace without activating any service.
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

import evaluation_pvc_probe
import fork_cluster
import ops_state_snapshot as snapshot
import yaml

LABEL = "ai.govbiz.evaluation-restore"
MIGRATION_NAMESPACE = "govbiz-evaluation"
PREFECT_VALUES = (
    Path(__file__).resolve().parents[1] / "environments/evaluation/prefect.yaml"
)
BOOTSTRAP = (
    "import json,sys; v=json.load(sys.stdin); n={'__name__':'pvc_probe'}; "
    "exec(v.pop('program'),n); n['main'](v)"
)


def helper_program():
    program = "import sys, types\n"
    for module in (snapshot.probe, snapshot.files):
        program += (
            f"m=types.ModuleType({module.__name__!r})\n"
            "sys.modules[m.__name__]=m\n"
            f"exec({Path(module.__file__).read_text(encoding='utf-8')!r},m.__dict__)\n"
        )
    return program + Path(evaluation_pvc_probe.__file__).read_text(encoding="utf-8")


def run(command, *, value=None, timeout=60):
    """Only stdin carries backup content; suppress private kubectl diagnostics."""
    raw = snapshot.storage.run(
        [str(part) for part in command],
        data=None if value is None else json.dumps(value).encode(),
        timeout=timeout,
    )
    return json.loads(raw) if raw.strip() else None


def pod(namespace, token, name, node, image, *, reader=False):
    return {
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {"name": name, "namespace": namespace, "labels": {LABEL: token}},
        "spec": {
            "restartPolicy": "Never",
            "activeDeadlineSeconds": 900,
            "terminationGracePeriodSeconds": 5,
            "automountServiceAccountToken": False,
            "nodeSelector": {"kubernetes.io/hostname": node},
            "securityContext": {
                "runAsUser": 10001 if reader else 0,
                "runAsGroup": 10001 if reader else 0,
                "runAsNonRoot": reader,
                "seccompProfile": {"type": "RuntimeDefault"},
            },
            "containers": [
                {
                    "name": "probe",
                    "image": image,
                    "imagePullPolicy": "IfNotPresent",
                    "command": ["python", "-B", "-c", "import time; time.sleep(900)"],
                    "workingDir": "/tmp",
                    "resources": {
                        "requests": {"cpu": "50m", "memory": "128Mi"},
                        "limits": {"cpu": "1", "memory": "1Gi"},
                    },
                    "securityContext": {
                        "readOnlyRootFilesystem": True,
                        "allowPrivilegeEscalation": False,
                        "capabilities": {
                            "drop": ["ALL"],
                            **(
                                {}
                                if reader
                                else {"add": ["CHOWN", "DAC_OVERRIDE", "FOWNER"]}
                            ),
                        },
                    },
                    "volumeMounts": [
                        {"name": kind, "mountPath": "/restore/" + kind}
                        for kind in ("prefect", "results")
                    ]
                    + [{"name": "tmp", "mountPath": "/tmp"}],
                }
            ],
            "volumes": [
                {"name": kind, "persistentVolumeClaim": {"claimName": kind}}
                for kind in ("prefect", "results")
            ]
            + [{"name": "tmp", "emptyDir": {"medium": "Memory", "sizeLimit": "32Mi"}}],
        },
    }


def require_owner(resource, namespace, token, uid=None):
    metadata = resource.get("metadata", {})
    if (
        metadata.get("name") != namespace
        or metadata.get("labels", {}).get(LABEL) != token
        or not metadata.get("uid")
        or (uid is not None and metadata["uid"] != uid)
    ):
        raise ValueError("Restore resource ownership changed")
    return metadata["uid"]


def bound_volumes(kube, nk, namespace, storage_name, token, claims, policy):
    """Verify newly provisioned PV identities before writing and before retention."""
    volumes = {}
    for kind, claim_uid in claims.items():
        claim = run(nk + ["get", "pvc", kind, "-o", "json"])
        require_owner(claim, kind, token, claim_uid)
        if (
            claim["metadata"].get("namespace") != namespace
            or claim.get("status", {}).get("phase") != "Bound"
            or claim["spec"].get("storageClassName") != storage_name
        ):
            raise ValueError("New PVC did not bind with its original identity")
        name = claim["spec"]["volumeName"]
        pv = run(kube + ["get", "pv", name, "-o", "json"])
        ref = pv.get("spec", {}).get("claimRef", {})
        if (
            pv["metadata"].get("name") != name
            or not pv["metadata"].get("uid")
            or ref.get("uid") != claim_uid
            or ref.get("namespace") != namespace
            or ref.get("name") != kind
            or pv["spec"].get("persistentVolumeReclaimPolicy") != policy
            or pv["spec"].get("storageClassName") != storage_name
            or pv["metadata"]
            .get("annotations", {})
            .get("pv.kubernetes.io/provisioned-by")
            != "rancher.io/local-path"
        ):
            raise ValueError(
                "PVC must have a new PV with the selected retention policy"
            )
        volumes[kind] = {
            "claim_uid": claim_uid,
            "pv": name,
            "pv_uid": pv["metadata"]["uid"],
        }
    if len({row["pv"] for row in volumes.values()}) != 2:
        raise ValueError("Restored stores cannot share one PV")
    return volumes


def remove_retained_helpers(kube, nk, namespace, token, uid):
    """Stop only this restore's helpers; never remove retained storage on failure."""
    require_owner(
        run(kube + ["get", "namespace", namespace, "-o", "json"]), namespace, token, uid
    )
    pods = run(nk + ["get", "pods", "-o", "json"])["items"]
    for item in pods:
        name = item.get("metadata", {}).get("name")
        if (
            name not in {"restore", "verify"}
            or item["metadata"].get("namespace") != namespace
        ):
            raise ValueError("Unexpected workload in retained restore namespace")
        require_owner(item, name, token)
    for item in pods:
        name = item["metadata"]["name"]
        current = run(nk + ["get", "pod", name, "-o", "json"])
        require_owner(current, name, token, item["metadata"]["uid"])
        snapshot.storage.run(
            [
                str(p)
                for p in nk + ["delete", "pod", name, "--wait=true", "--timeout=60s"]
            ],
            timeout=75,
        )


@contextmanager
def restored_pvcs(kube, node, stores, expected, *, image=None, retain=False):
    """Yield verified claims. Retained copies survive success AND failure.

    The CLI only reads these claims. The disposable runtime CI also starts the
    evaluation chart inside the default disposable lifetime. Retention stages
    storage only; it never certifies source quiescence or authorizes activation.
    """
    if type(retain) is not bool:
        raise ValueError("Select an explicit boolean retention mode")
    snapshot.probe.expected_runs(expected)
    if set(stores) != {"prefect", "results"}:
        raise ValueError("Both restored stores are required")
    for entries in stores.values():
        snapshot.files.validate(entries)
    image = image or yaml.safe_load(PREFECT_VALUES.read_text(encoding="utf-8"))["image"]
    if not re.fullmatch(r"[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}", image):
        raise ValueError("Use an immutable Python helper image")
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{0,251}[a-z0-9]", node):
        raise ValueError("An explicit kind node is required")
    if retain and run(
        kube
        + ["get", "namespace", MIGRATION_NAMESPACE, "--ignore-not-found", "-o", "json"]
    ):
        raise ValueError("Retained namespace already exists")
    # This first implementation targets the repository's single-node kind setup.
    # No static/existing PV can be adopted and no production CSI is assumed.
    storage_class = run(kube + ["get", "storageclass", "standard", "-o", "json"])
    if (
        storage_class.get("provisioner") != "rancher.io/local-path"
        or storage_class.get("volumeBindingMode") != "WaitForFirstConsumer"
        or storage_class.get("reclaimPolicy") != "Delete"
    ):
        raise ValueError("Rehearsal requires kind's disposable standard StorageClass")
    token = uuid4().hex
    storage_name = "govbiz-evaluation-restore-" + token[:12]
    namespace = MIGRATION_NAMESPACE if retain else storage_name
    policy = "Retain" if retain else "Delete"
    nk = kube + ["--namespace", namespace]
    uid = None
    class_uid = None
    pv_names = []
    result = None
    try:
        created = run(
            kube + ["create", "-f", "-", "-o", "json"],
            value={
                "apiVersion": "v1",
                "kind": "Namespace",
                "metadata": {"name": namespace, "labels": {LABEL: token}},
            },
        )
        uid = require_owner(created, namespace, token)
        # A new PVC can bind an old Available PV in a shared StorageClass.
        # A unique class ensures this rehearsal cannot adopt/delete such a PV.
        created_class = run(
            kube + ["create", "-f", "-", "-o", "json"],
            value={
                "apiVersion": "storage.k8s.io/v1",
                "kind": "StorageClass",
                "metadata": {"name": storage_name, "labels": {LABEL: token}},
                "provisioner": "rancher.io/local-path",
                "volumeBindingMode": "WaitForFirstConsumer",
                "reclaimPolicy": policy,
            },
        )
        class_uid = require_owner(created_class, storage_name, token)
        # No credentials or API service are mounted. Policy is defense in depth;
        # kind's default CNI does not prove enforcement of NetworkPolicy.
        run(
            nk + ["create", "-f", "-", "-o", "json"],
            value={
                "apiVersion": "networking.k8s.io/v1",
                "kind": "NetworkPolicy",
                "metadata": {"name": "deny-all", "namespace": namespace},
                "spec": {"podSelector": {}, "policyTypes": ["Ingress", "Egress"]},
            },
        )
        claims = {}
        for kind in stores:
            claim = run(
                nk + ["create", "-f", "-", "-o", "json"],
                value={
                    "apiVersion": "v1",
                    "kind": "PersistentVolumeClaim",
                    "metadata": {
                        "name": kind,
                        "namespace": namespace,
                        "labels": {LABEL: token},
                    },
                    "spec": {
                        "accessModes": ["ReadWriteOnce"],
                        "volumeMode": "Filesystem",
                        "storageClassName": storage_name,
                        "resources": {"requests": {"storage": "1Gi"}},
                    },
                },
            )
            claims[kind] = require_owner(claim, kind, token)
        run(
            nk + ["create", "-f", "-", "-o", "json"],
            value=pod(namespace, token, "restore", node, image),
        )
        snapshot.storage.run(
            [
                str(p)
                for p in nk
                + ["wait", "--for=condition=Ready", "pod/restore", "--timeout=180s"]
            ],
            timeout=195,
        )
        volumes = bound_volumes(
            kube, nk, namespace, storage_name, token, claims, policy
        )
        pv_names = [row["pv"] for row in volumes.values()]
        proof = run(
            nk
            + [
                "exec",
                "-i",
                "restore",
                "-c",
                "probe",
                "--",
                "python",
                "-B",
                "-c",
                BOOTSTRAP,
            ],
            value={
                "program": helper_program(),
                "action": "restore",
                "stores": stores,
                "expected": expected,
            },
            timeout=180,
        )
        if not isinstance(proof, dict) or set(proof) != set(stores):
            raise ValueError("Missing restored PVC evidence")
        for kind, entries in stores.items():
            archive = proof[kind].get("archive", {})
            if (
                archive.get("status") != "VERIFIED"
                or archive.get("permissions_verified") is not True
                or archive.get("tree_sha256")
                != hashlib.sha256(
                    json.dumps(entries, sort_keys=True).encode()
                ).hexdigest()
                or archive.get("matched_executions") != len(expected)
                or (kind == "prefect" and archive.get("sqlite_integrity") is not True)
            ):
                raise ValueError(
                    "Restored archive evidence differs from source inventory"
                )
        snapshot.storage.run(
            [
                str(p)
                for p in nk
                + ["delete", "pod", "restore", "--wait=true", "--timeout=60s"]
            ],
            timeout=75,
        )
        run(
            nk + ["create", "-f", "-", "-o", "json"],
            value=pod(namespace, token, "verify", node, image, reader=True),
        )
        snapshot.storage.run(
            [
                str(p)
                for p in nk
                + ["wait", "--for=condition=Ready", "pod/verify", "--timeout=90s"]
            ],
            timeout=105,
        )
        result = run(
            nk
            + [
                "exec",
                "-i",
                "verify",
                "-c",
                "probe",
                "--",
                "python",
                "-B",
                "-c",
                BOOTSTRAP,
            ],
            value={
                "program": helper_program(),
                "action": "verify",
                "proof": proof,
                "expected": expected,
            },
            timeout=120,
        )
        if (
            not isinstance(result, dict)
            or result.get("status") != "VERIFIED"
            or type(result.get("matched_completed_evaluations")) is not int
            or result["matched_completed_evaluations"] != len(expected)
            or result.get("runtime_uid") != 10001
            or result.get("runtime_gid") != 10001
            or result.get("model_api_calls") != 0
            or any(
                result.get(key) is not True
                for key in (
                    "pod_replacement_preserved_data",
                    "runtime_writable",
                    "sqlite_integrity",
                )
            )
        ):
            raise ValueError("Incomplete runtime PVC verification")
        snapshot.storage.run(
            [
                str(p)
                for p in nk
                + ["delete", "pod", "verify", "--wait=true", "--timeout=60s"]
            ],
            timeout=75,
        )
        if retain:
            require_owner(
                run(kube + ["get", "storageclass", storage_name, "-o", "json"]),
                storage_name,
                token,
                class_uid,
            )
            if (
                bound_volumes(kube, nk, namespace, storage_name, token, claims, policy)
                != volumes
            ):
                raise ValueError("Restored volume identity changed before retention")
            result = {
                **result,
                "namespace": namespace,
                "namespace_uid": uid,
                "storage_class": storage_name,
                "storage_class_uid": class_uid,
                "reclaim_policy": policy,
                "node": node,
                "helper_image": image,
                "claims": volumes,
            }
        yield namespace, result
    finally:
        if retain and uid is not None:
            remove_retained_helpers(kube, nk, namespace, token, uid)
        elif uid is not None:
            current = run(kube + ["get", "namespace", namespace, "-o", "json"])
            require_owner(current, namespace, token, uid)
            snapshot.storage.run(
                [
                    str(p)
                    for p in kube
                    + [
                        "delete",
                        "namespace",
                        namespace,
                        "--wait=true",
                        "--timeout=120s",
                    ]
                ],
                timeout=135,
            )
            for name in pv_names:
                snapshot.storage.run(
                    [
                        str(p)
                        for p in kube
                        + ["wait", "--for=delete", "pv/" + name, "--timeout=90s"]
                    ],
                    timeout=105,
                )
            if class_uid is not None:
                current_class = run(
                    kube + ["get", "storageclass", storage_name, "-o", "json"]
                )
                require_owner(current_class, storage_name, token, class_uid)
                snapshot.storage.run(
                    [
                        str(p)
                        for p in kube
                        + [
                            "delete",
                            "storageclass",
                            storage_name,
                            "--wait=true",
                            "--timeout=30s",
                        ]
                    ],
                    timeout=45,
                )


def rehearse(kube, node, stores, expected, *, image=None):
    """Restore/read only; no application or retained PVC is exposed by the CLI."""
    with restored_pvcs(kube, node, stores, expected, image=image) as (_, result):
        evidence = dict(result)
    return {
        **evidence,
        "scope": "disposable_kubernetes_evaluation_pvc",
        "cleanup_complete": True,
        "application_started": False,
        "services_changed": False,
        "production_storage_restored": False,
        "network_policy_enforcement_verified": False,
    }


def retain_for_migration(kube, node, stores, expected, *, image=None):
    """Keep new verified copies, but do not connect services or claim cutover readiness."""
    with restored_pvcs(kube, node, stores, expected, image=image, retain=True) as (
        _,
        result,
    ):
        evidence = dict(result)
    return {
        **evidence,
        "status": "RESTORED_NOT_ACTIVATED",
        "scope": "retained_kubernetes_evaluation_pvc",
        "resources_retained": True,
        "helpers_removed": True,
        "application_started": False,
        "services_changed": False,
        "production_cutover": False,
        "archive_freshness_verified": False,
        "source_quiescence_verified": False,
        "network_policy_enforcement_verified": False,
    }


def inspect_retained(kube, node, report):
    """Read live storage identities before initial handoff; never certify its data."""
    if (
        report.get("status") != "RESTORED_NOT_ACTIVATED"
        or report.get("scope") != "retained_kubernetes_evaluation_pvc"
        or report.get("namespace") != MIGRATION_NAMESPACE
        or report.get("node") != node
        or report.get("reclaim_policy") != "Retain"
        or any(
            report.get(key) is not True
            for key in ("resources_retained", "helpers_removed")
        )
        or any(
            report.get(key) is not False
            for key in ("application_started", "services_changed", "production_cutover")
        )
        or set(report.get("claims", {})) != {"prefect", "results"}
        or any(not report.get(key) for key in ("namespace_uid", "storage_class_uid"))
    ):
        raise ValueError("A retained, inactive evaluation restore report is required")
    namespace = MIGRATION_NAMESPACE
    nk = kube + ["--namespace", namespace]
    resource = run(kube + ["get", "namespace", namespace, "-o", "json"])
    token = resource.get("metadata", {}).get("labels", {}).get(LABEL, "")
    if not re.fullmatch(r"[a-f0-9]{32}", token):
        raise ValueError("Retained namespace has no restore ownership")
    require_owner(resource, namespace, token, report["namespace_uid"])
    if (
        resource["metadata"].get("deletionTimestamp")
        or resource.get("status", {}).get("phase") != "Active"
    ):
        raise ValueError("Retained namespace is not active")
    storage_name = "govbiz-evaluation-restore-" + token[:12]
    if report.get("storage_class") != storage_name:
        raise ValueError("Retained StorageClass differs from restore ownership")
    resource = run(kube + ["get", "storageclass", storage_name, "-o", "json"])
    require_owner(resource, storage_name, token, report["storage_class_uid"])
    if (
        resource["metadata"].get("deletionTimestamp")
        or resource.get("provisioner") != "rancher.io/local-path"
        or resource.get("volumeBindingMode") != "WaitForFirstConsumer"
        or resource.get("reclaimPolicy") != "Retain"
    ):
        raise ValueError("Retained StorageClass policy changed")
    claims = {name: row["claim_uid"] for name, row in report["claims"].items()}
    if (
        not all(claims.values())
        or bound_volumes(kube, nk, namespace, storage_name, token, claims, "Retain")
        != report["claims"]
    ):
        raise ValueError("Retained volume identity changed")
    for kind, row in report["claims"].items():
        claim = run(nk + ["get", "pvc", kind, "-o", "json"])
        volume = run(kube + ["get", "pv", row["pv"], "-o", "json"])
        if (
            claim["metadata"].get("deletionTimestamp")
            or volume["metadata"].get("deletionTimestamp")
            or volume.get("status", {}).get("phase") != "Bound"
            or claim["metadata"].get("uid") != row["claim_uid"]
            or volume["metadata"].get("uid") != row["pv_uid"]
        ):
            raise ValueError("Retained volume is being replaced or deleted")
        terms = (
            volume["spec"]
            .get("nodeAffinity", {})
            .get("required", {})
            .get("nodeSelectorTerms", [])
        )
        # Only the repository's single-node local-path provisioner is supported.
        # Do not interpret arbitrary OR/NOT affinity expressions as equivalent.
        if terms != [
            {
                "matchExpressions": [
                    {
                        "key": "kubernetes.io/hostname",
                        "operator": "In",
                        "values": [node],
                    }
                ]
            }
        ]:
            raise ValueError("Retained volume does not belong to the selected node")
    resource = run(kube + ["get", "node", node, "-o", "json"])
    if (
        resource["metadata"].get("name") != node
        or resource["metadata"].get("deletionTimestamp")
        or resource["metadata"].get("labels", {}).get("kubernetes.io/hostname") != node
        or not any(
            item.get("type") == "Ready" and item.get("status") == "True"
            for item in resource.get("status", {}).get("conditions", [])
        )
    ):
        raise ValueError("Retained storage node is not ready")
    # An initial handoff must not overlap helpers, writers or controllers which
    # could create them later. This is an observation, not a Kubernetes lock.
    workloads = run(
        nk
        + [
            "get",
            "pods,deployments,statefulsets,daemonsets,replicasets,replicationcontrollers,jobs,cronjobs",
            "-o",
            "json",
        ]
    )
    if workloads["items"]:
        raise ValueError("Retained namespace already contains workloads")
    return {
        "namespace": namespace,
        "namespace_uid": report["namespace_uid"],
        "storage_class": storage_name,
        "storage_class_uid": report["storage_class_uid"],
        "node": node,
        "claims": report["claims"],
        "reclaim_policy": "Retain",
        "identity_verified": True,
        "workloads_absent": True,
        "data_reverified": False,
        "archive_freshness_verified": False,
        "source_quiescence_verified": False,
    }


def verify_archive(state, archive, key_file, *, retain=False):
    settings = fork_cluster.load_settings(state)
    kube, _, _ = fork_cluster.commands(state, settings)
    fork_cluster.verify_context(kube, settings, timeout=15)
    raw = snapshot.database.read_archive(archive)
    payload = snapshot.validate(
        snapshot.storage.open_payload(raw, snapshot.storage.key_bytes(key_file))
    )
    # A disposable rehearsal may use an older backup. A retained migration copy
    # must match the current stopped source before allocating any new storage.
    if retain:
        snapshot.verify_current_source(state, payload)
    stores = {name: store["entries"] for name, store in payload["stores"].items()}
    # Caller-provided IDs cannot stand in for evidence from the restored Ops DB.
    with snapshot.database.restored_database(payload["database"]) as command:
        expected = snapshot.completed_evidence(command, stores["results"])
    if retain:
        if fork_cluster.load_settings(state) != settings:
            raise ValueError("Destination settings changed before retained restore")
        fork_cluster.verify_context(kube, settings, timeout=15)
    restore = retain_for_migration if retain else rehearse
    result = restore(kube, settings["cluster"] + "-control-plane", stores, expected)
    if retain:
        # The retained context has removed its helpers. A failure here keeps the
        # new PVCs for inspection, but must never return a successful handoff.
        snapshot.verify_current_source(state, payload)
        if fork_cluster.load_settings(state) != settings:
            raise ValueError("Destination settings changed during retained restore")
        fork_cluster.verify_context(kube, settings, timeout=15)
        inspect_retained(kube, settings["cluster"] + "-control-plane", result)
        result.update(
            archive_freshness_verified=True,
            source_quiescence_verified=True,
            source_verification_scope="before_and_after_retained_restore",
        )
    return {
        **result,
        "archive_sha256": hashlib.sha256(raw).hexdigest(),
        "cross_store_business_links_verified": True,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, default=fork_cluster.STATE)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--key-file", type=Path, required=True)
    parser.add_argument(
        "--retain-for-migration",
        action="store_true",
        help="Keep new govbiz-evaluation PVCs with Retain policy; never activate services",
    )
    args = parser.parse_args()
    if os.name != "posix":
        parser.error("Run inside WSL/Linux")
    try:
        print(
            json.dumps(
                verify_archive(
                    args.state_dir,
                    args.archive,
                    args.key_file,
                    retain=args.retain_for_migration,
                ),
                sort_keys=True,
            )
        )
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError):
        parser.exit(
            1,
            (
                "Retained evaluation restore failed; do not activate services. "
                "Inspect govbiz-evaluation and its labeled StorageClass/PVs; "
                "storage was not automatically deleted and helper cleanup may be incomplete.\n"
                if args.retain_for_migration
                else "Evaluation PVC rehearsal failed; existing services were not changed. "
                "Inspect disposable resources if cleanup failed.\n"
            ),
        )


if __name__ == "__main__":
    main()
