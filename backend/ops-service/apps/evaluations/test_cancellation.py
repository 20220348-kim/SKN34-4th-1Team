import threading
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db import close_old_connections, connection, transaction
from django.test import SimpleTestCase, TransactionTestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from . import prefect_client
from .budget import BudgetUnavailable, reserve, worker_action
from .models import EvaluationBudget, EvaluationBudgetCall, EvaluationRun
from .services import (
    DATASET_ID,
    RequestConflict,
    cancel_run,
    dispatch_run,
    sync_pending_runs,
    sync_run,
)
from .views import run_data


class CancellationContractTests(SimpleTestCase):
    @patch("apps.evaluations.prefect_client.request_json")
    def test_cancel_proposes_state_without_forcing_completion(self, request):
        flow_id = uuid4()
        request.return_value = {"status": "ACCEPT", "state": {"type": "CANCELLING"}}
        prefect_client.cancel_run(flow_id)
        request.assert_called_once_with(
            f"/flow_runs/{flow_id}/set_state",
            {"state": {"type": "CANCELLING"}, "force": False},
        )
        # Completion can win the race. The caller must read the actual state.
        request.return_value = {"status": "REJECT", "state": {"type": "COMPLETED"}}
        prefect_client.cancel_run(flow_id)

    @patch("apps.evaluations.prefect_client.request_json")
    def test_unconfirmed_or_invalid_acknowledgement_is_not_success(self, request):
        for result in [
            {},
            {"status": "ABORT"},
            {"status": [], "state": {"type": "CANCELLED"}},
            {"status": "ACCEPT", "state": {"type": []}},
            {"status": "WAIT"},
            {"status": "ACCEPT", "state": None},
            {"status": "ACCEPT", "state": {"type": "RUNNING"}},
            {"status": "REJECT", "state": {"type": "SCHEDULED"}},
        ]:
            with self.subTest(result=result), self.assertRaises(prefect_client.PrefectUnavailable):
                request.return_value = result
                prefect_client.cancel_run(uuid4())

    def test_anonymous_cancellation_is_rejected(self):
        with patch("apps.evaluations.views.cancel_run") as cancel:
            response = APIClient().post(f"/api/v1/ops/evaluations/{uuid4()}/cancel", {})
        self.assertEqual(response.status_code, 401)
        cancel.assert_not_called()

    @patch(
        "apps.evaluations.authentication.read_core_admin",
        return_value={
            "accountId": 1,
            "email": "operator@example.com",
            "role": "ADMIN",
        },
    )
    @patch("apps.evaluations.views.cancel_run")
    def test_core_cookie_without_csrf_cannot_cancel(self, cancel, principal):
        response = APIClient(enforce_csrf_checks=True).post(
            f"/api/v1/ops/evaluations/{uuid4()}/cancel",
            {},
            HTTP_COOKIE="govbiz_session=offline-admin-session",
        )
        self.assertEqual(response.status_code, 403)
        cancel.assert_not_called()

    def test_cancelled_or_finished_request_cannot_offer_dispatch_retry(self):
        user = get_user_model()(pk=1, username="owner")
        run = EvaluationRun(
            dataset_id=DATASET_ID,
            requested_by=user,
            execution_spec={"pinned": True},
            created_at=timezone.now(),
        )
        for status in ["CANCELLING", "CANCELLED", "COMPLETED", "FAILED", "RESULT_ERROR"]:
            run.status = status
            self.assertFalse(run_data(run, user.pk)["can_retry"])
        run.status = "QUEUED"
        self.assertTrue(run_data(run, user.pk)["can_cancel"])
        self.assertFalse(run_data(run, 2)["can_cancel"])


