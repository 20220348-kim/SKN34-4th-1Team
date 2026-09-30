import threading
from concurrent.futures import ThreadPoolExecutor
from io import StringIO
from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import close_old_connections, transaction
from django.test import SimpleTestCase, TestCase, TransactionTestCase, override_settings
from rest_framework.exceptions import PermissionDenied
from rest_framework.test import APIClient

from .budget import BudgetUnavailable, reserve, worker_action
from .budget_reporting import change_limits
from .models import EvaluationBudget, EvaluationBudgetChange, EvaluationRun
from .test_budget import TOKEN, USAGE


class BudgetReadPermissionTests(SimpleTestCase):
    def test_missing_session_and_worker_token_cannot_read_admin_ledger(self):
        client = APIClient()
        for url in (
            "/api/v1/ops/budget",
            "/api/v1/ops/budget/reservations",
            f"/api/v1/ops/evaluations/{uuid4()}/budget",
        ):
            for auth in ("", "Bearer " + TOKEN):
                self.assertEqual(client.get(url, HTTP_AUTHORIZATION=auth).status_code, 401)

    @patch("apps.evaluations.authentication.read_core_admin", side_effect=PermissionDenied)
    def test_non_admin_session_cannot_read_ledger(self, read):
        client = APIClient()
        client.cookies["govbiz_session"] = "ordinary-account"
        self.assertEqual(client.get("/api/v1/ops/budget").status_code, 403)
        read.assert_called_once_with("ordinary-account")


