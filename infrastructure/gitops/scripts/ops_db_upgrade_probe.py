"""Migrate a disposable 0017 DB and compare every original column and row in memory."""

import hashlib
import io
import json
import os
import re
import secrets
import sys
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from uuid import uuid4

APPEND_ONLY = {"django_migrations", "django_content_type", "auth_permission"}
MAX_BYTES = 128 * 1024 * 1024


def source_digest(root):
    paths = [root / "manage.py"]
    for directory in ("apps", "config"):
        paths.extend(
            path for path in (root / directory).rglob("*") if path.suffix in {".py", ".json"}
        )
    digest = hashlib.sha256()
    for path in sorted(paths):
        if path.is_symlink() or not path.is_file():
            raise ValueError("Unexpected Ops source file")
        digest.update(path.relative_to(root).as_posix().encode() + b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def capture_rows(connection, previous=None):
    """Keep only row hashes and private primary keys; never print application data."""
    captured = {}
    size = 0
    quote = connection.ops.quote_name
    with connection.cursor() as cursor:
        tables = connection.introspection.table_names(cursor) if previous is None else previous
        for table in tables:
            if not re.fullmatch(r"[a-z][a-z0-9_]*", table):
                raise ValueError("Unsupported restored table")
            if previous is None:
                columns = [
                    item.name
                    for item in connection.introspection.get_table_description(cursor, table)
                ]
                primary = [
                    item["columns"]
                    for item in connection.introspection.get_constraints(cursor, table).values()
                    if item["primary_key"]
                ]
                if len(primary) != 1 or not primary[0]:
                    raise ValueError("Every restored table needs a primary key")
                primary = primary[0]
            else:
                columns, primary = previous[table]["columns"], previous[table]["primary"]
            cursor.execute("SELECT " + ",".join(map(quote, columns)) + " FROM " + quote(table))
            positions = [columns.index(name) for name in primary]
            rows = {}
            while batch := cursor.fetchmany(512):
                for row in batch:
                    key = repr(tuple(row[index] for index in positions))
                    raw = repr(tuple(row)).encode("utf-8")
                    size += len(raw) + len(key.encode("utf-8"))
                    if size > MAX_BYTES or key in rows:
                        raise ValueError("Oversized or duplicate restored rows")
                    rows[key] = hashlib.sha256(raw).hexdigest()
            captured[table] = {"columns": columns, "primary": primary, "rows": rows}
    return captured


def require_preserved(before, after):
    if set(before) != set(after):
        raise ValueError("Restored table inventory changed")
    for table, original in before.items():
        rows, current = original["rows"], after[table]["rows"]
        if any(current.get(key) != value for key, value in rows.items()) or (
            table not in APPEND_ONLY and set(rows) != set(current)
        ):
            raise ValueError("Original restored rows changed during upgrade")


def configure(password):
    os.environ.clear()
    os.environ.update(
        DJANGO_SETTINGS_MODULE="config.settings",
        DJANGO_SECRET_KEY=secrets.token_urlsafe(48),
        DJANGO_DEBUG="false",
        DJANGO_ALLOWED_HOSTS="127.0.0.1",
        DB_HOST="127.0.0.1",
        DB_PORT="3306",
        DB_NAME="govbiz_ops",
        DB_USER="root",
        DB_PASSWORD=password,
        CORE_API_URL="http://disabled-core.invalid",
        PREFECT_API_URL="http://disabled-prefect.invalid/api",
        LLMOPS_ARTIFACT_URL="",
        LLMOPS_ARTIFACT_TOKEN="",
        LLMOPS_BUDGET_TOKEN="",
        LLMOPS_RESULTS_DIR="/tmp/results",
        LLMOPS_EVIDENCE_DIR="/tmp/evidence",
        LLMOPS_LIVE_ENABLED="false",
        LLMOPS_RAG_LIVE_ENABLED="false",
        LLMOPS_SCHEDULES_ENABLED="false",
        LLMOPS_LOCAL_SEED_ENABLED="false",
    )


def exercise(expected):
    if (
        expected.get("schema_version") != 1
        or not re.fullmatch(r"[a-f0-9]{64}", expected.get("password", ""))
        or source_digest(Path("/app")) != expected.get("source_sha256")
        or Path("/app/.env").exists()
    ):
        raise ValueError("Upgrade image or private input differs")
    configure(expected["password"])
    import django

    django.setup()
    from django.core.management import call_command
    from django.db import connection, transaction
    from django.db.migrations.executor import MigrationExecutor

    from apps.evaluations.admission import AdmissionPaused, lock_admission, require_open, status
    from apps.evaluations.models import EvaluationAdmissionChange, EvaluationBudgetCall
    from apps.health.schema import schema_is_ready

    if connection.vendor != "mysql" or connection.settings_dict["NAME"] != "govbiz_ops":
        raise ValueError("Unexpected rehearsal database")
    executor = MigrationExecutor(connection)
    executor.loader.check_consistent_history(connection)
    applied = set(executor.loader.applied_migrations)
    legacy = {node for node in applied if node[0] == "evaluations"}
    supported = set(executor.loader.graph.forwards_plan(("evaluations", "0017_input_token_budget")))
    if legacy != {node for node in supported if node[0] == "evaluations"}:
        raise ValueError("Only the observed 0017 evaluation schema is supported")
    targets = executor.loader.graph.leaf_nodes()
    plan = executor.migration_plan(targets)
    if not plan or any(backwards for _, backwards in plan) or executor.loader.detect_conflicts():
        raise ValueError("Expected a forward-only upgrade plan")
    if schema_is_ready():
        raise ValueError("Legacy schema unexpectedly ready")
    before = capture_rows(connection)
    if {name: len(item["rows"]) for name, item in before.items()} != expected["table_counts"]:
        raise ValueError("Restored row counts changed before upgrade")
    if any(name.startswith("evaluations_evaluationadmission") for name in before):
        raise ValueError("Unexpected legacy admission tables")
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT COUNT(*) FROM evaluations_evaluationrun WHERE status NOT IN "
            "('COMPLETED','FAILED','CANCELLED','CRASHED')"
        )
        if cursor.fetchone() != (0,):
            raise ValueError("Unsettled restored evaluations")
        cursor.execute(
            "SELECT COUNT(*) FROM evaluations_evaluationbudgetreservation WHERE closed_at IS NULL"
        )
        if cursor.fetchone() != (0,):
            raise ValueError("Unsettled restored reservations")
    call_command("migrate_deployment", verbosity=0)
    initial = status()
    if initial["initialized"] or not initial["accepting"] or initial["version"] != 0:
        raise ValueError("Unexpected admission bootstrap state")
    arguments = (
        "evaluation_admission",
        "pause",
        "--expected-version",
        "0",
        "--request-id",
        str(uuid4()),
        "--actor",
        "격리 DB 전환 검증",
        "--reason",
        "복원본 전환 후 신규 접수 중지",
    )
    for repeat in (False, True):
        if repeat:
            call_command("migrate_deployment", verbosity=0)
        output = io.StringIO()
        call_command(*arguments, stdout=output)
        paused = json.loads(output.getvalue())
        if paused["accepting"] or paused["version"] != 1 or paused["replayed"] is not repeat:
            raise ValueError("Admission pause is not repeatable")
        if EvaluationAdmissionChange.objects.count() != 1:
            raise ValueError("Admission audit was duplicated")
        try:
            with transaction.atomic():
                require_open(lock_admission())
        except AdmissionPaused:
            pass
        else:
            raise ValueError("Admission guard accepted a new request")
        require_preserved(before, capture_rows(connection, before))
    if (
        not schema_is_ready()
        or EvaluationBudgetCall.objects.exclude(
            max_input_tokens__isnull=True, max_output_tokens__isnull=True
        ).exists()
    ):
        raise ValueError("Upgraded schema or unknown legacy token bounds differ")
    connection.close()
    return {
        "status": "REHEARSED",
        "source_sha256": expected["source_sha256"],
        "from_evaluations": "0017_input_token_budget",
        "to_evaluations": next(name for app, name in targets if app == "evaluations"),
        "applied_migrations": len(plan),
        "preserved_tables": len(before),
        "preserved_rows": sum(len(item["rows"]) for item in before.values()),
        "schema_ready": True,
        "admission_paused": True,
        "admission_guard_rejected": True,
        "repeat_verified": True,
        "original_rows_preserved": True,
        "unknown_token_bounds_preserved": True,
    }


def main():
    try:
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            result = exercise(json.loads(sys.stdin.buffer.read(MAX_BYTES)))
    except Exception:
        print("Isolated DB upgrade rehearsal failed (private output withheld)", file=sys.stderr)
        raise SystemExit(1) from None
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
