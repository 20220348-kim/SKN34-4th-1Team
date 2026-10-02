"""Read deployment versions and readiness without Docker, secrets or mutations."""

import json
import shutil
import subprocess
from datetime import datetime, timezone

from check_msa import REPOSITORY_ROOT, SERVICES
from portfolio_cluster import run


def node_status(node):
    conditions = {
        item["type"]: item.get("status", "Unknown")
        for item in node.get("status", {}).get("conditions", [])
    }
    required = {
        "Ready": "True",
        "MemoryPressure": "False",
        "DiskPressure": "False",
        "PIDPressure": "False",
    }
    issues = [name for name, expected in required.items() if conditions.get(name) != expected]
    if conditions.get("NetworkUnavailable", "False") != "False":
        issues.append("NetworkUnavailable")
    if node.get("spec", {}).get("unschedulable"):
        issues.append("Unschedulable")
    return {
        "name": node["metadata"]["name"],
        "healthy": not issues,
        "conditions": {key: conditions.get(key) for key in (*required, "NetworkUnavailable")},
        "issues": issues,
    }


def local_filesystems(state):
    # WSL's virtual disk can have space while the Windows checkout drive is full.
    # These paths describe the diagnostic process, not the Docker data location.
    observations = []
    for name, path in (("checkout", REPOSITORY_ROOT), ("state", state)):
        item = {"name": name, "free_bytes": None, "minimum_free_bytes": 1024**3, "ok": False}
        try:
            item["free_bytes"] = shutil.disk_usage(path).free
            item["ok"] = item["free_bytes"] >= item["minimum_free_bytes"]
            item["issue"] = None if item["ok"] else "LOW_FREE_SPACE"
        except OSError:
            item["issue"] = "DISK_USAGE_UNAVAILABLE"
        observations.append(item)
    return observations


def service_status(service, deployment, pods, expected_image):
    if deployment is None:
        return {
            "name": service,
            "ready": False,
            "baseline_matches": None,
            "issues": ["DEPLOYMENT_MISSING"],
            "containers": [],
            "pods": [],
        }
    spec, status = deployment["spec"], deployment.get("status", {})
    selector = spec["selector"]["matchLabels"]
    selected = [
        pod
        for pod in pods
        if selector
        and all(
            pod["metadata"].get("labels", {}).get(key) == value for key, value in selector.items()
        )
    ]
    desired = spec.get("replicas", 1)
    containers = [
        {"name": c["name"], "image": c["image"]} for c in spec["template"]["spec"]["containers"]
    ]
    observations = []
    for pod in selected:
        states = {c["name"]: c for c in pod.get("status", {}).get("containerStatuses", [])}
        actual = [
            {
                "name": c["name"],
                "image": c["image"],
                "image_id": states.get(c["name"], {}).get("imageID"),
                "ready": states.get(c["name"], {}).get("ready", False),
                "restart_count": states.get(c["name"], {}).get("restartCount", 0),
            }
            for c in pod["spec"]["containers"]
        ]
        observations.append(
            {
                "name": pod["metadata"]["name"],
                "uid": pod["metadata"]["uid"],
                "node": pod["spec"].get("nodeName"),
                "phase": pod.get("status", {}).get("phase", "Unknown"),
                "terminating": bool(pod["metadata"].get("deletionTimestamp")),
                "ready": any(
                    c.get("type") == "Ready" and c.get("status") == "True"
                    for c in pod.get("status", {}).get("conditions", [])
                ),
                "containers": actual,
            }
        )
    active = [pod for pod in observations if not pod["terminating"]]
    template = {c["name"]: c["image"] for c in containers}
    observed = status.get("observedGeneration", 0) >= deployment["metadata"]["generation"]
    ready = bool(
        desired > 0
        and observed
        and status.get("updatedReplicas", 0) == status.get("availableReplicas", 0) == desired
        and len(active) == desired
        and all(
            pod["phase"] == "Running"
            and pod["ready"]
            and {c["name"]: c["image"] for c in pod["containers"]} == template
            and all(c["ready"] and c["image_id"] for c in pod["containers"])
            for pod in active
        )
    )
    matches = all(c["image"] == expected_image for c in containers) if expected_image else None
    issues = []
    if not ready:
        issues.append("ROLLOUT_NOT_READY")
    if matches is not True:
        issues.append("BASELINE_MISSING" if matches is None else "BASELINE_IMAGE_MISMATCH")
    return {
        "name": service,
        "ready": ready,
        "baseline_matches": matches,
        "baseline_image": expected_image,
        "desired_replicas": desired,
        "observed_generation": status.get("observedGeneration"),
        "desired_generation": deployment["metadata"]["generation"],
        "strategy": spec["strategy"]["type"],
        "issues": issues,
        "containers": containers,
        "pods": observations,
    }


