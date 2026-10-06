"""Read existing local overrides before planning default public Argo workloads."""

import hashlib
import json
import re
from pathlib import Path

import connected_runtime
import fork_cluster as cluster
import ops_runtime
import yaml


def ops_defaults():
    """Local reference only; neither a published release nor an approved overlay."""
    path = cluster.ROOT / "environments/portfolio/ops-service.yaml"
    payload = path.read_bytes()
    values = yaml.safe_load(payload)
    expected = [{"name": name, "value": value} for name, value in values["env"].items()]
    expected.extend(
        {
            "name": name,
            "valueFrom": {"secretKeyRef": {"name": values["secretName"], "key": name}},
        }
        for name in values["secretKeys"]
    )
    return payload, expected


def environment_rows(rows):
    """Keep values internal; reject ambiguity instead of losing duplicate entries."""
    result = {}
    for row in rows:
        name = row.get("name")
        if (
            not isinstance(name, str)
            or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,255}", name)
            or name in result
            or set(row) not in ({"name", "value"}, {"name", "valueFrom"})
            or ("value" in row and not isinstance(row["value"], str))
        ):
            raise ValueError("Ambiguous Ops environment entries")
        if "valueFrom" in row:
            reference = row["valueFrom"]
            if (
                not isinstance(reference, dict)
                or len(reference) != 1
                or not set(reference)
                <= {"secretKeyRef", "configMapKeyRef", "fieldRef", "resourceFieldRef"}
                or not isinstance(next(iter(reference.values())), dict)
            ):
                raise ValueError("Unknown Ops environment reference")
        result[name] = row
    return result


def preservation_review(inputs, deployment, reference):
    """List differences for review, never copy live configuration into Argo values."""
    payload, rows = reference
    expected = environment_rows(rows)
    containers = deployment["spec"]["template"]["spec"]["containers"]
    names = [item["name"] for item in containers]
    if len(names) != len(set(names)) or any(
        not isinstance(name, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", name)
        for name in names
    ):
        raise ValueError("Invalid Ops container names")
    changes = {}
    indirect = []
    for item in containers:
        name = item["name"]
        if item.get("envFrom"):
            indirect.append(name)
        if name not in {"ops-service", "ops-sync"}:
            continue
        actual = environment_rows(item.get("env", []))
        changes[name] = {
            "changed": sorted(
                key
                for key in actual.keys() & expected.keys()
                if actual[key] != expected[key]
            ),
            "runtimeOnly": sorted(actual.keys() - expected.keys()),
            "missing": sorted(expected.keys() - actual.keys()),
        }
    profile = inputs["integration"] or {}
    return {
        "scope": "ops_environment_and_saved_integrations",
        "reference": "checkout_portfolio_ops_defaults",
        "referenceSha256": hashlib.sha256(payload).hexdigest(),
        "integrationFeatures": sorted(profile.get("features", [])),
        "modelSettingNames": sorted(profile.get("modelKeys", [])),
        "connectionRecordConflict": len(
            {record["composeProject"] for record in inputs["connections"].values()}
        )
        > 1,
        "containers": {
            "runtimeOnly": sorted(set(names) - {"ops-service"}),
            "missing": sorted({"ops-service"} - set(names)),
        },
        "environmentChanges": changes,
        "uninspectedEnvFrom": sorted(indirect),
        "configurationValuesIncluded": False,
        "overlayGenerated": False,
    }


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
    reference = ops_defaults()
    preservation = preservation_review(inputs, deployment, reference)
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
    if any(
        any(change.values()) for change in preservation["environmentChanges"].values()
    ):
        blockers.append("ops_environment_differs")
    if preservation["uninspectedEnvFrom"]:
        blockers.append("ops_env_from_uninspected")
    # A result describes only a stable observation, never a reusable approval.
    current = read_deployment()
    if (
        current["metadata"].get("uid") != meta["uid"]
        or current["metadata"].get("resourceVersion") != meta["resourceVersion"]
        or current.get("spec") != deployment["spec"]
        or cluster.load_settings(state) != settings
        or local_inputs(state, settings) != inputs
        or ops_defaults() != reference
    ):
        raise ValueError("Local runtime changed during preflight")
    cluster.require_dev(state, settings)
    return {
        "schema": "msa-local-runtime-preflight-v1",
        "scope": "local_overrides_and_ops_connection",
        "status": "BLOCKED" if blockers else "NO_LOCAL_OVERRIDES",
        "stateId": settings["stateId"],
        "blockers": blockers,
        "preservationReview": preservation,
        "servicesChanged": False,
        "databaseChanged": False,
        "deploymentAuthorized": False,
    }
