import threading
from concurrent.futures import ThreadPoolExecutor
from io import StringIO
from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import IntegrityError, close_old_connections, transaction
from django.test import SimpleTestCase, TestCase, TransactionTestCase, override_settings
from rest_framework.test import APIClient

from .budget import BudgetUnavailable, reserve, validate_usage, worker_action
from .catalog import LEGACY_DATASET_ID, live_config, public_datasets
from .models import (
    EvaluationBudget,
    EvaluationBudgetCall,
    EvaluationBudgetReservation,
    EvaluationRun,
)
from .prefect_client import PrefectUnavailable
from .services import submit_run

TOKEN = "offline-budget-token-not-used-for-real-requests"
USAGE = {"input_tokens": 100, "output_tokens": 50, "total_tokens": 150}


class BudgetContractTests(SimpleTestCase):
    def test_unknown_invalid_or_over_cap_usage_is_not_zero(self):
        invalid = [
            None,
            {},
            {**USAGE, "input_tokens": True},
            {**USAGE, "output_tokens": -1},
            {**USAGE, "total_tokens": 151},
            {**USAGE, "input_tokens": 2**60},
            {"input_tokens": 0, "output_tokens": 2001, "total_tokens": 2001},
        ]
        for usage in invalid:
            with self.subTest(usage=usage), self.assertRaises(BudgetUnavailable):
                validate_usage(usage, 2000)
        self.assertEqual(validate_usage(USAGE, 2000), (100, 50))
        self.assertEqual(validate_usage(dict.fromkeys(USAGE, 0), 2000), (0, 0))

    @override_settings(LLMOPS_BUDGET_TOKEN=TOKEN)
    @patch("apps.evaluations.budget_views.worker_action")
    def test_worker_endpoint_rejects_cookies_and_requires_dedicated_token(self, action):
        client = APIClient()
        url = f"/internal/llmops/evaluations/{uuid4()}/budget/claim"
        data = {"worker_id": str(uuid4()), "flow_id": str(uuid4()), "spec_hash": "a" * 64}
        for auth in ("", "Bearer wrong"):
            response = client.post(
                url,
                data,
                format="json",
                HTTP_AUTHORIZATION=auth,
                HTTP_COOKIE="govbiz_session=admin-session",
            )
            self.assertEqual(response.status_code, 403)
        action.assert_not_called()
        response = client.post(url, data, format="json", HTTP_AUTHORIZATION="Bearer " + TOKEN)
        self.assertEqual(response.status_code, 200)
        action.assert_called_once()

    @override_settings(LLMOPS_BUDGET_TOKEN="")
    @patch("apps.evaluations.budget_views.worker_action")
    def test_missing_server_secret_fails_closed(self, action):
        response = APIClient().post(
            f"/internal/llmops/evaluations/{uuid4()}/budget/claim",
            {},
            format="json",
            HTTP_AUTHORIZATION="Bearer ",
        )
        self.assertEqual(response.status_code, 403)
        action.assert_not_called()


