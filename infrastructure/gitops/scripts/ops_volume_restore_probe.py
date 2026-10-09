"""Offline archive/restore checks run inside a networkless disposable container."""

import hashlib
import json
import os
import re
import secrets
import shutil
import sqlite3
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
from contextlib import closing
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from uuid import UUID

MAX_BYTES = 64 * 1024 * 1024
MAX_ENTRIES = 10000


def tree(root):
    result = {}
    total = 0
    for path in [root, *sorted(root.rglob("*"))]:
        info = path.lstat()
        if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
            raise ValueError("Only regular files and directories may be restored")
        if info.st_mode & 0o7000 or (path.is_file() and info.st_nlink != 1):
            raise ValueError("Special permissions and hard links are unsupported")
        directory = stat.S_ISDIR(info.st_mode)
        size = 0 if directory else info.st_size
        total += size
        if total > MAX_BYTES or len(result) >= MAX_ENTRIES:
            raise ValueError("Volume exceeds the isolated rehearsal size limit")
        result[path.relative_to(root).as_posix()] = {
            "kind": "directory" if directory else "file",
            "mode": stat.S_IMODE(info.st_mode),
            "uid": info.st_uid,
            "gid": info.st_gid,
            "mtime_ns": info.st_mtime_ns,
            "size": size,
            "sha256": None
            if directory
            else hashlib.sha256(path.read_bytes()).hexdigest(),
        }
    return result


def restore(source, target):
    if (
        source.resolve().is_relative_to(target.resolve())
        or target.resolve().is_relative_to(source.resolve())
        or source.is_symlink()
        or target.is_symlink()
    ):
        raise ValueError("Restore requires separate regular directories")
    if not source.is_dir() or not target.is_dir() or any(target.iterdir()):
        raise ValueError("Restore destination must be an empty directory")
    before = tree(source)
    if not any(row["kind"] == "file" for row in before.values()):
        raise ValueError("Source volume has no files")
    with tempfile.TemporaryFile() as archive:
        with tarfile.open(fileobj=archive, mode="w") as writer:
            for name in before:
                writer.add(source / name, arcname=name, recursive=False)
        archive.seek(0)
        with tarfile.open(fileobj=archive, mode="r") as reader:
            seen = set()
            for member in reader:
                # Compare against the validated source inventory, never trust a
                # general-purpose extractall path or a link stored in a tar file.
                if member.name not in before or member.name in seen:
                    raise ValueError("Unexpected archive entry")
                expected = before[member.name]
                if not (
                    member.isdir()
                    if expected["kind"] == "directory"
                    else member.isfile()
                ):
                    raise ValueError("Archive file type changed")
                seen.add(member.name)
                destination = target / member.name
                if member.isdir():
                    destination.mkdir(exist_ok=True)
                else:
                    with (
                        reader.extractfile(member) as incoming,
                        destination.open("xb") as outgoing,
                    ):
                        shutil.copyfileobj(incoming, outgoing)
            if seen != set(before):
                raise ValueError("Archive entries are missing")
    # Apply ownership last, including the volume root; writes only target files.
    for name, row in reversed(list(before.items())):
        destination = target / name
        destination.chmod(row["mode"])
        os.utime(destination, ns=(row["mtime_ns"], row["mtime_ns"]))
        os.chown(destination, row["uid"], row["gid"])
    if tree(source) != before or tree(target) != before:
        raise ValueError("Source or restored volume changed")
    return before


def expected_runs(value):
    if not isinstance(value, dict) or not value:
        raise ValueError("Completed execution evidence is required")
    for request, row in value.items():
        if str(UUID(request)) != request or str(UUID(row["flow_id"])) != row["flow_id"]:
            raise ValueError("Noncanonical execution identity")
        if not re.fullmatch(r"[a-f0-9]{64}", row["report_sha256"]):
            raise ValueError("Missing authenticated report digest")
        if "shared_review_copy" in row:
            copy = row["shared_review_copy"]
            if (
                not isinstance(copy, dict)
                or set(copy) != {"seed_id", "seed_sha256", "artifacts_verified"}
                or not isinstance(copy["seed_id"], str)
                or not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", copy["seed_id"])
                or not isinstance(copy["seed_sha256"], str)
                or not re.fullmatch(r"[a-f0-9]{64}", copy["seed_sha256"])
                or type(copy["artifacts_verified"]) is not int
                or copy["artifacts_verified"] < 6
            ):
                raise ValueError("Incomplete shared review provenance")
    return value


