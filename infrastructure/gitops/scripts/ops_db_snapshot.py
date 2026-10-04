"""Encrypt a stopped personal Kubernetes Ops DB; verify only in a new disposable MySQL.

WSL/Linux only. Never stops/resumes services, migrates, reads Kubernetes Secrets,
or restores onto an existing database. Files, Prefect and credentials are separate.
"""

import argparse
import hashlib
import json
import os
import re
import secrets
import stat
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from fork_cluster import REPOSITORY_ROOT, STATE, commands, load_settings, require_dev
from ops_runtime import BRIDGE, PROFILE, read_connection

sys.path.insert(0, str(REPOSITORY_ROOT / "infrastructure/llmops"))
import ops_snapshot as storage  # noqa: E402

DATABASE = "govbiz_ops"
SCOPE = "kubernetes_ops_database"
REQUIRED_TABLES = {
    "django_migrations",
    "evaluations_evaluationrun",
    "evaluations_evaluationbudgetreservation",
    "auth_user",
}
WRITERS = storage.WRITERS | {"prefect"}
TABLES = (
    "SELECT TABLE_NAME FROM information_schema.TABLES "
    "WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME;"
)
MYSQL = [
    "mysql",
    "--protocol=TCP",
    "--host=127.0.0.1",
    "--connect-timeout=5",
    "--user=root",
    "--default-character-set=utf8mb4",
    "--batch",
    "--raw",
    "--skip-column-names",
    DATABASE,
]
DUMP = [*storage.DUMP, "--protocol=TCP", "--host=127.0.0.1", DATABASE]


def read_json(arguments):
    return json.loads(storage.run(arguments, timeout=30))


def database_identity(namespaced, pod):
    """Pin the StatefulSet, PVC and service route, without reading any Secret."""

    def resource(kind, name):
        return read_json(namespaced + ["get", kind, name, "-o", "json"])

    stateful = resource("statefulset", "ops-mysql")
    owners = pod["metadata"].get("ownerReferences", [])
    if not any(
        owner.get("controller") is True
        and owner.get("kind") == "StatefulSet"
        and owner.get("uid") == stateful["metadata"]["uid"]
        for owner in owners
    ):
        raise ValueError("MySQL Pod does not belong to the expected StatefulSet")
    volumes = pod["spec"].get("volumes", [])
    if not any(
        volume.get("name") == "data"
        and volume.get("persistentVolumeClaim", {}).get("claimName") == "data-ops-mysql-0"
        for volume in volumes
    ):
        raise ValueError("Unexpected MySQL data claim")
    claim = resource("pvc", "data-ops-mysql-0")
    if claim["status"].get("phase") != "Bound" or claim["metadata"].get("deletionTimestamp"):
        raise ValueError("MySQL data claim is not bound")
    service = resource("service", "ops-mysql")
    selector = service["spec"].get("selector", {})
    labels = pod["metadata"].get("labels", {})
    if (
        not selector
        or any(labels.get(key) != value for key, value in selector.items())
        or service["spec"].get("ports")
        != [{"name": "mysql", "port": 3306, "protocol": "TCP", "targetPort": "mysql"}]
    ):
        raise ValueError("Ops MySQL service route differs from the expected database")
    slices = read_json(
        namespaced
        + ["get", "endpointslices", "-l", "kubernetes.io/service-name=ops-mysql", "-o", "json"]
    )
    endpoints = [item for part in slices["items"] for item in part.get("endpoints", [])]
    if not endpoints or any(
        item.get("targetRef", {}).get("uid") != pod["metadata"]["uid"]
        or item.get("conditions", {}).get("ready") is not True
        for item in endpoints
    ):
        raise ValueError("Ops MySQL service has unknown or unready endpoints")
    return {
        "statefulset_uid": stateful["metadata"]["uid"],
        "pvc_uid": claim["metadata"]["uid"],
        "volume": claim["spec"]["volumeName"],
        "service_uid": service["metadata"]["uid"],
    }


