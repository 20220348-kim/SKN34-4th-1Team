import copy
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from io import StringIO
from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import DatabaseError, close_old_connections, connection, transaction
from django.test import SimpleTestCase, TransactionTestCase, override_settings
from rest_framework.test import APIClient

from . import prefect_client
from .budget import BudgetUnavailable, reserve, worker_action
from .budget_cleanup import CleanupUnavailable, cleanup_reservation, terminal_evidence
from .execution_spec import digest
from .models import (
    EvaluationBudget,
    EvaluationBudgetCleanup,
    EvaluationBudgetReservation,
    EvaluationRun,
)
from .test_budget import TOKEN, USAGE


def terminal(run, state="FAILED"):
    return {
        "id": str(run.prefect_flow_run_id),
        "idempotency_key": f"ops-{run.pk}",
        "parameters": {**prefect_client.run_parameters(run), "recovery_config": None},
        "state_type": state,
        "state": {"id": str(uuid4()), "type": state, "timestamp": "2026-09-29T00:00:00Z"},
    }


class TerminalEvidenceTests(SimpleTestCase):
    def setUp(self):
        self.run = EvaluationRun(
            execution_mode="live", prefect_flow_run_id=uuid4(), execution_spec={"version": 1}
        )
        self.run.execution_spec_sha256 = digest(self.run.execution_spec)

    def test_only_confirmed_terminal_states_accept_normalized_defaults(self):
        for state in ("COMPLETED", "FAILED", "CRASHED", "CANCELLED"):
            self.assertEqual(
                terminal_evidence(self.run, terminal(self.run, state))["state_type"], state
            )
        for state in ("RUNNING", "CANCELLING", "PAUSED", "SCHEDULED", "PENDING"):
            with self.subTest(state=state), self.assertRaises(CleanupUnavailable):
                terminal_evidence(self.run, terminal(self.run, state))

    def test_missing_conflicting_or_unbound_remote_evidence_is_rejected(self):
        original = terminal(self.run)
        bad = [None, {}, {**original, "id": str(uuid4())}, {**original, "idempotency_key": "other"}]
        for field, value in (
            ("id", "bad"),
            ("timestamp", "bad"),
            ("timestamp", "2026-09-29"),
            ("type", "RUNNING"),
        ):
            bad.append({**original, "state": {**original["state"], field: value}})
        for field, value in (
            ("request_id", str(uuid4())),
            ("execution_spec_sha256", "b" * 64),
            ("live_config", {"model": "other"}),
        ):
            bad.append({**original, "parameters": {**original["parameters"], field: value}})
        # Python equality alone considers True equal to 1. The JSON digest must still differ.
        boolean_spec = copy.deepcopy(original)
        boolean_spec["parameters"]["execution_spec"]["version"] = True
        bad.append(boolean_spec)
        for response in bad:
            with self.subTest(response=response), self.assertRaises(CleanupUnavailable):
                terminal_evidence(self.run, response)
        self.run.execution_spec_sha256 = "a" * 64
        with self.assertRaises(CleanupUnavailable):
            terminal_evidence(self.run, original)


