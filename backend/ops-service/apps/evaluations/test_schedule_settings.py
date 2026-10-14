"""정기 접수 설정의 관리자 인증·변경 이력·유료 분리·접수 경합 검증."""

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier, Event
from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db import IntegrityError, close_old_connections, transaction
from django.test import TestCase, TransactionTestCase, override_settings
from rest_framework.exceptions import PermissionDenied
from rest_framework.test import APIClient

from .models import (
    EvaluationBudget,
    EvaluationBudgetReservation,
    EvaluationRun,
    EvaluationSchedule,
    EvaluationScheduleSettings,
    EvaluationScheduleSettingsChange,
)
from .schedule_settings import change_settings, lock_settings
from .schedules import dispatch_due_schedules
from .services import RequestConflict
from .test_budget import TOKEN
from .test_schedules import NOW, ScheduleFixture

URL = "/api/v1/ops/schedules/settings"


class PolicyFixture:
    def setUp(self):
        self.user = get_user_model().objects.create_user("core:81")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def payload(self, **changes):
        return {
            "request_id": str(uuid4()),
            "expected_revision": self.client.get(URL).json()["revision"],
            "enabled": True,
            "reason": "관리자 정기 접수 정책 검토",
            **changes,
        }


@override_settings(
    LLMOPS_SCHEDULES_ENABLED=False, LLMOPS_LIVE_ENABLED=False, LLMOPS_RAG_LIVE_ENABLED=False
)
class ScheduleSettingsTests(PolicyFixture, TestCase):
    def test_get_preserves_empty_database_and_environment_fallback(self):
        for value in (False, True):
            with override_settings(LLMOPS_SCHEDULES_ENABLED=value):
                response = self.client.get(URL)
                self.assertEqual(
                    response.json(),
                    {
                        "enabled": value,
                        "revision": 0,
                        "source": "environment",
                        "live_enabled": False,
                        "rag_live_enabled": False,
                        "changes": [],
                    },
                )
                self.assertEqual(self.client.get("/api/v1/ops/schedules").json()["enabled"], value)
                self.assertIn("no-store", response["Cache-Control"])
        self.assertFalse(EvaluationScheduleSettings.objects.exists())
        self.assertFalse(EvaluationScheduleSettingsChange.objects.exists())

    def test_lock_before_first_save_does_not_freeze_environment_value(self):
        with transaction.atomic():
            lock_settings()
        with override_settings(LLMOPS_SCHEDULES_ENABLED=True):
            data = self.client.get(URL).json()
        self.assertEqual(
            (data["enabled"], data["source"], data["revision"]), (True, "environment", 0)
        )

    def test_saved_toggle_is_audited_without_enabling_paid_or_creating_plan(self):
        body = self.payload()
        response = self.client.post(URL, body, format="json")
        self.assertEqual(response.status_code, 200, response.json())
        self.assertIn("no-store", response["Cache-Control"])
        data = response.json()
        self.assertEqual((data["enabled"], data["source"], data["revision"]), (True, "admin", 1))
        self.assertFalse(data["live_enabled"])
        self.assertFalse(data["rag_live_enabled"])
        self.assertEqual(data["change"], data["changes"][0])
        self.assertEqual(data["change"]["previous_enabled"], False)
        self.assertEqual(data["change"]["actor"], self.user.username)
        self.assertEqual(
            EvaluationScheduleSettingsChange.objects.get().authenticated_actor, self.user
        )
        for model in (
            EvaluationRun,
            EvaluationSchedule,
            EvaluationBudget,
            EvaluationBudgetReservation,
        ):
            self.assertFalse(model.objects.exists())
        self.assertTrue(self.client.get("/api/v1/ops/schedules").json()["enabled"])
        body = self.payload(enabled=False)
        self.assertEqual(self.client.post(URL, body, format="json").json()["revision"], 2)
        with override_settings(LLMOPS_SCHEDULES_ENABLED=True):
            self.assertFalse(self.client.get("/api/v1/ops/schedules").json()["enabled"])
        self.assertFalse(self.client.get("/api/v1/ops/session").json()["live_enabled"])

    def test_matching_retry_returns_original_change_and_current_state_after_later_disable(self):
        body = self.payload()
        first = self.client.post(URL, body, format="json").json()
        disable = self.payload(enabled=False)
        self.client.post(URL, disable, format="json")
        replay = self.client.post(URL, body, format="json")
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(replay.json()["change"], first["change"])
        self.assertEqual((replay.json()["enabled"], replay.json()["revision"]), (False, 2))
        self.assertEqual(EvaluationScheduleSettingsChange.objects.count(), 2)
        for key, value in (("reason", "다른 사유"), ("enabled", False), ("expected_revision", 1)):
            self.assertEqual(
                self.client.post(URL, {**body, key: value}, format="json").status_code, 409
            )
        self.client.force_authenticate(get_user_model().objects.create_user("core:82"))
        self.assertEqual(self.client.post(URL, body, format="json").status_code, 409)

    def test_stale_revision_and_aba_change_require_refresh(self):
        stale = self.payload(enabled=False)
        self.client.post(URL, self.payload(), format="json")
        self.client.post(URL, self.payload(enabled=False), format="json")
        response = self.client.post(URL, stale, format="json")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "SCHEDULE_SETTINGS_CONFLICT")
        self.assertEqual(EvaluationScheduleSettingsChange.objects.count(), 2)

    def test_payload_cannot_edit_paid_flags_or_impersonate_actor(self):
        original = self.payload()
        for changes in (
            {"live_enabled": True},
            {"rag_live_enabled": True},
            {"actor": "core:82"},
            {"enabled": "true"},
            {"enabled": 1},
            {"expected_revision": True},
            {"expected_revision": "0"},
            {"expected_revision": -1},
            {"request_id": "bad"},
            {"reason": "   "},
            {"reason": "제어\n문자"},
            {"reason": "x" * 501},
            {"reason": 123},
        ):
            with self.subTest(changes=changes):
                self.assertEqual(
                    self.client.post(URL, {**original, **changes}, format="json").status_code,
                    400,
                )
        self.assertFalse(EvaluationScheduleSettings.objects.exists())

    def test_admin_session_and_csrf_are_required(self):
        client = APIClient(enforce_csrf_checks=True)
        self.assertEqual(client.get(URL).status_code, 401)
        self.assertEqual(client.post(URL, self.payload(), format="json").status_code, 401)
        client.cookies["govbiz_session"] = "test-session"
        with patch("apps.evaluations.authentication.read_core_admin", side_effect=PermissionDenied):
            self.assertEqual(client.get(URL).status_code, 403)
        with patch(
            "apps.evaluations.authentication.read_core_admin",
            return_value={"accountId": 81, "email": "admin@example.com", "role": "ADMIN"},
        ):
            self.assertEqual(client.get(URL).status_code, 200)
            self.assertEqual(client.post(URL, self.payload(), format="json").status_code, 403)
            token = client.get("/api/v1/ops/session").json()["csrf_token"]
            self.assertEqual(
                client.post(URL, self.payload(), format="json", HTTP_X_CSRFTOKEN=token).status_code,
                200,
            )

    def test_only_recent_twenty_changes_are_returned(self):
        for revision in range(22):
            self.client.post(URL, self.payload(enabled=bool(revision % 2)), format="json")
        changes = self.client.get(URL).json()["changes"]
        self.assertEqual([change["revision"] for change in changes], list(range(22, 2, -1)))

    def test_policy_and_audit_rollback_together(self):
        EvaluationScheduleSettings.objects.create()
        with patch.object(EvaluationScheduleSettings, "save", side_effect=IntegrityError):
            with self.assertRaises(IntegrityError):
                self.client.post(URL, self.payload(), format="json")
        self.assertEqual(EvaluationScheduleSettings.objects.get().revision, 0)
        self.assertFalse(EvaluationScheduleSettingsChange.objects.exists())

    def test_database_enforces_singleton_and_initialized_revision(self):
        for values in ({"id": 2}, {"enabled": True}, {"revision": 1}):
            with self.assertRaises(IntegrityError), transaction.atomic():
                EvaluationScheduleSettings.objects.create(**values)


