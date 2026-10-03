import os
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from io import StringIO
from threading import Barrier
from unittest.mock import patch
from uuid import uuid4, uuid5

from django.core.management import call_command
from django.db import IntegrityError, close_old_connections, transaction
from django.test import TestCase, TransactionTestCase, override_settings
from rest_framework.test import APIClient

from . import prefect_client
from .budget import close_after_cancellation
from .catalog import public_datasets
from .models import (
    EvaluationBaseline,
    EvaluationBudget,
    EvaluationBudgetCall,
    EvaluationBudgetReservation,
    EvaluationDailyBudget,
    EvaluationRun,
    EvaluationSchedule,
    EvaluationScheduleOccurrence,
)
from .schedules import dispatch_due_schedules
from .test_budget import TOKEN
from .test_rag_baselines import BaselineFixture
from .test_reviews import ReviewFixture

URL = "/api/v1/ops/schedules"
NOW = datetime(2026, 10, 3, 0, 0, tzinfo=UTC)  # 서울 09:00


class ScheduleFixture(ReviewFixture):
    def setUp(self):
        clock = patch("django.utils.timezone.now", return_value=NOW)
        self.now = clock.start()
        self.addCleanup(clock.stop)
        super().setUp()
        dispatch = patch(
            "apps.evaluations.prefect_client.create_run", side_effect=lambda _: uuid4()
        )
        self.dispatch = dispatch.start()
        self.addCleanup(dispatch.stop)
        self.promote()
        self.budget = EvaluationBudget.objects.create(
            call_limit=100, input_token_limit=10000000, output_token_limit=1000000
        )
        # ReviewFixture는 파일로 만든 합성 기준이다. 이 테스트에는 미정산 호출이 없다.
        EvaluationBudgetReservation.objects.create(
            run=self.run,
            budget=self.budget,
            max_calls=1,
            max_input_tokens=32768,
            max_output_tokens=2000,
            reserved_input_tokens=0,
            reserved_output_tokens=0,
            closed_at=NOW,
            # 모델의 default=timezone.now는 import 때 함수를 보관하므로 patch를 따르지 않는다.
            created_at=NOW,
        )
        self.daily = EvaluationDailyBudget.objects.create(
            budget=self.budget,
            enabled=True,
            call_limit=20,
            input_token_limit=1000000,
            output_token_limit=100000,
        )

    def payload(self, **changes):
        dataset = next(item for item in public_datasets() if item["id"] == self.dataset)
        return {
            "request_id": str(uuid4()),
            "dataset_id": self.dataset,
            "reference_capture_id": f"run:{self.run.pk}",
            "baseline_version": 1,
            "live_config": dataset["live_config"],
            "execution_profile": dataset["execution_profiles"]["live"],
            "confirm_paid_run": True,
            "daily_at": "09:00",
            "starts_on": "2026-10-03",
            "ends_on": "2026-10-05",
            "reason": "격리 테스트의 3일 평가 승인",
            **changes,
        }

    def create(self, **changes):
        body = self.payload(**changes)
        result = self.client.post(URL, body, format="json")
        self.assertEqual(result.status_code, 201, result.json())
        return EvaluationSchedule.objects.get(pk=result.json()["id"]), body


