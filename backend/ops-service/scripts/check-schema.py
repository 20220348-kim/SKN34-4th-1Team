"""CI-only proof on a fresh MySQL service; never resets or deletes a database."""

import argparse
import hashlib
import io
import json
import os
import sys
from pathlib import Path
from uuid import uuid4

import django

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")


def prepare_legacy_fixture(connection):
    """Build the observed 0017 schema forward in the already-checked empty CI DB."""
    from django.db.migrations.executor import MigrationExecutor
    from django.utils import timezone

    if connection.vendor != "mysql" or connection.introspection.table_names():
        raise RuntimeError("Legacy fixture requires an empty MySQL database")
    executor = MigrationExecutor(connection)
    targets = [node for node in executor.loader.graph.leaf_nodes() if node[0] != "evaluations"]
    targets.append(("evaluations", "0017_input_token_budget"))
    if any(backwards for _, backwards in executor.migration_plan(targets)):
        raise AssertionError("Legacy rehearsal must never reverse an existing schema")
    executor.migrate(targets)
    apps = executor.loader.project_state(targets).apps
    user = apps.get_model("auth", "User").objects.create(username="ci-legacy-검토자")

    def model(name):
        return apps.get_model("evaluations", name)

    now = timezone.now()
    run = model("EvaluationRun").objects.create(
        requested_by=user,
        dataset_id="ci-legacy-fixture",
        status="COMPLETED",
        prefect_flow_run_id=uuid4(),
        evaluation_run_id="c" * 32,
        finished_at=now,
        summary={"한글 🧪": ["따옴표 ' \"", "줄바꿈\n보존", None]},
        execution_spec={"schema_version": 1, "fixture": "가상 CI 자료"},
        execution_spec_sha256="d" * 64,
    )
    model("EvaluationRun").objects.create(
        requested_by=user, dataset_id="ci-null-fixture", status="CANCELLED"
    )
    review = model("EvaluationReview").objects.create(
        run=run,
        reviewed_by=user,
        decision="APPROVED",
        version=1,
        comment="실제 사람 검토가 아닌 전환 시험 fixture 🧪",
        capture_sha256="a" * 64,
    )
    baseline = model("EvaluationBaseline").objects.create(
        dataset_id=run.dataset_id, review=review, selected_by=user, version=1
    )
    model("EvaluationBaselineChange").objects.create(
        baseline=baseline, review=review, changed_by=user, version=1, reason="가상 기준 이력"
    )
    budget = model("EvaluationBudget").objects.create(
        pk=1,
        call_limit=10,
        output_token_limit=100,
        allocated_calls=1,
        allocated_input_tokens=9,
        allocated_output_tokens=5,
    )
    reservation = model("EvaluationBudgetReservation").objects.create(
        run=run, budget=budget, max_calls=1, max_output_tokens=10, closed_at=now
    )
    call = model("EvaluationBudgetCall").objects.create(
        reservation=reservation,
        sequence=1,
        operation_id="기존-operation",
        input_tokens=7,
        output_tokens=3,
        settled_at=now,
    )
    model("EvaluationUsageCorrection").objects.create(
        request_id=uuid4(),
        call=call,
        actor="가상 운영자",
        reason="가상 사용량 정정",
        evidence_sha256="b" * 64,
        response_id="resp_ci_legacy_fixture",
        evidence_raw='{"가상":true}',
        input_tokens=9,
        output_tokens=5,
        original_call={"input_tokens": 7, "output_tokens": 3},
        before={"input_tokens": 7},
        after={"input_tokens": 9},
    )
    model("EvaluationBudgetChange").objects.create(
        request_id=uuid4(),
        budget=budget,
        actor="가상 운영자",
        reason="가상 예산 감사",
        call_limit=10,
        output_token_limit=100,
    )
    models = [apps.get_model("auth", "User")] + [
        model(name)
        for name in (
            "EvaluationRun",
            "EvaluationReview",
            "EvaluationBaseline",
            "EvaluationBaselineChange",
            "EvaluationBudget",
            "EvaluationBudgetReservation",
            "EvaluationBudgetCall",
            "EvaluationUsageCorrection",
            "EvaluationBudgetChange",
        )
    ]
    # Historical models keep selecting only columns that existed before the upgrade.
    snapshots = [list(item.objects.order_by("pk").values()) for item in models]
    return models, snapshots