@override_settings(
    LLMOPS_SCHEDULES_ENABLED=True, LLMOPS_LIVE_ENABLED=True, LLMOPS_BUDGET_TOKEN=TOKEN
)
class SchedulePolicyAdmissionTests(ScheduleFixture, TestCase):
    def change(self, enabled):
        response = self.client.post(
            URL,
            {
                "request_id": str(uuid4()),
                "expected_revision": self.client.get(URL).json()["revision"],
                "enabled": enabled,
                "reason": "정기 접수 경계 검증",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.json())

    def test_off_blocks_new_plans_and_dispatch_preserves_existing_request_retry(self):
        schedule, body = self.create()
        self.change(False)
        self.assertEqual(dispatch_due_schedules(), 0)
        self.assertFalse(schedule.occurrences.exists())
        self.assertEqual(
            self.client.post("/api/v1/ops/schedules", body, format="json").status_code, 200
        )
        rejected = self.client.post("/api/v1/ops/schedules", self.payload(), format="json")
        self.assertEqual(rejected.json()["code"], "SCHEDULE_DISABLED")
        self.dispatch.assert_not_called()

    def test_policy_on_overrides_legacy_off_but_keeps_paid_guard(self):
        with override_settings(LLMOPS_SCHEDULES_ENABLED=False, LLMOPS_LIVE_ENABLED=False):
            self.change(True)
            rejected = self.client.post("/api/v1/ops/schedules", self.payload(), format="json")
            self.assertEqual(rejected.json()["code"], "SCHEDULE_DISABLED")
        with override_settings(LLMOPS_SCHEDULES_ENABLED=False):
            schedule, _ = self.create()
            self.assertEqual(dispatch_due_schedules(), 1)
        self.assertEqual(schedule.occurrences.get().status, "SUBMITTED")

    def test_enabled_policy_cannot_dispatch_existing_plan_when_paid_execution_is_off(self):
        schedule, _ = self.create()
        self.change(True)
        with override_settings(LLMOPS_LIVE_ENABLED=False):
            self.assertEqual(dispatch_due_schedules(), 1)
        self.assertEqual(schedule.occurrences.get().reason_code, "SCHEDULE_DISABLED")
        self.assertEqual(EvaluationRun.objects.count(), 1)
        self.assertEqual(EvaluationBudgetReservation.objects.count(), 1)
        self.dispatch.assert_not_called()

    def test_disable_after_initial_validation_prevents_plan_creation(self):
        from .schedules import baseline_choices

        def disable_then_return():
            result = baseline_choices()
            self.change(False)
            return result

        with patch("apps.evaluations.schedules.baseline_choices", side_effect=disable_then_return):
            response = self.client.post("/api/v1/ops/schedules", self.payload(), format="json")
        self.assertEqual(response.json()["code"], "SCHEDULE_DISABLED")
        self.assertFalse(EvaluationSchedule.objects.exists())
        self.dispatch.assert_not_called()

    def test_disabling_preserves_admitted_runs_and_skips_old_days_on_reenable(self):
        schedule, _ = self.create()
        dispatch_due_schedules()
        occurrence = schedule.occurrences.get()
        run_before = EvaluationRun.objects.values().get(pk=occurrence.run_id)
        reservation_before = list(EvaluationBudgetReservation.objects.values())
        self.change(False)
        self.now.return_value += timedelta(days=1)
        self.assertEqual(dispatch_due_schedules(), 0)
        self.assertEqual(EvaluationRun.objects.values().get(pk=occurrence.run_id), run_before)
        self.assertEqual(list(EvaluationBudgetReservation.objects.values()), reservation_before)
        self.now.return_value += timedelta(days=1)
        self.change(True)
        dispatch_due_schedules()
        self.assertEqual(
            list(
                schedule.occurrences.order_by("scheduled_on").values_list("scheduled_on", flat=True)
            ),
            [NOW.date(), NOW.date() + timedelta(days=2)],
        )


@override_settings(LLMOPS_SCHEDULES_ENABLED=False)
class ConcurrentScheduleSettingsTests(PolicyFixture, TransactionTestCase):
    def test_two_admin_changes_with_same_revision_have_one_winner(self):
        barrier = Barrier(2)

        def save(value):
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                try:
                    change_settings(
                        user=self.user,
                        request_id=uuid4(),
                        expected_revision=0,
                        enabled=value,
                        reason="동시 관리자 변경",
                    )
                    return "saved"
                except RequestConflict:
                    return "conflict"
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(save, (False, True)))
        self.assertCountEqual(results, ["saved", "conflict"])
        self.assertEqual(EvaluationScheduleSettings.objects.get().revision, 1)
        self.assertEqual(EvaluationScheduleSettingsChange.objects.count(), 1)