@override_settings(
    LLMOPS_LIVE_ENABLED=True,
    LLMOPS_BUDGET_TOKEN="offline-cancellation-test-token-not-for-deployment",
    PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"],
)
class CancellationTests(TransactionTestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user("cancel-owner")
        self.budget = EvaluationBudget.objects.create(call_limit=6, output_token_limit=12000)
        self.run = EvaluationRun.objects.create(
            requested_by=self.user,
            dataset_id=DATASET_ID,
            status="QUEUED",
            execution_mode="live",
            candidate_capture_id="new-model-response",
            live_config={
                "model": "approved-model",
                "max_model_calls": 6,
                "max_output_tokens": 2000,
            },
            execution_spec={"pinned": True},
            execution_spec_sha256="a" * 64,
            prefect_flow_run_id=uuid4(),
            model_api_calls=None,
        )
        with transaction.atomic():
            reserve(self.run)
        self.worker = uuid4()

    def action(self, action, **values):
        return worker_action(
            self.run.pk,
            self.worker,
            self.run.prefect_flow_run_id,
            "a" * 64,
            action,
            **values,
        )

    def authorize(self):
        self.action("authorize", sequence=0, model="approved-model", max_output_tokens=2000)

    def allocated(self):
        self.budget.refresh_from_db()
        return self.budget.allocated_calls, self.budget.allocated_output_tokens

    @patch("apps.evaluations.prefect_client.read_run", return_value={"state_type": "CANCELLING"})
    def test_cancel_blocks_claim_and_next_call_and_records_owner_once(self, read):
        self.action("claim")
        self.authorize()
        run = cancel_run(self.run, self.user)
        stamp = run.cancel_requested_at
        self.assertEqual(run.cancel_requested_by_id, self.user.pk)
        self.assertEqual(cancel_run(run, self.user).cancel_requested_at, stamp)
        sync_run(run)
        self.assertEqual(run.status, "CANCELLING")
        self.assertEqual(self.allocated(), (6, 12000))
        with self.assertRaises(BudgetUnavailable):
            self.action("claim")
        with self.assertRaises(BudgetUnavailable):
            self.action("authorize", sequence=1, model="approved-model", max_output_tokens=2000)
        self.action(
            "settle",
            sequence=0,
            usage={"input_tokens": 100, "output_tokens": 50, "total_tokens": 150},
        )
        self.action("close")
        self.assertEqual(self.allocated(), (1, 50))
        # A stale local status must not re-enable authorizations.
        EvaluationRun.objects.filter(pk=run.pk).update(status="RUNNING")
        with self.assertRaises(BudgetUnavailable):
            self.action("claim")

    @patch("apps.evaluations.prefect_client.read_run", return_value={"state_type": "CANCELLED"})
    def test_confirmed_end_refunds_only_unused_and_preserves_unknown_call(self, read):
        self.action("claim")
        self.authorize()
        run = sync_run(cancel_run(self.run, self.user))
        self.assertEqual(run.status, "CANCELLED")
        self.assertIsNone(run.model_api_calls)
        self.assertEqual(self.allocated(), (1, 2000))
        sync_run(run)
        self.action("close")
        self.assertEqual(self.allocated(), (1, 2000))
        self.assertIsNotNone(run.budget_reservation.closed_at)

    @patch("apps.evaluations.prefect_client.read_run", return_value={"state_type": "CANCELLED"})
    def test_unclaimed_reservation_is_returned_only_after_confirmed_end(self, read):
        run = cancel_run(self.run, self.user)
        self.assertEqual(self.allocated(), (6, 12000))
        sync_run(run)
        self.assertEqual(self.allocated(), (0, 0))
        self.assertIsNone(run.model_api_calls)  # No invented capture/call count.

    @patch(
        "apps.evaluations.prefect_client.cancel_run", side_effect=prefect_client.PrefectUnavailable
    )
    @patch("apps.evaluations.prefect_client.read_run", return_value={"state_type": "RUNNING"})
    def test_remote_outage_keeps_cancellation_and_budget_and_retries_in_background(
        self, read, cancel
    ):
        run = sync_run(cancel_run(self.run, self.user))
        self.assertEqual(run.status, "CANCELLING")
        self.assertEqual(run.error_code, "PREFECT_CANCEL_UNCONFIRMED")
        self.assertEqual(self.allocated(), (6, 12000))
        sync_pending_runs(interval_seconds=0)
        self.assertEqual(cancel.call_count, 2)
        with self.assertRaises(BudgetUnavailable):
            self.action("claim")

    @patch("apps.evaluations.prefect_client.create_run")
    @patch("apps.evaluations.prefect_client.find_run", return_value=None)
    def test_missing_dispatch_stays_pending_without_creating_another_run(self, find, create):
        EvaluationRun.objects.filter(pk=self.run.pk).update(prefect_flow_run_id=None)
        run = sync_run(cancel_run(self.run, self.user))
        self.assertEqual(run.status, "CANCELLING")
        self.assertEqual(run.error_code, "PREFECT_CANCEL_UNCONFIRMED")
        dispatch_run(run)
        create.assert_not_called()
        self.assertEqual(self.allocated(), (6, 12000))
        find.return_value = uuid4()
        with patch(
            "apps.evaluations.prefect_client.read_run", return_value={"state_type": "CANCELLED"}
        ):
            sync_run(run)
        self.assertEqual(run.status, "CANCELLED")
        self.assertEqual(self.allocated(), (0, 0))

    @patch("apps.evaluations.prefect_client.create_run")
    def test_cancel_during_dispatch_keeps_cancel_intent_and_links_late_flow_id(self, create):
        EvaluationRun.objects.filter(pk=self.run.pk).update(
            prefect_flow_run_id=None, status="REQUESTED"
        )
        flow_id = uuid4()

        def dispatched(run):
            self.assertFalse(connection.in_atomic_block)
            cancel_run(run, self.user)
            return flow_id

        create.side_effect = dispatched
        run = dispatch_run(self.run)
        self.assertEqual(run.prefect_flow_run_id, flow_id)
        self.assertEqual(run.status, "CANCELLING")
        self.assertFalse(run_data(run, self.user.pk)["can_retry"])
        dispatch_run(run)
        create.assert_called_once()

    @patch("apps.evaluations.prefect_client.read_run")
    def test_stale_poll_cannot_overwrite_new_cancel_request(self, read):
        def stale(flow_id):
            cancel_run(self.run, self.user)
            return {"state_type": "RUNNING"}

        read.side_effect = stale
        sync_run(self.run)
        self.assertEqual(self.run.status, "CANCELLING")
        self.assertIsNotNone(self.run.cancel_requested_at)

    @patch(
        "apps.evaluations.services.read_result", return_value=("a" * 32, {"caseCount": 6}, None, {})
    )
    @patch("apps.evaluations.prefect_client.read_run", return_value={"state_type": "COMPLETED"})
    @patch("apps.evaluations.prefect_client.cancel_run")
    def test_completion_can_win_without_being_relabelled_cancelled(self, cancel, read, result):
        run = sync_run(cancel_run(self.run, self.user))
        self.assertEqual(run.status, "COMPLETED")
        self.assertEqual(run.summary, {"caseCount": 6})
        self.assertIsNotNone(run.cancel_requested_at)
        self.assertEqual(self.allocated(), (0, 0))
        cancel.assert_not_called()

    @patch("apps.evaluations.prefect_client.cancel_run")
    @patch("apps.evaluations.prefect_client.read_run")
    def test_acknowledgement_is_not_final_until_read_and_network_is_outside_transaction(
        self, read, cancel
    ):
        def remote(flow_id):
            self.assertFalse(connection.in_atomic_block)
            self.assertIsNotNone(EvaluationRun.objects.get(pk=self.run.pk).cancel_requested_at)
            return {"state_type": "RUNNING" if read.call_count == 1 else "CANCELLED"}

        read.side_effect = remote
        sync_run(cancel_run(self.run, self.user))
        cancel.assert_called_once_with(self.run.prefect_flow_run_id)
        self.assertEqual(read.call_count, 2)
        self.assertEqual(self.allocated(), (0, 0))

    @patch("apps.evaluations.prefect_client.read_run", return_value={"state_type": "CANCELLING"})
    def test_api_enforces_owner_and_returns_pending_then_idempotent_result(self, read):
        client = APIClient()
        url = f"/api/v1/ops/evaluations/{self.run.pk}/cancel"
        other = get_user_model().objects.create_user("other-admin")
        client.force_authenticate(other)
        self.assertEqual(client.post(url, {}, format="json").status_code, 403)
        read.assert_not_called()
        client.force_authenticate(self.user)
        response = client.post(url, {}, format="json")
        self.assertEqual(response.status_code, 202)
        data = response.json()
        self.assertEqual(data["status"], "CANCELLING")
        self.assertFalse(data["can_cancel"])
        self.assertFalse(data["can_retry"])
        self.assertEqual(
            client.post(url, {}, format="json").json()["cancel_requested_at"],
            data["cancel_requested_at"],
        )
        self.assertEqual(client.get(url).status_code, 405)

    def test_finished_run_rejects_new_cancellation_and_preserves_original_record(self):
        for status in ["COMPLETED", "CANCELLED", "FAILED", "CRASHED", "RESULT_ERROR"]:
            EvaluationRun.objects.filter(pk=self.run.pk).update(status=status)
            with self.assertRaises(RequestConflict):
                cancel_run(self.run, self.user)
        self.run.refresh_from_db()
        self.assertIsNone(self.run.cancel_requested_at)
        self.assertEqual(self.allocated(), (6, 12000))

    def test_cancel_and_authorize_serialize_on_mysql_budget_lock(self):
        self.action("claim")
        barrier = threading.Barrier(2)

        def attempt(action):
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                if action == "cancel":
                    cancel_run(self.run, self.user)
                    return "cancelled"
                try:
                    self.authorize()
                    return "authorized"
                except BudgetUnavailable:
                    return "blocked"
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(attempt, ["cancel", "authorize"]))
        self.assertEqual(results[0], "cancelled")
        self.assertIn(results[1], {"authorized", "blocked"})
        self.assertEqual(EvaluationBudgetCall.objects.count(), int(results[1] == "authorized"))
        with self.assertRaises(BudgetUnavailable):
            self.authorize()
        self.assertEqual(self.allocated(), (6, 12000))

    @patch("apps.evaluations.prefect_client.read_run", return_value={"state_type": "CANCELLED"})
    def test_worker_close_and_cancel_completion_do_not_refund_twice(self, read):
        self.action("claim")
        self.authorize()
        run = cancel_run(self.run, self.user)
        barrier = threading.Barrier(2)

        def attempt(action):
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                if action == "close":
                    self.action("close")
                else:
                    sync_run(run)
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as executor:
            list(executor.map(attempt, ["close", "sync"]))
        self.assertEqual(self.allocated(), (1, 2000))
