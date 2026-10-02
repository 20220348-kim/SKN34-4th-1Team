"""Offline archive/restore checks run inside a networkless disposable container."""

import hashlib
import json
import os
import re
import shutil
import sqlite3
import stat
import sys
import tarfile
import tempfile
from pathlib import Path
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
    return value


def check_prefect(root, expected):
    path = root / "prefect.db"
    if not path.is_file():
        raise ValueError("Prefect SQLite database is missing")
    # Never use immutable=1: it can ignore committed data still in the WAL.
    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as database:
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


def verify(source, target, kind, expected):
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
    if tree(source) != before:
        raise ValueError("Source volume changed during verification")
    result["source_preserved"] = True
    return result


if __name__ == "__main__":
    # Arguments contain only fixture execution identities and report hashes.
    value = json.loads(sys.argv[1])
    print(
        json.dumps(
            verify(Path("/source"), Path("/restore"), value["kind"], value["expected"])
        )
    )
