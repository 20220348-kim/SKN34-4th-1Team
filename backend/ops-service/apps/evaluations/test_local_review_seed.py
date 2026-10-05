"""Git으로 공유하는 실제 검토 이력의 무결성·기존 환경 보존을 검증한다."""

import json
from copy import deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.management import CommandError, call_command
from django.test import RequestFactory, SimpleTestCase, TestCase, override_settings
from django.utils.dateparse import parse_datetime
from rest_framework.test import APIClient

from .authentication import CoreSessionAuthentication
from .management.commands import bootstrap_local_reviews as seed
from .models import (
    EvaluationBaseline,
    EvaluationBaselineChange,
    EvaluationBudget,
    EvaluationCaseReview,
    EvaluationRun,
    FixtureReview,
    QualityAssessment,
)
from .quality import quality_pass
from .review_eligibility import current_approval
from .reviews import review_material
from .services import ResultsUnavailable, read_result

CURRENT_RUN = "628ae52a-f417-4b53-b400-d90405e6a7d8"
PREVIOUS_RUN = "ec068da7-8d59-46fb-a8e4-2ab42dc39efe"


class SeedFileTests(SimpleTestCase):
    def test_git_seed_has_only_review_history_and_no_personal_account(self):
        document, files = seed.load_seed()
        self.assertEqual(len(document["records"]), 24)
        self.assertEqual(len(files), 14)
        self.assertEqual(document["source_run_id"], CURRENT_RUN)
        self.assertIn(f"{CURRENT_RUN}/capture/capture.json", files)
        self.assertIn(f"{CURRENT_RUN}/reference-capture.json", files)
        for record in document["records"]:
            self.assertIn(record["model"], seed.MODELS)
            self.assertFalse({"password", "email", "session_key"} & record["fields"].keys())
        raw = json.dumps(document).encode() + b"".join(files.values())
        for forbidden in (
            b"admin@govbiz.local",
            b"OPENAI_API_KEY",
            b"LLMOPS_BUDGET_TOKEN",
            b"govbiz_session",
        ):
            self.assertNotIn(forbidden, raw)

    def test_tampered_artifact_cannot_be_imported(self):
        document, _ = seed.load_seed()
        document["artifacts"][0]["sha256"] = "0" * 64
        with patch.object(seed.json, "loads", return_value=document):
            with self.assertRaisesMessage(CommandError, "integrity check failed"):
                seed.load_seed()

    def test_accounts_and_unsafe_artifact_paths_are_rejected(self):
        document, _ = seed.load_seed()
        invalid = deepcopy(document)
        invalid["records"][0]["model"] = "auth.user"
        with patch.object(seed.json, "loads", return_value=invalid):
            with self.assertRaisesMessage(CommandError, "review records only"):
                seed.load_seed()
        invalid = deepcopy(document)
        invalid["artifacts"][0]["file"] = "../../secret"
        with patch.object(seed.json, "loads", return_value=invalid):
            with self.assertRaisesMessage(CommandError, "artifact path"):
                seed.load_seed()

    def test_incomplete_live_history_and_missing_reference_are_rejected(self):
        document, _ = seed.load_seed()
        for field, value in (
            ("status", "RUNNING"),
            ("model_api_calls", 0),
            ("reference_config", {"run_id": "unknown"}),
        ):
            with self.subTest(field=field):
                invalid = deepcopy(document)
                run = next(item for item in invalid["records"] if item["pk"] == CURRENT_RUN)
                run["fields"][field] = value
                with patch.object(seed.json, "loads", return_value=invalid):
                    with self.assertRaises(CommandError):
                        seed.load_seed()
        for change in ("missing", "duplicate"):
            with self.subTest(change=change):
                invalid = deepcopy(document)
                if change == "missing":
                    invalid["artifacts"].pop(0)
                else:
                    invalid["artifacts"].append(invalid["artifacts"][0])
                with patch.object(seed.json, "loads", return_value=invalid):
                    with self.assertRaisesMessage(CommandError, "review artifacts"):
                        seed.load_seed()

    @override_settings(LLMOPS_LOCAL_SEED_ENABLED=False)
    def test_not_enabled_in_other_environments(self):
        with self.assertRaisesMessage(CommandError, "explicitly enabled"):
            call_command("bootstrap_local_reviews")