def prefect_runs(expected):
    """Shared copies retain reports but do not claim local Prefect history."""
    if not expected:
        return {}
    return {
        request: row
        for request, row in expected_runs(expected).items()
        if "shared_review_copy" not in row
    }


def check_prefect(root, expected):
    expected = prefect_runs(expected)
    path = root / "prefect.db"
    if not path.is_file():
        raise ValueError("Prefect SQLite database is missing")
    # Never use immutable=1: it can ignore committed data still in the WAL.
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as database:
        database.execute("PRAGMA query_only=ON")
        if database.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise ValueError("Prefect SQLite integrity check failed")
        if database.execute("PRAGMA foreign_key_check").fetchall():
            raise ValueError("Prefect SQLite reference check failed")
        migrations = database.execute(
            "SELECT version_num FROM alembic_version"
        ).fetchall()
        if not migrations or any(not row[0] for row in migrations):
            raise ValueError("Prefect migration history is missing")
        if database.execute(
            "SELECT COUNT(*) FROM deployment_schedule WHERE active != 0"
        ).fetchone()[0]:
            raise ValueError(
                "Active Prefect schedules cannot be restored for this rehearsal"
            )
        if database.execute(
            "SELECT COUNT(*) FROM flow_run WHERE state_type IS NULL OR state_type NOT IN ('COMPLETED','FAILED','CANCELLED','CRASHED')"
        ).fetchone()[0]:
            raise ValueError("Unfinished Prefect executions remain")
        for request, evidence in expected.items():
            flow = UUID(evidence["flow_id"]).hex
            rows = database.execute(
                "SELECT state_type, parameters, deployment_id FROM flow_run WHERE replace(id, '-', '')=?",
                (flow,),
            ).fetchall()
            if (
                len(rows) != 1
                or rows[0][0] != "COMPLETED"
                or json.loads(rows[0][1]).get("request_id") != request
            ):
                raise ValueError("Completed Prefect execution was not preserved")
            deployment = rows[0][2]
            if (
                not deployment
                or not database.execute(
                    "SELECT id FROM deployment WHERE id=?", (deployment,)
                ).fetchone()
            ):
                raise ValueError("Prefect deployment was not preserved")
            if not database.execute(
                "SELECT id FROM flow_run_state WHERE replace(flow_run_id, '-', '')=? AND type='COMPLETED'",
                (flow,),
            ).fetchone():
                raise ValueError("Prefect completed state history is missing")
        return {
            "sqlite_integrity": True,
            "migration_count": len(migrations),
            "matched_executions": len(expected),
        }


def sqlite_digest(root):
    with closing(
        sqlite3.connect((root / "prefect.db").as_uri() + "?mode=ro", uri=True)
    ) as db:
        db.execute("PRAGMA query_only=ON")
        return hashlib.sha256("\n".join(sorted(db.iterdump())).encode()).hexdigest()


