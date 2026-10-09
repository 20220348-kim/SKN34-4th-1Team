"""Read-only inventory for a short Ops backup outage; never authorizes an upgrade."""

import argparse
import hashlib
import io
import json
import re
import subprocess
import sys
from contextlib import redirect_stdout
from datetime import UTC, datetime
from pathlib import Path

import ops_db_snapshot as database
import ops_runtime
from fork_cluster import locked
from gitops_runtime import argo_observation


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


def deployment_record(deployment, *, gitops_namespace=None):
    meta, spec, status = (
        deployment["metadata"],
        deployment["spec"],
        deployment.get("status", {}),
    )
    containers = spec["template"]["spec"]["containers"]
    replicas = spec.get("replicas", 1)
    tracking = {
        field: {
            key: value
            for key, value in meta.get(field, {}).items()
            if key.startswith("argocd.argoproj.io/")
        }
        for field in ("labels", "annotations")
    }
    expected_tracking = {"labels": {}, "annotations": {}}
    if gitops_namespace is not None:
        if (
            deployment.get("kind") != "Deployment"
            or meta.get("name") != "ops-service"
            or meta.get("namespace") != gitops_namespace
        ):
            raise ValueError("Unexpected Argo Ops resource identity")
        expected_tracking["annotations"]["argocd.argoproj.io/tracking-id"] = (
            f"govbiz-fork-ops-service:apps/Deployment:{gitops_namespace}/ops-service"
        )
    if (
        not meta.get("uid")
        or not meta.get("resourceVersion")
        or meta.get("deletionTimestamp")
        or type(replicas) is not int
        or replicas != 1
        or status.get("observedGeneration") != meta["generation"]
        or any(
            status.get(name, 0) != replicas
            for name in (
                "replicas",
                "readyReplicas",
                "updatedReplicas",
                "availableReplicas",
            )
        )
        or len(containers) != 2
        or {item["name"] for item in containers} != {"ops-service", "ops-sync"}
        or tracking != expected_tracking
    ):
        raise ValueError("Expected one stable Ops API/sync replica with matching ownership")
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


def runtime_image_check(images, project):
    """Check host-side key-probe images without reading keys or stopping writers."""
    result = {"status": "BLOCKED", "blockers": [], "ops_images": {}, "artifact": None}
    try:
        if set(images) != {"ops-service", "ops-sync"}:
            raise ValueError("Unexpected Ops containers")
        for name, reference in images.items():
            items = database.read_json(["docker", "image", "inspect", reference])
            if (
                not isinstance(items, list)
                or len(items) != 1
                or not re.fullmatch(r"sha256:[a-f0-9]{64}", items[0]["Id"])
            ):
                raise ValueError("Unverified Ops image")
            result["ops_images"][name] = items[0]["Id"]
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError):
        result["blockers"].append("source_ops_image_not_available_or_unverified")
    if not result["blockers"] and len(set(result["ops_images"].values())) != 1:
        result["blockers"].append("source_ops_container_images_differ")
    try:
        identities = (
            database.storage.run(
                [
                    "docker",
                    "ps",
                    "-aq",
                    "--no-trunc",
                    "--filter",
                    "label=com.docker.compose.project=" + project,
                    "--filter",
                    "label=com.docker.compose.service=ops-artifacts",
                ]
            )
            .decode()
            .split()
        )
        if len(identities) != 1 or not re.fullmatch(r"[a-f0-9]{64}", identities[0]):
            raise ValueError("One owned artifact server is required")
        item = database.storage.inspect(identities[0])
        labels = item["Config"].get("Labels") or {}
        if (
            item["Id"] != identities[0]
            or labels.get("com.docker.compose.project") != project
            or labels.get("com.docker.compose.service") != "ops-artifacts"
            or str(labels.get("com.docker.compose.oneoff", "false")).lower() != "false"
            or item["State"].get("Paused")
            or item["State"].get("Restarting")
            or item["State"]["Status"] not in {"running", "exited", "created"}
            or not re.fullmatch(r"sha256:[a-f0-9]{64}", item["Image"])
        ):
            raise ValueError("Unverified artifact server")
        result["artifact"] = {"container_id": item["Id"], "image_id": item["Image"]}
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError):
        result["blockers"].append("source_artifact_image_not_available_or_unverified")
    if not result["blockers"]:
        if result["artifact"]["image_id"] not in result["ops_images"].values():
            result["blockers"].append("source_ops_artifact_images_differ")
        else:
            result["status"] = "VERIFIED"
    return result


