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
    EvaluationBudget,
    EvaluationCaseReview,
    EvaluationRun,
    FixtureReview,
    QualityAssessment,
)
from .quality import quality_pass
from .review_eligibility import current_approval
from .reviews import review_material
from .services import read_result


class SeedFileTests(SimpleTestCase):
    def test_git_seed_has_only_review_history_and_no_personal_account(self):
        document, files = seed.load_seed()
        self.assertEqual(len(document["records"]), 14)
        self.assertEqual(set(files), seed.ARTIFACTS)
        self.assertEqual(document["source_run_id"], "ec068da7-8d59-46fb-a8e4-2ab42dc39efe")
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
        run = EvaluationRun.objects.get()
        self.assertEqual(str(run.pk), self.document["source_run_id"])
        self.assertEqual(EvaluationCaseReview.objects.count(), 6)
        self.assertEqual(FixtureReview.objects.count(), 2)
        self.assertEqual(QualityAssessment.objects.count(), 2)
        for record in self.document["records"]:
            if record["model"] != "evaluations.evaluationcasereview":
                continue
            saved = EvaluationCaseReview.objects.get(pk=record["pk"])
            self.assertEqual(saved.comment, record["fields"]["comment"])
            self.assertEqual(saved.created_at, parse_datetime(record["fields"]["created_at"]))
        baseline = EvaluationBaseline.objects.get()
        self.assertTrue(current_approval(baseline.review, run))
        self.assertTrue(quality_pass(run))
        self.assertEqual(
            [case["case_id"] for case in review_material(run)["cases"]],
            ["H01", "H02", "H03", "H04", "H05", "H06"],
        )
        read_result(run)
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
        self.assertEqual(EvaluationRun.objects.count(), 1)

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
            6,
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
