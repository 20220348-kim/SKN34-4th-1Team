"""입력 상한, 기존 미확인 사용량, 병행 접수와 반환을 실제 DB에서 검증한다."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from threading import Barrier
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db import close_old_connections, transaction
from django.test import TestCase, TransactionTestCase, override_settings
from django.utils import timezone

from .budget import BudgetUnavailable, close_after_cancellation, reserve, worker_action
from .budget_reporting import budget_summary, change_limits
from .execution_spec import digest
from .models import EvaluationBudget, EvaluationBudgetCall, EvaluationRun
from .test_budget import TOKEN, USAGE
from .test_budget_operations import approved_spec


def new_run(user):
    spec = deepcopy(approved_spec())
    return EvaluationRun.objects.create(
        requested_by=user,
        dataset_id=spec["dataset_id"],
        execution_mode="live",
        live_config=spec["live_config"],
        prefect_flow_run_id=uuid4(),
        execution_spec=spec,
        execution_spec_sha256=digest(spec),
    )


@override_settings(LLMOPS_LIVE_ENABLED=True, LLMOPS_BUDGET_TOKEN=TOKEN)
class InputBudgetTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user("input-operator")
        self.budget = EvaluationBudget.objects.create(
            call_limit=12,
            output_token_limit=24000,
            input_token_limit=6 * 32768,
        )
        self.run = new_run(self.user)
        reserve(self.run)
        self.worker = uuid4()
        self.action("claim")

    def action(self, action, **kwargs):
        worker_action(
            self.run.pk,
            self.worker,
            self.run.prefect_flow_run_id,
            self.run.execution_spec_sha256,
            action,
            **kwargs,
        )

    def authorize(self, sequence=0, tokens=100):
        self.action(
            "authorize",
            sequence=sequence,
            operation_id=self.run.execution_spec["model_operations"][sequence]["id"],
            model=self.run.live_config["model"],
            max_output_tokens=2000,
            input_token_count=tokens,
        )

    def settle(self, usage=USAGE):
        self.action(
            "settle",
            sequence=0,
            operation_id=self.run.execution_spec["model_operations"][0]["id"],
            usage=usage,
        )

    def test_terminal_cleanup_and_signed_correction_return_input_once(self):
        import json
        import os
        from pathlib import Path
        from tempfile import TemporaryDirectory
        from unittest.mock import patch

        from .budget_cleanup import cleanup_reservation
        from .test_budget_cleanup import terminal
        from .test_usage_correction import _runner, signed
        from .usage_correction import CorrectionUnavailable, correct_usage

        self.authorize()
        with TemporaryDirectory() as folder, override_settings(LLMOPS_RESULTS_DIR=Path(folder)):
            directory = Path(folder) / str(self.run.pk) / "capture"
            directory.mkdir(parents=True)
            with patch.dict(os.environ, {"LLMOPS_BUDGET_TOKEN": TOKEN}):
                runner = _runner.BudgetClient(
                    str(self.run.pk),
                    str(self.run.prefect_flow_run_id),
                    self.run.execution_spec_sha256,
                )
            runner.identity["worker_id"] = str(self.worker)
            runner.record_usage_receipt(
                directory,
                0,
                self.run.live_config["model"],
                2000,
                200,
                {"id": "resp_input_test", "status": "completed", "usage": USAGE},
            )
            cleanup_request = dict(
                run_id=self.run.pk, actor="operator", reason="terminal", request_id=uuid4()
            )
            with patch("apps.evaluations.prefect_client.read_run", return_value=terminal(self.run)):
                preview = cleanup_reservation(**cleanup_request)
                self.budget.refresh_from_db()
                self.assertEqual(self.budget.allocated_input_tokens, 196608)
                result = cleanup_reservation(**cleanup_request, apply=True)
                self.assertEqual(result["after"]["reservation_input_tokens"], 32768)
                self.assertEqual(preview["after"], result["after"])
            request = dict(
                run_id=self.run.pk,
                sequence=0,
                actor="operator",
                reason="receipt",
                request_id=uuid4(),
            )
            receipt = directory / "usage-0.json"
            original = receipt.read_bytes()
            excessive = json.loads(original)["payload"]
            excessive["usage"] = {"input_tokens": 32769, "output_tokens": 50, "total_tokens": 32819}
            receipt.write_bytes(signed(excessive))
            with self.assertRaises(CorrectionUnavailable):
                correct_usage(**request)
            self.budget.refresh_from_db()
            self.assertEqual(self.budget.allocated_input_tokens, 32768)
            receipt.write_bytes(original)
            preview = correct_usage(**request)
            request["evidence_sha256"] = preview["evidence_sha256"]
            result = correct_usage(**request, apply=True)
            correct_usage(**request, apply=True)
            self.budget.refresh_from_db()
            self.assertEqual(self.budget.allocated_input_tokens, 100)
            self.assertEqual(result["before"]["global_input_tokens"], 32768)
            self.assertIsNone(EvaluationBudgetCall.objects.get().settled_at)
            self.assertEqual(budget_summary(self.budget)["state"], "consistent")

    def test_input_limit_alone_blocks_new_run_and_missing_or_invalid_count_blocks_approval(self):
        with self.assertRaises(BudgetUnavailable):
            reserve(new_run(self.user))
        for value in (None, True, -1, "100", 32769):
            with self.subTest(value=value), self.assertRaises(BudgetUnavailable):
                self.authorize(tokens=value)
        self.assertFalse(EvaluationBudgetCall.objects.exists())
        self.authorize(tokens=32768)
        self.assertEqual(EvaluationBudgetCall.objects.get().counted_input_tokens, 32768)
        with self.assertRaises(BudgetUnavailable):
            self.settle({"input_tokens": 32769, "output_tokens": 50, "total_tokens": 32819})
        self.assertIsNone(EvaluationBudgetCall.objects.get().settled_at)

    def test_settle_close_retry_and_unknown_keep_exact_input_allocation(self):
        self.authorize()
        self.settle()
        self.settle()
        self.budget.refresh_from_db()
        self.assertEqual(self.budget.allocated_input_tokens, 6 * 32768)
        self.authorize(1)
        self.action("close")
        self.action("close")
        self.budget.refresh_from_db()
        summary = budget_summary(self.budget)
        self.assertEqual(summary["input_state"], "enforced")
        self.assertEqual(summary["allocated"]["input_tokens"], 32768 + 100)
        self.assertEqual(summary["breakdown"]["unknown_input_tokens"], 32768)
        self.assertEqual(summary["state"], "consistent")

    def test_cancel_releases_unapproved_and_known_slack_but_preserves_unknown(self):
        self.authorize()
        self.run.cancel_requested_at = timezone.now()
        self.run.save(update_fields=["cancel_requested_at"])
        with self.assertRaises(BudgetUnavailable):
            self.authorize(1)
        close_after_cancellation(self.run)
        self.budget.refresh_from_db()
        self.assertEqual(self.budget.allocated_input_tokens, 32768)
        self.assertEqual(budget_summary(self.budget)["state"], "consistent")

    def test_input_limit_cannot_drop_below_allocation_or_be_omitted_after_activation(self):
        for value in (None, 6 * 32768 - 1):
            with self.subTest(value=value), self.assertRaises(ValueError):
                change_limits(
                    calls=12,
                    output_tokens=24000,
                    input_tokens=value,
                    actor="operator",
                    reason="review",
                    request_id=uuid4(),
                )


@override_settings(LLMOPS_LIVE_ENABLED=True, LLMOPS_BUDGET_TOKEN=TOKEN)
class LegacyInputBudgetTests(TestCase):
    def test_unknown_legacy_is_never_zero_and_activation_waits_for_known_closed_usage(self):
        user = get_user_model().objects.create_user("legacy-input")
        budget = EvaluationBudget.objects.create(call_limit=6, output_token_limit=12000)
        run = EvaluationRun.objects.create(
            requested_by=user,
            execution_mode="live",
            execution_spec={"legacy": True},
            execution_spec_sha256="a" * 64,
            prefect_flow_run_id=uuid4(),
            live_config={"model": "legacy", "max_model_calls": 6, "max_output_tokens": 2000},
        )
        request = dict(
            calls=6,
            output_tokens=12000,
            input_tokens=1000,
            actor="operator",
            reason="review",
            request_id=uuid4(),
        )
        with self.assertRaises(ValueError):
            change_limits(**request)  # no reservation at all
        reserve(run)
        worker = uuid4()

        def action(name, **kwargs):
            worker_action(run.pk, worker, run.prefect_flow_run_id, "a" * 64, name, **kwargs)

        action("claim")
        action("authorize", sequence=0, model="legacy", max_output_tokens=2000)
        budget.refresh_from_db()
        summary = budget_summary(budget)
        self.assertIsNone(summary["allocated"]["input_tokens"])
        self.assertEqual(summary["input_state"], "legacy_unknown")
        with self.assertRaises(ValueError):
            change_limits(**request)
        action("settle", sequence=0, usage=USAGE)
        action("settle", sequence=0, usage=USAGE)
        action("close")
        change = change_limits(**request)
        self.assertEqual(change.input_token_limit, 1000)
        self.assertIsNone(change.previous_input_token_limit)
        budget.refresh_from_db()
        self.assertEqual(budget.allocated_input_tokens, 100)
        self.assertEqual(budget_summary(budget)["remaining"]["input_tokens"], 900)
        self.assertEqual(change_limits(**request).pk, change.pk)


@override_settings(LLMOPS_BUDGET_TOKEN=TOKEN)
class InputBudgetConcurrencyTests(TransactionTestCase):
    def test_two_reservations_cannot_exceed_shared_input_limit(self):
        user = get_user_model().objects.create_user("input-race")
        EvaluationBudget.objects.create(
            call_limit=12, output_token_limit=24000, input_token_limit=6 * 32768
        )
        runs = [new_run(user), new_run(user)]
        barrier = Barrier(2)

        def attempt(run):
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                with transaction.atomic():
                    reserve(run)
                return True
            except BudgetUnavailable:
                return False
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertCountEqual(list(pool.map(attempt, runs)), [True, False])
        budget = EvaluationBudget.objects.get(pk=1)
        self.assertEqual(budget.allocated_input_tokens, budget.input_token_limit)
