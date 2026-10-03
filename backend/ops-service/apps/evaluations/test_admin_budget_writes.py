import threading
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db import IntegrityError, close_old_connections, connection, transaction
from django.db.migrations.executor import MigrationExecutor
from django.test import TestCase, TransactionTestCase, override_settings
from rest_framework.exceptions import PermissionDenied
from rest_framework.test import APIClient

from .budget_reporting import change_limits
from .models import EvaluationBudget, EvaluationBudgetChange, EvaluationLegacyUsage
from .test_legacy_usage import LegacyFixture

LIMITS_URL = "/api/v1/ops/budget/limits"


class AdminBudgetFixture(LegacyFixture):
    def limit_payload(self, **changes):
        return {
            "request_id": str(uuid4()),
            "expected_revision": self.client.get("/api/v1/ops/budget").json()["limits_revision"],
            "calls": 20,
            "output_tokens": 40000,
            "input_tokens": None,
            "reason": "승인된 누적 한도 검토",
            **changes,
        }

    def usage_payload(self, **changes):
        return {
            "request_id": str(uuid4()),
            "evidence_sha256": self.preview()["evidence_sha256"],
            "reason": "저장 응답 전체 사용량 확인",
            **changes,
        }

    @property
    def apply_url(self):
        return self.url + "/legacy-usage"


