"""Read existing local overrides before planning default public Argo workloads."""

import json
from pathlib import Path

import connected_runtime
import fork_cluster as cluster
import ops_runtime


def local_inputs(state, settings):
    records = {}
    for name in (ops_runtime.PROFILE, ops_runtime.BRIDGE):
        path = state / name
        if path.exists() or path.is_symlink():
            records[name] = ops_runtime.read_connection(path, settings)
    images = state / "dev-images.json"
    return {
        "integration": connected_runtime.load_profile(state, settings),
        "connections": records,
        "development_images": images.exists() or images.is_symlink(),
    }


def preflight(state, fork):
    """Detect local connection conflicts, not migration or deployment readiness."""
    state = Path(state)
    settings = cluster.load_settings(state)
    if settings["repository"].lower() != fork.repository.lower():
        raise ValueError("Runtime state belongs to another repository")
    # Verifies loopback context, owner marker and absence of Argo ownership first.
    cluster.require_dev(state, settings)
    inputs = local_inputs(state, settings)
    _, namespaced, _ = cluster.commands(state, settings)
    command = namespaced + ["get", "deployment", "ops-service", "-o", "json"]

    def read_deployment():
        return json.loads(cluster.run(command, capture=True, timeout=15))

    deployment = read_deployment()
    meta = deployment["metadata"]
    if (
        meta.get("name") != "ops-service"
        or meta.get("namespace") != settings["namespace"]
        or not meta.get("uid")
        or not meta.get("resourceVersion")
        or meta.get("deletionTimestamp")
    ):
        raise ValueError("Missing or unstable Ops Deployment identity")
    containers = deployment["spec"]["template"]["spec"]["containers"]
    blockers = []
    if inputs["integration"] is not None:
        blockers.append("local_integration_profile")
    if inputs["development_images"]:
        blockers.append("local_development_images")
    try:
        ops_runtime.require_bootstrap_ops(state, containers)
    except ValueError:
        blockers.append("connected_or_unverified_ops")
    if inputs["connections"] and "connected_or_unverified_ops" not in blockers:
        blockers.append("connected_or_unverified_ops")
    if [item["name"] for item in containers] != ["ops-service"]:
        blockers.append("ops_container_layout_differs")
    # A result describes only a stable observation, never a reusable approval.
    current = read_deployment()
    if (
        current["metadata"].get("uid") != meta["uid"]
        or current["metadata"].get("resourceVersion") != meta["resourceVersion"]
        or current.get("spec") != deployment["spec"]
        or cluster.load_settings(state) != settings
        or local_inputs(state, settings) != inputs
    ):
        raise ValueError("Local runtime changed during preflight")
    cluster.require_dev(state, settings)
    return {
        "schema": "msa-local-runtime-preflight-v1",
        "scope": "local_overrides_and_ops_connection",
        "status": "BLOCKED" if blockers else "NO_LOCAL_OVERRIDES",
        "stateId": settings["stateId"],
        "blockers": blockers,
        "servicesChanged": False,
        "databaseChanged": False,
        "deploymentAuthorized": False,
    }
