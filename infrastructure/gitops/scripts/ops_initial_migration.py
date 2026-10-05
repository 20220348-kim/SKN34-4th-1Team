"""Verify a frozen legacy Ops backup, then optionally migrate and leave writers stopped.

Personal WSL/kind only. No stop/start, application rollout, admission resume or DB restore.
Execution requires a separate operator-approved outage and original-DB migration.
"""

import argparse
import hashlib
import io
import json
import os
import re
import sys
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import quote
from uuid import UUID

import fork_cluster as cluster

# fork_cluster installs the repository's release module path.
import gate
import ops_db_snapshot as database
import ops_db_upgrade as upgrade
import ops_runtime_keys as runtime_keys
import ops_state_snapshot as snapshot
import yaml
from ops_migration import run_migration
from repository import from_origin


def pause_arguments(request_id, actor, reason):
    request = str(UUID(str(request_id)))
    values = [request]
    for value, limit in ((actor, 150), (reason, 500)):
        if (
            not isinstance(value, str)
            or not 1 <= len(value.strip()) <= limit
            or any(ord(char) < 32 or ord(char) == 127 for char in value)
        ):
            raise ValueError("Invalid pause operator or reason")
        values.append(value.strip())
    return dict(zip(("request_id", "actor", "reason"), values))


def source_evidence(settings, sha, branch):
    root = database.REPOSITORY_ROOT
    fork = from_origin(root, branch)
    if not gate.valid_sha(sha) or fork.repository != settings["repository"]:
        raise ValueError("Source repository or SHA differs from the personal state")
    git = ["git", "-C", str(root)]
    if (
        database.storage.run(git + ["rev-parse", "HEAD"]).decode().strip() != sha
        or database.storage.run(
            git + ["status", "--porcelain", "--untracked-files=all"]
        ).strip()
    ):
        raise ValueError("Use the exact committed clean checkout")
    reference = f"repos/{fork.repository}/git/ref/heads/{quote(branch, safe='')}"
    if gate.api(reference)["object"]["sha"] != sha:
        raise ValueError("Selected source is not the current remote branch head")
    evidence = []
    reason = gate.ci_blocked_reason(sha, fork, get=gate.api, evidence=evidence)
    if reason:
        raise ValueError("Source CI is not fully successful: " + reason)
    if gate.api(reference)["object"]["sha"] != sha:
        raise ValueError("Remote source changed during CI verification")
    return evidence


def initial_job(image, pause, deployment, helm):
    if (
        not isinstance(image, str)
        or not re.fullmatch(
            r"govbiz-ops-service:[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", image
        )
        or image.endswith(":latest")
    ):
        raise ValueError("Use an explicit local govbiz-ops-service tag")
    rendered = cluster.render_services(
        helm, {"ops-service": image}, services=("ops-service",)
    )["ops-service"]
    job = next(row for row in yaml.safe_load_all(rendered) if row["kind"] == "Job")
    container = job["spec"]["template"]["spec"]["containers"][0]
    target = {row["name"]: row for row in container["env"]}
    for current in deployment["spec"]["template"]["spec"]["containers"]:
        env = current.get("env", [])
        actual = {row["name"]: row for row in env}
        if (
            current.get("envFrom")
            or len(actual) != len(env)
            or any(
                actual.get(key) != target[key]
                for key in (
                    "DB_HOST",
                    "DB_PORT",
                    "DB_NAME",
                    "DB_USER",
                    "DB_PASSWORD",
                    "DJANGO_SECRET_KEY",
                )
            )
        ):
            raise ValueError("Migration database route or credential references differ")
    # This is an explicit maintenance Job, not a reusable Argo hook.
    job["metadata"].pop("annotations")
    container["args"] = [
        "--verbosity=0",
        "--pause-request-id=" + pause["request_id"],
        "--pause-actor=" + pause["actor"],
        "--pause-reason=" + pause["reason"],
    ]
    return job