@override_settings(
    LLMOPS_SCHEDULES_ENABLED=True, LLMOPS_LIVE_ENABLED=True, LLMOPS_BUDGET_TOKEN=TOKEN
)
class ScheduleTests(ScheduleFixture, TestCase):
    def test_create_is_bounded_audited_idempotent_and_does_not_submit(self):
        schedule, body = self.create()
        response = self.client.post(URL, body, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["requested_by"], self.user.get_username())
        self.assertEqual(schedule.requested_by, self.user)
        self.assertEqual(schedule.request["execution_profile"], body["execution_profile"])
        self.assertEqual(
            schedule.max_usage, {"calls": 1, "input_tokens": 32768, "output_tokens": 2000}
        )
        self.assertEqual(EvaluationRun.objects.count(), 1)
        self.assertFalse(EvaluationScheduleOccurrence.objects.exists())
        self.dispatch.assert_not_called()
        self.assertEqual(
            self.client.post(URL, {**body, "reason": "다른 승인"}, format="json").status_code, 409
        )
        self.assertEqual(
            self.client.post(URL, self.payload(), format="json").json()["code"],
            "ACTIVE_SCHEDULE_EXISTS",
        )
        self.assertIn("no-store", self.client.get(URL)["Cache-Control"])

    def test_invalid_dates_time_consent_and_unknown_model_are_rejected(self):
        for changes in (
            {"starts_on": "2026-10-02"},
            {"ends_on": "2026-10-02"},
            {"ends_on": "2026-11-03"},
            {"starts_on": "2026-12-01", "ends_on": "2026-12-02"},
            {"daily_at": "09:00:01"},
            {"confirm_paid_run": False},
            {"live_config": {"model": "unapproved"}},
            {"live_config": []},
        ):
            with self.subTest(changes=changes):
                response = self.client.post(URL, self.payload(**changes), format="json")
                self.assertEqual(response.status_code, 400, response.json())
        self.assertFalse(EvaluationSchedule.objects.exists())

    def test_future_reservation_blocks_schedule_without_dispatch(self):
        EvaluationBudgetReservation.objects.filter(run=self.run).update(
            created_at=NOW + timedelta(days=1)
        )
        response = self.client.post(URL, self.payload(), format="json")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "SCHEDULE_BUDGET_UNAVAILABLE")
        self.assertFalse(EvaluationSchedule.objects.exists())
        self.assertFalse(EvaluationScheduleOccurrence.objects.exists())
        self.dispatch.assert_not_called()

    def test_disabled_missing_baseline_or_daily_budget_prevents_creation(self):
        with override_settings(LLMOPS_SCHEDULES_ENABLED=False):
            self.assertEqual(
                self.client.post(URL, self.payload(), format="json").json()["code"],
                "SCHEDULE_DISABLED",
            )
        with patch("apps.evaluations.schedules.baseline_choices", return_value={}):
            self.assertEqual(
                self.client.post(URL, self.payload(), format="json").json()["code"],
                "REVIEWED_BASELINE_REQUIRED",
            )
        self.daily.enabled = False
        self.daily.save()
        self.assertEqual(
            self.client.post(URL, self.payload(), format="json").json()["code"],
            "SCHEDULE_BUDGET_UNAVAILABLE",
        )
        self.assertFalse(EvaluationSchedule.objects.exists())

    def test_due_once_uses_pinned_request_reserves_budget_and_links_ui_run(self):
        schedule, _ = self.create()
        self.assertEqual(dispatch_due_schedules(), 1)
        self.assertEqual(dispatch_due_schedules(), 0)
        occurrence = schedule.occurrences.get()
        self.assertEqual(occurrence.pk, uuid5(schedule.pk, "2026-10-03"))
        self.assertEqual(occurrence.status, "SUBMITTED")
        self.assertEqual(occurrence.run_id, occurrence.pk)
        self.assertEqual(occurrence.run.status, "QUEUED")
        self.assertEqual(occurrence.run.reference_capture_id, f"run:{self.run.pk}")
        self.assertEqual(occurrence.run.baseline_version, 1)
        self.assertEqual(occurrence.run.budget_reservation.max_calls, 1)
        self.dispatch.assert_called_once()
        data = self.client.get(URL).json()["results"][0]
        self.assertEqual(data["occurrences"][0]["run_id"], str(occurrence.pk))

    def test_restart_recovers_pending_slot_and_prefect_uncertainty_keeps_same_request(self):
        schedule, _ = self.create()
        occurrence = EvaluationScheduleOccurrence.objects.create(
            id=uuid5(schedule.pk, "2026-10-03"), schedule=schedule, scheduled_on=NOW.date()
        )
        self.dispatch.side_effect = prefect_client.PrefectUnavailable
        dispatch_due_schedules()
        occurrence.refresh_from_db()
        self.assertEqual(occurrence.status, "SUBMITTED")
        self.assertEqual(occurrence.run.error_code, "PREFECT_DISPATCH_UNCONFIRMED")
        dispatch_due_schedules()
        self.dispatch.assert_called_once()
        self.now.return_value += timedelta(days=1)
        dispatch_due_schedules()
        self.assertEqual(
            schedule.occurrences.order_by("-scheduled_on").first().reason_code,
            "PREVIOUS_RUN_UNFINISHED",
        )
        self.assertEqual(EvaluationRun.objects.count(), 2)

    def test_seoul_boundary_end_date_and_no_backfill(self):
        schedule, _ = self.create()
        self.now.return_value = NOW - timedelta(seconds=1)
        self.assertEqual(dispatch_due_schedules(), 0)
        self.now.return_value = NOW + timedelta(days=2)
        self.assertEqual(dispatch_due_schedules(), 1)
        self.assertEqual(str(schedule.occurrences.get().scheduled_on), "2026-10-05")
        self.now.return_value += timedelta(days=1)
        self.assertEqual(dispatch_due_schedules(), 0)
        self.assertEqual(self.client.get(URL).json()["results"][0]["state"], "expired")

    def test_restart_marks_old_pending_day_blocked_without_backfill(self):
        schedule, _ = self.create()
        old = EvaluationScheduleOccurrence.objects.create(
            id=uuid5(schedule.pk, "2026-10-03"), schedule=schedule, scheduled_on=NOW.date()
        )
        self.now.return_value += timedelta(days=1)
        dispatch_due_schedules()
        old.refresh_from_db()
        self.assertEqual((old.status, old.reason_code), ("BLOCKED", "MISSED_SCHEDULE_DAY"))
        self.assertEqual(schedule.occurrences.filter(status="SUBMITTED").count(), 1)
        self.dispatch.assert_called_once()

    def test_cancelled_settled_run_allows_next_day_without_reusing_budget(self):
        schedule, _ = self.create()
        dispatch_due_schedules()
        run = schedule.occurrences.get().run
        run.status = "CANCELLED"
        run.cancel_requested_at = NOW
        run.save()
        close_after_cancellation(run)
        self.now.return_value += timedelta(days=1)
        dispatch_due_schedules()
        self.assertEqual(schedule.occurrences.filter(status="SUBMITTED").count(), 2)
        self.budget.refresh_from_db()
        self.assertEqual(self.budget.allocated_calls, 1)

    def test_closed_run_with_unknown_usage_blocks_next_day(self):
        schedule, _ = self.create()
        dispatch_due_schedules()
        run = schedule.occurrences.get().run
        EvaluationBudgetCall.objects.create(
            reservation=run.budget_reservation,
            sequence=0,
            operation_id="answer:E01",
            max_input_tokens=32768,
            max_output_tokens=2000,
        )
        run.status = "CANCELLED"
        run.cancel_requested_at = NOW
        run.save()
        close_after_cancellation(run)
        self.now.return_value += timedelta(days=1)
        dispatch_due_schedules()
        self.assertEqual(
            schedule.occurrences.order_by("-scheduled_on").first().reason_code,
            "PREVIOUS_BUDGET_UNSETTLED",
        )
        self.budget.refresh_from_db()
        self.assertEqual(self.budget.allocated_calls, 1)
        self.dispatch.assert_called_once()

    def test_midnight_between_validation_and_reservation_rolls_back_admission(self):
        schedule, _ = self.create(daily_at="23:59")
        self.now.return_value = NOW.replace(hour=14, minute=59, second=59)
        from .budget import reserve

        def after_midnight(run, **kwargs):
            self.now.return_value += timedelta(seconds=1)
            return reserve(run, **kwargs)

        with patch("apps.evaluations.services.reserve", side_effect=after_midnight):
            dispatch_due_schedules()
        self.assertEqual(schedule.occurrences.get().status, "BLOCKED")
        self.assertEqual(EvaluationRun.objects.count(), 1)
        self.assertEqual(EvaluationBudgetReservation.objects.count(), 1)
        self.dispatch.assert_not_called()

    def test_baseline_revoked_before_due_blocks_without_reservation(self):
        schedule, _ = self.create()
        response = self.client.delete(
            self.url + "/baseline", {"baseline_version": 1, "reason": "검토 철회"}, format="json"
        )
        self.assertEqual(response.status_code, 200)
        dispatch_due_schedules()
        self.assertEqual(schedule.occurrences.get().reason_code, "BASELINE_OR_PROFILE_CHANGED")
        self.assertEqual(EvaluationBudgetReservation.objects.count(), 1)
        self.dispatch.assert_not_called()

    def test_profile_change_blocks_and_never_follows_new_model(self):
        schedule, _ = self.create()
        with patch.dict(os.environ, {"LLMOPS_LIVE_MODEL": "different-model"}):
            dispatch_due_schedules()
        self.assertEqual(schedule.occurrences.get().status, "BLOCKED")
        self.dispatch.assert_not_called()

    def test_budget_reduction_or_disable_blocks_and_does_not_retry_that_day(self):
        schedule, _ = self.create()
        self.daily.call_limit = 0
        self.daily.save()
        dispatch_due_schedules()
        self.assertEqual(schedule.occurrences.get().reason_code, "LIVE_BUDGET_UNAVAILABLE")
        self.daily.call_limit = 20
        self.daily.save()
        dispatch_due_schedules()
        self.dispatch.assert_not_called()

    def test_pause_is_audited_replay_safe_and_replacement_requires_new_approval(self):
        schedule, body = self.create()
        payload = {"request_id": str(uuid4()), "reason": "운영 점검으로 중지"}
        url = f"{URL}/{schedule.pk}/pause"
        self.assertEqual(self.client.post(url, payload, format="json").status_code, 200)
        self.assertEqual(self.client.post(url, payload, format="json").status_code, 200)
        self.assertEqual(
            self.client.post(url, {**payload, "reason": "다른 사유"}, format="json").status_code,
            409,
        )
        self.assertEqual(self.client.post(URL, body, format="json").json()["state"], "paused")
        self.assertEqual(dispatch_due_schedules(), 0)
        schedule.refresh_from_db()
        self.assertEqual(schedule.paused_by, self.user)
        self.assertIsNone(schedule.active_dataset)
        self.create()

    def test_pause_during_preparation_prevents_admission(self):
        schedule, _ = self.create()
        from .services import read_candidate

        def pause_then_read(run):
            self.client.post(
                f"{URL}/{schedule.pk}/pause",
                {"request_id": str(uuid4()), "reason": "접수 전 중지"},
                format="json",
            )
            return read_candidate(run)

        with patch("apps.evaluations.services.read_candidate", side_effect=pause_then_read):
            dispatch_due_schedules()
        self.assertEqual(schedule.occurrences.get().reason_code, "SCHEDULE_CLOSED")
        self.dispatch.assert_not_called()

    def test_worker_default_off_does_not_touch_schedule_tables(self):
        with (
            override_settings(LLMOPS_SCHEDULES_ENABLED=False),
            patch(
                "apps.evaluations.management.commands.sync_evaluations.sync_pending_runs",
                return_value=0,
            ),
            self.assertNumQueries(0),
        ):
            call_command("sync_evaluations", stdout=StringIO())

    def test_session_and_csrf_are_required_for_writes(self):
        client = APIClient(enforce_csrf_checks=True)
        self.assertEqual(client.get(URL).status_code, 401)
        client.cookies["govbiz_session"] = "test-session"
        with patch(
            "apps.evaluations.authentication.read_core_admin",
            return_value={"accountId": 81, "email": "admin@example.com", "role": "ADMIN"},
        ):
            self.assertEqual(client.post(URL, self.payload(), format="json").status_code, 403)
        self.assertFalse(EvaluationSchedule.objects.exists())

    def test_database_enforces_pause_and_daily_uniqueness(self):
        schedule, _ = self.create()
        with self.assertRaises(IntegrityError), transaction.atomic():
            EvaluationSchedule.objects.filter(pk=schedule.pk).update(active_dataset=None)
        dispatch_due_schedules()
        with self.assertRaises(IntegrityError), transaction.atomic():
            EvaluationScheduleOccurrence.objects.create(
                id=uuid4(), schedule=schedule, scheduled_on=NOW.date()
            )


