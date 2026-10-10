"""Bundle a frozen Kubernetes Ops DB archive with its results and Prefect SQLite.

WSL/Linux only. No service stop/start, existing-store restore, migration or plaintext key export.
This is a storage backup, not proof of application recovery or upgrade approval.
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import ops_db_snapshot as database
import ops_runtime_keys as runtime_keys
import ops_volume_restore_probe as probe
import ops_volume_snapshot_files as files
from ops_state_links import completed_evidence

storage = database.storage
SCOPE = "kubernetes_ops_db_results_prefect"
STORES = {
    "results": ("evaluation-runner", "/results", "ops-results"),
    "prefect": ("prefect", "/var/lib/prefect", "prefect-data"),
}
HELPER = (
    "import sys, types\n"
    "module = types.ModuleType('ops_volume_restore_probe')\n"
    "sys.modules[module.__name__] = module\n"
    "exec("
    + repr(Path(probe.__file__).read_text(encoding="utf-8"))
    + ", module.__dict__)\n"
    + Path(files.__file__).read_text(encoding="utf-8")
)


def volume_sources(source):
    """Describe frozen PVCs or owned Compose volumes and their local restore image."""
    if "evaluation" in source:
        image = database.read_json(
            [
                "docker",
                "image",
                "inspect",
                source["evaluation"]["deployments"]["prefect"]["image"],
            ]
        )[0]["Id"]
        return {
            kind: {**store, "image": image}
            for kind, store in source["evaluation"]["stores"].items()
        }
    project = source["compose_project"]
    result = {}
    for kind, (service, destination, suffix) in STORES.items():
        owners = [
            (identity, row)
            for identity, row in source["writers"].items()
            if row["service"] == service
        ]
        if len(owners) != 1:
            raise ValueError("Expected exactly one source writer per store")
        owner, record = owners[0]
        volume = project + "_" + suffix
        info = database.read_json(["docker", "volume", "inspect", volume])[0]
        volume_labels = info.get("Labels") or {}
        if (
            info["Name"] != volume
            or info.get("Driver") != "local"
            or info.get("Options")
            or volume_labels.get("com.docker.compose.project") != project
            or volume_labels.get("com.docker.compose.volume") != suffix
        ):
            raise ValueError("Unexpected volume ownership or storage driver")
        identities = (
            storage.run(["docker", "ps", "-aq", "--no-trunc", "--filter", "volume=" + volume])
            .decode()
            .split()
        )
        if owner not in identities or len(identities) != len(set(identities)):
            raise ValueError("Source volume is not attached to its expected writer")
        consumers = {}
        for identity in identities:
            if not re.fullmatch(r"[a-f0-9]{64}", identity):
                raise ValueError("Invalid source consumer identity")
            item = storage.inspect(identity)
            labels = item["Config"].get("Labels") or {}
            name = labels.get("com.docker.compose.service")
            if (
                item["Id"] != identity
                or labels.get("com.docker.compose.project") != project
                or str(labels.get("com.docker.compose.oneoff", "false")).lower() != "false"
                or name
                not in ({"prefect"} if kind == "prefect" else storage.WRITERS | {"ops-artifacts"})
            ):
                raise ValueError("Unknown container uses the source volume")
            mounts = [mount for mount in item["Mounts"] if mount.get("Name") == volume]
            if (
                len(mounts) != 1
                or mounts[0].get("Type") != "volume"
                or mounts[0].get("Destination") != destination
                or (name == "ops-artifacts" and mounts[0].get("RW") is not False)
            ):
                raise ValueError("Unexpected source mount")
            state = item["State"]
            if name != "ops-artifacts" and (
                state.get("Running")
                or state.get("Paused")
                or state.get("Restarting")
                or state.get("Status") not in {"created", "exited"}
                or identity not in source["writers"]
                or item["Image"] != source["writers"][identity]["image"]
            ):
                raise ValueError("Source volume writer is not frozen")
            if identity == owner and kind == "prefect":
                env = storage.environment(item)
                if (
                    env.get("PREFECT_HOME") != destination
                    or env.get("PREFECT_PROFILES_PATH")
                    or any(
                        value != "sqlite+aiosqlite:////var/lib/prefect/prefect.db"
                        for key, value in env.items()
                        if "DATABASE_CONNECTION_URL" in key
                    )
                ):
                    raise ValueError("Only the standard local Prefect SQLite store is supported")
            consumers[identity] = {
                "image": item["Image"],
                "service": name,
                "state": state["Status"],
                "started_at": state["StartedAt"],
                "finished_at": state["FinishedAt"],
                "restart_count": item["RestartCount"],
                "writable": mounts[0]["RW"],
            }
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", record["image"]):
            raise ValueError("Source helper image must be immutable")
        result[kind] = {
            "volume": volume,
            "created_at": info["CreatedAt"],
            "image": record["image"],
            "consumers": consumers,
        }
    return result


def collect_source(state, settings, before, kind, source):
    if "evaluation" in before:
        import evaluation_snapshot

        kube, _, _ = database.commands(state, settings)
        return evaluation_snapshot.collect(kube, before["evaluation"], kind, HELPER)
    return volume_helper(source["image"], kind, source=source["volume"])


def volume_helper(image, kind, *, source=None, entries=None, expected=None):
    if kind not in STORES or (source is None) == (entries is None):
        raise ValueError("Select one source read or disposable restore")
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", image):
        raise ValueError("Expected a local immutable helper image")
    if entries is not None:
        files.validate(entries)
    elif not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,80}", source):
        raise ValueError("Invalid named source volume")
    if expected is not None:
        if source is not None:
            raise ValueError("Link verification only reads a restored store")
        probe.expected_runs(expected)
    storage.run(["docker", "image", "inspect", image])
    # Mounting a missing named volume would create it; require it to exist first.
    if source is not None:
        storage.run(["docker", "volume", "inspect", source])
    identity = None
    try:
        args = [
            "docker",
            "create",
            "--interactive",
            "--pull=never",
            "--name",
            "govbiz-ops-store-verify-" + uuid4().hex,
            "--network=none",
            "--log-driver=none",
            "--read-only",
            "--user=0:0",
            "--cap-drop=ALL",
            "--cap-add=DAC_OVERRIDE",
            "--cap-add=CHOWN",
            "--security-opt=no-new-privileges:true",
            "--memory=512m",
            "--pids-limit=32",
            "--tmpfs=/tmp:rw,noexec,nosuid,size=16m",
        ]
        if source is not None:
            args += [
                "--mount",
                "type=volume,source=" + source + ",target=/source,readonly",
            ]
        else:
            args += ["--tmpfs=/restore:rw,noexec,nosuid,size=192m"]
        args += [
            "--entrypoint",
            "python",
            image,
            "-B",
            "-c",
            HELPER,
            "collect" if source is not None else "restore",
            kind,
        ]
        identity = storage.run(args).decode().strip()
        if not re.fullmatch(r"[a-f0-9]{64}", identity):
            identity = None
            raise ValueError("Invalid helper identity")
        raw = storage.run(
            ["docker", "start", "--attach", "--interactive", identity],
            data=None
            if entries is None
            else json.dumps({"entries": entries, "expected": expected}).encode(),
        )
        state = database.read_json(["docker", "inspect", "--format", "{{json .State}}", identity])
        if state["Running"] or state["ExitCode"] != 0 or state["OOMKilled"]:
            raise ValueError("Volume helper did not exit successfully")
        result = json.loads(raw)
        if source is not None:
            files.validate(result)
        elif (
            not isinstance(result, dict)
            or result.get("status") != "VERIFIED"
            or result.get("permissions_verified") is not True
            or type(result.get("files")) is not int
            or result["files"] != sum(row["kind"] == "file" for row in entries.values())
            or type(result.get("bytes")) is not int
            or result["bytes"] != sum(row["size"] for row in entries.values())
            or result.get("tree_sha256")
            != hashlib.sha256(json.dumps(entries, sort_keys=True).encode()).hexdigest()
            or (kind == "prefect" and result.get("sqlite_integrity") is not True)
            or (
                expected is not None
                and (
                    type(result.get("matched_executions")) is not int
                    or result["matched_executions"]
                    != len(probe.prefect_runs(expected) if kind == "prefect" else expected)
                )
            )
        ):
            raise ValueError("Incomplete volume restore evidence")
    finally:
        if identity is not None:
            storage.run(["docker", "rm", "--force", "--volumes", identity])
    return result


def validate(payload):
    if (
        not isinstance(payload, dict)
        or type(payload.get("schema_version")) is not int
        or payload["schema_version"] != 1
        or payload.get("scope") != SCOPE
    ):
        raise ValueError("Unsupported Ops storage archive")
    database.validate(payload["database"])
    if "runtime_keys" in payload:
        runtime_keys.validate(payload["runtime_keys"])
    if not isinstance(payload["stores"], dict) or set(payload["stores"]) != set(STORES):
        raise ValueError("Missing source store")
    for kind, store in payload["stores"].items():
        if (
            not isinstance(store, dict)
            or not isinstance(store.get("image"), str)
            or not re.fullmatch(r"sha256:[a-f0-9]{64}", store["image"])
        ):
            raise ValueError("Missing immutable helper image")
        files.validate(store["entries"])
        if kind == "prefect" and (
            store["entries"].get("prefect.db", {}).get("kind") != "file"
            or "profiles.toml" in store["entries"]
        ):
            raise ValueError("Standard Prefect SQLite without custom profiles is required")
    return payload


def backup(state, db_archive, key_file, output, *, include_runtime_keys=False):
    key = storage.key_bytes(key_file)
    output = database.private_parent(output)
    if output.exists() or output.is_symlink():
        raise ValueError("Choose a new archive path")
    raw = database.read_archive(db_archive)
    db = database.validate(storage.open_payload(raw, key))
    settings = database.load_settings(state)
    options = {"kubernetes_evaluation": True} if "evaluation" in db.get("source", {}) else {}
    namespaced, before = database.frozen_source(state, settings, **options)
    if db.get("source") != before:
        raise ValueError("DB archive belongs to a different maintenance state")
    command = [
        *namespaced,
        "exec",
        "-i",
        "ops-mysql-0",
        "-c",
        "mysql",
        "--",
        *storage.AUTH,
    ]
    if database.dump(command) != db["sql"]:
        raise ValueError("Source DB has changed since its archive")
    sources = volume_sources(before)
    key_data = runtime_keys.capture(namespaced, before, sources) if include_runtime_keys else None
    key_proof = runtime_keys.run_probe(key_data, "capture") if key_data is not None else None
    stores = {
        kind: {
            "image": source["image"],
            "entries": collect_source(state, settings, before, kind, source),
        }
        for kind, source in sources.items()
    }
    for kind, source in sources.items():
        if collect_source(state, settings, before, kind, source) != stores[kind]["entries"]:
            raise ValueError("Volume changed during capture")
    if (
        database.dump(command) != db["sql"]
        or volume_sources(before) != sources
        or database.frozen_source(state, settings, **options)[1] != before
    ):
        raise ValueError("Source stores or writers changed during capture")
    if key_data is not None:
        if runtime_keys.capture(namespaced, before, sources) != key_data:
            raise ValueError("Runtime keys changed during capture")
        if database.frozen_source(state, settings, **options)[1] != before:
            raise ValueError("Source writers changed after the final key read")
    payload = validate(
        {
            "schema_version": 1,
            "scope": SCOPE,
            "database": db,
            "source_db_archive_sha256": hashlib.sha256(raw).hexdigest(),
            "created_at": datetime.now(UTC).isoformat(),
            "sources": sources,
            "stores": stores,
            **({"runtime_keys": {**key_data, "proof": key_proof}} if key_data is not None else {}),
        }
    )
    encrypted = storage.seal(payload, key)
    if validate(storage.open_payload(encrypted, key)) != payload:
        raise ValueError("Encrypted storage archive round trip failed")
    storage.exclusive(output, encrypted)
    return {
        "status": "BACKED_UP",
        "scope": SCOPE,
        "sha256": hashlib.sha256(encrypted).hexdigest(),
        "restore_verified": False,
        "full_backup_verified": False,
        "services_changed": False,
        "runtime_keys_included": key_data is not None,
    }


def verify_current_source(state, payload):
    """Compare an authenticated archive with its still-frozen source; never stop writers."""
    validate(payload)
    settings = database.load_settings(state)
    db = payload["database"]
    options = {"kubernetes_evaluation": True} if "evaluation" in db.get("source", {}) else {}
    namespaced, before = database.frozen_source(state, settings, **options)
    if before != db.get("source"):
        raise ValueError("Archive belongs to a different maintenance state")
    sources = volume_sources(before)
    if sources != payload.get("sources"):
        raise ValueError("Archived source volumes or consumers changed")
    command = [
        *namespaced,
        "exec",
        "-i",
        "ops-mysql-0",
        "-c",
        "mysql",
        "--",
        *storage.AUTH,
    ]

    def check_database():
        counts = database.inventory(command)
        database.quiet_database(command, counts)
        if counts != db["table_counts"] or database.dump(command) != db["sql"]:
            raise ValueError("Source DB differs from the archived database")

    def check_keys():
        if "runtime_keys" in payload:
            archived = {k: v for k, v in payload["runtime_keys"].items() if k != "proof"}
            if runtime_keys.capture(namespaced, before, sources) != archived:
                raise ValueError("Archived runtime credentials changed")

    check_database()
    check_keys()
    for kind, source in sources.items():
        store = payload["stores"][kind]
        if (
            source["image"] != store["image"]
            or collect_source(state, settings, before, kind, source) != store["entries"]
        ):
            raise ValueError("Source volume differs from the archived inventory")
    check_database()
    check_keys()
    if (
        database.load_settings(state) != settings
        or volume_sources(before) != sources
        or database.frozen_source(state, settings, **options) != (namespaced, before)
    ):
        raise ValueError("Source ownership or writer state changed during comparison")


def verify(
    archive,
    key_file,
    *,
    completed_links=False,
    verify_runtime_keys=False,
    database_login=False,
):
    if database_login and not verify_runtime_keys:
        raise ValueError("Database login verification requires runtime key verification")
    key = storage.key_bytes(key_file)
    raw = database.read_archive(archive)
    payload = validate(storage.open_payload(raw, key))
    if verify_runtime_keys and "runtime_keys" not in payload:
        raise ValueError("This archive has no runtime recovery keys")
    if database_login:
        database.validate_accounts(payload["runtime_keys"].get("database_accounts"))
    expected = None
    login_checks = None
    if completed_links or database_login:
        with database.restored_database(payload["database"]) as command:
            if completed_links:
                expected = completed_evidence(command, payload["stores"]["results"]["entries"])
            if database_login:
                login_checks = database.verify_database_login(
                    command,
                    payload["runtime_keys"]["database_accounts"],
                    payload["runtime_keys"]["keys"],
                    payload["database"]["table_counts"],
                )
        result = database.restore_report(payload["database"])
    else:
        result = database.restore_database(payload["database"])
    stores = {
        kind: volume_helper(store["image"], kind, entries=store["entries"], expected=expected)
        for kind, store in payload["stores"].items()
    }
    key_checks = None
    if verify_runtime_keys:
        key_data = payload["runtime_keys"]
        key_checks = runtime_keys.run_probe(key_data, "verify")
        count = runtime_keys.receipt_signatures(
            payload["stores"]["results"]["entries"], key_data["keys"]["budget"]
        )
        key_checks.update(
            signed_usage_receipts=count,
            usage_receipt_signatures_verified=count > 0,
            ops_budget_configured=key_data["ops_budget_configured"],
            database_login_verified=database_login,
            database_login_checks=login_checks,
            core_authentication_verified=False,
        )
    return {
        "status": "VERIFIED",
        "scope": SCOPE,
        "sha256": hashlib.sha256(raw).hexdigest(),
        "database": result,
        "stores": stores,
        "restore_verified": True,
        "cleanup_complete": True,
        "full_backup_verified": False,
        "application_started": False,
        "cross_store_business_links_verified": completed_links,
        "cross_store_scope": (
            "local_executions_and_shared_review_copies"
            if expected and any("shared_review_copy" in row for row in expected.values())
            else ("completed_evaluations" if completed_links else None)
        ),
        "matched_completed_evaluations": len(expected) if expected is not None else 0,
        "matched_prefect_executions": len(probe.prefect_runs(expected or {})),
        "shared_review_copies_verified": sum(
            "shared_review_copy" in row for row in (expected or {}).values()
        ),
        "runtime_keys_verified": verify_runtime_keys,
        "runtime_key_checks": key_checks,
        "model_api_calls": 0,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    create = actions.add_parser("backup")
    create.add_argument("--state-dir", type=Path, default=database.STATE)
    create.add_argument("--db-archive", type=Path, required=True)
    create.add_argument("--output", type=Path, required=True)
    create.add_argument("--key-file", type=Path, required=True)
    create.add_argument("--runtime-keys", action="store_true")
    check = actions.add_parser("verify")
    check.add_argument("--archive", type=Path, required=True)
    check.add_argument("--key-file", type=Path, required=True)
    check.add_argument("--completed-links", action="store_true")
    check.add_argument("--runtime-keys", action="store_true")
    check.add_argument("--database-login", action="store_true")
    args = parser.parse_args()
    if os.name != "posix":
        parser.error("Run this command inside WSL/Linux")
    os.umask(0o077)
    try:
        result = (
            backup(
                args.state_dir,
                args.db_archive,
                args.key_file,
                args.output,
                include_runtime_keys=args.runtime_keys,
            )
            if args.action == "backup"
            else verify(
                args.archive,
                args.key_file,
                completed_links=args.completed_links,
                verify_runtime_keys=args.runtime_keys,
                database_login=args.database_login,
            )
        )
        print(json.dumps(result, sort_keys=True))
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError):
        parser.exit(1, "Ops storage snapshot failed; no source writes or automatic restart.\n")


if __name__ == "__main__":
    main()
