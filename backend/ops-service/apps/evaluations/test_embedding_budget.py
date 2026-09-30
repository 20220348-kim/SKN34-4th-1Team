"""혼합 작업 예산과 기존 공개 RAG 접수 차단을 검증한다."""

import os
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Barrier
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db import close_old_connections, transaction
from django.test import SimpleTestCase, TestCase, TransactionTestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from .budget import BudgetUnavailable, operation_plan, reserve, worker_action
from .budget_cleanup import cleanup_reservation
from .budget_reporting import budget_summary, reservation_data
from .budget_views import BudgetRequest
from .catalog import validate_execution
from .execution_spec import digest
from .models import EvaluationBudget, EvaluationBudgetCall, EvaluationRun
from .test_budget import TOKEN, USAGE
from .test_budget_cleanup import terminal
from .test_usage_correction import _runner
from .usage_correction import CorrectionUnavailable, correct_usage


def mixed_spec():
    config = {
        "model": "gpt-6-luna",
        "embedding_model": "text-embedding-3-small",
        "embedding_dimensions": 1536,
        "max_model_calls": 3,
        "max_input_tokens": 32768,
        "max_output_tokens": 2000,
    }
    return {
        "evaluation_scope": "source-chunks-retrieval-answer",
        "execution_mode": "live",
        "live_config": config,
        "model_operations": [
            {
                "id": "document_embedding:D1:0",
                "kind": "document_embedding",
                "model": "text-embedding-3-small",
                "dimensions": 1536,
                "input_sha256": "a" * 64,
                "max_input_tokens": 500,
                "max_output_tokens": 0,
            },
            {
                "id": "query_embedding:E01:0",
                "kind": "query_embedding",
                "model": "text-embedding-3-small",
                "dimensions": 1536,
                "input_sha256": "b" * 64,
                "max_input_tokens": 50,
                "max_output_tokens": 0,
            },
            {
                "id": "answer:E01",
                "kind": "answer",
                "case_id": "E01",
                "model": "gpt-6-luna",
                "max_input_tokens": 32768,
                "max_output_tokens": 2000,
            },
        ],
    }


class EmbeddingPlanTests(SimpleTestCase):
    def test_malformed_plan_is_rejected_and_public_catalog_stays_closed(self):
        original = mixed_spec()
        operation_plan(
            SimpleNamespace(execution_spec=original, live_config=original["live_config"])
        )
        for field, value in (
            ("max_output_tokens", 1),
            ("max_input_tokens", True),
            ("dimensions", 1),
            ("input_sha256", "bad"),
            ("model", "different"),
            ("kind", "tool"),
            ("kind", []),
            ("id", "answer:D1"),
        ):
            spec = deepcopy(original)
            spec["model_operations"][0][field] = value
            with self.subTest(field=field), self.assertRaises(BudgetUnavailable):
                operation_plan(
                    SimpleNamespace(execution_spec=spec, live_config=spec["live_config"])
                )
        with self.assertRaises((KeyError, ValueError)):
            validate_execution("rag", "new-model-response", "rag", "live", original["live_config"])

    def test_embedding_configuration_and_strict_dimensions(self):
        for model, dimensions in (
            ("other", 1536),
            ("text-embedding-3-small", 1537),
            ("text-embedding-3-large", 3073),
        ):
            spec = mixed_spec()
            spec["live_config"].update(embedding_model=model, embedding_dimensions=dimensions)
            for item in spec["model_operations"][:2]:
                item.update(model=model, dimensions=dimensions)
            with (
                self.subTest(model=model, dimensions=dimensions),
                self.assertRaises(BudgetUnavailable),
            ):
                operation_plan(
                    SimpleNamespace(execution_spec=spec, live_config=spec["live_config"])
                )
        spec = mixed_spec()
        del spec["model_operations"]
        with self.assertRaises(BudgetUnavailable):
            operation_plan(SimpleNamespace(execution_spec=spec, live_config=spec["live_config"]))
        fields = {"worker_id": uuid4(), "flow_id": uuid4(), "spec_hash": "a" * 64}
        for dimensions in (True, "2", 2.0):
            self.assertFalse(BudgetRequest(data={**fields, "dimensions": dimensions}).is_valid())


