"""Read the stopped Kubernetes evaluation runtime and its PVCs for Ops backups."""

import hashlib
import json
import re
from uuid import uuid4

import ops_db_snapshot as database

NAMESPACE = "govbiz-evaluation"
COMPONENTS = ("prefect", "evaluation-runner", "ops-artifacts")


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def observe(kube, settings):
    """Require stopped, manually managed writers and stable bound PVC identities."""
    if settings.get("mode") != "gitops":
        raise ValueError("Kubernetes evaluation backup requires the existing GitOps runtime")
    nk = [*kube, "-n", NAMESPACE, "--request-timeout=15s"]
    namespace = database.read_json(kube + ["get", "namespace", NAMESPACE, "-o", "json"])
    if namespace["metadata"].get("deletionTimestamp"):
        raise ValueError("Evaluation namespace is being deleted")
    if database.read_json(nk + ["get", "pods", "-o", "json"])["items"]:
        raise ValueError("Stop evaluation Pods before backing up their PVCs")
    if database.read_json(nk + ["get", "statefulsets,daemonsets,jobs,cronjobs,hpa", "-o", "json"])[
        "items"
    ]:
        raise ValueError("Unexpected evaluation controllers may write during backup")
    rows = database.read_json(nk + ["get", "deployments", "-o", "json"])["items"]
    deployments = {row["metadata"]["name"]: row for row in rows}
    if len(rows) != 3 or set(deployments) != set(COMPONENTS):
        raise ValueError("Expected exactly the three evaluation Deployments")
    observed = {}
    for name, item in deployments.items():
        meta, spec, status = item["metadata"], item["spec"], item.get("status", {})
        if (
            not meta.get("uid")
            or meta.get("deletionTimestamp")
            or type(spec.get("replicas")) is not int
            or spec["replicas"] != 0
            or status.get("observedGeneration") != meta.get("generation")
            or any(
                status.get(key, 0) != 0
                for key in (
                    "replicas",
                    "readyReplicas",
                    "updatedReplicas",
                    "availableReplicas",
                )
            )
            or meta.get("annotations", {}).get("argocd.argoproj.io/tracking-id")
            != f"govbiz-evaluation-{name}:apps/Deployment:{NAMESPACE}/{name}"
        ):
            raise ValueError("Evaluation writers must be stopped with Argo ownership intact")
        app = database.read_json(
            kube
            + [
                "-n",
                "argocd",
                "get",
                "application",
                "govbiz-evaluation-" + name,
                "-o",
                "json",
            ]
        )
        declaration = app["spec"]
        source = declaration.get("source", {})
        if (
            app.get("operation")
            or app["metadata"].get("deletionTimestamp")
            or not app["metadata"].get("uid")
            or declaration.get("project") != NAMESPACE
            or declaration.get("destination")
            != {"server": "https://kubernetes.default.svc", "namespace": NAMESPACE}
            or declaration.get("syncPolicy", {}).get("automated")
            not in (None, {"enabled": False, "prune": False, "selfHeal": False})
            or "sources" in declaration
            or source.get("repoURL") != "https://github.com/" + settings["repository"] + ".git"
            or source.get("path") != "infrastructure/gitops/charts/govbiz-evaluation"
            or not re.fullmatch(r"[a-f0-9]{40}", source.get("targetRevision", ""))
            or app.get("status", {}).get("operationState", {}).get("phase") != "Succeeded"
        ):
            raise ValueError("Evaluation Argo must be pinned and manually managed")
        containers = spec["template"]["spec"]["containers"]
        if len(containers) != 1 or containers[0]["name"] != name:
            raise ValueError("Unexpected evaluation containers")
        if containers[0].get("envFrom"):
            raise ValueError("Unexpected indirect evaluation environment")
        rows = containers[0].get("env", [])
        if len({row["name"] for row in rows}) != len(rows):
            raise ValueError("Repeated evaluation environment")
        image = containers[0]["image"]
        if not re.fullmatch(r"[^\s@]+@sha256:[a-f0-9]{64}", image):
            raise ValueError("Evaluation backup requires immutable runtime images")
        values = source["helm"]["valuesObject"]
        if image != values["image"]:
            raise ValueError("Evaluation image differs from its Argo declaration")
        observed[name] = {
            "uid": meta["uid"],
            "spec_sha256": fingerprint(spec),
            "image": image,
            "application_uid": app["metadata"]["uid"],
            "application_spec_sha256": fingerprint(declaration),
        }
    stores = {}
    for kind, writer, destination in (
        ("prefect", "prefect", "/data"),
        ("results", "evaluation-runner", "/results"),
    ):
        spec = deployments[writer]["spec"]["template"]["spec"]
        volumes = [
            v
            for v in spec.get("volumes", [])
            if v.get("persistentVolumeClaim", {}).get("claimName") == kind
        ]
        if len(volumes) != 1 or not any(
            mount.get("name") == volumes[0]["name"]
            and mount.get("mountPath") == destination
            and not mount.get("subPath")
            and not mount.get("subPathExpr")
            for mount in spec["containers"][0].get("volumeMounts", [])
        ):
            raise ValueError("Evaluation writer does not use the expected whole PVC")
        if kind == "prefect":
            env = {row["name"]: row.get("value") for row in spec["containers"][0].get("env", [])}
            if (
                env.get("PREFECT_HOME") != "/tmp/prefect"
                or env.get("PREFECT_SERVER_DATABASE_CONNECTION_URL")
                != "sqlite+aiosqlite:////data/prefect.db"
                or env.get("PREFECT_PROFILES_PATH")
                or any(
                    value != "sqlite+aiosqlite:////data/prefect.db"
                    for key, value in env.items()
                    if "DATABASE_CONNECTION_URL" in key
                )
            ):
                raise ValueError("Only the standard Prefect SQLite PVC is supported")
        claim = database.read_json(nk + ["get", "pvc", kind, "-o", "json"])
        pv = database.read_json(kube + ["get", "pv", claim["spec"]["volumeName"], "-o", "json"])
        ref = pv["spec"].get("claimRef", {})
        if (
            claim["metadata"].get("deletionTimestamp")
            or claim["status"].get("phase") != "Bound"
            or pv["metadata"].get("deletionTimestamp")
            or pv["spec"].get("persistentVolumeReclaimPolicy") != "Retain"
            or ref.get("namespace") != NAMESPACE
            or ref.get("name") != kind
            or not claim["metadata"].get("uid")
            or ref.get("uid") != claim["metadata"]["uid"]
        ):
            raise ValueError("Evaluation PVC is not bound to its retained PV")
        stores[kind] = {
            "claim": kind,
            "claim_uid": claim["metadata"]["uid"],
            "volume": pv["metadata"]["name"],
            "volume_uid": pv["metadata"]["uid"],
            "claim_spec_sha256": fingerprint(claim["spec"]),
            "volume_spec_sha256": fingerprint(pv["spec"]),
        }
    if len({store["volume"] for store in stores.values()}) != 2:
        raise ValueError("Evaluation stores must use separate volumes")
    return {
        "namespace": NAMESPACE,
        "namespace_uid": namespace["metadata"]["uid"],
        "deployments": observed,
        "stores": stores,
    }


