"""Read restored Ops data through Django; injected into an isolated Ops image."""

import hashlib
import json
import os
import re
import secrets
from uuid import UUID


def validate_expected(expected, release_sha256):
    if not isinstance(expected, dict) or len(expected) != 3:
        raise ValueError("Expected the three completed restore evaluations")
    if not re.fullmatch(r"[a-f0-9]{64}", release_sha256):
        raise ValueError("Invalid expected execution release digest")
    flows = set()
    for request, row in expected.items():
        if str(UUID(request)) != request or str(UUID(row["flow_id"])) != row["flow_id"]:
            raise ValueError("Noncanonical restore evaluation identity")
        if not re.fullmatch(r"[a-f0-9]{64}", row["execution_spec_sha256"]):
            raise ValueError("Invalid expected execution spec digest")
        flows.add(row["flow_id"])
    if len(flows) != len(expected):
        raise ValueError("Repeated restore flow identity")


def verify_response(row, request, expected, digest):
    if (
        row["id"] != request
        or row["prefect_flow_run_id"] != expected["flow_id"]
        or row["execution_spec_sha256"] != expected["execution_spec_sha256"]
        or not row["execution_spec"]
        or digest(row["execution_spec"]) != expected["execution_spec_sha256"]
        or row["status"] != "COMPLETED"
        or row["model_api_calls"] != 0
        or not row["requested_by_id"]
        or not row["finished_at"]
        or not row["summary"]
        or not row["report_url"]
    ):
        raise ValueError("Restored Ops evaluation response differs")


def inspect_database(expected, release_sha256):
    validate_expected(expected, release_sha256)
    # Do not inherit Core/Prefect/model credentials or routes from an image.
    password = os.environ["DB_PASSWORD"]
    os.environ.clear()
    os.environ.update(
        DJANGO_SETTINGS_MODULE="config.settings",
        DJANGO_SECRET_KEY=secrets.token_urlsafe(48),
        DJANGO_ALLOWED_HOSTS="127.0.0.1",
        DB_HOST="127.0.0.1",
        DB_PORT="3306",
        DB_NAME="govbiz_ops",
        DB_USER="ops_restore_reader",
        DB_PASSWORD=password,
        LLMOPS_LIVE_ENABLED="false",
        LLMOPS_RAG_LIVE_ENABLED="false",
    )
    import django

    django.setup()
    from apps.evaluations.execution_spec import RELEASE_PATH, digest
    from apps.evaluations.models import (
        EvaluationAdmission,
        EvaluationBudgetChange,
        EvaluationBudgetReservation,
        EvaluationReview,
        EvaluationRun,
    )
    from apps.evaluations.views import run_data
    from django.db import DatabaseError, connection
    from django.test import Client
    from rest_framework.renderers import JSONRenderer

    if hashlib.sha256(RELEASE_PATH.read_bytes()).hexdigest() != release_sha256:
        raise ValueError("Restored Ops execution release differs")
    with connection.cursor() as cursor:
        cursor.execute("SHOW GRANTS FOR CURRENT_USER")
        if {row[0] for row in cursor.fetchall()} != {
            "GRANT USAGE ON *.* TO `ops_restore_reader`@`%`",
            "GRANT SELECT ON `govbiz_ops`.* TO `ops_restore_reader`@`%`",
        }:
            raise ValueError("Restore reader must have SELECT-only database grants")
        try:
            cursor.execute(
                "UPDATE evaluations_evaluationadmission SET version=version WHERE id=1"
            )
        except DatabaseError as error:
            if not error.args or error.args[0] != 1142:
                raise ValueError("Unexpected restore reader write failure") from None
        else:
            raise ValueError("Restore reader accepted a database write")
    # Exercise the real URL, view and migration/column checks, without a web server
    # or authentication bypass on a running service. No migration is applied.
    response = Client(HTTP_HOST="127.0.0.1").get("/api/v1/health/ready")
    if response.status_code != 200 or response.json() != {
        "status": "UP",
        "checks": {"database": "UP", "schema": "UP"},
    }:
        raise ValueError("Restored Ops schema is not ready")
    for request, expected_row in expected.items():
        run = EvaluationRun.objects.select_related(
            "requested_by", "cancel_requested_by"
        ).get(pk=request)
        row = json.loads(JSONRenderer().render(run_data(run, run.requested_by_id)))
        verify_response(row, request, expected_row, digest)

    fixture = EvaluationRun.objects.select_related("requested_by").get(
        dataset_id="backup-rehearsal-fixture"
    )
    review = EvaluationReview.objects.select_related("reviewed_by").get(run=fixture)
    reservation = EvaluationBudgetReservation.objects.select_related("budget").get(
        run=fixture
    )
    if (
        fixture.requested_by.username != "backup-rehearsal-fixture"
        or fixture.summary != {"한글": ["따옴표 ' \"", "줄바꿈\n복원 🧪", None]}
        or fixture.started_at is not None
        or fixture.finished_at is None
        or review.reviewed_by_id != fixture.requested_by_id
        or review.comment != "격리 복원 검증 🧪"
        or review.decision != "APPROVED"
        or reservation.closed_at is None
        or reservation.max_calls != 0
        or reservation.max_output_tokens != 0
        or not EvaluationBudgetChange.objects.filter(
            budget=reservation.budget,
            actor="isolated-backup-smoke",
            reason="복원 검증용 감사 데이터",
        ).exists()
        or EvaluationAdmission.objects.get(pk=1).accepting is not False
    ):
        raise ValueError("Restored Ops relational fixture differs")
    connection.close()
    return {
        "status": "PASS",
        "readiness": "UP",
        "evaluation_count": len(expected),
        "execution_release_sha256": release_sha256,
        "select_only_grants": True,
        "write_rejected": True,
        "response_serialization_verified": True,
        "relational_fixture_verified": True,
        "core_admin_auth_verified": False,
        "http_server_started": False,
        "model_api_calls": 0,
    }