@override_settings(LLMOPS_LIVE_ENABLED=True, LLMOPS_BUDGET_TOKEN=TOKEN)
class BudgetCleanupTests(TransactionTestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user("cleanup-operator")
        self.budget = EvaluationBudget.objects.create(call_limit=6, output_token_limit=12000)
        self.run = EvaluationRun.objects.create(
            requested_by=self.user,
            dataset_id="cleanup-fixture",
            execution_mode="live",
            status="RUNNING",
            prefect_flow_run_id=uuid4(),
            execution_spec={"version": 1},
            execution_spec_sha256=digest({"version": 1}),
            live_config={"model": "test-only", "max_model_calls": 6, "max_output_tokens": 2000},
        )
        with transaction.atomic():
            reserve(self.run)
        self.worker = uuid4()
        self.request = dict(
            run_id=self.run.pk,
            actor="김 운영자",
            reason="종료 후 close 실패 확인",
            request_id=uuid4(),
        )
        self.remote = terminal(self.run)
        self.read = patch(
            "apps.evaluations.prefect_client.read_run", side_effect=self.read_remote
        ).start()
        self.addCleanup(patch.stopall)

    def read_remote(self, flow_id):
        self.assertFalse(connection.in_atomic_block)
        self.assertEqual(flow_id, self.run.prefect_flow_run_id)
        return self.remote

    def action(self, name, **kwargs):
        worker_action(
            self.run.pk,
            self.worker,
            self.run.prefect_flow_run_id,
            self.run.execution_spec_sha256,
            name,
            **kwargs,
        )

    def authorize(self, sequence=0):
        self.action("authorize", sequence=sequence, model="test-only", max_output_tokens=2000)

    def amounts(self):
        self.budget.refresh_from_db()
        return self.budget.allocated_calls, self.budget.allocated_output_tokens

    def apply(self, **kwargs):
        return cleanup_reservation(**{**self.request, "apply": True, **kwargs})

    def test_preview_does_not_close_refund_or_record(self):
        self.action("claim")
        self.authorize()
        result = cleanup_reservation(**self.request)
        self.assertFalse(result["applied"])
        self.assertEqual(result["after"]["reservation_output_tokens"], 2000)
        self.assertEqual(self.amounts(), (6, 12000))
        self.assertIsNone(EvaluationBudgetReservation.objects.get(pk=self.run.pk).closed_at)
        self.assertFalse(EvaluationBudgetCleanup.objects.exists())

    def test_cleanup_preserves_independently_accounted_legacy_usage(self):
        from .test_legacy_usage import seed_legacy_usage

        seed_legacy_usage(self.budget, self.user)
        self.apply()
        self.assertEqual(self.amounts(), (1, 1))
        self.assertEqual(self.budget.allocated_input_tokens, 1)

    def test_cleanup_preserves_unknown_and_records_audit_without_new_execution(self):
        self.action("claim")
        self.authorize()
        self.action("settle", sequence=0, usage=USAGE)
        self.authorize(1)
        with patch("apps.evaluations.prefect_client.create_run") as create:
            result = self.apply()
        self.assertEqual(self.amounts(), (2, 2050))
        self.assertEqual(result["before"]["reservation_output_tokens"], 12000)
        self.assertEqual(result["after"]["unknown_output_tokens"], 2000)
        record = EvaluationBudgetCleanup.objects.get()
        self.assertEqual(record.actor, "김 운영자")
        self.assertEqual(record.worker_id, self.worker)
        self.assertEqual([item["sequence"] for item in record.calls], [0, 1])
        self.assertIsNone(record.calls[1]["output_tokens"])
        self.assertEqual(
            record.evidence["parameters_sha256"], digest(prefect_client.run_parameters(self.run))
        )
        create.assert_not_called()
        self.assertEqual(EvaluationRun.objects.count(), 1)
        # Even a stale/incorrect RUNNING status cannot reopen this reservation.
        for action in ("claim", "authorize", "settle"):
            with self.assertRaises(BudgetUnavailable):
                self.action(action, sequence=1, usage=USAGE)
        self.action("close")
        self.assertEqual(self.amounts(), (2, 2050))

    def test_unclaimed_preflight_failure_and_lost_claim_response(self):
        result = self.apply()
        self.assertEqual(self.amounts(), (0, 0))
        self.assertIsNone(EvaluationBudgetCleanup.objects.get().worker_id)
        self.assertEqual(result["after"]["unknown_calls"], 0)
        self.run.refresh_from_db()
        self.assertEqual(self.run.status, "RUNNING")  # Cleanup does not rewrite evaluation history.

    def test_claim_without_authorization_can_be_cleaned_after_crash(self):
        self.action("claim")
        self.remote = terminal(self.run, "CRASHED")
        self.apply()
        self.assertEqual(self.amounts(), (0, 0))
        self.assertEqual(EvaluationBudgetCleanup.objects.get().worker_id, self.worker)

    def test_completed_run_with_missing_report_can_release_only_known_slack(self):
        self.action("claim")
        self.authorize()
        self.action("settle", sequence=0, usage=USAGE)
        self.remote = terminal(self.run, "COMPLETED")
        self.apply()
        self.assertEqual(self.amounts(), (1, 50))

    def test_same_request_returns_original_without_prefect_and_conflicts_are_rejected(self):
        original = self.apply()
        self.read.reset_mock(side_effect=True)
        self.read.side_effect = prefect_client.PrefectUnavailable
        replay = self.apply()
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["evidence"], original["evidence"])
        self.read.assert_not_called()
        for changed in ({"reason": "changed"}, {"actor": "other"}, {"run_id": uuid4()}):
            with self.assertRaises(CleanupUnavailable):
                self.apply(**changed)
        with self.assertRaises(CleanupUnavailable):
            self.apply(request_id=uuid4())
        self.assertEqual(EvaluationBudgetCleanup.objects.count(), 1)
        self.assertEqual(self.amounts(), (0, 0))

    def test_remote_outage_or_active_state_never_releases(self):
        self.read.side_effect = prefect_client.PrefectUnavailable
        with self.assertRaises(prefect_client.PrefectUnavailable):
            self.apply()
        self.read.side_effect = lambda _: terminal(self.run, "RUNNING")
        with self.assertRaises(CleanupUnavailable):
            self.apply()
        self.assertEqual(self.amounts(), (6, 12000))
        self.assertFalse(EvaluationBudgetCleanup.objects.exists())

    def test_retry_that_observes_concurrent_commit_before_reading_reservation(self):
        self.apply()
        record = EvaluationBudgetCleanup.objects.get()
        with patch("apps.evaluations.budget_cleanup._existing", side_effect=[None, record]):
            self.assertTrue(self.apply()["replayed"])
        self.assertEqual(self.amounts(), (0, 0))

    def test_changed_owner_or_spec_while_reading_is_rejected(self):
        for field, value in (("worker_id", uuid4()), ("max_calls", 5)):

            def changed(_, field=field, value=value):
                EvaluationBudgetReservation.objects.filter(pk=self.run.pk).update(**{field: value})
                return self.remote

            self.read.side_effect = changed
            with self.assertRaises(CleanupUnavailable):
                self.apply()
            EvaluationBudgetReservation.objects.filter(pk=self.run.pk).update(
                worker_id=None, max_calls=6
            )

        def changed_spec(_):
            EvaluationRun.objects.filter(pk=self.run.pk).update(execution_spec_sha256="b" * 64)
            return self.remote

        self.read.side_effect = changed_spec
        with self.assertRaises(CleanupUnavailable):
            self.apply()
        self.assertEqual(self.amounts(), (6, 12000))

    def test_inconsistent_global_ledger_and_call_sequence_block_cleanup(self):
        EvaluationBudget.objects.filter(pk=1).update(allocated_output_tokens=11999)
        with self.assertRaises(CleanupUnavailable):
            self.apply()
        EvaluationBudget.objects.filter(pk=1).update(allocated_output_tokens=12000)
        self.action("claim")
        self.authorize()
        self.run.budget_reservation.calls.update(sequence=5)
        with self.assertRaises(CleanupUnavailable):
            self.apply()
        self.assertEqual(self.amounts(), (6, 12000))

    def test_audit_failure_rolls_back_closure_and_budget(self):
        with (
            patch.object(EvaluationBudgetCleanup, "save", side_effect=DatabaseError),
            self.assertRaises(DatabaseError),
        ):
            self.apply()
        self.assertEqual(self.amounts(), (6, 12000))
        self.assertIsNone(EvaluationBudgetReservation.objects.get(pk=self.run.pk).closed_at)
        self.assertFalse(EvaluationBudgetCleanup.objects.exists())

    def test_cli_defaults_to_preview_and_reports_unavailable_without_mutation(self):
        output = StringIO()
        call_command("cleanup_evaluation_budget", **self.request, stdout=output)
        self.assertFalse(json.loads(output.getvalue())["applied"])
        self.assertEqual(self.amounts(), (6, 12000))
        self.read.side_effect = prefect_client.PrefectUnavailable
        with self.assertRaises(CommandError):
            call_command("cleanup_evaluation_budget", **self.request, apply=True, stdout=StringIO())
        self.assertEqual(self.amounts(), (6, 12000))

    def test_detail_exposes_read_only_audit_without_worker_identity(self):
        self.action("claim")
        self.authorize()
        self.apply()
        client = APIClient()
        client.force_authenticate(self.user)
        url = f"/api/v1/ops/evaluations/{self.run.pk}/budget"
        response = client.get(url)
        self.assertEqual(response.status_code, 200)
        self.assertIn("no-store", response["Cache-Control"])
        audit = response.json()["cleanup"]
        self.assertEqual(audit["after"]["unknown_output_tokens"], 2000)
        self.assertNotIn("worker_id", audit)
        self.assertNotIn("calls", audit)
        self.assertEqual(client.post(url, {}).status_code, 405)

    def race(self, first, second):
        barrier = threading.Barrier(2)

        def attempt(action):
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                try:
                    return action()
                except (CleanupUnavailable, BudgetUnavailable):
                    return "blocked"
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as executor:
            return list(executor.map(attempt, [first, second]))

    def test_duplicate_cleanup_and_worker_close_do_not_release_twice(self):
        self.action("claim")
        self.authorize()
        self.race(self.apply, lambda: self.action("close"))
        self.assertEqual(self.amounts(), (1, 2000))
        self.assertLessEqual(EvaluationBudgetCleanup.objects.count(), 1)

    def test_concurrent_same_request_is_idempotent(self):
        results = self.race(self.apply, self.apply)
        self.assertEqual(self.amounts(), (0, 0))
        self.assertEqual(EvaluationBudgetCleanup.objects.count(), 1)
        self.assertTrue(all(result != "blocked" for result in results))

    def test_authorization_race_is_either_blocked_or_preserved_as_unknown(self):
        self.action("claim")
        self.race(self.apply, self.authorize)
        calls = self.run.budget_reservation.calls.count()
        self.assertIn(calls, (0, 1))
        self.assertEqual(self.amounts(), (calls, calls * 2000))
        with self.assertRaises(BudgetUnavailable):
            self.authorize()

    def test_settlement_race_uses_confirmed_usage_or_keeps_full_unknown_capacity(self):
        self.action("claim")
        self.authorize()
        self.race(self.apply, lambda: self.action("settle", sequence=0, usage=USAGE))
        settled = self.run.budget_reservation.calls.get().settled_at is not None
        self.assertEqual(self.amounts(), (1, 50 if settled else 2000))
        audit = EvaluationBudgetCleanup.objects.get()
        self.assertEqual(audit.after["unknown_calls"], 0 if settled else 1)
