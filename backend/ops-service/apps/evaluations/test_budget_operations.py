"""작업 명세 계약은 DB 없이, 승인·취소·migration은 CI MySQL에서 검증한다."""

from copy import deepcopy
from types import SimpleNamespace
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.test import SimpleTestCase, TestCase, TransactionTestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from .budget import BudgetUnavailable, operation_plan, reserve, worker_action
from .budget_views import BudgetRequest
from .catalog import LEGACY_DATASET_ID, live_config
from .execution_spec import digest, make_spec, read_release
from .models import EvaluationBudget, EvaluationBudgetCall, EvaluationRun
from .test_budget import TOKEN, USAGE


def approved_spec():
    return make_spec(
        read_release(),
        LEGACY_DATASET_ID,
        "live",
        live_config(LEGACY_DATASET_ID),
        "new-model-response",
        LEGACY_DATASET_ID,
    )


class BudgetOperationContractTests(SimpleTestCase):
    def test_operations_pin_each_case_model_and_limit_in_order(self):
        spec = approved_spec()
        plan = operation_plan(SimpleNamespace(execution_spec=spec, live_config=spec["live_config"]))
        self.assertEqual([item["case_id"] for item in plan], spec["dataset"]["case_ids"])
        self.assertEqual(len(plan), spec["live_config"]["max_model_calls"])
        for item in plan:
            self.assertEqual(item["kind"], "answer")
            self.assertEqual(item["id"], "answer:" + item["case_id"])
            self.assertEqual(item["model"], spec["live_config"]["model"])
            self.assertEqual(item["max_output_tokens"], spec["live_config"]["max_output_tokens"])

    def test_legacy_spec_does_not_invent_a_plan(self):
        spec = approved_spec()
        spec.pop("model_operations")
        self.assertIsNone(
            operation_plan(SimpleNamespace(execution_spec=spec, live_config=spec["live_config"]))
        )

    def test_malformed_mixed_or_changed_plan_is_rejected(self):
        original = approved_spec()
        changed = []
        for field, value in (
            ("id", "answer:another"),
            ("kind", "query_embedding"),
            ("case_id", "another"),
            ("model", "unapproved"),
            ("max_output_tokens", 1),
            ("max_input_tokens", 1),
        ):
            spec = deepcopy(original)
            spec["model_operations"][0][field] = value
            changed.append(spec)
        changed.extend(
            {**original, "model_operations": value}
            for value in (None, [], {}, original["model_operations"][::-1])
        )
        changed.extend(
            {**original, "dataset": value}
            for value in (None, [], {}, {"case_ids": ["TC01", "TC01"]}, {"case_ids": [True]})
        )
        changed.extend(
            [
                {**original, "evaluation_scope": "full-rag"},
                {**original, "execution_mode": "replay"},
                {**original, "live_config": {**original["live_config"], "model": "changed"}},
            ]
        )
        for spec in changed:
            with self.subTest(spec=spec), self.assertRaises(BudgetUnavailable):
                operation_plan(
                    SimpleNamespace(execution_spec=spec, live_config=original["live_config"])
                )

    def test_input_count_does_not_coerce_booleans_strings_or_floats(self):
        fields = {"worker_id": uuid4(), "flow_id": uuid4(), "spec_hash": "a" * 64}
        for value in (True, "100", 100.0, -1, 262113, None):
            with self.subTest(value=value):
                self.assertFalse(
                    BudgetRequest(data={**fields, "input_token_count": value}).is_valid()
                )
        self.assertTrue(BudgetRequest(data={**fields, "input_token_count": 32768}).is_valid())

    def test_worker_contract_accepts_case_id_but_rejects_unimplemented_operation(self):
        fields = {"worker_id": uuid4(), "flow_id": uuid4(), "spec_hash": "a" * 64}
        valid = BudgetRequest(data={**fields, "operation_id": "answer:TC01"})
        self.assertTrue(valid.is_valid(), valid.errors)
        self.assertEqual(valid.validated_data["operation_id"], "answer:TC01")
        for value in (None, "", "unsupported:TC01", "answer:", "answer:" + "a" * 101):
            with self.subTest(value=value):
                self.assertFalse(BudgetRequest(data={**fields, "operation_id": value}).is_valid())