@override_settings(LLMOPS_LIVE_ENABLED=True, LLMOPS_BUDGET_TOKEN=TOKEN)
class BudgetReportingTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user("ledger-operator")
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.budget = EvaluationBudget.objects.create(call_limit=12, output_token_limit=24000)
        self.run = EvaluationRun.objects.create(
            requested_by=self.user,
            dataset_id="ledger-fixture",
            execution_mode="live",
            live_config={"max_model_calls": 6, "max_output_tokens": 2000, "model": "test-only"},
            prefect_flow_run_id=uuid4(),
            execution_spec={"test": True},
            execution_spec_sha256="a" * 64,
        )
        self.worker = uuid4()

    def action(self, action, **kwargs):
        worker_action(
            self.run.pk, self.worker, self.run.prefect_flow_run_id, "a" * 64, action, **kwargs
        )

    def start(self):
        reserve(self.run)
        self.action("claim")
        self.action("authorize", sequence=0, model="test-only", max_output_tokens=2000)

    def summary(self):
        response = self.client.get("/api/v1/ops/budget")
        self.assertEqual(response.status_code, 200)
        self.assertIn("no-store", response["Cache-Control"])
        return response.json()

    def test_settlement_keeps_output_slack_until_close_and_unknown_is_not_zero(self):
        self.start()
        self.action("settle", sequence=0, usage=USAGE)
        summary = self.summary()
        self.assertEqual(summary["state"], "consistent")
        self.assertEqual(
            summary["allocated"], {"calls": 6, "output_tokens": 12000, "input_tokens": None}
        )
        self.assertEqual(
            summary["remaining"], {"calls": 6, "output_tokens": 12000, "input_tokens": None}
        )
        self.assertEqual(
            summary["breakdown"],
            {
                "allocated_input_tokens": 100,
                "unknown_input_tokens": 0,
                "unapproved_input_tokens": 0,
                "pending_release_input_tokens": 0,
                "unbounded_input_calls": 0,
                "unbounded_input_reservations": 1,
                "settled_calls": 1,
                "confirmed_input_tokens": 100,
                "confirmed_output_tokens": 50,
                "unknown_calls": 0,
                "unknown_output_tokens": 0,
                "unapproved_calls": 5,
                "unapproved_output_tokens": 10000,
                "pending_release_output_tokens": 1950,
                "allocated_calls": 6,
                "allocated_output_tokens": 12000,
            },
        )
        self.action("authorize", sequence=1, model="test-only", max_output_tokens=2000)
        self.action("close")
        summary = self.summary()
        self.assertEqual(
            summary["allocated"], {"calls": 2, "output_tokens": 2050, "input_tokens": None}
        )
        self.assertEqual(summary["breakdown"]["unknown_output_tokens"], 2000)
        self.assertEqual(summary["breakdown"]["pending_release_output_tokens"], 0)
        detail = self.client.get(f"/api/v1/ops/evaluations/{self.run.pk}/budget").json()
        self.assertEqual(detail["state"], "recorded")
        self.assertEqual(detail["reservation"]["breakdown"], summary["breakdown"])
        self.assertIsNone(detail["calls"][1]["output_tokens"])
        self.assertIsNone(detail["calls"][1]["settled_at"])
        self.assertNotIn("worker_id", detail["reservation"])

    def test_missing_historical_reservation_and_non_live_are_not_fabricated_zero_usage(self):
        self.assertEqual(self.summary()["legacy_live_run_count"], 1)
        url = f"/api/v1/ops/evaluations/{self.run.pk}/budget"
        detail = self.client.get(url).json()
        self.assertEqual(detail["state"], "missing")
        self.assertIsNone(detail["reservation"])
        self.run.execution_mode = "replay"
        self.run.save()
        self.assertEqual(self.client.get(url).json()["state"], "not_applicable")
        self.assertEqual(
            self.client.get(f"/api/v1/ops/evaluations/{uuid4()}/budget").status_code, 404
        )
        self.budget.delete()
        summary = self.summary()
        self.assertEqual(summary["state"], "unconfigured")
        self.assertIsNone(summary["remaining"])
        self.assertIsNone(summary["breakdown"])

    def test_inconsistent_stored_allocation_does_not_advertise_remaining_budget(self):
        self.start()
        EvaluationBudget.objects.filter(pk=1).update(allocated_output_tokens=1)
        summary = self.summary()
        self.assertEqual(summary["state"], "inconsistent")
        self.assertIsNone(summary["remaining"])
        self.assertEqual(summary["breakdown"]["allocated_output_tokens"], 12000)

    def test_pagination_totals_cover_all_reservations_and_no_write_api_exists(self):
        self.budget.call_limit, self.budget.output_token_limit = 162, 324000
        self.budget.save()
        for _ in range(27):
            run = EvaluationRun.objects.create(
                requested_by=self.user,
                dataset_id="page",
                execution_mode="live",
                live_config=self.run.live_config,
            )
            reserve(run)
        first = self.client.get("/api/v1/ops/budget/reservations").json()
        second = self.client.get("/api/v1/ops/budget/reservations?page=2").json()
        self.assertEqual(
            (first["count"], len(first["results"]), len(second["results"])), (27, 25, 2)
        )
        self.assertEqual(first["summary"]["allocated"]["calls"], 162)
        self.assertEqual(first["summary"], second["summary"])
        self.assertFalse(
            set(row["run_id"] for row in first["results"])
            & set(row["run_id"] for row in second["results"])
        )
        self.assertEqual(self.client.get("/api/v1/ops/budget/reservations?page=3").status_code, 404)
        self.assertEqual(self.client.post("/api/v1/ops/budget", {}, format="json").status_code, 405)

    @patch("apps.evaluations.authentication.read_core_admin")
    def test_real_core_session_can_read_other_operators_reservations(self, read):
        self.start()
        read.return_value = {"accountId": 999, "email": "other@example.com", "role": "ADMIN"}
        client = APIClient()
        client.cookies["govbiz_session"] = "valid-admin"
        response = client.get(f"/api/v1/ops/evaluations/{self.run.pk}/budget")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["reservation"]["run_id"], str(self.run.pk))


