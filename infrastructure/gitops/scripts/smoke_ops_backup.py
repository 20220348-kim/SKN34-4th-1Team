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
from pathlib import Path
from uuid import uuid4

import fork_cluster
import ops_core_restore_fixture
import ops_database_restore_probe
import ops_runtime
import smoke_ops_volumes
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
from apps.evaluations.catalog import DATASETS
assert settings.DATABASES["default"]["HOST"] == "ops-mysql"
assert settings.DATABASES["default"]["NAME"] == "govbiz_ops"
assert EvaluationAdmission.objects.get(pk=1).accepting is False
with transaction.atomic():
    user = get_user_model().objects.create_user("backup-rehearsal-fixture")
    dataset = next(iter(DATASETS.values()))
    capture = dataset["captures"][0]["id"]
    run = EvaluationRun.objects.create(
        requested_by=user, dataset_id=dataset["id"], status="CANCELLED",
        candidate_capture_id=capture, reference_capture_id=capture,
        summary={"한글": ["따옴표 ' \\\"", "줄바꿈\\n복원 🧪", None]},
        finished_at=timezone.now(), model_api_calls=0,
    )
    EvaluationReview.objects.create(
        run=run, reviewed_by=user, decision="APPROVED", version=1,
        comment="격리 복원 검증 🧪", capture_sha256="a" * 64,
    )
    budget, _ = EvaluationBudget.objects.get_or_create(pk=1)
    EvaluationBudgetReservation.objects.create(
        run=run, budget=budget, max_calls=1, max_output_tokens=0,
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
    "WHERE requested_by_id IN (SELECT id FROM auth_user "
    "WHERE username='backup-rehearsal-fixture'));"
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


def application_read(target, database_id, image_id, expected, release_sha256, evidence):
    application = evidence["application"] = {
        "status": "FAIL",
        "cleanup_complete": False,
    }
    password = secrets.token_hex(32)
    execute(
        target + MYSQL,
        data=(
            "CREATE USER 'ops_restore_reader'@'%' IDENTIFIED BY '" + password + "';\n"
            "GRANT SELECT, LOCK TABLES ON govbiz_ops.* TO 'ops_restore_reader'@'%';"
        ),
    )
    identity = None
    try:
        identity = execute(
            [
                "docker",
                "create",
                "-i",
                "--name",
                "govbiz-ops-reader-" + uuid4().hex,
                "--network",
                "container:" + database_id,
                "--user",
                "10001:10001",
                "--read-only",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges:true",
                "--memory",
                "256m",
                "--pids-limit",
                "64",
                "--tmpfs",
                "/tmp:rw,nosuid,size=32m",
                "--env",
                "DB_PASSWORD",
                "--entrypoint",
                "python",
                image_id,
                "-B",
                "-",
            ],
            env={**os.environ, "DB_PASSWORD": password},
        ).strip()
        if not re.fullmatch(r"[a-f0-9]{64}", identity):
            identity = None
            raise ValueError("Invalid restore reader identity")
        probe = Path(ops_database_restore_probe.__file__).read_text(encoding="utf-8")
        program = probe + (
            "\nprint(json.dumps(inspect_database("
            + repr(expected)
            + ", "
            + repr(release_sha256)
            + ")))\n"
        )
        result = json.loads(
            execute(
                ["docker", "start", "--attach", "--interactive", identity],
                data=program,
                timeout=120,
            )
        )
        if (
            result.get("status") != "PASS"
            or result.get("evaluation_count") != len(expected)
            or result.get("execution_release_sha256") != release_sha256
            or result.get("readiness") != "UP"
            or result.get("model_api_calls") != 0
            or any(
                result.get(key) is not True
                for key in (
                    "read_only_grants",
                    "budget_lock_verified",
                    "write_rejected",
                    "response_serialization_verified",
                    "relational_fixture_verified",
                )
            )
            or result.get("core_admin_auth_verified") is not False
            or result.get("http_server_started") is not False
        ):
            raise ValueError("Incomplete restored Ops application evidence")
        application.update(result, status="FAIL", image_id=image_id)
    finally:
        if identity is not None:
            execute(["docker", "rm", "--force", "--volumes", identity], timeout=60)
            application["cleanup_complete"] = True
    application["status"] = "PASS"
    return password


def verify(
    state,
    settings,
    report,
    *,
    ops_image,
    core_image,
    core_password,
    expected,
    release_sha256,
    compose,
    compose_env,
):
    evidence = report["database_restore"] = {
        "status": "FAIL",
        "scope": "disposable_ops_mysql_application_read",
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
    ops_database_restore_probe.validate_expected(expected, release_sha256)
    smoke_ops_volumes.probe.expected_runs(expected)
    fork_cluster.require_dev(state, settings)
    _, nk, _ = fork_cluster.commands(state, settings)
    deployment = json.loads(
        execute(nk + ["get", "deployment", "ops-service", "-o", "json"])
    )
    deployed = deployment["spec"]["template"]["spec"]["containers"]
    if not deployed or any(item["image"] != ops_image for item in deployed):
        raise ValueError("Restore reader image differs from the deployed Ops image")
    image_id = execute(
        ["docker", "image", "inspect", ops_image, "--format", "{{.Id}}"]
    ).strip()
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", image_id):
        raise ValueError("Invalid Ops restore image identity")
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
        password = application_read(
            target, identity, image_id, expected, release_sha256, evidence
        )
        same_dump(dump, execute(target + DUMP))
        evidence["application"]["database_unchanged"] = True
        # Keep the verified disposable DB alive while the restored result volume
        # is read through the real Ops HTTP server. No credential enters report.
        evidence["restored_database_ready"] = True
        report["evaluation_phase"] = "volume_restore_rehearsal"
        with ops_core_restore_fixture.restored_core(
            nk, target, identity, core_image, report
        ):
            runner_image_id = smoke_ops_volumes.verify(
                state,
                settings,
                compose,
                compose_env,
                expected,
                report,
                database={
                    "id": identity,
                    "image": image_id,
                    "password": password,
                    "core_password": core_password,
                },
            )
        same_dump(dump, execute(target + DUMP))
        report["volume_restore"]["results"]["ops_http"]["database_unchanged"] = True
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
    return runner_image_id
