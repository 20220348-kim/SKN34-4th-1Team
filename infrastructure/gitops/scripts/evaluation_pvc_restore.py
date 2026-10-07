"""Rehearse an encrypted evaluation backup on NEW disposable kind PVCs.

Never stops writers, restores an existing PVC, starts an API/runner, or changes
Ops routing. The generated namespace and PVCs are removed after the rehearsal.
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path
from uuid import uuid4

import evaluation_pvc_probe
import fork_cluster
import ops_state_snapshot as snapshot
import yaml

LABEL = "ai.govbiz.evaluation-restore"
PREFECT_VALUES = (
    Path(__file__).resolve().parents[1] / "environments/evaluation/prefect.yaml"
)
BOOTSTRAP = "import json,sys; v=json.load(sys.stdin); n={'__name__':'pvc_probe'}; exec(v.pop('program'),n); n['main'](v)"


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
        raise ValueError("Disposable resource ownership changed")
    return metadata["uid"]


def rehearse(kube, node, stores, expected, *, image=None):
    """Internal entry also used with synthetic fixtures by the required CI job."""
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
    namespace = "govbiz-evaluation-restore-" + token[:12]
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
                "metadata": {"name": namespace, "labels": {LABEL: token}},
                "provisioner": "rancher.io/local-path",
                "volumeBindingMode": "WaitForFirstConsumer",
                "reclaimPolicy": "Delete",
            },
        )
        class_uid = require_owner(created_class, namespace, token)
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
                        "storageClassName": namespace,
                        "resources": {"requests": {"storage": "1Gi"}},
                    },
                },
            )
            claims[kind] = claim["metadata"]["uid"]
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
        for kind, claim_uid in claims.items():
            claim = run(nk + ["get", "pvc", kind, "-o", "json"])
            if (
                claim["metadata"]["uid"] != claim_uid
                or claim.get("status", {}).get("phase") != "Bound"
            ):
                raise ValueError("New PVC did not bind with its original identity")
            pv = run(kube + ["get", "pv", claim["spec"]["volumeName"], "-o", "json"])
            ref = pv.get("spec", {}).get("claimRef", {})
            if (
                ref.get("uid") != claim_uid
                or ref.get("namespace") != namespace
                or ref.get("name") != kind
                or pv["spec"].get("persistentVolumeReclaimPolicy") != "Delete"
                or pv["spec"].get("storageClassName") != namespace
                or pv["metadata"]
                .get("annotations", {})
                .get("pv.kubernetes.io/provisioned-by")
                != "rancher.io/local-path"
            ):
                raise ValueError("PVC must have a newly provisioned disposable PV")
            pv_names.append(pv["metadata"]["name"])
        if len(set(pv_names)) != 2:
            raise ValueError("Restored stores cannot share one PV")
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
    finally:
        if uid is not None:
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
                    kube + ["get", "storageclass", namespace, "-o", "json"]
                )
                require_owner(current_class, namespace, token, class_uid)
                snapshot.storage.run(
                    [
                        str(p)
                        for p in kube
                        + [
                            "delete",
                            "storageclass",
                            namespace,
                            "--wait=true",
                            "--timeout=30s",
                        ]
                    ],
                    timeout=45,
                )
    return {
        **result,
        "scope": "disposable_kubernetes_evaluation_pvc",
        "cleanup_complete": True,
        "application_started": False,
        "services_changed": False,
        "production_storage_restored": False,
        "network_policy_enforcement_verified": False,
    }


def verify_archive(state, archive, key_file):
    settings = fork_cluster.load_settings(state)
    kube, _, _ = fork_cluster.commands(state, settings)
    fork_cluster.verify_context(kube, settings, timeout=15)
    raw = snapshot.database.read_archive(archive)
    payload = snapshot.validate(
        snapshot.storage.open_payload(raw, snapshot.storage.key_bytes(key_file))
    )
    stores = {name: store["entries"] for name, store in payload["stores"].items()}
    # Caller-provided IDs cannot stand in for evidence from the restored Ops DB.
    with snapshot.database.restored_database(payload["database"]) as command:
        expected = snapshot.completed_evidence(command, stores["results"])
    result = rehearse(kube, settings["cluster"] + "-control-plane", stores, expected)
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
    args = parser.parse_args()
    if os.name != "posix":
        parser.error("Run inside WSL/Linux")
    try:
        print(
            json.dumps(
                verify_archive(args.state_dir, args.archive, args.key_file),
                sort_keys=True,
            )
        )
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError):
        parser.exit(
            1,
            "Evaluation PVC rehearsal failed; existing services were not changed. Inspect disposable resources if cleanup failed.\n",
        )


if __name__ == "__main__":
    main()
