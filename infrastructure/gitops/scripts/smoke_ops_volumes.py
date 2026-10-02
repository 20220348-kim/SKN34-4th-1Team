"""Restore only the disposable bridge smoke's stopped result and Prefect volumes."""

import json
import re
from pathlib import Path
from uuid import uuid4

import fork_cluster
import ops_volume_restore_probe as probe
from smoke_ops_artifacts import require_disposable
from smoke_ops_bridge import execute

INSPECT = (
    '{"Id":{{json .Id}},"Image":{{json .Image}},"Labels":{{json .Config.Labels}},'
    '"State":{{json .State}},"Mounts":{{json .Mounts}}}'
)
SERVICES = {
    "evaluation-runner": ("/results", "ops-results", True),
    "ops-artifacts": ("/results", "ops-results", False),
    "prefect": ("/var/lib/prefect", "prefect-data", True),
}


def container(identity, project, service):
    value = json.loads(execute(["docker", "inspect", "--format", INSPECT, identity]))
    labels = value["Labels"]
    destination, suffix, writable = SERVICES[service]
    mounts = [item for item in value["Mounts"] if item["Destination"] == destination]
    if (
        value["Id"] != identity
        or labels.get("com.docker.compose.project") != project
        or labels.get("com.docker.compose.service") != service
        or str(labels.get("com.docker.compose.oneoff", "false")).lower() != "false"
        or len(mounts) != 1
        or mounts[0].get("Type") != "volume"
        or mounts[0].get("Name") != project + "_" + suffix
        or mounts[0].get("RW") is not writable
        or not re.fullmatch(r"sha256:[a-f0-9]{64}", value["Image"])
    ):
        raise ValueError("Unexpected source container or volume ownership")
    return value


def unused_volumes(sources, containers):
    for volume, owners in sources.items():
        actual = set(
            execute(
                [
                    "docker",
                    "ps",
                    "--all",
                    "--no-trunc",
                    "--filter",
                    "volume=" + volume,
                    "--format",
                    "{{.ID}}",
                ]
            ).split()
        )
        if actual != {containers[name]["Id"] for name in owners}:
            raise ValueError("Unexpected container uses the source volume")


def restore_volume(image, source, kind, expected):
    name = "govbiz-volume-restore-" + uuid4().hex
    label = "govbiz.restore=" + name
    identity = None
    created = False
    result = None
    if execute(
        ["docker", "volume", "ls", "--filter", "name=" + name, "--format", "{{.Name}}"]
    ).strip():
        raise ValueError("Restore volume name already exists")
    try:
        returned = execute(
            ["docker", "volume", "create", "--label", label, name]
        ).strip()
        if returned != name:
            raise ValueError("Unexpected created volume identity")
        info = json.loads(execute(["docker", "volume", "inspect", name]))[0]
        if info["Name"] != name or info.get("Labels", {}).get("govbiz.restore") != name:
            raise ValueError("Restore volume ownership was not established")
        created = True
        identity = execute(
            [
                "docker",
                "create",
                "--interactive",
                "--network",
                "none",
                "--read-only",
                "--user",
                "0:0",
                "--cap-drop",
                "ALL",
                "--cap-add",
                "CHOWN",
                "--cap-add",
                "DAC_OVERRIDE",
                "--security-opt",
                "no-new-privileges:true",
                "--memory",
                "768m" if kind == "prefect" else "256m",
                "--pids-limit",
                "64" if kind == "prefect" else "32",
                "--tmpfs",
                "/tmp:rw,noexec,nosuid,size=128m,mode=1777",
                "--mount",
                "type=volume,source=" + source + ",target=/source,readonly",
                "--mount",
                "type=volume,source=" + name + ",target=/restore",
                "--entrypoint",
                "python",
                image,
                "-B",
                "-",
                json.dumps({"kind": kind, "expected": expected}),
            ]
        ).strip()
        if not re.fullmatch(r"[a-f0-9]{64}", identity):
            identity = None
            raise ValueError("Invalid restore helper identity")
        raw = execute(
            ["docker", "start", "--attach", "--interactive", identity],
            data=Path(probe.__file__).read_text(encoding="utf-8"),
            timeout=180,
        )
        state = json.loads(
            execute(["docker", "inspect", "--format", "{{json .State}}", identity])
        )
        if state["Running"] or state["ExitCode"] != 0 or state["OOMKilled"]:
            raise ValueError("Volume restore helper did not exit successfully")
        result = json.loads(raw)
        if (
            not isinstance(result, dict)
            or result.get("status") != "PASS"
            or result.get("source_preserved") is not True
            or result.get("permissions_preserved") is not True
            or any(
                type(result.get(key)) is not int or result[key] < 1
                for key in ("file_count", "total_bytes")
            )
            or not re.fullmatch(r"[a-f0-9]{64}", str(result.get("tree_sha256", "")))
        ):
            raise ValueError("Incomplete volume restore evidence")
        required = "matched_reports" if kind == "results" else "matched_executions"
        if (
            type(result.get(required)) is not int
            or result[required] != len(expected)
            or (kind == "prefect" and result.get("sqlite_integrity") is not True)
        ):
            raise ValueError("Incomplete restored execution evidence")
        if kind == "prefect":
            api = result.get("api", {})
            if (
                not isinstance(api, dict)
                or api.get("status") != "PASS"
                or type(api.get("matched_executions")) is not int
                or api["matched_executions"] != len(expected)
                or api.get("database_unchanged") is not True
                or api.get("server_stopped") is not True
                or api.get("scheduling_disabled") is not True
                or api.get("automatic_migrations") is not False
            ):
                raise ValueError("Incomplete restored Prefect API evidence")
    finally:
        # Attempt both removals even if one fails; never target a source volume.
        try:
            if identity is not None:
                execute(["docker", "rm", "--force", identity], timeout=30)
        finally:
            if created:
                info = json.loads(execute(["docker", "volume", "inspect", name]))[0]
                if (
                    info["Name"] != name
                    or info.get("Labels", {}).get("govbiz.restore") != name
                ):
                    raise ValueError("Restore volume ownership changed before cleanup")
                execute(["docker", "volume", "rm", name], timeout=30)
    return {**result, "cleanup_complete": True}


