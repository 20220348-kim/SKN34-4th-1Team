"""Full Ops DB restore rehearsal, exclusively for the disposable bridge smoke.

The SQL dump stays in memory. This does not back up personal data, artifacts,
Prefect or credentials, and does not authorize an upgrade.
"""

import hashlib
import json
import os
import re
import secrets
import subprocess
import time
from uuid import uuid4

import fork_cluster
import ops_runtime
from smoke_ops_bridge import execute

DATABASE = "govbiz_ops"
MYSQL = [
    "mysql",
    "--protocol=TCP",
    "--host=127.0.0.1",
    "--user=root",
    "--default-character-set=utf8mb4",
    "--batch",
    "--raw",
    "--skip-column-names",
    DATABASE,
]
DUMP = [
    "mysqldump",
    "--protocol=TCP",
    "--host=127.0.0.1",
    "--user=root",
    "--default-character-set=utf8mb4",
    "--single-transaction",
    "--no-tablespaces",
    "--set-gtid-purged=OFF",
    "--hex-blob",
    "--order-by-primary",
    "--skip-comments",
    "--skip-dump-date",
    "--skip-extended-insert",
    "--routines",
    "--events",
    "--triggers",
    DATABASE,
]
AUTH = ["sh", "-c", 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec "$@"', "sh"]
TABLES = (
    "SELECT TABLE_NAME FROM information_schema.TABLES "
    "WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME;"
)
REQUIRED_TABLES = {
    "django_migrations",
    "evaluations_evaluationrun",
    "evaluations_evaluationreview",
    "evaluations_evaluationbudgetreservation",
    "evaluations_evaluationbudgetchange",
    "evaluations_evaluationadmissionchange",
}
FIXTURES = """
import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
import django
django.setup()
from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone
from uuid import uuid4
from apps.evaluations.models import (
    EvaluationAdmission, EvaluationRun, EvaluationReview, EvaluationBudget,
    EvaluationBudgetReservation, EvaluationBudgetChange,
)
assert settings.DATABASES["default"]["HOST"] == "ops-mysql"
assert settings.DATABASES["default"]["NAME"] == "govbiz_ops"
assert EvaluationAdmission.objects.get(pk=1).accepting is False
with transaction.atomic():
    user = get_user_model().objects.create_user("backup-rehearsal-fixture")
    run = EvaluationRun.objects.create(
        requested_by=user, dataset_id="backup-rehearsal-fixture", status="COMPLETED",
        summary={"한글": ["따옴표 ' \\\"", "줄바꿈\\n복원 🧪", None]},
        finished_at=timezone.now(), model_api_calls=0,
    )
    EvaluationReview.objects.create(
        run=run, reviewed_by=user, decision="APPROVED", version=1,
        comment="격리 복원 검증 🧪", capture_sha256="a" * 64,
    )
    budget, _ = EvaluationBudget.objects.get_or_create(pk=1)
    EvaluationBudgetReservation.objects.create(
        run=run, budget=budget, max_calls=0, max_output_tokens=0,
        closed_at=timezone.now(),
    )
    EvaluationBudgetChange.objects.create(
        request_id=uuid4(), budget=budget, actor="isolated-backup-smoke",
        reason="복원 검증용 감사 데이터", previous_call_limit=budget.call_limit,
        previous_output_token_limit=budget.output_token_limit,
        call_limit=budget.call_limit, output_token_limit=budget.output_token_limit,
    )
print("backup-fixtures-ready")
"""
FIXTURE_REVIEW = (
    " WHERE run_id IN (SELECT id FROM evaluations_evaluationrun "
    "WHERE dataset_id='backup-rehearsal-fixture');"
)


def inventory(command):
    tables = execute(command + MYSQL, data=TABLES).splitlines()
    if (
        not REQUIRED_TABLES.issubset(tables)
        or len(tables) != len(set(tables))
        or any(not re.fullmatch(r"[a-z_][a-z0-9_]*", name) for name in tables)
    ):
        raise ValueError("Incomplete Ops restore table inventory")
    query = "\n".join(f"SELECT '{name}', COUNT(*) FROM `{name}`;" for name in tables)
    rows = execute(command + MYSQL, data=query).splitlines()
    result = {}
    for line in rows:
        name, count = line.split("\t")
        if name in result or not count.isdecimal():
            raise ValueError("Invalid Ops restore row counts")
        result[name] = int(count)
    if set(result) != set(tables) or any(result[name] < 1 for name in REQUIRED_TABLES):
        raise ValueError("Missing Ops restore fixture or migration rows")
    return result


def same_dump(expected, actual):
    if not expected or actual != expected:
        raise ValueError("Ops database dump comparison failed")


def verify(state, settings, report):
    evidence = report["database_restore"] = {
        "status": "FAIL",
        "scope": "disposable_ops_mysql_only",
        "backup_verified": False,
        "artifacts_restored": False,
        "prefect_restored": False,
        "personal_environment_verified": False,
        "model_api_calls": 0,
        "cleanup_complete": False,
    }
    if (
        settings.get("repository") != "bridge-smoke/local"
        or not re.fullmatch(
            r"govbiz-bridge-smoke-[a-f0-9]{10}", settings.get("cluster", "")
        )
        or settings.get("namespace") != "govbiz-msa"
    ):
        raise ValueError("DB restore rehearsal requires the disposable bridge smoke")
    fork_cluster.require_dev(state, settings)
    _, nk, _ = fork_cluster.commands(state, settings)
    pod = json.loads(execute(nk + ["get", "pod", "ops-mysql-0", "-o", "json"]))
    containers = pod["spec"]["containers"]
    if (
        len(containers) != 1
        or containers[0]["name"] != "mysql"
        or containers[0]["image"] != "mysql:8.4"
    ):
        raise ValueError("Restore rehearsal requires the MySQL 8.4 fixture")
    seed = execute(
        nk
        + [
            "exec",
            "-i",
            "deployment/ops-service",
            "-c",
            "ops-service",
            "--",
            "python",
            "-",
        ],
        data=FIXTURES,
    )
    if seed.strip() != "backup-fixtures-ready":
        raise ValueError("Ops restore fixtures were not created")
    evidence["preflight"] = ops_runtime.upgrade_preflight(state, settings)
    if evidence["preflight"]["status"] != "PASS":
        raise ValueError("Outstanding work prevents isolated DB restore rehearsal")
    # Last phase of the disposable test. The caller deletes this cluster even on
    # failure; do not resume admission or restart writers after an uncertain dump.
    execute(nk + ["scale", "deployment/ops-service", "--replicas=0"])
    execute(
        nk
        + [
            "wait",
            "--for=delete",
            "pod",
            "-l",
            "app.kubernetes.io/name=ops-service",
            "--timeout=120s",
        ]
    )
    if json.loads(
        execute(
            nk
            + ["get", "pods", "-l", "app.kubernetes.io/name=ops-service", "-o", "json"]
        )
    )["items"]:
        raise ValueError("Ops writers remain running")
    evidence["source_writers_stopped"] = True
    source = nk + ["exec", "-i", "ops-mysql-0", "-c", "mysql", "--"] + AUTH
    version = execute(source + MYSQL, data="SELECT VERSION();").strip()
    if not re.fullmatch(r"8\.4\.\d+", version):
        raise ValueError("Unexpected source MySQL version")
    counts = inventory(source)
    dump = execute(source + DUMP)
    if not dump or "CREATE TABLE `django_migrations`" not in dump:
        raise ValueError("Incomplete Ops database dump")
    identity = None
    try:
        # No published port, outbound network, shared mount or persistent volume.
        identity = execute(
            [
                "docker",
                "create",
                "--name",
                "govbiz-ops-restore-" + uuid4().hex,
                "--network",
                "none",
                "--memory",
                "768m",
                "--tmpfs",
                "/var/lib/mysql:rw,nosuid,size=512m",
                "--env",
                "MYSQL_ROOT_PASSWORD",
                "--env",
                "MYSQL_DATABASE=" + DATABASE,
                "mysql:8.4",
                "--event-scheduler=OFF",
                "--mysqlx=0",
                "--performance-schema=OFF",
                "--innodb-buffer-pool-size=67108864",
                "--character-set-server=utf8mb4",
                "--collation-server=utf8mb4_0900_ai_ci",
            ],
            env={**os.environ, "MYSQL_ROOT_PASSWORD": secrets.token_urlsafe(32)},
        ).strip()
        if not re.fullmatch(r"[a-f0-9]{64}", identity):
            identity = None
            raise ValueError("Invalid restore container identity")
        execute(["docker", "start", identity])
        target = ["docker", "exec", "-i", identity] + AUTH
        deadline = time.monotonic() + 120
        while True:
            try:
                restored_version = execute(
                    target + MYSQL, data="SELECT VERSION();", timeout=10
                ).strip()
                break
            except subprocess.CalledProcessError:
                if time.monotonic() >= deadline:
                    raise ValueError("Restore MySQL startup timed out") from None
                time.sleep(2)
        if restored_version != version:
            raise ValueError("Source and restore MySQL versions differ")
        execute(target + MYSQL, data=dump)
        if inventory(target) != counts:
            raise ValueError("Ops restore table or row counts differ")
        same_dump(dump, execute(target + DUMP))
        # MySQL dump import disables FK checks temporarily; verify enforcement
        # again in a new connection using the dedicated synthetic review.
        try:
            execute(
                target + MYSQL,
                data=(
                    "UPDATE evaluations_evaluationreview SET run_id='"
                    + uuid4().hex
                    + "'"
                    + FIXTURE_REVIEW
                ),
            )
        except subprocess.CalledProcessError as error:
            if "ERROR 1452" not in (error.stderr or ""):
                raise ValueError("Unexpected restore constraint failure") from None
        else:
            raise ValueError("Restored foreign key did not reject an invalid reference")
        execute(
            target + MYSQL,
            data=(
                "UPDATE evaluations_evaluationreview SET comment='restore-tampering-fixture'"
                + FIXTURE_REVIEW
            ),
        )
        try:
            same_dump(dump, execute(target + DUMP))
        except ValueError:
            evidence["tampering_detected"] = True
        else:
            raise ValueError("Restored data tampering was not detected")
        same_dump(dump, execute(source + DUMP))
        evidence.update(
            mysql_version=version,
            table_count=len(counts),
            row_count=sum(counts.values()),
            migration_count=counts["django_migrations"],
            dump_sha256=hashlib.sha256(dump.encode("utf-8")).hexdigest(),
            schema_and_rows_match=True,
            foreign_key_enforced=True,
            source_preserved=True,
            network_isolated=True,
        )
    finally:
        if identity is not None:
            execute(["docker", "rm", "--force", "--volumes", identity], timeout=60)
            evidence["cleanup_complete"] = True
    evidence["status"] = "PASS"