@override_settings(LLMOPS_LIVE_ENABLED=True, LLMOPS_BUDGET_TOKEN=TOKEN)
class BudgetOperationTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user("operation-operator")
        self.budget = EvaluationBudget.objects.create(call_limit=6, output_token_limit=12000)
        spec = approved_spec()
        self.run = EvaluationRun.objects.create(
            requested_by=self.user,
            dataset_id=LEGACY_DATASET_ID,
            execution_mode="live",
            live_config=spec["live_config"],
            prefect_flow_run_id=uuid4(),
            execution_spec=spec,
            execution_spec_sha256=digest(spec),
        )
        self.worker = uuid4()
        self.ids = [item["id"] for item in spec["model_operations"]]
        reserve(self.run)
        self.action("claim")

    def action(self, action, **fields):
        worker_action(
            self.run.pk,
            self.worker,
            self.run.prefect_flow_run_id,
            self.run.execution_spec_sha256,
            action,
            **fields,
        )

    def authorize(self, sequence, operation_id):
        self.action(
            "authorize",
            sequence=sequence,
            operation_id=operation_id,
            model=self.run.live_config["model"],
            max_output_tokens=2000,
            input_token_count=100,
        )

    def test_substituted_or_missing_case_cannot_authorize_or_settle(self):
        for wrong in (None, self.ids[1], "answer:unknown", "document_embedding:TC01"):
            with self.subTest(wrong=wrong), self.assertRaises(BudgetUnavailable):
                self.authorize(0, wrong)
        self.assertFalse(EvaluationBudgetCall.objects.exists())
        self.authorize(0, self.ids[0])
        for wrong in (None, self.ids[1]):
            with self.subTest(wrong=wrong), self.assertRaises(BudgetUnavailable):
                self.action("settle", sequence=0, operation_id=wrong, usage=USAGE)
        call = EvaluationBudgetCall.objects.get()
        self.assertIsNone(call.settled_at)
        self.assertEqual(call.operation_id, self.ids[0])
        for _ in range(2):
            self.action("settle", sequence=0, operation_id=self.ids[0], usage=USAGE)
        with self.assertRaises(BudgetUnavailable):
            self.authorize(1, self.ids[0])
        self.authorize(1, self.ids[1])
        self.action("close")
        self.budget.refresh_from_db()
        self.assertEqual(
            (self.budget.allocated_calls, self.budget.allocated_output_tokens), (2, 2050)
        )

    def test_lost_approval_response_is_never_reissued_and_unknown_usage_keeps_reservation(self):
        self.authorize(0, self.ids[0])
        with self.assertRaises(BudgetUnavailable):
            self.authorize(0, self.ids[0])
        self.action("settle", sequence=0, operation_id=self.ids[0], usage=None)
        with self.assertRaises(BudgetUnavailable):
            self.authorize(1, self.ids[1])
        self.action("close")
        self.budget.refresh_from_db()
        self.assertEqual(
            (self.budget.allocated_calls, self.budget.allocated_output_tokens), (1, 2000)
        )

    def test_cancel_blocks_next_operation_but_can_settle_prior_operation(self):
        self.authorize(0, self.ids[0])
        EvaluationRun.objects.filter(pk=self.run.pk).update(cancel_requested_at=timezone.now())
        self.action("settle", sequence=0, operation_id=self.ids[0], usage=USAGE)
        with self.assertRaises(BudgetUnavailable):
            self.authorize(1, self.ids[1])
        self.action("close")
        self.budget.refresh_from_db()
        self.assertEqual(
            (self.budget.allocated_calls, self.budget.allocated_output_tokens), (1, 50)
        )

    def test_mysql_rejects_duplicate_operation_even_at_different_sequence(self):
        self.authorize(0, self.ids[0])
        for value in (self.ids[0], ""):
            with self.subTest(value=value), self.assertRaises(IntegrityError), transaction.atomic():
                EvaluationBudgetCall.objects.create(
                    reservation_id=self.run.pk, sequence=1, operation_id=value
                )

    def test_admin_response_preserves_operation_identity_without_worker_secret(self):
        self.authorize(0, self.ids[0])
        client = APIClient()
        client.force_authenticate(self.user)
        response = client.get(f"/api/v1/ops/evaluations/{self.run.pk}/budget")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["calls"][0]["operation_id"], self.ids[0])
        self.assertNotIn(str(self.worker), response.content.decode())
        self.assertNotIn(TOKEN, response.content.decode())