def verify(state, settings, compose, env, expected, report):
    evidence = report["volume_restore"] = {
        "status": "FAIL",
        "scope": "disposable_results_and_prefect_api",
        "backup_verified": False,
        "personal_environment_verified": False,
        "prefect_server_started": None,
        "model_api_calls": 0,
    }
    expected = probe.expected_runs(expected)
    if settings.get("repository") != "bridge-smoke/local" or report.get(
        "compose_project"
    ) != settings.get("cluster"):
        raise ValueError("Volume restore requires the disposable bridge smoke")
    fork_cluster.require_dev(state, settings)
    _, nk, _ = fork_cluster.commands(state, settings)
    project = report["compose_project"]
    require_disposable(nk, compose, env, project)
    database = report.get("database_restore", {})
    if (
        database.get("status") != "PASS"
        or database.get("source_writers_stopped") is not True
    ):
        raise ValueError("Complete the isolated DB rehearsal before volume restore")
    if json.loads(
        execute(
            nk
            + ["get", "pods", "-l", "app.kubernetes.io/name=ops-service", "-o", "json"]
        )
    )["items"]:
        raise ValueError("Ops writers must remain stopped")
    containers = {}
    for service in SERVICES:
        identities = execute(compose + ["ps", "-q", service], env=env).split()
        if len(identities) != 1 or not re.fullmatch(r"[a-f0-9]{64}", identities[0]):
            raise ValueError("Expected one running disposable container per service")
        value = container(identities[0], project, service)
        if not value["State"]["Running"]:
            raise ValueError("Source fixture is not running")
        containers[service] = value
    sources = {
        project + "_ops-results": {"evaluation-runner", "ops-artifacts"},
        project + "_prefect-data": {"prefect"},
    }
    for volume in sources:
        info = json.loads(execute(["docker", "volume", "inspect", volume]))[0]
        if (
            info["Name"] != volume
            or info.get("Labels", {}).get("com.docker.compose.project") != project
        ):
            raise ValueError("Source volume does not belong to this smoke")
    unused_volumes(sources, containers)
    execute(
        [
            "docker",
            "stop",
            "--time",
            "30",
            *[item["Id"] for item in containers.values()],
        ],
        timeout=120,
    )
    for service, before in containers.items():
        after = container(before["Id"], project, service)
        if (
            after["Image"] != before["Image"]
            or after["State"]["Running"]
            or after["State"]["OOMKilled"]
            or after["State"]["ExitCode"] not in (0, 143)
        ):
            raise ValueError("Source writer did not stop cleanly")
    unused_volumes(sources, containers)
    evidence["writers_stopped"] = True
    image = containers["ops-artifacts"]["Image"]
    evidence["results"] = restore_volume(
        image, project + "_ops-results", "results", expected
    )
    evidence["prefect"] = restore_volume(
        containers["prefect"]["Image"], project + "_prefect-data", "prefect", expected
    )
    evidence.update(
        status="PASS",
        network_isolated=True,
        cleanup_complete=True,
        prefect_server_started=True,
    )
    # Preserve the already verified runner identity before the caller's cleanup.
    return containers["evaluation-runner"]["Image"]