@override_settings(
    LLMOPS_SCHEDULES_ENABLED=True, LLMOPS_LIVE_ENABLED=True, LLMOPS_BUDGET_TOKEN=TOKEN
)
class ConcurrentSchedulePolicyAdmissionTests(ScheduleFixture, TransactionTestCase):
    def test_disable_committed_during_preparation_blocks_new_admission(self):
        schedule, _ = self.create()
        prepared, resume = Event(), Event()
        from .quality import quality_pass

        def delayed_read(run, *args, **kwargs):
            result = quality_pass(run, *args, **kwargs)
            prepared.set()
            if not resume.wait(timeout=10):
                raise AssertionError("disable did not complete during artifact preparation")
            return result

        def dispatch():
            close_old_connections()
            try:
                return dispatch_due_schedules()
            finally:
                close_old_connections()

        with patch("apps.evaluations.quality.quality_pass", side_effect=delayed_read):
            with ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(dispatch)
                try:
                    self.assertTrue(prepared.wait(timeout=10))
                    change_settings(
                        user=self.user,
                        request_id=uuid4(),
                        expected_revision=0,
                        enabled=False,
                        reason="자료 검증 중 접수 중지",
                    )
                finally:
                    resume.set()
                self.assertEqual(future.result(timeout=10), 1)
        self.assertEqual(schedule.occurrences.get().reason_code, "SCHEDULE_DISABLED")
        self.assertEqual(EvaluationRun.objects.count(), 1)
        self.assertEqual(EvaluationBudgetReservation.objects.count(), 1)
        self.dispatch.assert_not_called()

    def test_admission_committed_before_disable_preserves_its_run_and_reservation(self):
        from .budget import reserve

        schedule, _ = self.create()
        reserving, resume, disabling, disabled = Event(), Event(), Event(), Event()

        def delayed_reserve(run, **kwargs):
            reserving.set()
            if not resume.wait(timeout=10):
                raise AssertionError("admission was not released")
            return reserve(run, **kwargs)

        def dispatch():
            close_old_connections()
            try:
                return dispatch_due_schedules()
            finally:
                close_old_connections()

        def disable():
            close_old_connections()
            try:
                disabling.set()
                result = change_settings(
                    user=self.user,
                    request_id=uuid4(),
                    expected_revision=0,
                    enabled=False,
                    reason="접수 중인 평가 이후 정기 접수 중지",
                )
                disabled.set()
                return result
            finally:
                close_old_connections()

        with patch("apps.evaluations.services.reserve", side_effect=delayed_reserve):
            with ThreadPoolExecutor(max_workers=2) as pool:
                admission = pool.submit(dispatch)
                try:
                    self.assertTrue(reserving.wait(timeout=10))
                    update = pool.submit(disable)
                    self.assertTrue(disabling.wait(timeout=10))
                    self.assertFalse(disabled.wait(timeout=0.2))
                finally:
                    resume.set()
                self.assertEqual(admission.result(timeout=10), 1)
                self.assertFalse(update.result(timeout=10)["enabled"])
        occurrence = schedule.occurrences.get()
        self.assertEqual(occurrence.status, "SUBMITTED")
        self.assertEqual(occurrence.run.status, "QUEUED")
        self.assertIsNone(occurrence.run.cancel_requested_at)
        self.assertEqual(EvaluationRun.objects.count(), 2)
        self.assertEqual(EvaluationBudgetReservation.objects.count(), 2)
        self.assertEqual(dispatch_due_schedules(), 0)
        self.dispatch.assert_called_once()