def require_backup_source(state, settings, payload):
    namespaced, source = database.frozen_source(state, settings)
    db = payload["database"]
    if source != db.get("source"):
        raise ValueError(
            "Backup is not from this exact, still-frozen maintenance window"
        )
    command = [
        *namespaced,
        "exec",
        "-i",
        "ops-mysql-0",
        "-c",
        "mysql",
        "--",
        *database.storage.AUTH,
    ]
    database.quiet_database(command, db["table_counts"])
    if (
        database.inventory(command) != db["table_counts"]
        or database.dump(command) != db["sql"]
    ):
        raise ValueError("Original database changed since backup")
    sources = snapshot.volume_sources(source)
    if sources != payload["sources"]:
        raise ValueError("Original volume identities or consumers changed since backup")
    for kind, store in sources.items():
        if (
            snapshot.volume_helper(store["image"], kind, source=store["volume"])
            != payload["stores"][kind]["entries"]
        ):
            raise ValueError("Original result or Prefect files changed since backup")
    keys = {
        key: value for key, value in payload["runtime_keys"].items() if key != "proof"
    }
    if runtime_keys.capture(namespaced, source, sources) != keys:
        raise ValueError("Original runtime keys changed since backup")
    if database.frozen_source(state, settings)[1] != source:
        raise ValueError("Source writers changed during verification")
    return namespaced, source, command


def verify_pause(command, pause):
    state = database.query(
        command, "SELECT accepting, version FROM evaluations_evaluationadmission;"
    )
    changes = database.query(
        command,
        "SELECT JSON_OBJECT('request_id', request_id, 'accepting', accepting, 'version', version, "
        "'actor', actor, 'reason', reason) FROM evaluations_evaluationadmissionchange;",
    ).splitlines()
    if state != "0\t1" or len(changes) != 1:
        raise ValueError(
            "Initial admission pause was not confirmed; keep writers stopped"
        )
    change = json.loads(changes[0])
    if change != {
        **pause,
        "request_id": UUID(pause["request_id"]).hex,
        "accepting": 0,
        "version": 1,
    }:
        raise ValueError("Initial admission audit differs; keep writers stopped")