@override_settings(LLMOPS_ARTIFACT_URL="")
class AdminBudgetWriteTests(AdminBudgetFixture, TestCase):
    def test_authenticated_writes_record_identity_without_enabling_live_or_faking_reservations(
        self,
    ):
        body = self.limit_payload()
        response = self.client.post(LIMITS_URL, body, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertIn("no-store", response["Cache-Control"])
        change = EvaluationBudgetChange.objects.get()
        self.assertEqual(change.source, "CORE_ADMIN")
        self.assertEqual(change.authenticated_actor, self.user)
        self.assertEqual(change.actor, self.user.username)
        self.assertEqual(change.expected_revision, body["expected_revision"])
        applied = self.client.post(self.apply_url, self.usage_payload(), format="json")
        self.assertEqual(applied.status_code, 200)
        record = EvaluationLegacyUsage.objects.get()
        self.assertEqual(record.actor_source, "CORE_ADMIN")
        self.assertEqual(record.authenticated_actor, self.user)
        self.assertFalse(applied.json()["record"]["provider_receipt_verified"])
        self.assertEqual(self.amounts(), (1, 100, 50))
        session = self.client.get("/api/v1/ops/session").json()
        self.assertFalse(session["live_enabled"])
        self.assertFalse(session["rag_live_enabled"])
        self.assertEqual(self.client.get(self.url + "/budget").json()["state"], "legacy_recorded")
        self.assertEqual(self.client.get("/api/v1/ops/budget/unaccounted-runs").json()["count"], 0)

    def test_stale_edit_detects_cli_changes_even_if_values_return_to_original(self):
        payload = self.limit_payload(calls=30)
        for calls in (25, 20):
            change_limits(
                calls=calls,
                output_tokens=40000,
                actor="CLI operator",
                reason="테스트 한도 변경",
                request_id=uuid4(),
            )
        response = self.client.post(LIMITS_URL, payload, format="json")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(EvaluationBudgetChange.objects.count(), 2)
        self.budget.refresh_from_db()
        self.assertEqual(self.budget.call_limit, 20)

    def test_same_request_retry_after_later_change_returns_original_without_overwriting(self):
        payload = self.limit_payload(calls=30)
        first = self.client.post(LIMITS_URL, payload, format="json").json()
        change_limits(
            calls=40,
            output_tokens=50000,
            actor="CLI operator",
            reason="후속 변경",
            request_id=uuid4(),
        )
        retry = self.client.post(LIMITS_URL, payload, format="json")
        self.assertEqual(retry.status_code, 200)
        self.assertEqual(retry.json(), first)
        self.budget.refresh_from_db()
        self.assertEqual(self.budget.call_limit, 40)
        self.assertEqual(EvaluationBudgetChange.objects.count(), 2)
        for field, value in (
            ("calls", 31),
            ("reason", "다른 사유"),
            ("expected_revision", "0" * 64),
        ):
            self.assertEqual(
                self.client.post(LIMITS_URL, {**payload, field: value}, format="json").status_code,
                409,
            )

    def test_another_admin_cannot_reuse_original_operators_request(self):
        limit = self.limit_payload()
        usage = self.usage_payload()
        self.assertEqual(self.client.post(LIMITS_URL, limit, format="json").status_code, 200)
        self.assertEqual(self.client.post(self.apply_url, usage, format="json").status_code, 200)
        other = get_user_model().objects.create_user("other-admin")
        self.client.force_authenticate(other)
        self.assertEqual(self.client.post(LIMITS_URL, limit, format="json").status_code, 409)
        self.assertEqual(self.client.post(self.apply_url, usage, format="json").status_code, 409)
        self.assertEqual(self.amounts(), (1, 100, 50))

    def test_usage_retry_does_not_read_or_charge_again_and_changed_evidence_is_rejected(self):
        payload = self.usage_payload()
        self.assertEqual(self.client.post(self.apply_url, payload, format="json").status_code, 200)
        with patch("apps.evaluations.legacy_usage.read_artifact", side_effect=AssertionError):
            retry = self.client.post(self.apply_url, payload, format="json")
        self.assertTrue(retry.json()["replayed"])
        for changes in ({"request_id": str(uuid4())}, {"evidence_sha256": "0" * 64}):
            self.assertEqual(
                self.client.post(self.apply_url, {**payload, **changes}, format="json").status_code,
                409,
            )
        self.assertEqual(EvaluationLegacyUsage.objects.count(), 1)
        self.assertEqual(self.amounts(), (1, 100, 50))

    def test_usage_unconfigured_insufficient_or_changed_capture_never_writes(self):
        payload = self.usage_payload()
        path = self.root / str(self.run.pk) / "capture/capture.json"
        original = path.read_bytes()
        path.write_bytes(original + b" ")
        self.assertEqual(self.client.post(self.apply_url, payload, format="json").status_code, 409)
        path.write_bytes(original)
        EvaluationBudget.objects.filter(pk=1).update(call_limit=0)
        self.assertEqual(self.client.post(self.apply_url, payload, format="json").status_code, 409)
        self.budget.delete()
        self.assertEqual(self.client.post(self.apply_url, payload, format="json").status_code, 409)
        self.assertFalse(EvaluationBudget.objects.exists())
        self.assertFalse(EvaluationLegacyUsage.objects.exists())

    def test_input_enable_requires_complete_history_and_cannot_erase_existing_usage(self):
        payload = self.limit_payload(input_tokens=1000)
        self.assertEqual(self.client.post(LIMITS_URL, payload, format="json").status_code, 409)
        self.client.post(self.apply_url, self.usage_payload(), format="json")
        self.assertEqual(self.client.post(LIMITS_URL, payload, format="json").status_code, 200)
        for change in (
            {"input_tokens": None},
            {"input_tokens": 99},
            {"calls": 0},
            {"output_tokens": 49},
        ):
            payload = (
                self.limit_payload(input_tokens=1000, **change)
                if "input_tokens" not in change
                else self.limit_payload(**change)
            )
            self.assertEqual(self.client.post(LIMITS_URL, payload, format="json").status_code, 409)
        self.assertEqual(self.amounts(), (1, 100, 50))

    def test_inconsistent_ledger_is_rejected_by_server_even_with_current_revision(self):
        EvaluationBudget.objects.filter(pk=1).update(allocated_calls=1)
        response = self.client.post(LIMITS_URL, self.limit_payload(calls=50), format="json")
        self.assertEqual(response.status_code, 409)
        self.assertFalse(EvaluationBudgetChange.objects.exists())

    def test_rejects_forged_actor_boolean_numeric_string_and_unknown_fields(self):
        base = self.limit_payload()
        for changes in (
            {"actor": "spoof"},
            {"source": "CLI"},
            {"authenticated_actor": 99},
            {"calls": True},
            {"calls": "20"},
            {"calls": -1},
            {"calls": 1.5},
            {"calls": 2**53},
            {"reason": " "},
            {"reason": 123},
            {"expected_revision": "bad"},
        ):
            with self.subTest(changes=changes):
                self.assertEqual(
                    self.client.post(LIMITS_URL, {**base, **changes}, format="json").status_code,
                    400,
                )
        for changes in (
            {"actor": "spoof"},
            {"apply": True},
            {"reason": " "},
            {"evidence_sha256": "bad"},
            {"actor_source": "CLI"},
        ):
            self.assertEqual(
                self.client.post(
                    self.apply_url, self.usage_payload(**changes), format="json"
                ).status_code,
                400,
            )
        self.assertFalse(EvaluationBudgetChange.objects.exists())
        self.assertFalse(EvaluationLegacyUsage.objects.exists())

    def test_admin_session_csrf_and_origin_required_for_both_writes(self):
        client = APIClient(enforce_csrf_checks=True)
        for url, payload in (
            (LIMITS_URL, self.limit_payload()),
            (self.apply_url, self.usage_payload()),
        ):
            self.assertEqual(client.post(url, payload, format="json").status_code, 401)
        client.cookies["govbiz_session"] = "test-admin-session"
        with patch("apps.evaluations.authentication.read_core_admin", side_effect=PermissionDenied):
            self.assertEqual(
                client.post(LIMITS_URL, self.limit_payload(), format="json").status_code, 403
            )
        with patch(
            "apps.evaluations.authentication.read_core_admin",
            return_value={
                "accountId": 81,
                "email": "admin@example.test",
                "role": "ADMIN",
            },
        ):
            for url, payload in (
                (LIMITS_URL, self.limit_payload()),
                (self.apply_url, self.usage_payload()),
            ):
                self.assertEqual(client.post(url, payload, format="json").status_code, 403)
                token = client.get("/api/v1/ops/session").json()["csrf_token"]
                self.assertEqual(
                    client.post(
                        url,
                        payload,
                        format="json",
                        HTTP_X_CSRFTOKEN=token,
                        HTTP_ORIGIN="https://untrusted.example",
                    ).status_code,
                    403,
                )
                self.assertEqual(
                    client.post(url, payload, format="json", HTTP_X_CSRFTOKEN=token).status_code,
                    200,
                )
        self.assertEqual(EvaluationBudgetChange.objects.get().actor, "core:81")
        self.assertEqual(EvaluationLegacyUsage.objects.get().actor, "core:81")

    def test_initial_stale_revision_rolls_back_budget_creation(self):
        self.budget.delete()
        response = self.client.post(
            LIMITS_URL, self.limit_payload(expected_revision="0" * 64), format="json"
        )
        self.assertEqual(response.status_code, 409)
        self.assertFalse(EvaluationBudget.objects.exists())

    def test_database_rejects_authenticated_source_without_identity(self):
        with self.assertRaises(IntegrityError), transaction.atomic():
            EvaluationBudgetChange.objects.create(
                budget=self.budget,
                request_id=uuid4(),
                actor="spoof",
                source="CORE_ADMIN",
                reason="test",
                expected_revision="a" * 64,
                call_limit=20,
                output_token_limit=40000,
            )
        self.apply()
        with self.assertRaises(IntegrityError), transaction.atomic():
            EvaluationLegacyUsage.objects.update(actor_source="CORE_ADMIN")


@override_settings(LLMOPS_ARTIFACT_URL="")
class AdminBudgetConcurrencyTests(AdminBudgetFixture, TransactionTestCase):
    def test_two_initial_editors_cannot_silently_overwrite_each_other(self):
        self.budget.delete()
        body = self.limit_payload()
        barrier = threading.Barrier(2)

        def submit(calls):
            close_old_connections()
            try:
                client = APIClient()
                client.force_authenticate(self.user)
                barrier.wait(timeout=10)
                return client.post(
                    LIMITS_URL, {**body, "calls": calls, "request_id": str(uuid4())}, format="json"
                ).status_code
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(submit, [10, 20]))
        self.assertEqual(sorted(results), [200, 409])
        self.assertEqual(EvaluationBudget.objects.count(), 1)
        self.assertEqual(EvaluationBudgetChange.objects.count(), 1)