@override_settings(LLMOPS_LIVE_ENABLED=True, LLMOPS_BUDGET_TOKEN=TOKEN)
class EmbeddingBudgetTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user("embedding-budget")
        self.budget = EvaluationBudget.objects.create(
            call_limit=6, output_token_limit=4000, input_token_limit=33318
        )
        spec = mixed_spec()
        self.run = EvaluationRun.objects.create(
            requested_by=self.user,
            execution_mode="live",
            execution_spec=spec,
            execution_spec_sha256=digest(spec),
            live_config=spec["live_config"],
            prefect_flow_run_id=uuid4(),
        )
        reserve(self.run)
        self.worker = uuid4()
        self.action("claim")

    def action(self, name, **fields):
        worker_action(
            self.run.pk,
            self.worker,
            self.run.prefect_flow_run_id,
            self.run.execution_spec_sha256,
            name,
            **fields,
        )

    def authorize(self, sequence, **changes):
        item = self.run.execution_spec["model_operations"][sequence]
        self.action(
            "authorize",
            **{
                "sequence": sequence,
                "operation_id": item["id"],
                "model": item["model"],
                "max_output_tokens": item["max_output_tokens"],
                "input_token_count": 10,
                **(
                    {"input_sha256": item["input_sha256"], "dimensions": item["dimensions"]}
                    if item["kind"] != "answer"
                    else {}
                ),
                **changes,
            },
        )

    def settle(self, sequence, tokens, output=0):
        self.action(
            "settle",
            sequence=sequence,
            operation_id=self.run.execution_spec["model_operations"][sequence]["id"],
            usage={
                "input_tokens": tokens,
                "output_tokens": output,
                "total_tokens": tokens + output,
            },
        )

    def test_exact_mixed_capacity_and_unknown_embedding_are_preserved(self):
        self.budget.refresh_from_db()
        self.assertEqual(
            (self.budget.allocated_input_tokens, self.budget.allocated_output_tokens), (33318, 2000)
        )
        for changes in (
            {"input_sha256": "c" * 64},
            {"dimensions": 3072},
            {"input_token_count": 501},
        ):
            with self.assertRaises(BudgetUnavailable):
                self.authorize(0, **changes)
        self.authorize(0)
        for usage in ((501, 0), (100, 1)):
            with self.assertRaises(BudgetUnavailable):
                self.settle(0, *usage)
        self.action("close")
        self.budget.refresh_from_db()
        self.assertEqual(
            (self.budget.allocated_input_tokens, self.budget.allocated_output_tokens), (500, 0)
        )
        summary = budget_summary(self.budget)
        self.assertEqual(summary["state"], "consistent")
        self.assertEqual(summary["breakdown"]["unknown_input_tokens"], 500)
        self.run.budget_reservation.refresh_from_db()
        self.assertEqual(
            summary["breakdown"], reservation_data(self.run.budget_reservation)["breakdown"]
        )

    def test_cache_hit_slots_are_unapproved_and_only_unused_capacity_returns(self):
        self.authorize(1)  # cached document means no document embedding call
        self.settle(1, 10)
        self.authorize(2)
        self.settle(2, 100, 50)
        self.budget.refresh_from_db()
        self.assertEqual(budget_summary(self.budget)["state"], "consistent")
        self.action("close")
        self.action("close")
        self.budget.refresh_from_db()
        self.assertEqual(
            (
                self.budget.allocated_calls,
                self.budget.allocated_input_tokens,
                self.budget.allocated_output_tokens,
            ),
            (2, 110, 50),
        )
        self.assertEqual(budget_summary(self.budget)["state"], "consistent")
        self.assertEqual(
            list(
                EvaluationBudgetCall.objects.order_by("sequence").values_list("sequence", flat=True)
            ),
            [1, 2],
        )

    def test_cancel_blocks_next_batch_and_keeps_prior_unknown_input(self):
        self.authorize(0)
        self.settle(0, 100)
        self.authorize(1)
        EvaluationRun.objects.filter(pk=self.run.pk).update(cancel_requested_at=timezone.now())
        with self.assertRaises(BudgetUnavailable):
            self.authorize(2)
        self.action("close")
        self.budget.refresh_from_db()
        self.assertEqual(self.budget.allocated_input_tokens, 150)
        self.assertEqual(budget_summary(self.budget)["state"], "consistent")
        client = APIClient()
        client.force_authenticate(self.user)
        result = client.get(f"/api/v1/ops/evaluations/{self.run.pk}/budget").json()
        self.assertEqual(result["calls"][1]["max_input_tokens"], 50)
        self.assertEqual(result["calls"][1]["max_output_tokens"], 0)
        self.assertNotIn(TOKEN, str(result))

    def test_answer_cannot_be_skipped_as_a_cache_hit(self):
        spec = deepcopy(self.run.execution_spec)
        spec["model_operations"] = [spec["model_operations"][2], *spec["model_operations"][:2]]
        self.run.execution_spec = spec
        self.run.execution_spec_sha256 = digest(spec)
        self.run.save(update_fields=["execution_spec", "execution_spec_sha256"])
        with self.assertRaises(BudgetUnavailable):
            self.authorize(1)
        self.assertFalse(EvaluationBudgetCall.objects.exists())

    def test_changed_reservation_capacity_blocks_claim_and_authorization(self):
        self.run.budget_reservation.reserved_input_tokens = 33317
        self.run.budget_reservation.save(update_fields=["reserved_input_tokens"])
        with self.assertRaises(BudgetUnavailable):
            self.action("claim")
        with self.assertRaises(BudgetUnavailable):
            self.authorize(0)

    def test_terminal_cleanup_and_answer_receipt_allow_cache_gaps(self):
        self.authorize(2)  # both embedding batches were cached
        cleanup_request = dict(
            run_id=self.run.pk, actor="operator", reason="terminal", request_id=uuid4()
        )

        def cleanup():
            with patch("apps.evaluations.prefect_client.read_run", return_value=terminal(self.run)):
                preview = cleanup_reservation(**cleanup_request)
                result = cleanup_reservation(**cleanup_request, apply=True)
                self.assertEqual(preview["after"], result["after"])
            self.assertEqual(result["after"]["reservation_input_tokens"], 32768)

        self.correct_receipt(2, allowed=True, before_correction=cleanup)
        self.budget.refresh_from_db()
        self.assertEqual(
            (self.budget.allocated_input_tokens, self.budget.allocated_output_tokens), (100, 50)
        )
        self.assertEqual(budget_summary(self.budget)["state"], "consistent")

    def test_embedding_cannot_use_an_answer_usage_receipt(self):
        self.authorize(0)
        self.action("close")
        self.correct_receipt(0, allowed=False)
        self.budget.refresh_from_db()
        self.assertEqual(
            (self.budget.allocated_input_tokens, self.budget.allocated_output_tokens), (500, 0)
        )

    def correct_receipt(self, sequence, *, allowed, before_correction=None):
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
                sequence,
                self.run.live_config["model"],
                2000 if allowed else 0,
                200,
                {
                    "id": "resp_mixed_budget",
                    "status": "completed",
                    "usage": USAGE
                    if allowed
                    else {
                        "input_tokens": 100,
                        "output_tokens": 0,
                        "total_tokens": 100,
                    },
                },
            )
            if before_correction:
                before_correction()
            request = dict(
                run_id=self.run.pk,
                sequence=sequence,
                actor="operator",
                reason="receipt",
                request_id=uuid4(),
            )
            if not allowed:
                with self.assertRaises(CorrectionUnavailable):
                    correct_usage(**request)
                return
            preview = correct_usage(**request)
            request["evidence_sha256"] = preview["evidence_sha256"]
            result = correct_usage(**request, apply=True)
            self.assertTrue(correct_usage(**request, apply=True)["replayed"])
            self.assertEqual(result["after"]["unknown_calls"], 0)


@override_settings(LLMOPS_LIVE_ENABLED=True, LLMOPS_BUDGET_TOKEN=TOKEN)
class EmbeddingBudgetConcurrencyTests(TransactionTestCase):
    def test_shared_input_limit_and_unconfigured_input_limit(self):
        user = get_user_model().objects.create_user("embedding-race")
        budget = EvaluationBudget.objects.create(call_limit=6, output_token_limit=4000)
        spec = mixed_spec()
        runs = [
            EvaluationRun.objects.create(
                requested_by=user,
                execution_mode="live",
                execution_spec=spec,
                execution_spec_sha256=digest(spec),
                live_config=spec["live_config"],
                prefect_flow_run_id=uuid4(),
            )
            for _ in range(2)
        ]
        with transaction.atomic(), self.assertRaises(BudgetUnavailable):
            reserve(runs[0])
        budget.input_token_limit = 33318
        budget.save(update_fields=["input_token_limit"])
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
        budget.refresh_from_db()
        self.assertEqual(
            (budget.allocated_input_tokens, budget.allocated_output_tokens), (33318, 2000)
        )