@override_settings(LLMOPS_LIVE_ENABLED=True, LLMOPS_BUDGET_TOKEN=TOKEN)
class BudgetTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user("budget-operator")
        self.budget = EvaluationBudget.objects.create(call_limit=6, output_token_limit=12000)
        self.run = EvaluationRun.objects.create(
            requested_by=self.user,
            dataset_id=LEGACY_DATASET_ID,
            execution_mode="live",
            live_config=live_config(LEGACY_DATASET_ID),
            prefect_flow_run_id=uuid4(),
            execution_spec={"approved": True},
            execution_spec_sha256="a" * 64,
        )
        self.worker = uuid4()

    def action(self, name, **kwargs):
        return worker_action(
            self.run.pk,
            self.worker,
            self.run.prefect_flow_run_id,
            self.run.execution_spec_sha256,
            name,
            **kwargs,
        )

    def authorize(self, sequence=0):
        self.action(
            "authorize",
            sequence=sequence,
            model=self.run.live_config["model"],
            max_output_tokens=2000,
        )

    def claimed(self):
        reserve(self.run)
        self.action("claim")

    def test_same_uuid_reserves_once_and_different_uuid_shares_global_limit(self):
        reserve(self.run)
        reserve(self.run)
        other = EvaluationRun.objects.create(
            requested_by=self.user,
            dataset_id="another-dataset",
            execution_mode="live",
            live_config=self.run.live_config,
        )
        with self.assertRaises(BudgetUnavailable):
            reserve(other)
        self.budget.refresh_from_db()
        self.assertEqual(
            (self.budget.allocated_calls, self.budget.allocated_output_tokens), (6, 12000)
        )
        self.assertEqual(EvaluationBudgetReservation.objects.count(), 1)

    def test_output_budget_independently_blocks_reservation(self):
        self.budget.output_token_limit = 11999
        self.budget.save()
        with self.assertRaises(BudgetUnavailable):
            reserve(self.run)
        self.assertFalse(EvaluationBudgetReservation.objects.exists())

    def test_unconfigured_budget_or_secret_does_not_allow_live(self):
        with override_settings(LLMOPS_BUDGET_TOKEN=""), self.assertRaises(BudgetUnavailable):
            reserve(self.run)
        self.budget.delete()
        with self.assertRaises(BudgetUnavailable):
            reserve(self.run)

    def test_transaction_rollback_keeps_budget_unchanged(self):
        with self.assertRaises(RuntimeError), transaction.atomic():
            reserve(self.run)
            raise RuntimeError("simulated request persistence failure")
        self.budget.refresh_from_db()
        self.assertEqual(self.budget.allocated_calls, 0)
        self.assertFalse(EvaluationBudgetReservation.objects.exists())

    def test_worker_identity_spec_and_flow_cannot_be_substituted(self):
        self.claimed()
        for worker, flow, spec in [
            (uuid4(), self.run.prefect_flow_run_id, "a" * 64),
            (self.worker, uuid4(), "a" * 64),
            (self.worker, self.run.prefect_flow_run_id, "b" * 64),
        ]:
            with self.assertRaises(BudgetUnavailable):
                worker_action(self.run.pk, worker, flow, spec, "claim")
        self.action("claim")  # same owner may recheck; a restarted process cannot take over

    def test_duplicate_authorization_and_unknown_previous_call_block_next_send(self):
        self.claimed()
        self.authorize()
        for index in (0, 1):
            with self.assertRaises(BudgetUnavailable):
                self.authorize(index)
        self.action("settle", sequence=0, usage=None)
        with self.assertRaises(BudgetUnavailable):
            self.authorize(1)
        self.assertEqual(EvaluationBudgetCall.objects.count(), 1)

    def test_settlement_is_idempotent_and_close_returns_only_unused_amounts(self):
        self.claimed()
        self.authorize()
        self.action("settle", sequence=0, usage=USAGE)
        self.action("settle", sequence=0, usage=USAGE)
        with self.assertRaises(BudgetUnavailable):
            self.action(
                "settle",
                sequence=0,
                usage={"input_tokens": 0, "output_tokens": 1, "total_tokens": 1},
            )
        self.authorize(1)
        self.action("close")
        self.action("close")
        self.budget.refresh_from_db()
        # One known 50-token response + one unknown 2000-token reservation, never zero.
        self.assertEqual(
            (self.budget.allocated_calls, self.budget.allocated_output_tokens), (2, 2050)
        )
        for name in ("claim", "authorize", "settle"):
            with self.assertRaises(BudgetUnavailable):
                self.action(name, sequence=2)

    def test_restart_or_dispatch_uncertainty_does_not_refund(self):
        self.claimed()
        self.budget.refresh_from_db()
        self.assertEqual(self.budget.allocated_output_tokens, 12000)
        with self.assertRaises(BudgetUnavailable):
            worker_action(self.run.pk, uuid4(), self.run.prefect_flow_run_id, "a" * 64, "close")
        self.budget.refresh_from_db()
        self.assertEqual(self.budget.allocated_calls, 6)

    def test_disable_live_blocks_next_call_but_allows_settlement_and_close(self):
        self.claimed()
        self.authorize()
        with override_settings(LLMOPS_LIVE_ENABLED=False):
            self.action("settle", sequence=0, usage=USAGE)
            with self.assertRaises(BudgetUnavailable):
                self.authorize(1)
            self.action("close")

    def test_terminal_run_cannot_send_again_but_can_account_for_prior_call(self):
        self.claimed()
        self.authorize()
        EvaluationRun.objects.filter(pk=self.run.pk).update(status="CANCELLED")
        with self.assertRaises(BudgetUnavailable):
            self.authorize(1)
        self.action("settle", sequence=0, usage=USAGE)
        self.action("close")

    def test_operator_limit_change_never_resets_or_undercuts_allocated_usage(self):
        reserve(self.run)
        with self.assertRaises(CommandError):
            call_command(
                "set_evaluation_budget",
                calls=5,
                output_tokens=12000,
                actor="test-operator",
                reason="한도 축소 검증",
                request_id=str(uuid4()),
                stdout=StringIO(),
            )
        call_command(
            "set_evaluation_budget",
            calls=12,
            output_tokens=24000,
            actor="test-operator",
            reason="한도 증액 검증",
            request_id=str(uuid4()),
            stdout=StringIO(),
        )
        self.budget.refresh_from_db()
        self.assertEqual(self.budget.allocated_calls, 6)
        self.assertEqual(self.budget.call_limit, 12)

    def test_database_rejects_exceeded_budget_and_duplicate_call(self):
        with self.assertRaises(IntegrityError), transaction.atomic():
            EvaluationBudget.objects.filter(pk=1).update(allocated_calls=7)
        self.claimed()
        self.authorize()
        with self.assertRaises(IntegrityError), transaction.atomic():
            EvaluationBudgetCall.objects.create(reservation_id=self.run.pk, sequence=0)

    @patch("apps.evaluations.prefect_client.create_run")
    def test_dispatch_loss_reuses_reservation_and_exhausted_request_rolls_back(self, create):
        create.side_effect = [PrefectUnavailable(), uuid4()]
        payload = dict(
            user=self.user,
            request_id=uuid4(),
            dataset_id=LEGACY_DATASET_ID,
            candidate_capture_id="new-model-response",
            execution_mode="live",
            confirm_paid_run=True,
            live_config=live_config(LEGACY_DATASET_ID),
            execution_profile=public_datasets()[0]["execution_profiles"]["live"],
        )
        run, first = submit_run(**payload)
        self.assertTrue(first)
        self.assertIsNone(run.prefect_flow_run_id)
        repeated, created = submit_run(**payload)
        self.assertFalse(created)
        self.assertEqual(run.pk, repeated.pk)
        self.assertEqual(EvaluationBudgetReservation.objects.count(), 1)
        next_id = uuid4()
        with self.assertRaises(BudgetUnavailable):
            submit_run(**{**payload, "request_id": next_id})
        self.assertFalse(EvaluationRun.objects.filter(pk=next_id).exists())
        self.assertEqual(create.call_count, 2)

    @patch("apps.evaluations.prefect_client.create_run")
    def test_api_budget_rejection_does_not_create_or_dispatch_run(self, create):
        self.budget.call_limit = 0
        self.budget.save()
        client = APIClient()
        client.force_authenticate(self.user)
        request_id = uuid4()
        response = client.post(
            "/api/v1/ops/evaluations",
            {
                "request_id": str(request_id),
                "dataset_id": LEGACY_DATASET_ID,
                "candidate_capture_id": "new-model-response",
                "execution_mode": "live",
                "confirm_paid_run": True,
                "live_config": live_config(LEGACY_DATASET_ID),
                "execution_profile": public_datasets()[0]["execution_profiles"]["live"],
            },
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {"code": "LIVE_BUDGET_UNAVAILABLE"})
        self.assertFalse(EvaluationRun.objects.filter(pk=request_id).exists())
        create.assert_not_called()

    def test_replay_needs_no_budget(self):
        self.run.execution_mode = "replay"
        reserve(self.run)
        self.assertFalse(EvaluationBudgetReservation.objects.exists())


