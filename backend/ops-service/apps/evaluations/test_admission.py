import json
from concurrent.futures import ThreadPoolExecutor
from io import StringIO
from threading import Barrier, Event
from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import DatabaseError, close_old_connections, connection, transaction
from django.db.models.deletion import ProtectedError
from django.test import SimpleTestCase, TestCase, TransactionTestCase
from rest_framework.test import APIClient

from . import services
from .admission import (
    AdmissionPaused,
    change_admission,
    lock_admission,
    status,
)
from .catalog import LEGACY_DATASET_ID, public_datasets
from .models import (
    EvaluationAdmission,
    EvaluationAdmissionChange,
    EvaluationBudgetReservation,
    EvaluationRun,
)
from .prefect_client import PrefectUnavailable
from .services import submit_run
from .test_recovery import RecoveryFixture


def change(accepting=False, version=0, request_id=None):
    return change_admission(
        accepting=accepting,
        expected_version=version,
        request_id=request_id or uuid4(),
        actor="점검 담당자",
        reason="무료 갱신 검증",
    )


def payload(request_id=None):
    return {
        "request_id": str(request_id or uuid4()),
        "dataset_id": LEGACY_DATASET_ID,
        "execution_profile": public_datasets()[0]["execution_profiles"]["replay"],
    }


class AdmissionValidationTests(SimpleTestCase):
    def test_cli_passes_the_explicit_version_and_idempotency_identity(self):
        request_id = str(uuid4())
        with patch(
            "apps.evaluations.management.commands.evaluation_admission.change_admission",
            return_value={"accepting": False, "version": 8},
        ) as apply:
            output = StringIO()
            call_command(
                "evaluation_admission",
                "pause",
                "--expected-version",
                "7",
                "--request-id",
                request_id,
                "--actor",
                "운영자",
                "--reason",
                "점검",
                stdout=output,
            )
        apply.assert_called_once_with(
            accepting=False,
            expected_version=7,
            request_id=request_id,
            actor="운영자",
            reason="점검",
        )
        self.assertEqual(json.loads(output.getvalue()), {"accepting": False, "version": 8})

    def test_invalid_changes_do_not_access_database(self):
        valid = dict(
            accepting=False, expected_version=0, request_id=uuid4(), actor="담당자", reason="점검"
        )
        for change in (
            {"accepting": "false"},
            {"expected_version": True},
            {"expected_version": -1},
            {"request_id": "bad"},
            {"actor": " "},
            {"reason": "a\nb"},
            {"reason": "x" * 501},
        ):
            with self.subTest(change=change), self.assertRaises(ValueError):
                change_admission(**(valid | change))

    def test_command_does_not_expose_database_error_text(self):
        with patch(
            "apps.evaluations.management.commands.evaluation_admission.status",
            side_effect=DatabaseError("private password"),
        ):
            with self.assertRaises(CommandError) as error:
                call_command("evaluation_admission", "status", stdout=StringIO())
        self.assertNotIn("private", str(error.exception))


class AdmissionTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user("admission-operator")
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.create = patch(
            "apps.evaluations.prefect_client.create_run", return_value=uuid4()
        ).start()
        self.addCleanup(patch.stopall)

    def post(self, value=None):
        return self.client.post("/api/v1/ops/evaluations", value or payload(), format="json")

    def test_initial_status_is_read_only_and_pause_blocks_new_requests(self):
        self.assertTrue(status()["accepting"])
        self.assertFalse(EvaluationAdmission.objects.exists())
        change()
        response = self.post()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"code": "EVALUATION_ADMISSION_PAUSED"})
        self.assertFalse(EvaluationRun.objects.exists())
        self.assertFalse(EvaluationBudgetReservation.objects.exists())
        self.create.assert_not_called()

    def test_resume_allows_same_unaccepted_request_and_existing_requests_are_preserved(self):
        request = payload()
        change()
        self.assertEqual(self.post(request).status_code, 503)
        change(True, 1)
        accepted = self.post(request)
        self.assertEqual(accepted.status_code, 202)
        change(False, 2)
        self.assertEqual(self.post(request).status_code, 200)
        self.assertEqual(EvaluationRun.objects.count(), 1)
        self.assertEqual(self.create.call_count, 1)
        self.assertEqual(self.client.get("/api/v1/ops/evaluations").status_code, 200)

    def test_pending_dispatch_can_drain_after_pause_without_accepting_new_work(self):
        request = payload()
        self.create.side_effect = PrefectUnavailable()
        self.assertEqual(self.post(request).status_code, 503)
        change()
        self.create.side_effect = None
        self.assertEqual(self.post(request).status_code, 200)
        self.assertEqual(self.post().status_code, 503)
        self.assertEqual(EvaluationRun.objects.count(), 1)
        self.assertEqual(self.create.call_count, 2)

    def test_replaying_old_resume_does_not_reopen_later_pause(self):
        change()
        request_id = uuid4()
        first = change(True, 1, request_id)
        change(False, 2)
        retry = change(True, 1, request_id)
        self.assertTrue(retry["replayed"])
        self.assertEqual(retry["change"], first["change"])
        self.assertFalse(retry["accepting"])
        self.assertEqual(retry["version"], 3)
        self.assertEqual(EvaluationAdmissionChange.objects.count(), 3)
        with self.assertRaises(ValueError):
            change(True, 1)
        with self.assertRaises(ValueError):
            change(False, 1, request_id)
        self.assertFalse(status()["accepting"])

    def test_audit_protects_state_and_write_failure_rolls_back_both(self):
        change()
        with self.assertRaises(ProtectedError):
            EvaluationAdmission.objects.all().delete()
        with patch.object(EvaluationAdmission, "save", side_effect=DatabaseError("write failed")):
            with self.assertRaises(DatabaseError):
                change(True, 1)
        self.assertFalse(status()["accepting"])
        self.assertEqual(status()["version"], 1)
        self.assertEqual(EvaluationAdmissionChange.objects.count(), 1)

    def test_schema_access_failure_is_closed_and_sanitized(self):
        with patch(
            "apps.evaluations.admission.EvaluationAdmission.objects.get_or_create",
            side_effect=DatabaseError("private sql"),
        ):
            response = self.post()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"code": "EVALUATION_ADMISSION_UNAVAILABLE"})
        self.create.assert_not_called()

    def test_cli_pause_and_status_report_current_version(self):
        output = StringIO()
        call_command(
            "evaluation_admission",
            "pause",
            "--expected-version",
            "0",
            "--request-id",
            str(uuid4()),
            "--actor",
            "운영자",
            "--reason",
            "점검",
            stdout=output,
        )
        self.assertFalse(json.loads(output.getvalue())["accepting"])
        self.assertEqual(json.loads(output.getvalue())["version"], 1)
        output = StringIO()
        call_command("evaluation_admission", "status", stdout=output)
        self.assertFalse(json.loads(output.getvalue())["accepting"])