class BudgetAuditTests(TestCase):
    def change(self, **kwargs):
        return change_limits(
            **{
                "calls": 6,
                "output_tokens": 12000,
                "actor": "운영자 김",
                "reason": "승인된 평가 범위",
                "request_id": uuid4(),
                **kwargs,
            }
        )

    def test_first_change_and_existing_unaudited_limit_preserve_provenance(self):
        change = self.change()
        self.assertIsNone(change.previous_call_limit)
        self.assertEqual(change.source, "CLI")
        next_change = self.change(calls=12)
        self.assertEqual(next_change.previous_call_limit, 6)
        self.assertEqual(EvaluationBudgetChange.objects.count(), 2)

    def test_old_unaudited_budget_does_not_get_fabricated_history(self):
        EvaluationBudget.objects.create(call_limit=3, output_token_limit=6000)
        self.assertEqual(EvaluationBudgetChange.objects.count(), 0)
        change = self.change()
        self.assertEqual(change.previous_call_limit, 3)
        self.assertEqual(EvaluationBudgetChange.objects.count(), 1)

    def test_summary_reports_latest_ten_changes_and_full_count(self):
        changes = [self.change(calls=index) for index in range(12)]
        client = APIClient()
        client.force_authenticate(get_user_model().objects.create_user("audit-reader"))
        result = client.get("/api/v1/ops/budget").json()
        self.assertEqual(result["change_count"], 12)
        self.assertEqual(
            [row["request_id"] for row in result["recent_changes"]],
            [str(change.request_id) for change in reversed(changes[-10:])],
        )
        self.assertEqual(result["recent_changes"][0]["previous_limits"]["calls"], 10)

    def test_duplicate_old_request_never_rolls_back_a_later_limit(self):
        original = self.change()
        self.change(calls=12)
        retry = self.change(request_id=original.request_id)
        self.assertEqual(original.pk, retry.pk)
        self.assertEqual(EvaluationBudget.objects.get(pk=1).call_limit, 12)
        with self.assertRaises(ValueError):
            self.change(request_id=original.request_id, reason="다른 사유")
        self.assertEqual(EvaluationBudgetChange.objects.count(), 2)

    def test_audit_or_budget_write_failure_rolls_back_both_rows(self):
        for target in ("EvaluationBudgetChange.objects.create", "EvaluationBudget.save"):
            with (
                patch("apps.evaluations.budget_reporting." + target, side_effect=RuntimeError),
                self.assertRaises(RuntimeError),
            ):
                self.change()
            self.assertFalse(EvaluationBudget.objects.exists())
            self.assertFalse(EvaluationBudgetChange.objects.exists())
        self.change()
        with (
            patch(
                "apps.evaluations.budget_reporting.EvaluationBudget.save", side_effect=RuntimeError
            ),
            self.assertRaises(RuntimeError),
        ):
            self.change(calls=12)
        self.assertEqual(EvaluationBudget.objects.get(pk=1).call_limit, 6)
        self.assertEqual(EvaluationBudgetChange.objects.count(), 1)

    def test_invalid_limits_and_attribution_create_nothing(self):
        for kwargs in (
            {"calls": True},
            {"output_tokens": 2**53},
            {"actor": " "},
            {"reason": " "},
            {"reason": "x" * 1001},
            {"request_id": "invalid"},
        ):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.change(**kwargs)
        self.assertFalse(EvaluationBudget.objects.exists())

    def test_cli_requires_actor_reason_and_request_id(self):
        with self.assertRaises(CommandError):
            call_command("set_evaluation_budget", calls=6, output_tokens=12000, stdout=StringIO())
        call_command(
            "set_evaluation_budget",
            calls=6,
            output_tokens=12000,
            actor="관리자",
            reason="검토된 한도",
            request_id=str(uuid4()),
            stdout=StringIO(),
        )
        self.assertEqual(EvaluationBudgetChange.objects.get().actor, "관리자")