def frozen_source(state, settings):
    require_dev(state, settings)
    record = read_connection(Path(state) / PROFILE, settings)
    if read_connection(Path(state) / BRIDGE, settings) != record:
        raise ValueError("Ops connection records differ")
    _, namespaced, _ = commands(state, settings)
    namespaced = [*namespaced, "--request-timeout=15s"]
    deployment = read_json(namespaced + ["get", "deployment", "ops-service", "-o", "json"])
    containers = deployment["spec"]["template"]["spec"]["containers"]
    if (
        deployment["spec"].get("replicas", 1) != 0
        or deployment.get("status", {}).get("replicas", 0) != 0
        or {item["name"] for item in containers} != {"ops-service", "ops-sync"}
    ):
        raise ValueError("Stop the Kubernetes Ops API and sync before DB backup")
    for container in containers:
        env = {item["name"]: item.get("value") for item in container.get("env", [])}
        if any(
            env.get(name) != value
            for name, value in {
                "DB_HOST": "ops-mysql",
                "DB_PORT": "3306",
                "DB_NAME": DATABASE,
            }.items()
        ):
            raise ValueError("Ops deployment does not use the supported database")
    if read_json(
        namespaced + ["get", "pods", "-l", "app.kubernetes.io/name=ops-service", "-o", "json"]
    )["items"]:
        raise ValueError("Ops Pods still exist; wait for writer termination")
    autoscalers = read_json(namespaced + ["get", "hpa", "-o", "json"])["items"]
    if any(item["spec"]["scaleTargetRef"].get("name") == "ops-service" for item in autoscalers):
        raise ValueError("Disable the Ops autoscaler before DB backup")
    project = record["composeProject"]
    identities = (
        storage.run(
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
    writers = {}
    services = []
    for identity in identities:
        if not re.fullmatch(r"[a-f0-9]{64}", identity):
            raise ValueError("Invalid Compose container identity")
        item = storage.inspect(identity)
        labels = item["Config"].get("Labels") or {}
        if item["Id"] != identity or labels.get("com.docker.compose.project") != project:
            raise ValueError("Compose ownership changed")
        service = labels.get("com.docker.compose.service")
        if service not in WRITERS:
            continue
        status = item["State"]
        if (
            status["Status"] not in {"exited", "created"}
            or status["Running"]
            or status.get("Paused")
            or status.get("Restarting")
        ):
            raise ValueError("Stop Compose Ops writers and Prefect before DB backup")
        services.append(service)
        writers[identity] = {
            "service": service,
            "image": item["Image"],
            "status": status["Status"],
            "started_at": status["StartedAt"],
            "finished_at": status["FinishedAt"],
            "restart_count": item["RestartCount"],
        }
    if services.count("prefect") != 1 or services.count("evaluation-runner") != 1:
        raise ValueError("Expected one stopped Prefect and evaluation-runner")
    pod = read_json(namespaced + ["get", "pod", "ops-mysql-0", "-o", "json"])
    statuses = pod["status"]["containerStatuses"]
    if (
        len(statuses) != 1
        or statuses[0]["name"] != "mysql"
        or not statuses[0]["ready"]
        or "running" not in statuses[0]["state"]
        or pod["metadata"].get("deletionTimestamp")
    ):
        raise ValueError("Expected a ready dedicated Ops MySQL Pod")
    image = statuses[0]["imageID"].removeprefix("docker-pullable://")
    if not re.fullmatch(r"(?:docker\.io/library/)?mysql@sha256:[a-f0-9]{64}", image):
        raise ValueError("Expected a pinned official MySQL image")
    image = "mysql@" + image.split("@", 1)[1]
    # It must already be available locally; never silently pull a replacement image.
    storage.run(["docker", "image", "inspect", image])
    return namespaced, {
        **database_identity(namespaced, pod),
        "repository": settings["repository"],
        "state_id": settings["stateId"],
        "namespace": settings["namespace"],
        "compose_project": project,
        "deployment_uid": deployment["metadata"]["uid"],
        "deployment_version": deployment["metadata"]["resourceVersion"],
        "pod_uid": pod["metadata"]["uid"],
        "mysql_image": image,
        "mysql_started_at": statuses[0]["state"]["running"]["startedAt"],
        "mysql_restart_count": statuses[0]["restartCount"],
        "writers": writers,
    }


def query(command, text):
    return storage.run([*command, *MYSQL], data=text.encode()).decode("utf-8").strip()


def inventory(command):
    names = query(command, TABLES).splitlines()
    if (
        not REQUIRED_TABLES.issubset(names)
        or len(names) != len(set(names))
        or any(not re.fullmatch(r"[a-z][a-z0-9_]*", name) for name in names)
    ):
        raise ValueError("Incomplete Ops table inventory")
    result = {}
    rows = query(command, "\n".join(f"SELECT '{name}', COUNT(*) FROM `{name}`;" for name in names))
    for row in rows.splitlines():
        name, count = row.split("\t")
        if name in result or not count.isdecimal():
            raise ValueError("Invalid table row count")
        result[name] = int(count)
    if set(result) != set(names):
        raise ValueError("Missing table row count")
    return result


def quiet_database(command, counts):
    checks = [
        "SELECT COUNT(*) FROM information_schema.EVENTS "
        "WHERE EVENT_SCHEMA=DATABASE() AND STATUS='ENABLED';",
        "SELECT COUNT(*) FROM evaluations_evaluationrun WHERE status NOT IN "
        "('COMPLETED','FAILED','CANCELLED','CRASHED');",
        "SELECT COUNT(*) FROM evaluations_evaluationbudgetreservation WHERE closed_at IS NULL;",
    ]
    schedules = {"evaluations_evaluationschedule", "evaluations_evaluationscheduleoccurrence"}
    if schedules.intersection(counts):
        if not schedules.issubset(counts):
            raise ValueError("Incomplete schedule tables")
        checks += [
            "SELECT COUNT(*) FROM evaluations_evaluationschedule WHERE paused_at IS NULL;",
            "SELECT COUNT(*) FROM evaluations_evaluationscheduleoccurrence "
            "WHERE status NOT IN ('SUBMITTED','BLOCKED');",
        ]
    if any(query(command, sql) != "0" for sql in checks):
        raise ValueError("Outstanding Ops work prevents a maintenance DB backup")


def dump(command):
    raw = storage.run([*command, *DUMP])
    if not raw or len(raw) > storage.MAX_BYTES or b"CREATE TABLE `django_migrations`" not in raw:
        raise ValueError("Missing, incomplete or oversized Ops SQL dump")
    return raw.decode("utf-8")


def private_parent(path):
    parent = path.parent.resolve(strict=True)
    info = parent.stat()
    if (
        parent.is_relative_to(REPOSITORY_ROOT.resolve())
        or info.st_uid != os.getuid()
        or stat.S_IMODE(info.st_mode) & 0o077
    ):
        raise ValueError("Use your private mode-0700 backup directory outside the repository")
    return parent / path.name


def validate(payload):
    if (
        not isinstance(payload, dict)
        or type(payload.get("schema_version")) is not int
        or payload.get("schema_version") != 1
        or payload.get("scope") != SCOPE
        or payload.get("database") != DATABASE
        or not isinstance(payload.get("mysql_image"), str)
        or not isinstance(payload.get("mysql_version"), str)
        or not isinstance(payload.get("sql"), str)
        or not re.fullmatch(r"mysql@sha256:[a-f0-9]{64}", payload.get("mysql_image", ""))
        or not re.fullmatch(r"8\.4\.\d+", payload.get("mysql_version", ""))
    ):
        raise ValueError("Unsupported Kubernetes Ops DB snapshot")
    sql = payload["sql"].encode("utf-8")
    if (
        not sql
        or len(sql) > storage.MAX_BYTES
        or hashlib.sha256(sql).hexdigest() != payload["sql_sha256"]
        or b"CREATE TABLE `django_migrations`" not in sql
    ):
        raise ValueError("Invalid SQL snapshot integrity")
    counts = payload["table_counts"]
    if (
        not isinstance(counts, dict)
        or not REQUIRED_TABLES.issubset(counts)
        or any(
            not isinstance(name, str)
            or not re.fullmatch(r"[a-z][a-z0-9_]*", name)
            or type(count) is not int
            or count < 0
            for name, count in counts.items()
        )
    ):
        raise ValueError("Invalid snapshot row counts")
    return payload


def backup(state, key_file, output):
    key = storage.key_bytes(key_file)
    output = private_parent(output)
    if output.exists() or output.is_symlink():
        raise ValueError("Choose a new backup file; existing output is never overwritten")
    settings = load_settings(state)
    namespaced, before = frozen_source(state, settings)
    command = [*namespaced, "exec", "-i", "ops-mysql-0", "-c", "mysql", "--", *storage.AUTH]
    version = query(command, "SELECT VERSION();")
    counts = inventory(command)
    quiet_database(command, counts)
    sql = dump(command)
    if (
        frozen_source(state, settings)[1] != before
        or inventory(command) != counts
        or dump(command) != sql
    ):
        raise ValueError("Source changed during DB backup; no archive was published")
    # Recheck writer state after the final DB read as well.
    if frozen_source(state, settings)[1] != before:
        raise ValueError("Source writers changed during DB backup")
    payload = validate(
        {
            "schema_version": 1,
            "scope": SCOPE,
            "database": DATABASE,
            "mysql_image": before["mysql_image"],
            "mysql_version": version,
            "source": before,
            "created_at": datetime.now(UTC).isoformat(),
            "sql": sql,
            "sql_sha256": hashlib.sha256(sql.encode()).hexdigest(),
            "table_counts": counts,
        }
    )
    raw = storage.seal(payload, key)
    if validate(storage.open_payload(raw, key)) != payload:
        raise ValueError("Encrypted DB snapshot round trip failed")
    storage.exclusive(output, raw)
    return {
        "status": "BACKED_UP",
        "scope": SCOPE,
        "sha256": hashlib.sha256(raw).hexdigest(),
        "tables": len(counts),
        "rows": sum(counts.values()),
        "restore_verified": False,
        "full_backup_verified": False,
        "services_changed": False,
    }


def verify(archive, key_file):
    key = storage.key_bytes(key_file)
    with os.fdopen(os.open(archive, os.O_RDONLY | os.O_NOFOLLOW), "rb") as source:
        info = os.fstat(source.fileno())
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_mode & 0o077
            or info.st_nlink != 1
            or info.st_uid != os.getuid()
        ):
            raise ValueError("Use a private regular encrypted archive")
        raw = source.read(storage.MAX_BYTES * 4 + 1)
    payload = validate(storage.open_payload(raw, key))
    storage.run(["docker", "image", "inspect", payload["mysql_image"]])
    identity = None
    try:
        identity = (
            storage.run(
                [
                    "docker",
                    "create",
                    "--pull=never",
                    "--name",
                    "govbiz-ops-db-verify-" + uuid4().hex,
                    "--network=none",
                    "--memory=512m",
                    "--pids-limit=128",
                    "--tmpfs=/var/lib/mysql:rw,nosuid,size=384m",
                    "--env",
                    "MYSQL_ROOT_PASSWORD",
                    "--env",
                    "MYSQL_DATABASE=" + DATABASE,
                    payload["mysql_image"],
                    "--event-scheduler=OFF",
                    "--mysqlx=0",
                    "--performance-schema=OFF",
                    "--innodb-buffer-pool-size=64M",
                    "--skip-log-bin",
                ],
                env={**os.environ, "MYSQL_ROOT_PASSWORD": secrets.token_hex(32)},
            )
            .decode()
            .strip()
        )
        if not re.fullmatch(r"[a-f0-9]{64}", identity):
            identity = None
            raise ValueError("Invalid disposable MySQL identity")
        storage.run(["docker", "start", identity])
        command = ["docker", "exec", "-i", identity, *storage.AUTH]
        deadline = time.monotonic() + 90
        while True:
            try:
                version = query(command, "SELECT VERSION();")
                break
            except storage.SnapshotError:
                if time.monotonic() >= deadline:
                    raise ValueError("Disposable MySQL did not become ready") from None
                time.sleep(1)
        if version != payload["mysql_version"] or query(command, "SHOW TABLES;"):
            raise ValueError("Restore requires a new empty MySQL of the exact source version")
        query(command, payload["sql"])
        if inventory(command) != payload["table_counts"] or dump(command) != payload["sql"]:
            raise ValueError("Restored database differs from encrypted backup")
    finally:
        if identity is not None:
            storage.run(["docker", "rm", "--force", "--volumes", identity])
    return {
        "status": "VERIFIED",
        "scope": SCOPE,
        "sha256": hashlib.sha256(raw).hexdigest(),
        "tables": len(payload["table_counts"]),
        "rows": sum(payload["table_counts"].values()),
        "restore_verified": True,
        "cleanup_complete": True,
        "full_backup_verified": False,
        "application_started": False,
        "model_api_calls": 0,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    create = actions.add_parser("backup")
    create.add_argument("--state-dir", type=Path, default=STATE)
    create.add_argument("--output", type=Path, required=True)
    create.add_argument("--key-file", type=Path, required=True)
    check = actions.add_parser("verify")
    check.add_argument("--archive", type=Path, required=True)
    check.add_argument("--key-file", type=Path, required=True)
    args = parser.parse_args()
    if os.name != "posix":
        parser.error("Run this command inside WSL/Linux")
    os.umask(0o077)
    try:
        result = (
            backup(args.state_dir, args.key_file, args.output)
            if args.action == "backup"
            else verify(args.archive, args.key_file)
        )
        print(json.dumps(result, sort_keys=True))
    except (ValueError, KeyError, TypeError, OSError):
        # Never print raw SQL, credentials, remote output or archive contents.
        parser.exit(
            1, "Ops DB snapshot failed; no source writes, overwrite or automatic restart.\n"
        )


if __name__ == "__main__":
    main()