@override_settings(
    LLMOPS_SCHEDULES_ENABLED=True, LLMOPS_LIVE_ENABLED=True, LLMOPS_BUDGET_TOKEN=TOKEN
)
class ConcurrentScheduleTests(ScheduleFixture, TransactionTestCase):
    def test_two_dispatchers_reserve_and_dispatch_only_once(self):
        schedule, _ = self.create()
        barrier = Barrier(2)

        def dispatch():
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                return dispatch_due_schedules()
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(lambda _: dispatch(), range(2)))
        self.assertEqual(schedule.occurrences.count(), 1)
        self.assertEqual(EvaluationRun.objects.count(), 2)
        self.assertEqual(EvaluationBudgetReservation.objects.count(), 2)
        self.assertEqual(schedule.occurrences.get().status, "SUBMITTED")
        # 여러 HTTP 재전송은 Prefect가 요청 ID로 합친다. Ops DB 예약은 항상 한 건이다.
        self.assertTrue(
            all(
                call.args[0].pk == schedule.occurrences.get().pk
                for call in self.dispatch.call_args_list
            )
        )

    def test_baseline_change_while_registering_is_rejected(self):
        from .schedules import baseline_choices

        def revoke_after_read():
            result = baseline_choices()
            EvaluationBaseline.objects.filter(pk=self.dataset).update(version=2, review=None)
            return result

        with patch("apps.evaluations.schedules.baseline_choices", side_effect=revoke_after_read):
            self.assertEqual(self.client.post(URL, self.payload(), format="json").status_code, 409)
        self.assertFalse(EvaluationSchedule.objects.exists())


