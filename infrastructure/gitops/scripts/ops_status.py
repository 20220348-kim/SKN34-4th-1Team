"""Read connected Compose containers and routes without starting or changing work."""

import io
import json
import re
import subprocess
from contextlib import redirect_stdout

import ops_bridge
from ops_runtime import BRIDGE, PROFILE, read_connection
from portfolio_cluster import run

SERVICES = ("prefect", "ops-artifacts", "evaluation-runner")
READ_ERRORS = (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError)


def container_status(project, service):
    item = {"service": service, "ready": False, "issues": []}
    try:
        identities = run(
            [
                "docker",
                "ps",
                "--all",
                "--no-trunc",
                "--filter",
                "label=com.docker.compose.project=" + project,
                "--filter",
                "label=com.docker.compose.service=" + service,
                "--filter",
                "label=com.docker.compose.oneoff=False",
                "--format",
                "{{.ID}}",
            ],
            capture=True,
            timeout=15,
        ).split()
        if len(identities) != 1:
            item["issues"].append(
                "CONTAINER_MISSING" if not identities else "CONTAINER_AMBIGUOUS"
            )
            return item
        if not re.fullmatch(r"[a-f0-9]{64}", identities[0]):
            raise ValueError("Invalid container identity")
        # Never retrieve environment, command arguments, health logs or State.Error.
        template = (
            '{"id":{{json .Id}},'
            '"project":{{json (index .Config.Labels "com.docker.compose.project")}},'
            '"service":{{json (index .Config.Labels "com.docker.compose.service")}},'
            '"oneoff":{{json (index .Config.Labels "com.docker.compose.oneoff")}},'
            '"state":{{json .State.Status}},"running":{{json .State.Running}},'
            '"paused":{{json .State.Paused}},"restarting":{{json .State.Restarting}},'
            '"restart_count":{{json .RestartCount}},"started_at":{{json .State.StartedAt}},'
            '"health":{{with index .State "Health"}}{{json .Status}}{{else}}null{{end}}}'
        )
        value = json.loads(
            run(
                [
                    "docker",
                    "inspect",
                    "--type",
                    "container",
                    "--format",
                    template,
                    identities[0],
                ],
                capture=True,
                timeout=15,
            )
        )
        if (
            value["id"] != identities[0]
            or value["project"] != project
            or value["service"] != service
            or value["oneoff"] not in {"False", "false"}
            or value["state"]
            not in {
                "created",
                "running",
                "paused",
                "restarting",
                "removing",
                "exited",
                "dead",
            }
            or any(
                type(value[key]) is not bool
                for key in ("running", "paused", "restarting")
            )
            or type(value["restart_count"]) is not int
            or value["restart_count"] < 0
            or not isinstance(value["started_at"], str)
            or not re.fullmatch(
                r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z", value["started_at"]
            )
            or value["health"] not in {None, "starting", "healthy", "unhealthy"}
        ):
            raise ValueError("Invalid container observation")
        item.update(
            {
                key: value[key]
                for key in ("id", "state", "restart_count", "started_at", "health")
            }
        )
        if not value["running"] or value["state"] != "running":
            item["issues"].append("CONTAINER_NOT_RUNNING")
        if value["paused"]:
            item["issues"].append("CONTAINER_PAUSED")
        if value["restarting"]:
            item["issues"].append("CONTAINER_RESTARTING")
        if value["health"] not in {None, "healthy"}:
            item["issues"].append("CONTAINER_NOT_HEALTHY")
        item["ready"] = not item["issues"]
    except READ_ERRORS:
        item["issues"].append("CONTAINER_INSPECTION_FAILED")
    return item


def snapshot(state, settings):
    """Called only after fork_cluster has verified the dedicated cluster owner."""
    report = {
        "schema_version": 1,
        "scope": "ops_compose_bridge_snapshot",
        "status": "UNKNOWN",
        "issues": [],
        "containers": [],
        "bridge_verified": False,
        "application_paths_verified": False,
        "evaluation_executed": False,
    }
    if settings["mode"] not in {"dev", "gitops"}:
        report["issues"].append("UNSUPPORTED_MODE")
        return report
    try:
        record = read_connection(state / PROFILE, settings)
        if read_connection(state / BRIDGE, settings) != record:
            raise ValueError("Connection records differ")
    except READ_ERRORS:
        report["issues"].append("CONNECTION_RECORD_INVALID_OR_MISSING")
        return report
    project = record["composeProject"]
    report["compose_project"] = project
    report["containers"] = [container_status(project, service) for service in SERVICES]
    if not all(item["ready"] for item in report["containers"]):
        report["status"] = "FAIL"
        report["issues"].append("COMPOSE_NOT_READY")
        return report
    try:
        # Reuse the ownership/IP/EndpointSlice checker, keeping stdout valid JSON.
        with redirect_stdout(io.StringIO()):
            ops_bridge.connect(state, settings, project, check=True)
        after = [container_status(project, service) for service in SERVICES]
        if after != report["containers"]:
            report["issues"].append("COMPOSE_CHANGED_DURING_CHECK")
        else:
            report["bridge_verified"] = True
    except READ_ERRORS:
        report["issues"].append("BRIDGE_CHECK_FAILED")
    report["status"] = "FAIL" if report["issues"] else "PASS"
    return report