@override_settings(LLMOPS_LIVE_ENABLED=True, LLMOPS_BUDGET_TOKEN=TOKEN)
class BudgetConcurrencyTests(TransactionTestCase):
    def test_different_datasets_compete_for_one_mysql_budget_without_overspending(self):
        user = get_user_model().objects.create_user("concurrent-operator")
        EvaluationBudget.objects.create(call_limit=1, output_token_limit=2000)
        runs = [
            EvaluationRun.objects.create(
                requested_by=user,
                dataset_id=f"dataset-{i}",
                execution_mode="live",
                live_config={"max_model_calls": 1, "max_output_tokens": 2000},
            )
            for i in range(2)
        ]
        barrier = threading.Barrier(2)

        def attempt(run):
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                with transaction.atomic():
                    reserve(run)
                return "reserved"
            except BudgetUnavailable:
                return "blocked"
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(attempt, runs))
        self.assertCountEqual(results, ["reserved", "blocked"])
        self.assertEqual(EvaluationBudgetReservation.objects.count(), 1)
        self.assertEqual(EvaluationBudget.objects.get(pk=1).allocated_calls, 1)

    def test_duplicate_workers_cannot_share_the_same_reserved_run(self):
        user = get_user_model().objects.create_user("worker-race")
        EvaluationBudget.objects.create(call_limit=1, output_token_limit=2000)
        run = EvaluationRun.objects.create(
            requested_by=user,
            dataset_id="worker-race",
            execution_mode="live",
            live_config={
                "model": "approved-model",
                "max_model_calls": 1,
                "max_output_tokens": 2000,
            },
            prefect_flow_run_id=uuid4(),
            execution_spec={"approved": True},
            execution_spec_sha256="a" * 64,
        )
        with transaction.atomic():
            reserve(run)
        barrier = threading.Barrier(2)

        def claim(owner):
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                worker_action(run.pk, owner, run.prefect_flow_run_id, "a" * 64, "claim")
                worker_action(
                    run.pk,
                    owner,
                    run.prefect_flow_run_id,
                    "a" * 64,
                    "authorize",
                    sequence=0,
                    model="approved-model",
                    max_output_tokens=2000,
                )
                return "authorized"
            except BudgetUnavailable:
                return "blocked"
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(claim, [uuid4(), uuid4()]))
        self.assertCountEqual(results, ["authorized", "blocked"])
        self.assertEqual(EvaluationBudgetCall.objects.count(), 1)