@override_settings(
    LLMOPS_SCHEDULES_ENABLED=True,
    LLMOPS_LIVE_ENABLED=True,
    LLMOPS_RAG_LIVE_ENABLED=True,
    LLMOPS_BUDGET_TOKEN=TOKEN,
)
class RagScheduleTests(BaselineFixture, TestCase):
    def test_rag_schedule_pins_review_and_reserves_embedding_and_answer_operations(self):
        self.qualify()
        self.assertEqual(self.promote().status_code, 200)
        budget = EvaluationBudget.objects.create(
            call_limit=100, input_token_limit=10000000, output_token_limit=1000000
        )
        EvaluationDailyBudget.objects.create(
            budget=budget,
            enabled=True,
            call_limit=100,
            input_token_limit=10000000,
            output_token_limit=1000000,
        )
        dataset = next(row for row in public_datasets() if row["id"] == self.run.dataset_id)
        with (
            patch("django.utils.timezone.now", return_value=NOW),
            patch("apps.evaluations.prefect_client.create_run", return_value=uuid4()) as dispatch,
        ):
            response = self.client.post(
                URL,
                {
                    "request_id": str(uuid4()),
                    "dataset_id": self.run.dataset_id,
                    "reference_capture_id": f"run:{self.run.pk}",
                    "baseline_version": 1,
                    "live_config": dataset["live_config"],
                    "execution_profile": dataset["execution_profiles"]["live"],
                    "confirm_paid_run": True,
                    "daily_at": "09:00",
                    "starts_on": "2026-10-03",
                    "ends_on": "2026-10-03",
                    "reason": "격리 RAG 계획 승인",
                },
                format="json",
            )
            self.assertEqual(response.status_code, 201, response.json())
            self.assertEqual(dispatch_due_schedules(), 1)
        occurrence = EvaluationScheduleOccurrence.objects.get()
        self.assertEqual(occurrence.status, "SUBMITTED", occurrence.reason_code)
        run = occurrence.run
        self.assertEqual(
            run.reference_config["assessment_id"], self.state()["quality"]["current_id"]
        )
        operations = run.execution_spec["model_operations"]
        self.assertTrue(any(row["kind"] != "answer" for row in operations))
        self.assertEqual(run.budget_reservation.max_calls, len(operations))
        self.assertEqual(
            run.budget_reservation.reserved_input_tokens,
            sum(row["max_input_tokens"] for row in operations),
        )
        dispatch.assert_called_once()
