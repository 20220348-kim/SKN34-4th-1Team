from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase, override_settings
from rest_framework.exceptions import PermissionDenied
from rest_framework.test import APIClient

from .catalog import public_datasets
from .daily_budget import change_daily_limits
from .models import (
    EvaluationAdmission,
    EvaluationBudget,
    EvaluationBudgetReservation,
    EvaluationRun,
)

URL = "/api/v1/ops/evaluations/live-readiness"
FIXED = "target-coverage-20260907-v1"
RAG = "rag-synthetic-multichunk-v1"
TOKEN = "test-only-readiness-budget-token-not-for-production"


class LiveReadinessPermissionTests(SimpleTestCase):
    def test_requires_core_admin_session_not_worker_token(self):
        client = APIClient()
        for auth in ("", "Bearer " + TOKEN):
            self.assertEqual(client.get(URL, HTTP_AUTHORIZATION=auth).status_code, 401)
        client.cookies["govbiz_session"] = "ordinary-user"
        with patch("apps.evaluations.authentication.read_core_admin", side_effect=PermissionDenied):
            self.assertEqual(client.get(URL).status_code, 403)


@override_settings(
    LLMOPS_LIVE_ENABLED=True, LLMOPS_RAG_LIVE_ENABLED=True, LLMOPS_BUDGET_TOKEN=TOKEN
)
class LiveReadinessTests(TestCase):
    def setUp(self):
        cache = patch("apps.evaluations.vector_cache.discover", return_value=None)
        cache.start()
        self.addCleanup(cache.stop)
        self.user = get_user_model().objects.create_user("readiness-operator")
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.datasets = {row["id"]: row for row in public_datasets()}
        self.budget = EvaluationBudget.objects.create(
            call_limit=100, input_token_limit=1000000, output_token_limit=200000
        )

    def query(self, dataset_id=FIXED, **changes):
        return {
            "dataset_id": dataset_id,
            "execution_profile": self.datasets[dataset_id]["execution_profiles"]["live"],
            **changes,
        }

    def read(self, dataset_id=FIXED):
        response = self.client.get(URL, self.query(dataset_id))
        self.assertEqual(response.status_code, 200, response.data)
        self.assertIn("no-store", response["Cache-Control"])
        return response.json()

    def test_fixed_totals_read_only_and_absent_admission_is_not_created(self):
        before = list(EvaluationBudget.objects.values())
        with patch("apps.evaluations.prefect_client.create_run") as dispatch:
            for _ in range(2):
                data = self.read()
                self.assertEqual(data["state"], "checked")
                self.assertEqual(
                    data["required"], {"calls": 6, "input_tokens": 196608, "output_tokens": 12000}
                )
                self.assertEqual(
                    data["remaining"],
                    {"calls": 100, "input_tokens": 1000000, "output_tokens": 200000},
                )
                self.assertEqual(data["blockers"], [])
                self.assertEqual(data["warnings"], [])
            dispatch.assert_not_called()
        self.assertEqual(list(EvaluationBudget.objects.values()), before)
        self.assertFalse(EvaluationAdmission.objects.exists())
        self.assertFalse(EvaluationRun.objects.exists())
        self.assertFalse(EvaluationBudgetReservation.objects.exists())
        self.assertNotIn(TOKEN, str(data))

    def test_rag_preview_matches_real_reservation_without_counting_embedding_as_output(self):
        change_daily_limits(
            calls=100,
            input_tokens=1000000,
            output_tokens=200000,
            actor="operator",
            reason="RAG 일별 예약 검증",
            request_id=uuid4(),
        )
        data = self.read(RAG)
        self.assertEqual(data["state"], "checked")
        # R01/R02 share document vectors: 2 document + 3 query + 3 answer calls.
        self.assertEqual(data["required"]["calls"], 8)
        self.assertEqual(data["required"]["output_tokens"], 6000)
        dataset = self.datasets[RAG]
        self.assertEqual(dataset["live_config"]["document_vectors"]["R02"]["source_case_id"], "R01")
        self.assertEqual(
            data["required"]["input_tokens"], dataset["live_config"]["max_total_input_tokens"]
        )
        # The real admission path must reserve exactly the advertised values.
        with patch("apps.evaluations.prefect_client.create_run", return_value=uuid4()):
            response = self.client.post(
                "/api/v1/ops/evaluations",
                {
                    "request_id": str(uuid4()),
                    "dataset_id": RAG,
                    "candidate_capture_id": "new-model-response",
                    "reference_capture_id": dataset["captures"][0]["id"],
                    "execution_mode": "live",
                    "confirm_paid_run": True,
                    "live_config": dataset["live_config"],
                    "execution_profile": dataset["execution_profiles"]["live"],
                },
                format="json",
            )
        self.assertEqual(response.status_code, 202, response.data)
        reservation = EvaluationBudgetReservation.objects.get()
        self.assertEqual(
            data["required"],
            {
                "calls": reservation.max_calls,
                "input_tokens": reservation.reserved_input_tokens,
                "output_tokens": reservation.reserved_output_tokens,
            },
        )
        fresh = self.read(RAG)
        for key in data["remaining"]:
            self.assertEqual(
                fresh["remaining"][key], data["remaining"][key] - data["required"][key]
            )
            self.assertEqual(fresh["daily"]["remaining"][key], fresh["remaining"][key])

    def test_daily_shortage_blocks_readiness_even_with_large_cumulative_budget(self):
        change_daily_limits(
            calls=5,
            input_tokens=196607,
            output_tokens=11999,
            actor="operator",
            reason="일별 한도",
            request_id=uuid4(),
        )
        data = self.read()
        self.assertEqual(data["state"], "blocked")
        self.assertEqual(
            {issue["code"] for issue in data["blockers"]},
            {
                "DAILY_INSUFFICIENT_CALLS",
                "DAILY_INSUFFICIENT_INPUT_TOKENS",
                "DAILY_INSUFFICIENT_OUTPUT_TOKENS",
            },
        )
        EvaluationRun.objects.create(
            requested_by=self.user, execution_mode="live", dataset_id=FIXED
        )
        data = self.read()
        self.assertEqual(data["daily"]["state"], "unknown")
        self.assertIn("DAILY_BUDGET_UNAVAILABLE", {issue["code"] for issue in data["blockers"]})

    def test_reports_disabled_paused_and_worker_auth_without_exposing_secrets(self):
        EvaluationAdmission.objects.create(accepting=False)
        with override_settings(
            LLMOPS_LIVE_ENABLED=False, LLMOPS_BUDGET_TOKEN="private-short-token"
        ):
            data = self.read()
        self.assertEqual(data["state"], "blocked")
        self.assertEqual(
            {row["code"] for row in data["blockers"]},
            {"LIVE_DISABLED", "ADMISSION_PAUSED", "BUDGET_AUTH_UNCONFIGURED"},
        )
        self.assertNotIn("private-short-token", str(data))
        with override_settings(LLMOPS_RAG_LIVE_ENABLED=False):
            self.assertIn("LIVE_DISABLED", {row["code"] for row in self.read(RAG)["blockers"]})

    def test_unconfigured_and_inconsistent_budget_never_report_zero_remaining(self):
        self.budget.allocated_calls = 1
        self.budget.save()
        data = self.read()
        self.assertIsNone(data["remaining"])
        self.assertEqual(data["blockers"][0]["code"], "BUDGET_INCONSISTENT")
        self.budget.delete()
        data = self.read()
        self.assertEqual(data["state"], "blocked")
        self.assertIsNone(data["remaining"])
        self.assertEqual(data["blockers"][0]["code"], "BUDGET_UNCONFIGURED")
        self.assertFalse(EvaluationBudget.objects.exists())

    def test_input_limit_optional_warning_for_fixed_but_required_for_rag(self):
        self.budget.input_token_limit = None
        self.budget.save()
        fixed, rag = self.read(), self.read(RAG)
        self.assertEqual(fixed["state"], "checked")
        self.assertIsNone(fixed["remaining"]["input_tokens"])
        self.assertEqual(fixed["warnings"][0]["code"], "INPUT_BUDGET_UNCONFIGURED")
        self.assertEqual(rag["state"], "blocked")
        self.assertEqual(rag["blockers"][0]["code"], "INPUT_BUDGET_UNCONFIGURED")
        EvaluationRun.objects.create(
            requested_by=self.user, execution_mode="live", dataset_id=FIXED
        )
        self.assertEqual(self.read()["warnings"][0]["code"], "INPUT_BUDGET_UNKNOWN")
        self.assertIsNone(self.read()["remaining"]["input_tokens"])

    def test_exact_limit_fits_and_each_shortage_is_reported(self):
        required = self.read()["required"]
        self.budget.call_limit = required["calls"]
        self.budget.input_token_limit = required["input_tokens"]
        self.budget.output_token_limit = required["output_tokens"]
        self.budget.save()
        self.assertEqual(self.read()["state"], "checked")
        self.budget.call_limit -= 1
        self.budget.input_token_limit -= 1
        self.budget.output_token_limit -= 1
        self.budget.save()
        data = self.read()
        self.assertEqual(data["state"], "blocked")
        self.assertEqual(
            {row["code"] for row in data["blockers"]},
            {"INSUFFICIENT_CALLS", "INSUFFICIENT_INPUT_TOKENS", "INSUFFICIENT_OUTPUT_TOKENS"},
        )

    def test_profile_change_or_missing_plan_is_not_presented_as_ready(self):
        with patch.dict("os.environ", {"LLMOPS_LIVE_MODEL": "changed-model"}):
            response = self.client.get(URL, self.query())
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "LIVE_PROFILE_CHANGED")
        with patch(
            "apps.evaluations.runtime_views.read_release", side_effect=ValueError("private-path")
        ):
            response = self.client.get(URL, self.query())
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("private-path", response.content.decode())
        with patch("apps.evaluations.runtime_views.live_config", return_value=None):
            self.assertEqual(self.client.get(URL, self.query()).status_code, 400)
        self.assertFalse(EvaluationRun.objects.exists())

    def test_rejects_invalid_query_and_write_methods(self):
        for query in (
            {},
            {"dataset_id": "absent", "execution_profile": "a" * 64},
            self.query(execution_profile="wrong"),
        ):
            self.assertEqual(self.client.get(URL, query).status_code, 400)
        for method in (self.client.post, self.client.put, self.client.patch, self.client.delete):
            self.assertEqual(method(URL, self.query()).status_code, 405)