def prefect_json(path):
    class NoRedirect(HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None

    client = build_opener(ProxyHandler({}), NoRedirect())
    with client.open("http://127.0.0.1:4200/api" + path, timeout=3) as response:
        raw = response.read(4 * 1024 * 1024 + 1)
        if response.status != 200 or len(raw) > 4 * 1024 * 1024:
            raise ValueError("Unexpected restored Prefect HTTP response")
        return json.loads(raw)


def completed_prefect_execution(read, request, flow_id):
    """Read one completed execution and its deployment/state links in either runtime."""
    flow = read("/flow_runs/" + flow_id)
    if (
        flow["id"] != flow_id
        or flow["state_type"] != "COMPLETED"
        or flow["state"]["type"] != "COMPLETED"
        or flow["parameters"].get("request_id") != request
    ):
        raise ValueError("Prefect API completed execution differs")
    deployment_id = str(UUID(flow["deployment_id"]))
    deployment = read("/deployments/" + deployment_id)
    if deployment["id"] != deployment_id or deployment["flow_id"] != flow["flow_id"]:
        raise ValueError("Prefect API deployment differs")
    history = read("/flow_run_states/?flow_run_id=" + flow_id)
    states = [row for row in history if row["id"] == flow["state"]["id"]]
    if (
        len(states) != 1
        or states[0]["type"] != "COMPLETED"
        or states[0]["state_details"]["flow_run_id"] != flow["id"]
    ):
        raise ValueError("Prefect API state history differs")
    return flow


def check_prefect_api(root, expected):
    """Start only the restored API, never migrations, scheduling or a runner."""
    expected = prefect_runs(expected)
    before = sqlite_digest(root)
    with tempfile.TemporaryDirectory(prefix="prefect-restore-") as home:
        # No inherited profile, credentials, proxy, remote database or API URL.
        env = {
            "PATH": os.environ["PATH"],
            "HOME": home,
            "PREFECT_HOME": home,
            "PREFECT_PROFILES_PATH": str(Path(home) / "profiles.toml"),
            "PREFECT_SERVER_DATABASE_CONNECTION_URL": "sqlite+aiosqlite:///"
            + str(root / "prefect.db"),
            "PREFECT_API_DATABASE_MIGRATE_ON_START": "false",
            "PREFECT_API_BLOCKS_REGISTER_ON_START": "false",
            "PREFECT_SERVER_UI_ENABLED": "false",
            "PREFECT_SERVER_ANALYTICS_ENABLED": "false",
            "PREFECT_SERVER_SERVICES_SCHEDULER_ENABLED": "false",
            "PREFECT_SERVER_SERVICES_LATE_RUNS_ENABLED": "false",
            "PREFECT_SERVER_ALLOW_EPHEMERAL_MODE": "false",
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        server = subprocess.Popen(
            [
                "prefect",
                "server",
                "start",
                "--host",
                "127.0.0.1",
                "--port",
                "4200",
                "--no-services",
                "--analytics-off",
            ],
            env=env,
            cwd=home,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            deadline = time.monotonic() + 90
            while True:
                if server.poll() is not None:
                    raise ValueError(
                        "Restored Prefect server exited before verification"
                    )
                try:
                    if prefect_json("/health") is not True:
                        raise ValueError("Invalid restored Prefect health response")
                    break
                except (URLError, TimeoutError):
                    if time.monotonic() >= deadline:
                        raise ValueError(
                            "Restored Prefect API startup timed out"
                        ) from None
                    time.sleep(1)
            for request, evidence in expected.items():
                flow = completed_prefect_execution(
                    prefect_json, request, evidence["flow_id"]
                )
                if flow["parameters"].get("execution_mode") != "replay" or flow[
                    "parameters"
                ].get("live_config"):
                    raise ValueError("Restored Prefect API execution differs")
            if server.poll() is not None:
                raise ValueError("Restored Prefect server exited during verification")
        finally:
            server.terminate()
            try:
                code = server.wait(timeout=15)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=5)
                raise ValueError(
                    "Restored Prefect server did not stop cleanly"
                ) from None
            if code not in (0, -15, 143):
                raise ValueError("Restored Prefect server exit was unsuccessful")
    if sqlite_digest(root) != before:
        raise ValueError("Restored Prefect API changed database contents")
    return {
        "status": "PASS",
        "matched_executions": len(expected),
        "database_unchanged": True,
        "server_stopped": True,
        "scheduling_disabled": True,
        "automatic_migrations": False,
    }


def results_response(path, token=None, *, method="GET"):
    class NoRedirect(HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None

    client = build_opener(ProxyHandler({}), NoRedirect())
    request = Request(
        "http://127.0.0.1:8010" + path,
        headers={} if token is None else {"Authorization": "Bearer " + token},
        method=method,
    )
    try:
        response = client.open(request, timeout=3)
    except HTTPError as error:
        response = error
    with response:
        raw = response.read(8 * 1024 * 1024 + 1)
        if (
            len(raw) > 8 * 1024 * 1024
            or response.headers.get("Content-Length") != str(len(raw))
            or response.headers.get("Cache-Control") != "no-store"
            or response.headers.get("X-Content-Type-Options") != "nosniff"
        ):
            raise ValueError("Unexpected restored results HTTP response")
        return response.status, response.headers, raw


def check_results_api(root, expected):
    """Read restored reports as the image's runtime user with a fresh test token."""
    expected = expected_runs(expected)
    if os.getuid() != 10001 or os.getgid() != 10001:
        raise ValueError("Restored results API requires runtime UID/GID 10001")
    before = tree(root)
    token = secrets.token_hex(32)
    with tempfile.TemporaryDirectory(prefix="results-restore-") as home:
        evidence = Path(home) / "empty-evidence"
        evidence.mkdir()
        # Only the restored results are available. Never inherit DB/model credentials,
        # the original storage token, proxy settings or the original evidence mount.
        env = {
            "PATH": os.environ["PATH"],
            "HOME": home,
            "PYTHONDONTWRITEBYTECODE": "1",
            "LLMOPS_RESULTS_DIR": str(root),
            "LLMOPS_EVIDENCE_DIR": str(evidence),
            "LLMOPS_ARTIFACT_TOKEN": token,
        }
        server = subprocess.Popen(
            [
                sys.executable,
                "-B",
                "-m",
                "gunicorn",
                "apps.evaluations.artifact_server:create_app()",
                "--bind",
                "127.0.0.1:8010",
                "--workers",
                "1",
                "--timeout",
                "15",
                "--graceful-timeout",
                "5",
                "--worker-tmp-dir",
                home,
            ],
            env=env,
            cwd="/app",
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            deadline = time.monotonic() + 30
            while True:
                if server.poll() is not None:
                    raise ValueError(
                        "Restored results server exited before verification"
                    )
                try:
                    status, _, raw = results_response("/v1/status", token)
                    if status != 200 or json.loads(raw) != {
                        "schema_version": 1,
                        "results_readable": True,
                    }:
                        raise ValueError("Invalid restored results health response")
                    break
                except (URLError, TimeoutError):
                    if time.monotonic() >= deadline:
                        raise ValueError(
                            "Restored results API startup timed out"
                        ) from None
                    time.sleep(1)
            for request, row in expected.items():
                path = "/v1/results/" + request + "/evaluation/report.html"
                for credential in (None, "invalid-restore-token"):
                    status, _, raw = results_response(path, credential)
                    if status != 401 or json.loads(raw) != {
                        "code": "ARTIFACT_AUTH_REQUIRED"
                    }:
                        raise ValueError(
                            "Restored results API accepted invalid credentials"
                        )
                for method in ("POST", "PUT", "DELETE"):
                    status, headers, raw = results_response(path, token, method=method)
                    if (
                        status != 405
                        or headers.get("Allow") != "GET"
                        or json.loads(raw) != {"code": "READ_ONLY"}
                    ):
                        raise ValueError("Restored results API accepted a write method")
                status, _, raw = results_response(path, token)
                if (
                    status != 200
                    or hashlib.sha256(raw).hexdigest() != row["report_sha256"]
                ):
                    raise ValueError("Restored results HTTP report digest differs")
            if server.poll() is not None:
                raise ValueError("Restored results server exited during verification")
        finally:
            server.terminate()
            try:
                code = server.wait(timeout=15)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=5)
                raise ValueError(
                    "Restored results server did not stop cleanly"
                ) from None
            if code not in (0, -15, 143):
                raise ValueError("Restored results server exit was unsuccessful")
    if tree(root) != before:
        raise ValueError("Restored results API changed files")
    return {
        "status": "PASS",
        "matched_reports": len(expected),
        "unauthenticated_rejected": True,
        "invalid_token_rejected": True,
        "writes_rejected": True,
        "files_unchanged": True,
        "server_stopped": True,
        "runtime_uid": 10001,
    }


def verify(source, target, kind, expected, *, api=False):
    expected = expected_runs(expected)
    if kind not in {"results", "prefect"}:
        raise ValueError("Unsupported volume kind")
    before = restore(source, target)
    result = {
        "status": "PASS",
        "file_count": sum(row["kind"] == "file" for row in before.values()),
        "total_bytes": sum(row["size"] for row in before.values()),
        "tree_sha256": hashlib.sha256(
            json.dumps(before, sort_keys=True).encode()
        ).hexdigest(),
        "permissions_preserved": True,
    }
    if kind == "results":
        for request, evidence in expected.items():
            row = before.get(request + "/evaluation/report.html")
            if not row or row["sha256"] != evidence["report_sha256"]:
                raise ValueError("Authenticated report digest was not preserved")
        result["matched_reports"] = len(expected)
    else:
        result.update(check_prefect(target, expected))
        if api:
            result["api"] = check_prefect_api(target, expected)
    if tree(source) != before:
        raise ValueError("Source volume changed during verification")
    result["source_preserved"] = True
    return result


if __name__ == "__main__":
    # Arguments contain only fixture execution identities and report hashes.
    value = json.loads(sys.argv[1])
    if value.get("phase") == "results-api" and value["kind"] == "results":
        result = check_results_api(Path("/restore"), value["expected"])
    elif "phase" not in value:
        result = verify(
            Path("/source"),
            Path("/restore"),
            value["kind"],
            value["expected"],
            api=value["kind"] == "prefect",
        )
    else:
        raise ValueError("Unsupported restore verification phase")
    print(json.dumps(result))