class BudgetOperationMigrationTests(TransactionTestCase):
    def test_legacy_calls_keep_usage_and_unknown_operation(self):
        from django.db import connection
        from django.db.migrations.executor import MigrationExecutor

        executor = MigrationExecutor(connection)
        latest = executor.loader.graph.leaf_nodes()
        old = [("evaluations", "0015_usage_correction")]
        try:
            executor.migrate(old)
            apps = executor.loader.project_state(old).apps
            user = apps.get_model("auth", "User").objects.create(username="legacy-budget-operator")
            run = apps.get_model("evaluations", "EvaluationRun").objects.create(
                requested_by_id=user.pk
            )
            budget = apps.get_model("evaluations", "EvaluationBudget").objects.create(
                call_limit=6,
                output_token_limit=12000,
                allocated_calls=6,
                allocated_output_tokens=12000,
            )
            reservation = apps.get_model(
                "evaluations", "EvaluationBudgetReservation"
            ).objects.create(
                run_id=run.pk, budget_id=budget.pk, max_calls=6, max_output_tokens=2000
            )
            calls = apps.get_model("evaluations", "EvaluationBudgetCall")
            calls.objects.create(reservation_id=reservation.pk, sequence=0)
            calls.objects.create(
                reservation_id=reservation.pk,
                sequence=1,
                input_tokens=100,
                output_tokens=50,
                settled_at=timezone.now(),
            )
            corrected = calls.objects.create(reservation_id=reservation.pk, sequence=2)
            apps.get_model("evaluations", "EvaluationUsageCorrection").objects.create(
                request_id=uuid4(),
                call_id=corrected.pk,
                actor="legacy",
                reason="receipt",
                evidence_sha256="c" * 64,
                response_id="resp_legacy",
                evidence_raw="{}",
                input_tokens=150,
                output_tokens=30,
                original_call={},
                before={},
                after={},
            )
            executor = MigrationExecutor(connection)
            executor.migrate(latest)
            apps = executor.loader.project_state(latest).apps
            kept = list(
                apps.get_model("evaluations", "EvaluationBudgetCall").objects.order_by("sequence")
            )
            self.assertEqual([call.counted_input_tokens for call in kept], [None, None, None])
            self.assertEqual([call.max_input_tokens for call in kept], [None, None, None])
            self.assertEqual([call.max_output_tokens for call in kept], [None, None, None])
            from .budget import call_limits, reservation_limits
            from .models import EvaluationBudgetReservation

            current = EvaluationBudgetReservation.objects.get(pk=run.pk)
            self.assertIsNone(current.reserved_input_tokens)
            self.assertIsNone(current.reserved_output_tokens)
            self.assertEqual(reservation_limits(current), (None, 12000))
            self.assertEqual(call_limits(current.calls.get(sequence=0)), (None, 2000))
            self.assertEqual(
                apps.get_model("evaluations", "EvaluationBudget")
                .objects.get(pk=1)
                .allocated_input_tokens,
                250,
            )
            self.assertIsNone(
                apps.get_model("evaluations", "EvaluationBudgetReservation")
                .objects.get(pk=run.pk)
                .max_input_tokens
            )
            self.assertEqual([call.operation_id for call in kept], [None, None, None])
            self.assertEqual([call.output_tokens for call in kept], [None, 50, None])
            receipt = apps.get_model("evaluations", "EvaluationUsageCorrection").objects.get()
            self.assertEqual(receipt.response_id, "resp_legacy")
            self.assertIsNone(receipt.provider_request_id)
            self.assertEqual((receipt.input_tokens, receipt.output_tokens), (150, 30))
            self.assertEqual(receipt.evidence_raw, "{}")
            self.assertEqual(
                apps.get_model("evaluations", "EvaluationBudget")
                .objects.get(pk=1)
                .allocated_output_tokens,
                12000,
            )
        finally:
            MigrationExecutor(connection).migrate(latest)