@override_settings(LLMOPS_ARTIFACT_URL="", CORE_ACCOUNT_NAMESPACE="")
class LocalReviewSeedTests(TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        override = override_settings(LLMOPS_RESULTS_DIR=self.root)
        override.enable()
        self.addCleanup(override.disable)
        self.document, self.files = seed.load_seed()

    def test_import_preserves_human_decisions_hashes_and_timestamps(self):
        self.assertEqual(seed.import_seed(), "SHARED_REVIEWS_IMPORTED")
        run = EvaluationRun.objects.get(pk=CURRENT_RUN)
        self.assertEqual(str(run.pk), self.document["source_run_id"])
        self.assertEqual(EvaluationRun.objects.count(), 2)
        self.assertEqual(EvaluationCaseReview.objects.count(), 12)
        self.assertEqual(FixtureReview.objects.count(), 2)
        self.assertEqual(QualityAssessment.objects.count(), 3)
        for record in self.document["records"]:
            if record["model"] != "evaluations.evaluationcasereview":
                continue
            saved = EvaluationCaseReview.objects.get(pk=record["pk"])
            self.assertEqual(saved.comment, record["fields"]["comment"])
            self.assertEqual(saved.created_at, parse_datetime(record["fields"]["created_at"]))
        baseline = EvaluationBaseline.objects.get()
        self.assertEqual(baseline.version, 2)
        self.assertEqual(baseline.review.run_id, run.pk)
        self.assertEqual(run.execution_mode, "live")
        self.assertEqual(run.model_api_calls, 6)
        self.assertEqual(str(run.baseline_review.run_id), PREVIOUS_RUN)
        self.assertEqual(run.baseline_version, 1)
        self.assertEqual(EvaluationBaselineChange.objects.count(), 2)
        change = EvaluationBaselineChange.objects.get(version=2)
        self.assertEqual(str(change.previous_review.run_id), PREVIOUS_RUN)
        self.assertEqual(change.review_id, baseline.review_id)
        self.assertTrue(current_approval(baseline.review, run))
        self.assertTrue(quality_pass(run))
        self.assertEqual(
            [case["case_id"] for case in review_material(run)["cases"]],
            ["H01", "H02", "H03", "H04", "H05", "H06"],
        )
        read_result(run)
        material = review_material(run)
        self.assertEqual(material["recorded_model"], "gpt-6-luna")
        self.assertEqual(
            material["capture_sha256"],
            "beeabad9669554ab643a7cbd0e0682d977823c9fa06623a0a6c8c9b3e7b2d2e1",
        )
        previous = EvaluationRun.objects.get(pk=PREVIOUS_RUN)
        read_result(previous)
        self.assertTrue(current_approval(previous.reviews.first(), previous))
        self.assertTrue(quality_pass(previous))
        reviewer = get_user_model().objects.get(username=self.document["reviewer"])
        self.assertFalse(reviewer.is_active or reviewer.is_staff or reviewer.has_usable_password())
        self.assertEqual(reviewer.email, "")
        self.assertFalse(EvaluationBudget.objects.exists())
        client = APIClient()
        client.force_authenticate(get_user_model().objects.create_user("core:2", is_staff=True))
        self.assertEqual(client.get(f"/api/v1/ops/evaluations/{run.id}/review").status_code, 200)

    def test_restart_keeps_revoked_baseline_and_local_changes(self):
        seed.import_seed()
        baseline = EvaluationBaseline.objects.get()
        baseline.review = None
        baseline.version += 1
        baseline.save()
        path = self.root / self.document["source_run_id"] / "request.json"
        path.write_bytes(b"local-change")
        with patch.object(seed, "load_seed", side_effect=AssertionError("must not reread seed")):
            self.assertEqual(seed.import_seed(), "EXISTING_DATA_PRESERVED")
        baseline.refresh_from_db()
        self.assertIsNone(baseline.review)
        self.assertEqual(path.read_bytes(), b"local-change")
        self.assertEqual(EvaluationRun.objects.count(), 2)

    def test_existing_budget_only_is_also_preserved(self):
        EvaluationBudget.objects.create(id=1, call_limit=8)
        self.assertEqual(seed.import_seed(), "EXISTING_DATA_PRESERVED")
        self.assertFalse(EvaluationRun.objects.exists())
        self.assertEqual(list(self.root.iterdir()), [])

    def test_same_numeric_core_account_does_not_reattribute_original_review(self):
        seed.import_seed()
        request = RequestFactory().get("/api/v1/ops/session")
        request.COOKIES["govbiz_session"] = "synthetic-session"
        with patch(
            "apps.evaluations.authentication.read_core_admin",
            return_value={
                "accountId": 2,
                "email": "teammate@example.invalid",
                "role": "ADMIN",
            },
        ):
            user, _ = CoreSessionAuthentication().authenticate(request)
        self.assertEqual(user.username, "core:2")
        self.assertFalse(EvaluationCaseReview.objects.filter(reviewed_by=user).exists())
        self.assertEqual(
            EvaluationCaseReview.objects.filter(
                reviewed_by__username=self.document["reviewer"],
            ).count(),
            12,
        )

    def test_incompatible_policy_rolls_back_all_rows_and_identical_files_can_retry(self):
        with patch.object(seed, "quality_pass", return_value=False):
            with self.assertRaisesMessage(CommandError, "incompatible"):
                seed.import_seed()
        self.assertFalse(EvaluationRun.objects.exists())
        self.assertFalse(get_user_model().objects.exists())
        self.assertEqual(seed.import_seed(), "SHARED_REVIEWS_IMPORTED")

    def test_existing_different_file_is_not_overwritten(self):
        path = self.root / self.document["source_run_id"] / "request.json"
        path.parent.mkdir()
        path.write_bytes(b"existing")
        with self.assertRaisesMessage(CommandError, "nothing was overwritten"):
            seed.import_seed()
        self.assertEqual(path.read_bytes(), b"existing")
        self.assertFalse(EvaluationRun.objects.exists())
        self.assertFalse(get_user_model().objects.exists())

    def test_invalid_live_evidence_rolls_back_without_recreating_approval(self):
        files = dict(self.files)
        files[f"{CURRENT_RUN}/capture/capture.json"] = b"{}"
        with patch.object(seed, "load_seed", return_value=(self.document, files)):
            with self.assertRaises(ResultsUnavailable):
                seed.import_seed()
        self.assertFalse(EvaluationRun.objects.exists())
        self.assertFalse(get_user_model().objects.exists())

    def test_seed_must_select_the_declared_current_run(self):
        document = deepcopy(self.document)
        document["source_run_id"] = PREVIOUS_RUN
        with patch.object(seed, "load_seed", return_value=(document, self.files)):
            with self.assertRaisesMessage(CommandError, "incompatible"):
                seed.import_seed()
        self.assertFalse(EvaluationBaseline.objects.exists())