def migrate(args):
    pause = pause_arguments(args.pause_request_id, args.pause_actor, args.pause_reason)
    settings = database.load_settings(args.state_dir)
    if settings["stateId"] != args.expected_state_id:
        raise ValueError("Personal state identity differs from the selected target")
    cluster.require_dev(args.state_dir, settings)
    # Refuse active writers before reading archives or creating disposable containers.
    database.frozen_source(args.state_dir, settings)
    evidence = source_evidence(settings, args.source_sha, args.source_branch)
    archive = database.private_parent(args.archive)
    raw = database.read_archive(archive)
    payload = snapshot.validate(
        database.storage.open_payload(raw, database.storage.key_bytes(args.key_file))
    )
    if "runtime_keys" not in payload:
        raise ValueError("A verified state backup including runtime keys is required")
    namespaced, source, command = require_backup_source(
        args.state_dir, settings, payload
    )
    deployment = database.read_json(
        namespaced + ["get", "deployment", "ops-service", "-o", "json"]
    )
    if deployment["metadata"]["resourceVersion"] != source["deployment_version"]:
        raise ValueError("Ops Deployment changed")
    job = initial_job(args.ops_image, pause, deployment, args.helm)
    image = database.read_json(["docker", "image", "inspect", args.ops_image])[0]["Id"]
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", image):
        raise ValueError("Missing immutable local image identity")
    existing = database.storage.run(
        namespaced
        + ["get", "job", "ops-service-migrate", "--ignore-not-found", "-o", "name"]
    )
    if existing.strip():
        raise ValueError("Inspect the existing migration Job before any retry")
    restored = snapshot.verify(
        archive,
        args.key_file,
        completed_links=True,
        verify_runtime_keys=True,
        database_login=True,
    )
    if restored["sha256"] != hashlib.sha256(raw).hexdigest():
        raise ValueError("Backup changed during restore verification")
    with database.restored_database(payload["database"]) as restored_command:
        rehearsed = upgrade.run_upgrade(restored_command, image, payload["database"])
    report = {
        "schema_version": 1,
        "scope": "ops_initial_migration",
        "status": "VERIFIED_FOR_MIGRATION",
        "source_sha": args.source_sha,
        "source_branch": args.source_branch,
        "state_id": settings["stateId"],
        "frozen_source": source,
        "deployment_spec_sha256": hashlib.sha256(
            json.dumps(deployment["spec"], sort_keys=True).encode()
        ).hexdigest(),
        "database_pvc_uid": source["pvc_uid"],
        "database_pod_uid": source["pod_uid"],
        "archive_sha256": restored["sha256"],
        "target_image": args.ops_image,
        "target_image_id": image,
        "pause": pause,
        "ci": evidence,
        "rehearsal": rehearsed,
        "restore_verified": True,
        "full_backup_verified": False,
        "job_sha256": hashlib.sha256(
            json.dumps(job, sort_keys=True).encode()
        ).hexdigest(),
        "original_database_migration_attempted": False,
        "writers_resumed": False,
        "runtime_updated": False,
        "automatic_database_restore": False,
    }

    def recheck():
        if source_evidence(settings, args.source_sha, args.source_branch) != evidence:
            raise ValueError("CI evidence changed; run verification again")
        if (
            database.read_json(["docker", "image", "inspect", args.ops_image])[0]["Id"]
            != image
        ):
            raise ValueError("Target image tag changed")
        if database.read_archive(archive) != raw:
            raise ValueError("Encrypted archive changed")
        if require_backup_source(args.state_dir, settings, payload)[1] != source:
            raise ValueError("Frozen source changed")

    recheck()
    if not args.execute:
        return report
    journal = (
        Path(args.state_dir)
        / "ops-initial-migrations"
        / (pause["request_id"] + ".json")
    )
    if journal.parent.is_symlink() or journal.exists() or journal.is_symlink():
        raise ValueError(
            "Inspect the existing migration journal before retry; never reuse it"
        )
    report.update(status="RUNNING", stage="image_load")
    cluster.write_json(journal, report)
    try:
        with redirect_stdout(io.StringIO()):
            cluster.load_image(
                SimpleNamespace(kind=args.kind),
                settings,
                args.ops_image,
                args.state_dir,
            )
        report["stage"] = "final_verification"
        cluster.write_json(journal, report)
        recheck()
        report.update(stage="migration", original_database_migration_attempted=True)
        cluster.write_json(journal, report)
        kube, _, _ = cluster.commands(args.state_dir, settings)

        def execute(arguments, *, data=None, capture=False):
            return database.storage.run(
                arguments, data=None if data is None else data.encode(), timeout=390
            ).decode()

        run_migration(job, kube, namespaced, execute, retain_completed=True)
        report["stage"] = "pause_verification"
        cluster.write_json(journal, report)
        if database.frozen_source(args.state_dir, settings)[1] != source:
            raise ValueError(
                "Writers changed during migration; inspect before resuming"
            )
        verify_pause(command, pause)
        report.update(
            status="MIGRATED_PAUSED", stage="completed", admission_paused=True
        )
        cluster.write_json(journal, report)
    except BaseException as error:
        # An interrupted create/wait has an unknown DB outcome, never automatic rollback.
        report.update(status="FAILED", error_type=type(error).__name__)
        cluster.write_json(journal, report)
        raise
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, default=database.STATE)
    parser.add_argument("--expected-state-id", required=True)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--key-file", type=Path, required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--source-branch", required=True)
    parser.add_argument("--ops-image", required=True)
    parser.add_argument("--pause-request-id", required=True)
    parser.add_argument("--pause-actor", required=True)
    parser.add_argument("--pause-reason", required=True)
    parser.add_argument("--helm", default="helm")
    parser.add_argument("--kind", default="kind")
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Apply approved original-DB migration and keep all writers stopped",
    )
    args = parser.parse_args()
    if os.name != "posix":
        parser.error("Run inside WSL/Linux")
    os.umask(0o077)
    try:
        with cluster.locked(args.state_dir):
            report = migrate(args)
        print(json.dumps(report, sort_keys=True))
        return 0
    except Exception:  # noqa: BLE001 - archive, subprocess and DB errors may contain secrets
        print(
            "Initial Ops migration stopped; inspect the journal and keep writers stopped if migration was attempted (private details withheld)",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