def snapshot(state, settings, kube, nk, ak):
    # The caller must verify the dedicated context and ownership marker first.
    resources = json.loads(
        run(nk + ["get", "deployments,pods,pvc", "-o", "json"], capture=True, timeout=15)
    )["items"]
    nodes = [
        node_status(item)
        for item in json.loads(
            run(kube + ["get", "nodes", "-o", "json"], capture=True, timeout=15)
        )["items"]
    ]
    deployments = {
        item["metadata"]["name"]: item for item in resources if item["kind"] == "Deployment"
    }
    pods = [item for item in resources if item["kind"] == "Pod"]
    path = state / "baseline.json"
    if path.is_symlink():
        raise ValueError("Local baseline must not be a symlink")
    baseline = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    services = [
        service_status(name, deployments.get(name), pods, baseline.get("images", {}).get(name))
        for name in SERVICES
    ]
    claims = [
        {
            "name": item["metadata"]["name"],
            "phase": item.get("status", {}).get("phase"),
            "volume": item["spec"].get("volumeName"),
            "storage_class": item["spec"].get("storageClassName"),
            "terminating": bool(item["metadata"].get("deletionTimestamp")),
        }
        for item in resources
        if item["kind"] == "PersistentVolumeClaim"
    ]
    referenced_claims = {
        volume["persistentVolumeClaim"]["claimName"]
        for pod in pods
        if pod.get("status", {}).get("phase") not in {"Succeeded", "Failed"}
        for volume in pod["spec"].get("volumes", [])
        if "persistentVolumeClaim" in volume
    }
    missing_claims = sorted(referenced_claims - {claim["name"] for claim in claims})
    storage_ready = (
        bool(claims)
        and not missing_claims
        and all(
            claim["phase"] == "Bound" and claim["volume"] and not claim["terminating"]
            for claim in claims
        )
    )
    filesystems = local_filesystems(state)
    crd = run(
        kube + ["get", "crd", "applications.argoproj.io", "--ignore-not-found", "-o", "name"],
        capture=True,
        timeout=15,
    ).strip()
    applications = []
    if crd:
        for app in json.loads(
            run(ak + ["get", "applications", "-o", "json"], capture=True, timeout=15)
        )["items"]:
            if app["spec"].get("destination", {}).get("namespace") != settings["namespace"]:
                continue
            applications.append(
                {
                    "name": app["metadata"]["name"],
                    "sync": app.get("status", {}).get("sync", {}).get("status"),
                    "health": app.get("status", {}).get("health", {}).get("status"),
                }
            )
    checkout_sha, checkout_dirty = None, None
    try:
        checkout_sha = run(
            ["git", "-C", REPOSITORY_ROOT, "rev-parse", "HEAD"], capture=True, timeout=10
        ).strip()
        checkout_dirty = bool(
            run(
                ["git", "-C", REPOSITORY_ROOT, "status", "--porcelain", "--untracked-files=normal"],
                capture=True,
                timeout=10,
            ).strip()
        )
    except (OSError, subprocess.SubprocessError):
        pass  # Missing checkout information is explicit; cluster observations remain useful.
    return {
        "schema_version": 2,
        "scope": "deployment_snapshot",
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "repository": settings["repository"],
        "namespace": settings["namespace"],
        "cluster": settings["cluster"],
        "mode": settings["mode"],
        "checkout_sha": checkout_sha,
        "checkout_dirty": checkout_dirty,
        "baseline_source": baseline.get("source"),
        "baseline_revision": baseline.get("release", {}).get("verifiedRevision"),
        "workloads_ready": all(s["ready"] for s in services),
        "baseline_matches": all(s["baseline_matches"] is True for s in services),
        "nodes_healthy": bool(nodes) and all(node["healthy"] for node in nodes),
        "nodes": nodes,
        "storage_ready": storage_ready,
        "missing_claims": missing_claims,
        "local_storage_ok": all(item["ok"] for item in filesystems),
        "local_filesystems": filesystems,
        "services": services,
        "claims": claims,
        "argocd": {"application_crd_present": bool(crd), "applications": applications},
        "image_source_verified": False,
        "application_paths_verified": False,
        "backup_verified": False,
    }
