"""RAG 새 실행 접수·예약·중복·취소 및 관측한 사용량의 경계를 검증한다."""

from copy import deepcopy
from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from .budget import BudgetUnavailable, worker_action
from .catalog import public_datasets
from .models import EvaluationBudget, EvaluationBudgetReservation, EvaluationRun
from .services import cancel_run

DATASET = "rag-synthetic-multichunk-v1"
CAPTURE = "rag-synthetic-capture-v1"


@override_settings(
    LLMOPS_LIVE_ENABLED=True,
    LLMOPS_RAG_LIVE_ENABLED=True,
    LLMOPS_BUDGET_TOKEN="test-only-rag-budget-token-never-used-in-production",
)
class RagLiveSubmissionTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user("core:rag-live-test")
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        dataset = next(row for row in public_datasets() if row["id"] == DATASET)
        self.payload = {
            "request_id": str(uuid4()),
            "dataset_id": DATASET,
            "candidate_capture_id": "new-model-response",
            "reference_capture_id": CAPTURE,
            "execution_mode": "live",
            "live_config": dataset["live_config"],
            "confirm_paid_run": True,
            "execution_profile": dataset["execution_profiles"]["live"],
        }
        self.budget = EvaluationBudget.objects.create(
            call_limit=9, input_token_limit=200000, output_token_limit=6000
        )
        self.dispatch = patch("apps.evaluations.prefect_client.create_run", return_value=uuid4())
        self.create = self.dispatch.start()
        self.addCleanup(self.dispatch.stop)

    def post(self, **changes):
        return self.client.post(
            "/api/v1/ops/evaluations", {**self.payload, **changes}, format="json"
        )

    def test_distinct_activation_and_explicit_data_budget_confirmation_are_required(self):
        with override_settings(LLMOPS_RAG_LIVE_ENABLED=False):
            self.assertEqual(self.post().status_code, 400)
        with override_settings(LLMOPS_LIVE_ENABLED=False):
            self.assertEqual(self.post().status_code, 400)
        self.assertEqual(self.post(confirm_paid_run=False).status_code, 400)
        changed = deepcopy(self.payload["live_config"])
        changed["embedding_model"] = "other"
        self.assertEqual(self.post(live_config=changed).status_code, 400)
        self.assertEqual(self.post(execution_profile="0" * 64).status_code, 400)
        self.assertFalse(EvaluationRun.objects.exists())
        self.assertFalse(EvaluationBudgetReservation.objects.exists())
        self.create.assert_not_called()

    def test_reserves_mixed_call_plan_once_and_preserves_retry_after_disabling(self):
        first = self.post()
        self.assertEqual(first.status_code, 202, first.data)
        run = EvaluationRun.objects.get()
        self.assertIsNone(first.data["model_api_calls"])
        plan = run.execution_spec["model_operations"]
        self.assertEqual(len(plan), 9)
        self.assertEqual(
            {row["kind"] for row in plan}, {"document_embedding", "query_embedding", "answer"}
        )
        reservation = EvaluationBudgetReservation.objects.get()
        self.assertEqual(
            reservation.reserved_input_tokens, sum(row["max_input_tokens"] for row in plan)
        )
        self.assertEqual(reservation.reserved_output_tokens, 6000)
        with override_settings(LLMOPS_RAG_LIVE_ENABLED=False):
            repeated = self.post()
            self.assertEqual(repeated.status_code, 200)
            self.assertEqual(
                repeated.data["prefect_flow_run_id"], first.data["prefect_flow_run_id"]
            )
            self.assertEqual(self.post(request_id=str(uuid4())).status_code, 400)
        self.assertEqual(EvaluationBudgetReservation.objects.count(), 1)
        self.create.assert_called_once()

    def test_disabling_rag_blocks_worker_claim_and_authorization(self):
        self.assertEqual(self.post().status_code, 202)
        run = EvaluationRun.objects.get()
        identity = (run.pk, uuid4(), run.prefect_flow_run_id, run.execution_spec_sha256)
        with override_settings(LLMOPS_RAG_LIVE_ENABLED=False), self.assertRaises(BudgetUnavailable):
            worker_action(*identity, "claim")
        worker_action(*identity, "claim")
        item = run.execution_spec["model_operations"][0]
        with override_settings(LLMOPS_RAG_LIVE_ENABLED=False), self.assertRaises(BudgetUnavailable):
            worker_action(
                *identity,
                "authorize",
                sequence=0,
                operation_id=item["id"],
                model=item["model"],
                max_output_tokens=0,
                input_token_count=item["max_input_tokens"],
                input_sha256=item["input_sha256"],
                dimensions=item["dimensions"],
            )
        self.assertFalse(run.budget_reservation.calls.exists())

    def test_missing_or_insufficient_input_budget_never_dispatches(self):
        for limit in (None, 1):
            EvaluationBudget.objects.filter(pk=1).update(input_token_limit=limit)
            response = self.post()
            self.assertEqual(response.status_code, 400, response.data)
        self.assertFalse(EvaluationRun.objects.exists())
        self.create.assert_not_called()

    def test_unknown_embedding_usage_and_cancelled_run_block_further_authorization(self):
        response = self.post()
        self.assertEqual(response.status_code, 202, response.data)
        run = EvaluationRun.objects.get()
        identity = (run.pk, uuid4(), run.prefect_flow_run_id, run.execution_spec_sha256)
        worker_action(*identity, "claim")
        operation = run.execution_spec["model_operations"][0]
        fields = dict(
            sequence=0,
            operation_id=operation["id"],
            model=operation["model"],
            max_output_tokens=0,
            input_token_count=operation["max_input_tokens"],
            input_sha256=operation["input_sha256"],
            dimensions=operation["dimensions"],
        )
        worker_action(*identity, "authorize", **fields)
        worker_action(*identity, "settle", sequence=0, operation_id=operation["id"], usage=None)
        cancel_run(run, self.user)
        with self.assertRaises(BudgetUnavailable):
            worker_action(*identity, "authorize", **fields)
        worker_action(*identity, "close")
        reservation = EvaluationBudgetReservation.objects.get()
        # 미확정 전송의 입력 예약은 취소·종료 후에도 0으로 바뀌지 않는다.
        self.assertIsNotNone(reservation.closed_at)
        self.assertIsNone(reservation.calls.get().settled_at)
        self.budget.refresh_from_db()
        self.assertEqual(self.budget.allocated_input_tokens, operation["max_input_tokens"])
