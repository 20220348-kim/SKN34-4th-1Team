"""일별 정책의 접수·이월·동시성은 실제 MySQL에서 검증한다. 유료 호출은 없다."""

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from io import StringIO
from threading import Barrier
from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.db import close_old_connections, transaction
from django.test import TestCase, TransactionTestCase, override_settings
from django.utils import timezone

from .budget import BudgetUnavailable, close_after_cancellation, reserve, worker_action
from .daily_budget import change_daily_limits, daily_summary, day_bounds
from .models import (
    EvaluationBudget,
    EvaluationBudgetReservation,
    EvaluationDailyBudget,
    EvaluationDailyBudgetChange,
    EvaluationLegacyUsage,
)
from .test_budget import TOKEN, USAGE
from .test_input_budget import new_run

CAPS = {"calls": 6, "input_tokens": 196608, "output_tokens": 12000}
BEFORE_MIDNIGHT = datetime(2026, 10, 3, 14, 59, 59, tzinfo=UTC)


def configure(**kwargs):
    return change_daily_limits(
        **{
            **CAPS,
            "actor": "test-operator",
            "reason": "격리 DB 일별 한도 검증",
            "request_id": uuid4(),
            **kwargs,
        }
    )


@override_settings(LLMOPS_LIVE_ENABLED=True, LLMOPS_BUDGET_TOKEN=TOKEN)
class DailyBudgetTests(TestCase):
    def setUp(self):
        self.clock = patch("django.utils.timezone.now", return_value=BEFORE_MIDNIGHT)
        self.now = self.clock.start()
        self.addCleanup(self.clock.stop)
        self.user = get_user_model().objects.create_user("daily-budget-operator")
        self.budget = EvaluationBudget.objects.create(
            call_limit=100, input_token_limit=10000000, output_token_limit=1000000
        )
        self.worker = uuid4()

    def start(self):
        run = new_run(self.user)
        reserve(run)
        self.action(run, "claim")
        return run

    def action(self, run, name, **kwargs):
        worker_action(
            run.pk, self.worker, run.prefect_flow_run_id, run.execution_spec_sha256, name, **kwargs
        )

    def authorize(self, run, sequence=0):
        self.action(
            run,
            "authorize",
            sequence=sequence,
            operation_id=run.execution_spec["model_operations"][sequence]["id"],
            model=run.live_config["model"],
            max_output_tokens=2000,
            input_token_count=100,
        )

    def settle(self, run):
        self.action(
            run,
            "settle",
            sequence=0,
            operation_id=run.execution_spec["model_operations"][0]["id"],
            usage=USAGE,
        )

    def summary(self):
        self.budget.refresh_from_db()
        return daily_summary(self.budget)

    def test_optional_policy_get_does_not_create_or_change_existing_behavior(self):
        self.assertEqual(self.summary()["state"], "disabled")
        self.start()
        self.assertEqual(self.summary()["state"], "disabled")
        self.assertFalse(EvaluationDailyBudget.objects.exists())
        self.assertFalse(EvaluationDailyBudgetChange.objects.exists())

    def test_each_limit_blocks_admission_and_rolls_back_run(self):
        for key in CAPS:
            configure(**{key: CAPS[key] - 1})
            with self.subTest(key=key), self.assertRaises(BudgetUnavailable), transaction.atomic():
                reserve(new_run(self.user))
            self.assertFalse(EvaluationBudgetReservation.objects.exists())
        configure()
        run = self.start()
        reserve(run)
        self.assertEqual(self.summary()["remaining"], dict.fromkeys(CAPS, 0))
        self.assertEqual(EvaluationBudgetReservation.objects.count(), 1)
        with self.assertRaises(BudgetUnavailable), transaction.atomic():
            reserve(new_run(self.user))

    def test_midnight_blocks_new_claim_and_call_but_allows_settle_close_and_retry(self):
        configure()
        run = self.start()
        self.authorize(run)
        self.now.return_value += timedelta(seconds=1)
        summary = self.summary()
        self.assertEqual(summary["period_start"], "2026-10-04T00:00:00+09:00")
        self.assertEqual(summary["carried"], CAPS)
        reserve(run)  # Same admission is still idempotent after rollover.
        for action in ("claim", "authorize"):
            with self.subTest(action=action), self.assertRaises(BudgetUnavailable):
                self.action(run, action)
        self.settle(run)
        self.action(run, "close")
        self.assertEqual(self.summary()["remaining"], CAPS)
        self.budget.refresh_from_db()
        self.assertEqual(self.budget.allocated_calls, 1)
        self.assertEqual(self.budget.allocated_input_tokens, 100)
        self.assertEqual(self.budget.allocated_output_tokens, 50)

    def test_closed_unknown_survives_multiple_midnights_and_cancel_releases_only_unapproved(self):
        configure()
        run = self.start()
        self.authorize(run)
        run.cancel_requested_at = timezone.now()
        run.save(update_fields=["cancel_requested_at"])
        close_after_cancellation(run)
        for days in (1, 2, 10):
            self.now.return_value = BEFORE_MIDNIGHT + timedelta(days=days)
            summary = self.summary()
            self.assertEqual(
                summary["carried"], {"calls": 1, "input_tokens": 32768, "output_tokens": 2000}
            )
            self.assertEqual(summary["current_day"], dict.fromkeys(CAPS, 0))
            with self.assertRaises(BudgetUnavailable), transaction.atomic():
                reserve(new_run(self.user))

    def test_confirmed_slack_is_carried_until_close_and_prior_confirmed_usage_is_not_recharged(
        self,
    ):
        configure()
        run = self.start()
        self.authorize(run)
        self.settle(run)
        self.now.return_value += timedelta(days=1)
        self.assertEqual(
            self.summary()["carried"], {"calls": 5, "input_tokens": 196508, "output_tokens": 11950}
        )
        self.action(run, "close")
        self.assertEqual(self.summary()["carried"], dict.fromkeys(CAPS, 0))
        self.start()
        self.assertEqual(self.summary()["allocated"], CAPS)
        self.budget.refresh_from_db()
        self.assertEqual(self.budget.allocated_calls, 7)

    def test_unknown_input_missing_ledger_and_future_timestamp_never_become_zero(self):
        configure()
        run = self.start()
        reservation = EvaluationBudgetReservation.objects.get(run=run)
        for changes in (
            {"max_input_tokens": None},
            {"created_at": BEFORE_MIDNIGHT + timedelta(days=1)},
        ):
            with self.subTest(changes=changes), transaction.atomic():
                EvaluationBudgetReservation.objects.filter(pk=run.pk).update(**changes)
                self.assertEqual(self.summary()["state"], "unknown")
                self.assertIsNone(self.summary()["remaining"])
                with self.assertRaises(ValueError):
                    configure(calls=100)
                transaction.set_rollback(True)
        self.assertEqual(reservation.created_at, BEFORE_MIDNIGHT)
        new_run(self.user)  # Historical live run without accounting evidence.
        self.assertEqual(self.summary()["state"], "unknown")
        with self.assertRaises(BudgetUnavailable), transaction.atomic():
            reserve(new_run(self.user))

    def test_policy_refuses_reductions_and_request_retry_does_not_restore_old_policy(self):
        request = {"request_id": uuid4()}
        first = configure(**request)
        self.start()
        for key in CAPS:
            with self.subTest(key=key), self.assertRaises(ValueError):
                configure(**{key: CAPS[key] - 1})
        configure(calls=12)
        self.assertEqual(configure(**request).pk, first.pk)
        self.assertEqual(EvaluationDailyBudget.objects.get().call_limit, 12)
        with self.assertRaises(ValueError):
            configure(**request, reason="다른 요청")
        disable_request = dict(
            disable=True, actor="operator", reason="명시적 해제", request_id=uuid4()
        )
        change_daily_limits(**disable_request)
        self.assertEqual(self.summary()["state"], "disabled")
        configure()
        change_daily_limits(**disable_request)
        self.assertTrue(EvaluationDailyBudget.objects.get().enabled)

    def test_invalid_limits_and_cli_command(self):
        for value in (True, -1, None, "6", 2**53):
            with self.subTest(value=value), self.assertRaises(ValueError):
                configure(calls=value)
        with self.assertRaises(ValueError):
            configure(disable=True)
        output = StringIO()
        call_command(
            "set_daily_evaluation_budget",
            calls=6,
            input_tokens=196608,
            output_tokens=12000,
            actor="operator",
            reason="운영 명령 검증",
            request_id=str(uuid4()),
            stdout=output,
        )
        self.assertEqual(self.summary()["state"], "enforced")
        self.assertIn("일별 정책 요청", output.getvalue())
        record = EvaluationDailyBudgetChange.objects.get()
        self.assertIsNone(record.previous)
        self.assertEqual(record.policy_snapshot["limits"], CAPS)

    def test_legacy_usage_is_attributed_to_original_run_day_not_reconciliation_day(self):
        configure()
        run = new_run(self.user)
        EvaluationLegacyUsage.objects.create(
            run=run,
            budget=self.budget,
            request_id=uuid4(),
            actor="operator",
            reason="저장 응답",
            capture_sha256="a" * 64,
            evidence_sha256="b" * 64,
            evidence={},
            calls=1,
            input_tokens=100,
            output_tokens=50,
            before={},
            after={},
        )
        self.budget.allocated_calls = 1
        self.budget.allocated_input_tokens = 100
        self.budget.allocated_output_tokens = 50
        self.budget.save()
        self.assertEqual(
            self.summary()["current_day"], {"calls": 1, "input_tokens": 100, "output_tokens": 50}
        )
        self.now.return_value += timedelta(days=1)
        self.assertEqual(self.summary()["allocated"], dict.fromkeys(CAPS, 0))

    def test_seoul_boundary_is_independent_of_application_timezone(self):
        with override_settings(TIME_ZONE="UTC"):
            self.assertEqual(
                day_bounds(BEFORE_MIDNIGHT)[0].isoformat(), "2026-10-03T00:00:00+09:00"
            )
            self.assertEqual(
                day_bounds(BEFORE_MIDNIGHT + timedelta(seconds=1))[0].isoformat(),
                "2026-10-04T00:00:00+09:00",
            )


@override_settings(LLMOPS_BUDGET_TOKEN=TOKEN)
class DailyBudgetConcurrencyTests(TransactionTestCase):
    def test_two_requests_cannot_take_the_last_daily_slot(self):
        user = get_user_model().objects.create_user("daily-race")
        budget = EvaluationBudget.objects.create(
            call_limit=100, input_token_limit=10000000, output_token_limit=1000000
        )
        configure()
        barrier = Barrier(2)

        def attempt():
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                with transaction.atomic():
                    reserve(new_run(user))
                return True
            except BudgetUnavailable:
                return False
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: attempt(), range(2)))
        self.assertCountEqual(results, [True, False])
        budget.refresh_from_db()
        self.assertEqual(daily_summary(budget)["remaining"], dict.fromkeys(CAPS, 0))
        self.assertEqual(EvaluationBudgetReservation.objects.count(), 1)
