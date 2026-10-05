"""Rehearse an encrypted 0017 Ops DB upgrade in disposable MySQL; never deploy."""

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from uuid import uuid4

import ops_db_snapshot as database
from ops_db_upgrade_probe import source_digest

storage = database.storage
PROBE = Path(__file__).with_name("ops_db_upgrade_probe.py").read_text(encoding="utf-8")


def run_upgrade(command, image, payload):
    target = database.require_disposable_database(command)
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", image):
        raise ValueError("Use an immutable local Ops image ID")
    inspected = database.read_json(["docker", "image", "inspect", image])[0]
    if inspected["Id"] != image or inspected["Config"].get("User") != "10001:10001":
        raise ValueError("Unexpected Ops image identity or runtime user")
    expected = {
        "schema_version": 1,
        "source_sha256": source_digest(database.REPOSITORY_ROOT / "backend/ops-service"),
        "password": storage.environment(target)["MYSQL_ROOT_PASSWORD"],
        "table_counts": payload["table_counts"],
    }
    identity = None
    try:
        identity = (
            storage.run(
                [
                    "docker",
                    "create",
                    "--interactive",
                    "--pull=never",
                    "--name",
                    "govbiz-ops-upgrade-verify-" + uuid4().hex,
                    "--network=container:" + target["Id"],
                    "--log-driver=none",
                    "--read-only",
                    "--cap-drop=ALL",
                    "--security-opt=no-new-privileges:true",
                    "--memory=384m",
                    "--pids-limit=64",
                    "--tmpfs=/tmp:rw,noexec,nosuid,size=32m,mode=1777",
                    "--entrypoint",
                    "python",
                    image,
                    "-B",
                    "-c",
                    PROBE,
                ]
            )
            .decode()
            .strip()
        )
        if not re.fullmatch(r"[a-f0-9]{64}", identity):
            identity = None
            raise ValueError("Invalid upgrade helper identity")
        raw = storage.run(
            ["docker", "start", "--attach", "--interactive", identity],
            data=json.dumps(expected).encode(),
            timeout=180,
        )
        state = database.read_json(["docker", "inspect", "--format", "{{json .State}}", identity])
        if state["Running"] or state["ExitCode"] != 0 or state["OOMKilled"]:
            raise ValueError("Upgrade helper did not complete")
        result = json.loads(raw)
        required = {
            "schema_ready",
            "admission_paused",
            "admission_guard_rejected",
            "repeat_verified",
            "original_rows_preserved",
            "unknown_token_bounds_preserved",
        }
        if (
            set(result)
            != required
            | {
                "status",
                "source_sha256",
                "from_evaluations",
                "to_evaluations",
                "applied_migrations",
                "preserved_tables",
                "preserved_rows",
            }
            or result["status"] != "REHEARSED"
            or result["source_sha256"] != expected["source_sha256"]
            or any(result[key] is not True for key in required)
            or result["from_evaluations"] != "0017_input_token_budget"
            or not re.fullmatch(r"\d{4}_[a-z0-9_]+", result["to_evaluations"])
            or type(result["applied_migrations"]) is not int
            or result["applied_migrations"] < 1
            or type(result["preserved_tables"]) is not int
            or result["preserved_tables"] != len(payload["table_counts"])
            or type(result["preserved_rows"]) is not int
            or result["preserved_rows"] != sum(payload["table_counts"].values())
        ):
            raise ValueError("Incomplete upgrade rehearsal result")
    finally:
        if identity is not None:
            storage.run(["docker", "rm", "--force", "--volumes", identity])
    return result


def rehearse(archive, key_file, image):
    key = storage.key_bytes(key_file)
    raw = database.read_archive(archive)
    payload = database.validate(storage.open_payload(raw, key))
    with database.restored_database(payload) as command:
        result = run_upgrade(command, image, payload)
    return {
        **result,
        "scope": "disposable_ops_database_upgrade",
        "archive_sha256": hashlib.sha256(raw).hexdigest(),
        "image_id": image,
        "cleanup_complete": True,
        "personal_environment_verified": False,
        "full_backup_verified": False,
        "services_changed": False,
        "application_started": False,
        "core_authentication_verified": False,
        "model_api_calls": 0,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--key-file", type=Path, required=True)
    parser.add_argument("--ops-image", required=True)
    args = parser.parse_args()
    if os.name != "posix":
        parser.error("Run this command inside WSL/Linux")
    os.umask(0o077)
    try:
        result = rehearse(args.archive, args.key_file, args.ops_image)
    except Exception:
        print("Ops DB upgrade rehearsal failed (private output withheld)", file=sys.stderr)
        raise SystemExit(1) from None
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