@override_settings(LLMOPS_LIVE_ENABLED=True, LLMOPS_BUDGET_TOKEN=TOKEN)
class BudgetReadConcurrencyTests(TransactionTestCase):
    def test_limit_reduction_racing_reservation_cannot_undercut_allocated_usage(self):
        EvaluationBudget.objects.create(call_limit=6, output_token_limit=12000)
        user = get_user_model().objects.create_user("limit-race")
        run = EvaluationRun.objects.create(
            requested_by=user,
            dataset_id="race",
            execution_mode="live",
            live_config={"max_model_calls": 6, "max_output_tokens": 2000},
        )
        barrier = threading.Barrier(2)

        def attempt(action):
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                if action == "reserve":
                    with transaction.atomic():
                        reserve(run)
                else:
                    change_limits(
                        calls=5,
                        output_tokens=12000,
                        actor="operator",
                        reason="축소",
                        request_id=uuid4(),
                    )
                return "accepted"
            except (BudgetUnavailable, ValueError):
                return "blocked"
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(attempt, ["reserve", "reduce"]))
        self.assertCountEqual(results, ["accepted", "blocked"])
        budget = EvaluationBudget.objects.get(pk=1)
        self.assertLessEqual(budget.allocated_calls, budget.call_limit)
        self.assertEqual(EvaluationBudgetChange.objects.count(), int(budget.call_limit == 5))

    def test_summary_cannot_mix_settlement_before_and_after_same_response(self):
        user = get_user_model().objects.create_user("snapshot-reader")
        EvaluationBudget.objects.create(call_limit=6, output_token_limit=12000)
        run = EvaluationRun.objects.create(
            requested_by=user,
            dataset_id="snapshot",
            execution_mode="live",
            live_config={"max_model_calls": 6, "max_output_tokens": 2000, "model": "test"},
            prefect_flow_run_id=uuid4(),
            execution_spec={"test": True},
            execution_spec_sha256="a" * 64,
        )
        worker = uuid4()
        with transaction.atomic():
            reserve(run)
        worker_action(run.pk, worker, run.prefect_flow_run_id, "a" * 64, "claim")
        worker_action(
            run.pk,
            worker,
            run.prefect_flow_run_id,
            "a" * 64,
            "authorize",
            sequence=0,
            model="test",
            max_output_tokens=2000,
        )
        entered, release, settling = threading.Event(), threading.Event(), threading.Event()
        from .budget_reporting import budget_summary

        def held_summary(budget):
            entered.set()
            if not release.wait(10):
                raise AssertionError("reader not released")
            return budget_summary(budget)

        def read():
            close_old_connections()
            try:
                client = APIClient()
                client.force_authenticate(user)
                return client.get("/api/v1/ops/budget/reservations").json()
            finally:
                close_old_connections()

        def settle():
            close_old_connections()
            settling.set()
            try:
                worker_action(
                    run.pk,
                    worker,
                    run.prefect_flow_run_id,
                    "a" * 64,
                    "settle",
                    sequence=0,
                    usage=USAGE,
                )
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            with patch(
                "apps.evaluations.budget_admin_views.budget_summary", side_effect=held_summary
            ):
                reader = pool.submit(read)
                try:
                    self.assertTrue(entered.wait(10))
                    writer = pool.submit(settle)
                    self.assertTrue(settling.wait(10))
                    with self.assertRaises(TimeoutError):
                        writer.result(timeout=0.2)
                finally:
                    release.set()
                data = reader.result(timeout=10)
                writer.result(timeout=10)
        self.assertEqual(data["summary"]["breakdown"]["settled_calls"], 0)
        self.assertEqual(data["summary"]["breakdown"], data["results"][0]["breakdown"])
        self.assertEqual(read()["summary"]["breakdown"]["settled_calls"], 1)

    def test_simultaneous_initial_changes_record_one_chain(self):
        barrier = threading.Barrier(2)

        def update(calls):
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                return change_limits(
                    calls=calls,
                    output_tokens=20000,
                    actor="operator",
                    reason="race",
                    request_id=uuid4(),
                ).pk
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(update, [5, 10]))
        changes = list(EvaluationBudgetChange.objects.order_by("id"))
        self.assertIsNone(changes[0].previous_call_limit)
        self.assertEqual(changes[1].previous_call_limit, changes[0].call_limit)
        self.assertEqual(EvaluationBudget.objects.get(pk=1).call_limit, changes[1].call_limit)
