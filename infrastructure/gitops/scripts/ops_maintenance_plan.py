"""Read-only inventory for a short Ops backup outage; never authorizes an upgrade."""

import argparse
import hashlib
import io
import json
import re
import sys
from contextlib import redirect_stdout
from datetime import UTC, datetime
from pathlib import Path

import ops_db_snapshot as database
import ops_runtime
from fork_cluster import locked


def require_quiet(preflight):
    if not isinstance(preflight, dict) or not isinstance(preflight.get("checks"), dict):
        raise ValueError("Missing Ops preflight evidence")
    checks = preflight.get("checks", {})
    counters = {
        "unsettled_evaluations",
        "open_reservations",
        "unfinished_flows",
        "active_schedules",
        "unpaused_ops_schedules",
        "unsettled_schedule_occurrences",
        "inspected_flows",
        "open_admission",
    }
    legacy = (
        preflight.get("status") == "BLOCKED"
        and preflight.get("reason") == "admission_control_unsupported"
        and preflight.get("admission_supported") is False
        and preflight.get("admission_blocked") is False
        and checks.get("open_admission") is None
    )
    paused = (
        preflight.get("status") == "PASS"
        and preflight.get("admission_supported") is True
        and preflight.get("admission_blocked") is True
        and type(preflight.get("admission_version")) is int
        and preflight["admission_version"] >= 1
        and type(checks.get("open_admission")) is int
        and checks["open_admission"] == 0
    )
    if (
        preflight.get("schemaVersion") != 4
        or preflight.get("scope") != "ops_upgrade_preflight"
        or not (legacy or paused)
        or set(checks) != counters
        or type(checks["inspected_flows"]) is not int
        or checks["inspected_flows"] < 0
        or any(
            type(checks[name]) is not int or checks[name] != 0
            for name in counters - {"inspected_flows", "open_admission"}
        )
    ):
        raise ValueError("Maintenance requires complete, quiet Ops and Prefect evidence")


def inspect_writers(project):
    identities = (
        database.storage.run(
            [
                "docker",
                "ps",
                "-aq",
                "--no-trunc",
                "--filter",
                "label=com.docker.compose.project=" + project,
            ]
        )
        .decode()
        .split()
    )
    if len(identities) != len(set(identities)):
        raise ValueError("Duplicate Compose identities")
    writers = {}
    services = set()
    for identity in identities:
        if not re.fullmatch(r"[a-f0-9]{64}", identity):
            raise ValueError("Invalid Compose identity")
        item = database.storage.inspect(identity)
        labels = item["Config"].get("Labels") or {}
        if item["Id"] != identity or labels.get("com.docker.compose.project") != project:
            raise ValueError("Compose ownership changed")
        service = labels.get("com.docker.compose.service")
        if service not in database.WRITERS:
            continue
        state = item["State"]
        if (
            service in services
            or str(labels.get("com.docker.compose.oneoff", "false")).lower() != "false"
            or state.get("Paused")
            or state.get("Restarting")
            or state["Status"] not in {"running", "exited", "created"}
            or type(state["Running"]) is not bool
            or state["Running"] != (state["Status"] == "running")
            or not re.fullmatch(r"sha256:[a-f0-9]{64}", item["Image"])
        ):
            raise ValueError("Unstable or duplicate Compose writer")
        services.add(service)
        writers[identity] = {
            "service": service,
            "image_id": item["Image"],
            "running": state["Running"],
            "status": state["Status"],
            "started_at": state["StartedAt"],
            "finished_at": state["FinishedAt"],
            "restart_count": item["RestartCount"],
        }
    if not {"prefect", "evaluation-runner"}.issubset(services):
        raise ValueError("Missing Prefect or evaluation runner")
    return writers


def deployment_record(deployment):
    meta, spec, status = deployment["metadata"], deployment["spec"], deployment.get("status", {})
    containers = spec["template"]["spec"]["containers"]
    replicas = spec.get("replicas", 1)
    if (
        not meta.get("uid")
        or not meta.get("resourceVersion")
        or meta.get("deletionTimestamp")
        or type(replicas) is not int
        or replicas != 1
        or status.get("observedGeneration") != meta["generation"]
        or any(
            status.get(name, 0) != replicas
            for name in ("replicas", "readyReplicas", "updatedReplicas", "availableReplicas")
        )
        or len(containers) != 2
        or {item["name"] for item in containers} != {"ops-service", "ops-sync"}
        or any(
            key.startswith("argocd.argoproj.io/")
            for field in ("labels", "annotations")
            for key in meta.get(field, {})
        )
    ):
        raise ValueError("Expected one stable, locally owned Ops API/sync replica")
    for container in containers:
        env = container.get("env", [])
        mapping = {row["name"]: row for row in env}
        if (
            container.get("envFrom")
            or len(mapping) != len(env)
            or any(
                mapping.get(name) != {"name": name, "value": value}
                for name, value in {
                    "DB_HOST": "ops-mysql",
                    "DB_PORT": "3306",
                    "DB_NAME": database.DATABASE,
                }.items()
            )
        ):
            raise ValueError("Unexpected Ops database route")
    return {
        "name": "ops-service",
        "uid": meta["uid"],
        "resource_version": meta["resourceVersion"],
        "replicas": replicas,
        "spec_sha256": hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest(),
        "images": {item["name"]: item["image"] for item in containers},
    }