class AdminBudgetMigrationTests(TransactionTestCase):
    def test_forward_migration_keeps_cli_provenance_and_does_not_assign_human_identity(self):
        executor = MigrationExecutor(connection)
        latest = executor.loader.graph.leaf_nodes()
        old = [("evaluations", "0024_legacy_usage")]
        executor.migrate(old)
        try:
            apps = executor.loader.project_state(old).apps
            budget = apps.get_model("evaluations", "EvaluationBudget").objects.create(
                call_limit=7, output_token_limit=776
            )
            request_id = uuid4()
            apps.get_model("evaluations", "EvaluationBudgetChange").objects.create(
                budget=budget,
                request_id=request_id,
                actor="과거 CLI",
                reason="이전 설정",
                call_limit=7,
                output_token_limit=776,
            )
            user = apps.get_model("auth", "User").objects.create(username="historical-test")
            run = apps.get_model("evaluations", "EvaluationRun").objects.create(
                requested_by=user, dataset_id="test", execution_mode="live"
            )
            apps.get_model("evaluations", "EvaluationLegacyUsage").objects.create(
                run=run,
                budget=budget,
                request_id=uuid4(),
                actor="과거 CLI",
                reason="이전 검토",
                capture_sha256="a" * 64,
                evidence_sha256="b" * 64,
                evidence={},
                calls=1,
                input_tokens=100,
                output_tokens=50,
                before={},
                after={},
            )
            MigrationExecutor(connection).migrate(latest)
            row = EvaluationBudgetChange.objects.get(request_id=request_id)
            self.assertEqual(row.source, "CLI")
            self.assertIsNone(row.authenticated_actor_id)
            self.assertIsNone(row.expected_revision)
            legacy = EvaluationLegacyUsage.objects.get()
            self.assertEqual(legacy.actor_source, "CLI")
            self.assertIsNone(legacy.authenticated_actor_id)
            self.assertEqual(legacy.input_tokens, 100)
        finally:
            MigrationExecutor(connection).migrate(latest)