def verify_legacy_upgrade(fixture):
    from unittest.mock import patch

    from django.contrib.auth import get_user_model
    from django.core.management import call_command
    from rest_framework.test import APIClient

    from apps.evaluations.catalog import LEGACY_DATASET_ID, public_datasets
    from apps.evaluations.models import EvaluationAdmissionChange, EvaluationBudgetCall

    def preserved():
        models, snapshots = fixture
        for model, expected in zip(models, snapshots, strict=True):
            if list(model.objects.order_by("pk").values()) != expected:
                raise AssertionError("Legacy rows changed: " + model._meta.label)

    preserved()
    # One command verifies schema and pause under the migration lock. API/sync/
    # runner shutdown remains an external prerequisite, including in real cutover.
    request_id = str(uuid4())
    arguments = (
        "migrate_deployment",
        "--pause-request-id",
        request_id,
        "--pause-actor",
        "CI 전환 검증",
        "--pause-reason",
        "가상 구버전 DB 전환",
    )
    output = io.StringIO()
    call_command(*arguments, stdout=output, verbosity=0)
    paused = json.loads(output.getvalue())
    if paused["accepting"] or paused["version"] != 1 or paused["replayed"]:
        raise AssertionError("Legacy upgrade did not close admission")
    client = APIClient()
    client.force_authenticate(get_user_model().objects.get(username="ci-legacy-검토자"))
    with patch("apps.evaluations.prefect_client.create_run") as dispatch:
        response = client.post(
            "/api/v1/ops/evaluations",
            {
                "request_id": str(uuid4()),
                "dataset_id": LEGACY_DATASET_ID,
                "execution_profile": public_datasets()[0]["execution_profiles"]["replay"],
            },
            format="json",
        )
        if response.status_code != 503 or response.json() != {
            "code": "EVALUATION_ADMISSION_PAUSED"
        }:
            raise AssertionError("New evaluation was not rejected after migration and pause")
        dispatch.assert_not_called()
    call_command("migrate_deployment")
    output = io.StringIO()
    call_command(*arguments, stdout=output, verbosity=0)
    replayed = json.loads(output.getvalue())
    if not replayed["replayed"] or replayed["accepting"] or replayed["version"] != 1:
        raise AssertionError("Repeated migration or pause reopened admission")
    if EvaluationAdmissionChange.objects.count() != 1:
        raise AssertionError("Pause retry duplicated admission audit records")
    legacy_call = EvaluationBudgetCall.objects.get(operation_id="기존-operation")
    if legacy_call.max_input_tokens is not None or legacy_call.max_output_tokens is not None:
        raise AssertionError("Migration invented unknown legacy operation bounds")
    preserved()
    print(
        "PASS: 0017 legacy rows, audit and NULL bounds preserved; admission paused and replay-safe"
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--legacy-evaluations", action="store_true")
    args = parser.parse_args()
    if (
        os.environ.get("GITHUB_ACTIONS") != "true"
        or os.environ.get("OPS_SCHEMA_TEST_ONLY") != "true"
    ):
        raise RuntimeError("Run only against the dedicated empty CI MySQL service")
    django.setup()
    from django.contrib.auth import get_user_model
    from django.core.management import CommandError, call_command
    from django.db import connection
    from django.test import RequestFactory

    from apps.health.views import health, readiness

    if connection.vendor != "mysql" or connection.introspection.table_names():
        raise RuntimeError(
            "Expected an empty MySQL test database; no existing tables may be changed"
        )
    request = RequestFactory().get("/api/v1/health/ready")
    if health(request).status_code != 200:
        raise AssertionError("Liveness must work on an empty schema")
    response = readiness(request)
    if response.status_code != 503 or response.data["checks"] != {
        "database": "UP",
        "schema": "DOWN",
    }:
        raise AssertionError("An empty connected database must not be ready")
    fixture = prepare_legacy_fixture(connection) if args.legacy_evaluations else None
    if fixture and readiness(request).status_code != 503:
        raise AssertionError("The legacy schema must not pass current application readiness")
    if fixture:
        verify_legacy_upgrade(fixture)
    else:
        call_command("migrate_deployment")
    if readiness(request).status_code != 200:
        raise AssertionError("Migrated schema must be ready")
    if fixture:
        return
    user = get_user_model().objects.create_user(username="ci-schema-preservation")
    call_command("migrate_deployment")
    if not get_user_model().objects.filter(pk=user.pk).exists():
        raise AssertionError("Repeated migration lost existing data")

    # A separate real MySQL session must exclude a concurrent migration command.
    lock = (
        "govbiz-ops-migrate:"
        + hashlib.sha256(str(connection.settings_dict["NAME"]).encode()).hexdigest()[:40]
    )
    contender = connection.copy(alias="migration-contender")
    try:
        with contender.cursor() as cursor:
            cursor.execute("SELECT GET_LOCK(%s, 0)", [lock])
            if cursor.fetchone() != (1,):
                raise AssertionError("Could not acquire fixture lock")
        try:
            call_command("migrate_deployment")
        except CommandError as error:
            if "Another Ops migration" not in str(error):
                raise
        else:
            raise AssertionError("Concurrent migration was not rejected")
    finally:
        # Socket close can return before MySQL releases this session's lock.
        # Confirm release before testing a fresh migration's immediate GET_LOCK.
        try:
            with contender.cursor() as cursor:
                cursor.execute("SELECT RELEASE_LOCK(%s)", [lock])
                if cursor.fetchone() != (1,):
                    raise AssertionError("Could not release fixture lock")
        finally:
            contender.close()
    call_command("migrate_deployment")
    # Applied migration history alone cannot conceal a physically missing column.
    table = connection.ops.quote_name(user._meta.db_table)
    with connection.cursor() as cursor:
        cursor.execute(f"ALTER TABLE {table} RENAME COLUMN first_name TO ci_hidden_first_name")
    try:
        if readiness(request).status_code != 503:
            raise AssertionError("Missing model column must block readiness")
    finally:
        with connection.cursor() as cursor:
            cursor.execute(f"ALTER TABLE {table} RENAME COLUMN ci_hidden_first_name TO first_name")
    if (
        readiness(request).status_code != 200
        or not get_user_model().objects.filter(pk=user.pk).exists()
    ):
        raise AssertionError("Restored schema or preserved data failed verification")
    print(
        "PASS: empty schema blocked; forward/repeated migration; "
        "lock exclusion; missing column blocked"
    )


if __name__ == "__main__":
    main()