def plan(state):
    settings = database.load_settings(state)
    database.require_dev(state, settings)
    record = database.read_connection(Path(state) / database.PROFILE, settings)
    if database.read_connection(Path(state) / database.BRIDGE, settings) != record:
        raise ValueError("Ops connection records differ")
    # Bridge diagnostics are not part of the JSON report or a reusable authorization.
    with redirect_stdout(io.StringIO()):
        preflight = ops_runtime.upgrade_preflight(state, settings)
    require_quiet(preflight)
    _, namespaced, _ = database.commands(state, settings)
    namespaced = [*namespaced, "--request-timeout=15s"]
    deployment_args = namespaced + ["get", "deployment", "ops-service", "-o", "json"]
    deployment = deployment_record(database.read_json(deployment_args))
    autoscalers = database.read_json(namespaced + ["get", "hpa", "-o", "json"])["items"]
    if any(row["spec"]["scaleTargetRef"].get("name") == "ops-service" for row in autoscalers):
        raise ValueError("Ops autoscaling prevents a maintenance window")
    pod_args = namespaced + ["get", "pod", "ops-mysql-0", "-o", "json"]
    pod = database.read_json(pod_args)
    statuses = pod["status"]["containerStatuses"]
    if (
        len(statuses) != 1
        or statuses[0]["name"] != "mysql"
        or not statuses[0]["ready"]
        or "running" not in statuses[0]["state"]
        or pod["metadata"].get("deletionTimestamp")
    ):
        raise ValueError("Expected a ready Ops MySQL source")
    image = statuses[0]["imageID"].removeprefix("docker-pullable://")
    if not re.fullmatch(r"(?:docker\.io/library/)?mysql@sha256:[a-f0-9]{64}", image):
        raise ValueError("Expected a pinned official MySQL image")
    image = "mysql@" + image.split("@", 1)[1]
    identity = database.database_identity(namespaced, pod)
    writers = inspect_writers(record["composeProject"])
    try:
        database.storage.run(["docker", "image", "inspect", image])
        image_available = True
    except database.storage.SnapshotError:
        image_available = False
    # A report describes one observation, never a reusable approval to mutate.
    latest_pod = database.read_json(pod_args)
    if (
        deployment_record(database.read_json(deployment_args)) != deployment
        or inspect_writers(record["composeProject"]) != writers
        or latest_pod["metadata"]["uid"] != pod["metadata"]["uid"]
        or latest_pod["status"]["containerStatuses"] != statuses
        or latest_pod["metadata"].get("deletionTimestamp")
        or database.database_identity(namespaced, latest_pod) != identity
    ):
        raise ValueError("Source changed while preparing maintenance")
    active = sorted(
        (identity for identity, row in writers.items() if row["running"]),
        key=lambda identity: (
            writers[identity]["service"] == "prefect",
            writers[identity]["service"],
        ),
    )
    return {
        "schema_version": 1,
        "scope": "ops_backup_maintenance_plan",
        "status": "PLANNED" if image_available else "BLOCKED",
        "blockers": [] if image_available else ["source_mysql_image_not_available_or_unverified"],
        "checked_at": datetime.now(UTC).isoformat(),
        "repository": settings["repository"],
        "state_id": settings["stateId"],
        "namespace": settings["namespace"],
        "compose_project": record["composeProject"],
        "deployment": deployment,
        "database": {**identity, "pod_uid": pod["metadata"]["uid"], "image": image},
        "writers": writers,
        "stop_order": ["deployment/ops-service", *active],
        "resume_order": [*reversed(active), "deployment/ops-service"],
        "leave_stopped": [identity for identity, row in writers.items() if not row["running"]],
        "retained_services": ["ops-mysql", "ops-artifacts"],
        "preflight": preflight,
        "services_changed": False,
        "backup_verified": False,
        "upgrade_allowed": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, default=database.STATE)
    args = parser.parse_args()
    try:
        with locked(args.state_dir):
            report = plan(args.state_dir)
        print(json.dumps(report, sort_keys=True))
        return 0 if report["status"] == "PLANNED" else 1
    except (ValueError, KeyError, TypeError, OSError):
        print("Cannot prepare Ops maintenance (private details withheld)", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