def collect(kube, source, kind, program):
    """Read one source PVC through a short-lived, read-only, non-root Pod."""
    if kind not in {"prefect", "results"} or source["namespace"] != NAMESPACE:
        raise ValueError("Unexpected evaluation store")
    token = uuid4().hex
    name = "govbiz-backup-" + token
    nk = [*kube, "-n", NAMESPACE]
    image = source["deployments"]["prefect"]["image"]
    claim = database.read_json(nk + ["get", "pvc", kind, "-o", "json"])
    if (
        claim["metadata"]["uid"] != source["stores"][kind]["claim_uid"]
        or fingerprint(claim["spec"]) != source["stores"][kind]["claim_spec_sha256"]
        or claim["metadata"].get("deletionTimestamp")
    ):
        raise ValueError("Evaluation source PVC changed before collection")
    manifest = {
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {
            "name": name,
            "namespace": NAMESPACE,
            "labels": {"ai.govbiz/backup": token},
        },
        "spec": {
            "restartPolicy": "Never",
            "activeDeadlineSeconds": 180,
            "automountServiceAccountToken": False,
            "securityContext": {
                "runAsNonRoot": True,
                "runAsUser": 10001,
                "runAsGroup": 10001,
                "seccompProfile": {"type": "RuntimeDefault"},
            },
            "containers": [
                {
                    "name": "reader",
                    "image": image,
                    "imagePullPolicy": "IfNotPresent",
                    "command": ["python", "-c", "import time; time.sleep(170)"],
                    "securityContext": {
                        "readOnlyRootFilesystem": True,
                        "allowPrivilegeEscalation": False,
                        "capabilities": {"drop": ["ALL"]},
                    },
                    "resources": {
                        "requests": {"cpu": "50m", "memory": "64Mi"},
                        "limits": {"cpu": "500m", "memory": "256Mi"},
                    },
                    "volumeMounts": [{"name": "source", "mountPath": "/source", "readOnly": True}],
                }
            ],
            "volumes": [
                {
                    "name": "source",
                    "persistentVolumeClaim": {
                        "claimName": source["stores"][kind]["claim"],
                        "readOnly": True,
                    },
                }
            ],
        },
    }
    policy = {
        "apiVersion": "networking.k8s.io/v1",
        "kind": "NetworkPolicy",
        "metadata": {"name": name, "namespace": NAMESPACE},
        "spec": {
            "podSelector": {"matchLabels": {"ai.govbiz/backup": token}},
            "policyTypes": ["Ingress", "Egress"],
            "ingress": [],
            "egress": [],
        },
    }
    uid, policy_uid = None, None
    try:
        created = json.loads(
            database.storage.run(
                nk + ["create", "-f", "-", "-o", "json"],
                data=json.dumps(policy).encode(),
            )
        )
        policy_uid = created["metadata"]["uid"]
        created = json.loads(
            database.storage.run(
                nk + ["create", "-f", "-", "-o", "json"],
                data=json.dumps(manifest).encode(),
            )
        )
        uid = created["metadata"]["uid"]
        database.storage.run(
            nk + ["wait", "--for=condition=Ready", "pod/" + name, "--timeout=60s"],
            timeout=75,
        )
        result = json.loads(
            database.storage.run(
                nk
                + [
                    "exec",
                    "-i",
                    name,
                    "--",
                    "python",
                    "-B",
                    "-c",
                    program,
                    "collect",
                    kind,
                ],
                timeout=90,
            )
        )
        from ops_volume_snapshot_files import validate

        validate(result)
        return result
    finally:
        if uid is not None:
            database.storage.run(
                kube
                + [
                    "delete",
                    "--raw",
                    f"/api/v1/namespaces/{NAMESPACE}/pods/{name}",
                    "-f",
                    "-",
                ],
                data=json.dumps(
                    {
                        "apiVersion": "v1",
                        "kind": "DeleteOptions",
                        "preconditions": {"uid": uid},
                        "gracePeriodSeconds": 0,
                    }
                ).encode(),
            )
            database.storage.run(
                nk + ["wait", "--for=delete", "pod/" + name, "--timeout=30s"],
                timeout=45,
            )

        if policy_uid is not None:
            database.storage.run(
                kube
                + [
                    "delete",
                    "--raw",
                    f"/apis/networking.k8s.io/v1/namespaces/{NAMESPACE}/networkpolicies/{name}",
                    "-f",
                    "-",
                ],
                data=json.dumps(
                    {
                        "apiVersion": "v1",
                        "kind": "DeleteOptions",
                        "preconditions": {"uid": policy_uid},
                    }
                ).encode(),
            )