class AdmissionRecoveryTests(RecoveryFixture, TestCase):
    def test_new_recovery_is_blocked_but_existing_recovery_is_preserved(self):
        request_id = uuid4()
        change()
        rejected = self.post(request_id)
        self.assertEqual(rejected.status_code, 503)
        self.assertEqual(rejected.json()["code"], "EVALUATION_ADMISSION_PAUSED")
        self.assertEqual(EvaluationRun.objects.count(), 1)
        self.create.assert_not_called()
        change(True, 1)
        self.assertEqual(self.post(request_id).status_code, 202)
        change(False, 2)
        self.assertEqual(self.post(request_id).status_code, 200)
        self.assertEqual(self.post().status_code, 503)
        self.assertEqual(self.create.call_count, 1)


class AdmissionConcurrencyTests(TransactionTestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user("concurrent-admission")

    def test_pause_does_not_wait_for_request_preparation(self):
        preparing, release = Event(), Event()
        original = services.make_spec

        def prepare(*args, **kwargs):
            preparing.set()
            if not release.wait(timeout=10):
                raise AssertionError("Preparation was not released")
            return original(*args, **kwargs)

        def submit():
            close_old_connections()
            try:
                return submit_run(self.user, **payload())
            finally:
                close_old_connections()

        def pause():
            close_old_connections()
            try:
                return change()
            finally:
                close_old_connections()

        with patch.object(services, "make_spec", side_effect=prepare):
            with ThreadPoolExecutor(max_workers=2) as pool:
                pending = pool.submit(submit)
                try:
                    self.assertTrue(preparing.wait(timeout=5))
                    self.assertFalse(pool.submit(pause).result(timeout=5)["accepting"])
                finally:
                    release.set()
                with self.assertRaises(AdmissionPaused):
                    pending.result(timeout=10)
        self.assertFalse(EvaluationRun.objects.exists())

    def test_pause_commits_before_waiting_submission_can_create_a_run(self):
        started = Event()

        def submit():
            close_old_connections()
            try:
                started.set()
                return submit_run(self.user, **payload())
            finally:
                close_old_connections()

        with patch("apps.evaluations.prefect_client.create_run") as create:
            with ThreadPoolExecutor(max_workers=1) as pool:
                with transaction.atomic():
                    lock_admission()
                    future = pool.submit(submit)
                    self.assertTrue(started.wait(timeout=5))
                    change()
                with self.assertRaises(AdmissionPaused):
                    future.result(timeout=10)
            self.assertFalse(EvaluationRun.objects.exists())
            create.assert_not_called()

    def test_two_operators_with_same_version_cannot_both_change_state(self):
        barrier = Barrier(2)

        def apply(accepting):
            close_old_connections()
            try:
                barrier.wait(timeout=5)
                try:
                    return change(accepting)
                except ValueError:
                    return None
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(apply, value) for value in (True, False)]
            results = [future.result(timeout=15) for future in futures]
        self.assertEqual(sum(result is not None for result in results), 1)
        self.assertEqual(EvaluationAdmissionChange.objects.count(), 1)
        self.assertEqual(status()["version"], 1)

    def test_dispatch_runs_after_admission_transaction_is_committed(self):
        def dispatch(run):
            self.assertFalse(connection.in_atomic_block)
            self.assertTrue(EvaluationRun.objects.filter(pk=run.pk).exists())
            return uuid4()

        with patch("apps.evaluations.prefect_client.create_run", side_effect=dispatch):
            run, created = submit_run(self.user, **payload())
        self.assertTrue(created)
        self.assertEqual(run.status, "QUEUED")
