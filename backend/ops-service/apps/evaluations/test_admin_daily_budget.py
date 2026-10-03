"""일별 정책 웹 변경의 인증·동시성·재전송 및 기존 CLI 이력 보존."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db import IntegrityError, close_old_connections, connection, transaction
from django.db.migrations.executor import MigrationExecutor
from django.test import TestCase, TransactionTestCase, override_settings
from rest_framework.exceptions import PermissionDenied
from rest_framework.test import APIClient

from .budget import reserve
from .daily_budget import change_daily_limits
from .models import EvaluationBudget, EvaluationDailyBudget, EvaluationDailyBudgetChange
from .test_budget import TOKEN
from .test_input_budget import new_run

URL = "/api/v1/ops/budget/daily-limits"


class AdminDailyFixture:
    def setUp(self):
        self.user = get_user_model().objects.create_user("core:81")
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.budget = EvaluationBudget.objects.create(
            call_limit=100, input_token_limit=10000000, output_token_limit=1000000
        )

    def daily(self):
        return self.client.get("/api/v1/ops/budget").json()["daily"]

    def payload(self, **changes):
        return {
            "request_id": str(uuid4()),
            "expected_revision": self.daily()["limits_revision"],
            "disable": False,
            "calls": 12,
            "input_tokens": 400000,
            "output_tokens": 24000,
            "reason": "일별 호출 및 토큰 한도 검토",
            **changes,
        }

    def cli(self, calls=12):
        return change_daily_limits(
            calls=calls,
            input_tokens=400000,
            output_tokens=24000,
            actor="CLI operator",
            reason="운영 명령 검증",
            request_id=uuid4(),
        )


@override_settings(LLMOPS_LIVE_ENABLED=False, LLMOPS_RAG_LIVE_ENABLED=False)
class AdminDailyBudgetTests(AdminDailyFixture, TestCase):
    def test_enable_update_disable_records_admin_and_keeps_cumulative_budget(self):
        self.assertFalse(EvaluationDailyBudget.objects.exists())
        body = self.payload()
        response = self.client.post(URL, body, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertIn("no-store", response["Cache-Control"])
        change = EvaluationDailyBudgetChange.objects.get()
        self.assertEqual(change.authenticated_actor, self.user)
        self.assertEqual(change.source, "CORE_ADMIN")
        self.assertEqual(change.actor, "core:81")
        self.assertEqual(change.expected_revision, body["expected_revision"])
        self.assertIsNone(change.previous)
        self.assertEqual(self.daily()["recent_changes"][0], response.json()["change"])
        self.assertEqual(self.daily()["state"], "enforced")
        self.assertEqual(
            self.client.post(URL, self.payload(calls=20), format="json").status_code, 200
        )
        disabled = self.payload(disable=True, calls=None, input_tokens=None, output_tokens=None)
        self.assertEqual(self.client.post(URL, disabled, format="json").status_code, 200)
        self.assertEqual(self.daily()["state"], "disabled")
        self.assertEqual(self.daily()["limits"]["calls"], 20)
        self.assertEqual(EvaluationDailyBudgetChange.objects.count(), 3)
        self.budget.refresh_from_db()
        self.assertEqual(self.budget.call_limit, 100)
        self.assertEqual(self.budget.allocated_calls, 0)
        session = self.client.get("/api/v1/ops/session").json()
        self.assertFalse(session["live_enabled"])
        self.assertFalse(session["rag_live_enabled"])

    def test_revision_detects_cli_aba_and_stale_disable(self):
        self.cli()
        body = self.payload(disable=True, calls=None, input_tokens=None, output_tokens=None)
        self.cli(15)
        self.cli(12)
        self.assertEqual(self.client.post(URL, body, format="json").status_code, 409)
        self.assertTrue(EvaluationDailyBudget.objects.get().enabled)
        self.assertEqual(EvaluationDailyBudgetChange.objects.count(), 3)

    def test_retry_after_later_policy_returns_original_without_reverting(self):
        body = self.payload()
        first = self.client.post(URL, body, format="json")
        self.cli(30)
        self.assertEqual(self.client.post(URL, body, format="json").json(), first.json())
        self.assertEqual(EvaluationDailyBudget.objects.get().call_limit, 30)
        for field, value in (
            ("calls", 13),
            ("reason", "다른 사유"),
            ("expected_revision", "0" * 64),
        ):
            self.assertEqual(
                self.client.post(URL, {**body, field: value}, format="json").status_code, 409
            )
        self.client.force_authenticate(get_user_model().objects.create_user("core:82"))
        self.assertEqual(self.client.post(URL, body, format="json").status_code, 409)
        self.assertEqual(EvaluationDailyBudgetChange.objects.count(), 2)

    def test_disable_retry_does_not_disable_a_later_reactivation(self):
        self.cli()
        body = self.payload(disable=True, calls=None, input_tokens=None, output_tokens=None)
        first = self.client.post(URL, body, format="json").json()
        self.cli(30)
        self.assertEqual(self.client.post(URL, body, format="json").json(), first)
        self.assertTrue(EvaluationDailyBudget.objects.get().enabled)

    def test_cli_cannot_impersonate_admin_replay(self):
        body = self.payload()
        self.client.post(URL, body, format="json")
        args = {key: value for key, value in body.items() if key != "expected_revision"}
        with self.assertRaises(ValueError):
            change_daily_limits(**args, actor=self.user.username)
        with self.assertRaises(ValueError):
            change_daily_limits(**body, actor=self.user.username)

    @override_settings(LLMOPS_LIVE_ENABLED=True, LLMOPS_BUDGET_TOKEN=TOKEN)
    def test_new_reservations_are_rechecked_even_when_policy_revision_is_unchanged(self):
        body = self.payload(calls=5)
        run = new_run(self.user)
        reserve(run)  # Six calls reserved after this administrator opened the form.
        self.assertEqual(self.client.post(URL, body, format="json").status_code, 409)
        self.assertFalse(EvaluationDailyBudget.objects.exists())
        self.assertFalse(EvaluationDailyBudgetChange.objects.exists())

    def test_missing_budget_or_policy_and_inconsistent_ledger_do_not_create_records(self):
        body = self.payload()
        self.assertEqual(
            self.client.post(
                URL,
                self.payload(disable=True, calls=None, input_tokens=None, output_tokens=None),
                format="json",
            ).status_code,
            409,
        )
        EvaluationBudget.objects.filter(pk=1).update(allocated_calls=1)
        self.assertEqual(self.client.post(URL, body, format="json").status_code, 409)
        self.budget.delete()
        self.assertEqual(self.client.post(URL, body, format="json").status_code, 409)
        self.assertFalse(EvaluationBudget.objects.exists())
        self.assertFalse(EvaluationDailyBudget.objects.exists())

    def test_strict_payload_rejects_spoofed_identity_and_ambiguous_limits(self):
        body = self.payload()
        for changes in (
            {"actor": "spoof"},
            {"source": "CLI"},
            {"authenticated_actor": 81},
            {"expected_revision": "bad"},
            {"calls": True},
            {"calls": "12"},
            {"calls": 1.5},
            {"calls": -1},
            {"calls": 2**53},
            {"calls": None},
            {"input_tokens": None},
            {"disable": "false"},
            {"disable": 0},
            {"disable": True},
            {"reason": " "},
            {"reason": 1},
        ):
            with self.subTest(changes=changes):
                self.assertEqual(
                    self.client.post(URL, {**body, **changes}, format="json").status_code, 400
                )
        self.assertEqual(self.client.get(URL).status_code, 405)
        self.assertEqual(self.client.delete(URL).status_code, 405)
        self.assertFalse(EvaluationDailyBudgetChange.objects.exists())

    def test_admin_session_csrf_origin_and_attribution(self):
        client = APIClient(enforce_csrf_checks=True)
        body = self.payload()
        self.assertEqual(client.post(URL, body, format="json").status_code, 401)
        client.cookies["govbiz_session"] = "test-admin-session"
        with patch("apps.evaluations.authentication.read_core_admin", side_effect=PermissionDenied):
            self.assertEqual(client.post(URL, body, format="json").status_code, 403)
        with patch(
            "apps.evaluations.authentication.read_core_admin",
            return_value={
                "accountId": 81,
                "email": "admin@example.test",
                "role": "ADMIN",
            },
        ):
            self.assertEqual(client.post(URL, body, format="json").status_code, 403)
            token = client.get("/api/v1/ops/session").json()["csrf_token"]
            self.assertEqual(
                client.post(
                    URL,
                    body,
                    format="json",
                    HTTP_X_CSRFTOKEN=token,
                    HTTP_ORIGIN="https://untrusted.example",
                ).status_code,
                403,
            )
            self.assertEqual(
                client.post(URL, body, format="json", HTTP_X_CSRFTOKEN=token).status_code, 200
            )
        self.assertEqual(EvaluationDailyBudgetChange.objects.get().actor, "core:81")

    def test_database_requires_authenticated_source_and_identity_together(self):
        change = self.cli()
        with self.assertRaises(IntegrityError), transaction.atomic():
            EvaluationDailyBudgetChange.objects.filter(pk=change.pk).update(
                source="CORE_ADMIN", expected_revision="a" * 64
            )


class AdminDailyConcurrencyTests(AdminDailyFixture, TransactionTestCase):
    def test_two_initial_editors_cannot_overwrite_one_another(self):
        body = self.payload()
        barrier = Barrier(2)

        def submit(calls):
            close_old_connections()
            try:
                client = APIClient()
                client.force_authenticate(self.user)
                barrier.wait(timeout=10)
                return client.post(
                    URL, {**body, "calls": calls, "request_id": str(uuid4())}, format="json"
                ).status_code
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(submit, [12, 20])), [200, 409])
        self.assertEqual(EvaluationDailyBudgetChange.objects.count(), 1)


class AdminDailyMigrationTests(TransactionTestCase):
    def test_existing_cli_policy_and_history_keep_their_provenance(self):
        executor = MigrationExecutor(connection)
        latest = executor.loader.graph.leaf_nodes()
        old = [("evaluations", "0026_daily_evaluation_budget")]
        executor.migrate(old)
        try:
            apps = executor.loader.project_state(old).apps
            budget = apps.get_model("evaluations", "EvaluationBudget").objects.create(
                call_limit=10, input_token_limit=1000, output_token_limit=100
            )
            policy = apps.get_model("evaluations", "EvaluationDailyBudget").objects.create(
                budget=budget,
                enabled=True,
                call_limit=3,
                input_token_limit=300,
                output_token_limit=30,
            )
            snapshot = {
                "enabled": True,
                "limits": {"calls": 3, "input_tokens": 300, "output_tokens": 30},
            }
            request_id = uuid4()
            apps.get_model("evaluations", "EvaluationDailyBudgetChange").objects.create(
                policy=policy,
                request_id=request_id,
                actor="한글 CLI 담당자",
                reason="기존 운영 이력",
                previous=None,
                policy_snapshot=snapshot,
            )
        finally:
            executor = MigrationExecutor(connection)
            executor.migrate(latest)
        change = EvaluationDailyBudgetChange.objects.get(request_id=request_id)
        self.assertEqual(change.source, "CLI")
        self.assertIsNone(change.authenticated_actor_id)
        self.assertIsNone(change.expected_revision)
        self.assertEqual(change.actor, "한글 CLI 담당자")
        self.assertEqual(change.policy_snapshot, snapshot)
        self.assertTrue(EvaluationDailyBudget.objects.get().enabled)