def plan(state, *, runtime_keys=False):
    settings = database.load_settings(state)
    argo = None
    if settings["mode"] == "gitops":
        argo = argo_observation(state, settings)
    else:
        database.require_dev(state, settings)
    record = database.read_connection(Path(state) / database.PROFILE, settings)
    if database.read_connection(Path(state) / database.BRIDGE, settings) != record:
        raise ValueError("Ops connection records differ")
    # Bridge diagnostics are not part of the JSON report or a reusable authorization.
    with redirect_stdout(io.StringIO()):
        preflight = ops_runtime.upgrade_preflight(state, settings)
    require_quiet(preflight)
    # The legacy admission exception belongs only to the original dev inventory.
    if argo is not None and preflight["status"] != "PASS":
        raise ValueError("GitOps maintenance requires supported, paused admission")
    _, namespaced, _ = database.commands(state, settings)
    namespaced = [*namespaced, "--request-timeout=15s"]
    deployment_args = namespaced + ["get", "deployment", "ops-service", "-o", "json"]
    deployment_options = {"gitops_namespace": settings["namespace"]} if argo is not None else {}
    deployment = deployment_record(database.read_json(deployment_args), **deployment_options)
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
    runtime_images = (
        runtime_image_check(deployment["images"], record["composeProject"])
        if runtime_keys
        else {"status": "NOT_CHECKED"}
    )
    # A report describes one observation, never a reusable approval to mutate.
    latest_pod = database.read_json(pod_args)
    if (
        deployment_record(database.read_json(deployment_args), **deployment_options) != deployment
        or inspect_writers(record["composeProject"]) != writers
        or latest_pod["metadata"]["uid"] != pod["metadata"]["uid"]
        or latest_pod["status"]["containerStatuses"] != statuses
        or latest_pod["metadata"].get("deletionTimestamp")
        or database.database_identity(namespaced, latest_pod) != identity
    ):
        raise ValueError("Source changed while preparing maintenance")
    latest_autoscalers = database.read_json(namespaced + ["get", "hpa", "-o", "json"])["items"]
    if any(
        row["spec"]["scaleTargetRef"].get("name") == "ops-service" for row in latest_autoscalers
    ):
        raise ValueError("Ops autoscaling changed while preparing maintenance")
    with redirect_stdout(io.StringIO()):
        latest_preflight = ops_runtime.upgrade_preflight(state, settings)
    require_quiet(latest_preflight)
    if (
        {
            key: value
            for key, value in latest_preflight.items()
            if key not in {"started_at", "checked_at"}
        }
        != {
            key: value
            for key, value in preflight.items()
            if key not in {"started_at", "checked_at"}
        }
        or database.load_settings(state) != settings
        or any(
            database.read_connection(Path(state) / name, settings) != record
            for name in (database.PROFILE, database.BRIDGE)
        )
    ):
        raise ValueError("Ops admission or connection changed while preparing maintenance")
    if argo is not None:
        if argo_observation(state, settings) != argo:
            raise ValueError("Argo changed while preparing maintenance")
    else:
        database.require_dev(state, settings)
    if (
        runtime_keys
        and runtime_image_check(deployment["images"], record["composeProject"]) != runtime_images
    ):
        raise ValueError("Runtime backup images changed while preparing maintenance")
    blockers = [] if image_available else ["source_mysql_image_not_available_or_unverified"]
    blockers.extend(runtime_images.get("blockers", []))
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
        "status": "BLOCKED" if blockers else "PLANNED",
        "blockers": blockers,
        "runtime_key_images": runtime_images,
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
        **({"argo_observation": argo} if argo is not None else {}),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, default=database.STATE)
    parser.add_argument(
        "--runtime-keys",
        action="store_true",
        help="Also check local Ops key-probe images and artifact image alignment; no Secret reads",
    )
    args = parser.parse_args()
    try:
        with locked(args.state_dir):
            report = plan(args.state_dir, runtime_keys=args.runtime_keys)
        print(json.dumps(report, sort_keys=True))
        return 0 if report["status"] == "PLANNED" else 1
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError):
        print("Cannot prepare Ops maintenance (private details withheld)", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
