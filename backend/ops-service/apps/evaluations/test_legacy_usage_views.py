import json
from unittest.mock import patch
from uuid import uuid4

from django.test import SimpleTestCase, TestCase, override_settings
from rest_framework.exceptions import PermissionDenied
from rest_framework.test import APIClient

from .models import EvaluationBudgetReservation, EvaluationLegacyUsage, EvaluationRun
from .test_budget import TOKEN
from .test_legacy_usage import LegacyFixture


class LegacyUsageReadPermissionsTests(SimpleTestCase):
    def test_admin_session_required_for_both_endpoints(self):
        client = APIClient()
        for url in (
            "/api/v1/ops/budget/unaccounted-runs",
            f"/api/v1/ops/evaluations/{uuid4()}/legacy-usage-preview",
        ):
            for token in ("", "Bearer " + TOKEN):
                with self.subTest(url=url, token=bool(token)):
                    self.assertEqual(client.get(url, HTTP_AUTHORIZATION=token).status_code, 401)
            client.cookies["govbiz_session"] = "ordinary-account"
            with patch(
                "apps.evaluations.authentication.read_core_admin", side_effect=PermissionDenied
            ):
                self.assertEqual(client.get(url).status_code, 403)
            client.cookies.clear()


@override_settings(LLMOPS_ARTIFACT_URL="", LLMOPS_BUDGET_TOKEN=TOKEN, LLMOPS_LIVE_ENABLED=True)
class LegacyUsageReadTests(LegacyFixture, TestCase):
    def setUp(self):
        super().setUp()
        self.preview_url = f"/api/v1/ops/evaluations/{self.run.pk}/legacy-usage-preview"
        self.list_url = "/api/v1/ops/budget/unaccounted-runs"

    def test_preview_matches_cli_and_does_not_write_or_expose_raw_evidence(self):
        before = list(EvaluationRun.objects.values())
        cli = self.preview()
        with patch("apps.evaluations.prefect_client.read_run") as prefect:
            for _ in range(2):
                response = self.client.get(self.preview_url)
                self.assertEqual(response.status_code, 200)
                self.assertIn("no-store", response["Cache-Control"])
                data = response.json()
                self.assertEqual(data["state"], "verified")
                self.assertTrue(data["can_apply"])
                self.assertFalse(data["applied"])
                self.assertFalse(data["provider_receipt_verified"])
                for key in ("usage", "before", "after", "blockers", "evidence_sha256"):
                    self.assertEqual(data[key], cli[key])
                self.assertEqual(data["capture_sha256"], cli["evidence"]["capture_sha256"])
                self.assertEqual(
                    set(data),
                    {
                        "as_of",
                        "run_id",
                        "applied",
                        "state",
                        "can_apply",
                        "blockers",
                        "usage",
                        "before",
                        "after",
                        "evidence_sha256",
                        "source",
                        "provider_receipt_verified",
                        "capture_sha256",
                    },
                )
            prefect.assert_not_called()
        self.assertEqual(self.amounts(), (0, 0, 0))
        self.assertFalse(EvaluationLegacyUsage.objects.exists())
        self.assertFalse(EvaluationBudgetReservation.objects.exists())
        self.assertEqual(list(EvaluationRun.objects.values()), before)

    def test_unconfigured_and_insufficient_limits_keep_verified_usage(self):
        self.budget.call_limit = 0
        self.budget.save()
        data = self.client.get(self.preview_url).json()
        self.assertEqual(data["state"], "verified")
        self.assertFalse(data["can_apply"])
        self.assertEqual(data["usage"]["calls"], 1)
        self.assertTrue(data["blockers"])
        self.budget.delete()
        data = self.client.get(self.preview_url).json()
        self.assertEqual(data["state"], "verified")
        self.assertFalse(data["can_apply"])
        self.assertIsNone(data["before"])
        self.assertIsNone(data["after"])
        self.assertEqual(data["usage"]["input_tokens"], 100)

    def test_missing_usage_and_changed_file_never_return_zero_or_old_success(self):
        path = self.root / str(self.run.pk) / "capture/capture.json"
        capture = json.loads(path.read_bytes())
        capture["apiResponses"][0]["usage"]["input_tokens"] = None
        self.write_capture(self.run, capture)
        for mutation in (lambda: None, lambda: path.write_text("private-corrupt-evidence")):
            mutation()
            response = self.client.get(self.preview_url)
            self.assertEqual(response.status_code, 200)
            data = response.json()
            self.assertEqual(data["state"], "unavailable")
            self.assertTrue(data["blockers"])
            self.assertNotIn("usage", data)
            self.assertNotIn("evidence_sha256", data)
            self.assertNotIn("private-corrupt-evidence", response.content.decode())
        self.assertFalse(EvaluationLegacyUsage.objects.exists())

    def test_new_spec_and_incomplete_runs_remain_visible_but_cannot_be_previewed_as_legacy(self):
        for fields in (
            {"status": "FAILED"},
            {"status": "RUNNING"},
            {"status": "COMPLETED", "execution_spec": {"new": True}},
        ):
            EvaluationRun.objects.filter(pk=self.run.pk).update(**fields)
            listing = self.client.get(self.list_url).json()
            self.assertEqual(listing["count"], 1)
            data = self.client.get(self.preview_url).json()
            self.assertEqual(data["state"], "unavailable")
            self.assertNotIn("usage", data)

    def test_listing_excludes_replay_reserved_and_accounted_runs_without_reading_artifacts(self):
        self.apply()
        for mode in ("replay", "recovery"):
            EvaluationRun.objects.create(
                requested_by=self.user, dataset_id="test", execution_mode=mode
            )
        reserved = EvaluationRun.objects.create(
            requested_by=self.user, dataset_id="test", execution_mode="live"
        )
        EvaluationBudgetReservation.objects.create(
            run=reserved, budget=self.budget, max_calls=1, max_output_tokens=100
        )
        for _ in range(26):
            EvaluationRun.objects.create(
                requested_by=self.user, dataset_id="한글 자료", execution_mode="live"
            )
        with patch("apps.evaluations.legacy_usage.read_artifact") as read:
            first_response = self.client.get(self.list_url)
            first = first_response.json()
            second = self.client.get(self.list_url + "?page=2").json()
            read.assert_not_called()
        self.assertIn("no-store", first_response["Cache-Control"])
        self.assertEqual(first["count"], 26)
        self.assertEqual(len(first["results"]), 25)
        self.assertEqual(len(second["results"]), 1)
        self.assertTrue(first["next"])
        ids = [row["run_id"] for row in first["results"] + second["results"]]
        self.assertEqual(len(set(ids)), 26)
        self.assertNotIn(str(self.run.pk), ids)
        self.assertNotIn(str(reserved.pk), ids)
        self.assertEqual(first["results"][0]["dataset_label"], "한글 자료")
        self.assertEqual(self.client.get(self.preview_url).json()["state"], "unavailable")

    def test_only_get_is_supported_and_missing_run_is_404(self):
        for url in (self.list_url, self.preview_url):
            for method in (
                self.client.post,
                self.client.put,
                self.client.patch,
                self.client.delete,
            ):
                self.assertEqual(method(url, {"apply": True}).status_code, 405)
        missing = f"/api/v1/ops/evaluations/{uuid4()}/legacy-usage-preview"
        self.assertEqual(self.client.get(missing).status_code, 404)
        self.assertEqual(self.amounts(), (0, 0, 0))
        self.assertFalse(EvaluationLegacyUsage.objects.exists())
