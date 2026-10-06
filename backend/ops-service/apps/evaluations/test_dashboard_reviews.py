import json
from copy import deepcopy
from unittest.mock import patch
from uuid import uuid4

from django.test import SimpleTestCase, TestCase
from rest_framework.exceptions import PermissionDenied
from rest_framework.test import APIClient

from .dashboard import FIXED_SCOPE, RAG_SCOPE
from .dashboard_reviews import review_summary
from .models import EvaluationBaseline, EvaluationCaseReview, QualityAssessment
from .services import ResultsUnavailable
from .test_rag_baselines import BaselineFixture
from .test_reviews import ReviewFixture


def summary_inputs(rag=False):
    material = {
        "evaluation_scope": RAG_SCOPE if rag else FIXED_SCOPE,
        "cases": [{"case_id": "H01"}, {"case_id": "H02"}],
        "capture_sha256": "a" * 64,
        "fixture_sha256": "b" * 64,
    }
    state = {
        "case_reviews": [],
        "rubric": {"version": "test-v1"},
        "approval_current": False,
        "reference_review": {"approved": False},
        "quality": {
            "status": "NOT_EVALUATED",
            "is_current": False,
            "history": [],
            "fixture_reviews": [],
            "fixture_rubric_version": "fixture-v1",
        },
    }
    return material, state


class ReviewSummaryTests(SimpleTestCase):
    def test_unreviewed_is_not_approved_or_failed(self):
        value = review_summary(*summary_inputs())
        self.assertEqual(value["cases"]["unreviewed"], 2)
        self.assertEqual(value["approval"], "pending")
        self.assertFalse(value["reference_approved"])
        self.assertEqual(value["quality"], "NOT_EVALUATED")

    def test_latest_stale_review_does_not_fall_back_to_old_suitable_review(self):
        material, state = summary_inputs()
        row = {
            "case_id": "H01",
            "version": 1,
            "decision": "SUITABLE",
            "capture_sha256": material["capture_sha256"],
            "fixture_sha256": material["fixture_sha256"],
            "rubric_version": "test-v1",
        }
        state["case_reviews"] = [row, {**row, "version": 2, "capture_sha256": "c" * 64}]
        counts = review_summary(material, state)["cases"]
        self.assertEqual((counts["stale"], counts["suitable"], counts["unreviewed"]), (1, 0, 1))

    def test_fixture_approval_must_match_current_material_cases_and_rubric(self):
        material, state = summary_inputs()
        valid = {
            "decision": "APPROVED",
            "fixture_sha256": material["fixture_sha256"],
            "case_ids": ["H01", "H02"],
            "rubric_version": "fixture-v1",
        }
        state["quality"]["fixture_reviews"] = [valid]
        self.assertTrue(review_summary(material, state)["reference_approved"])
        for change in (
            {"decision": "DEFERRED"},
            {"fixture_sha256": "c" * 64},
            {"case_ids": ["H01"]},
            {"rubric_version": "old"},
        ):
            state["quality"]["fixture_reviews"] = [{**valid, **change}, valid]
            self.assertFalse(review_summary(material, state)["reference_approved"])

    def test_rag_requires_three_dimensions_and_current_material(self):
        material, state = summary_inputs(True)
        row = {
            "case_id": "H01",
            "version": 1,
            "is_current": True,
            "retrieval_decision": "SUITABLE",
            "answer_decision": "SUITABLE",
            "citation_decision": "SUITABLE",
        }
        for changes, expected in (
            ({}, "suitable"),
            ({"answer_decision": "UNSUITABLE"}, "unsuitable"),
            ({"citation_decision": "DEFERRED"}, "deferred"),
            ({"is_current": False}, "stale"),
        ):
            state["case_reviews"] = [{**row, **changes}]
            value = review_summary(material, state)
            self.assertEqual(value["cases"][expected], 1)
            self.assertEqual(value["approval"], "not_required")

    def test_historical_pass_and_unavailable_inputs_are_not_current_pass(self):
        material, state = summary_inputs()
        state["quality"].update(status="PASS", history=[{"status": "PASS"}])
        self.assertEqual(review_summary(material, state)["quality"], "STALE")
        state["quality"]["blocked_reason"] = "자료 확인 불가"
        self.assertEqual(review_summary(material, state)["quality"], "UNAVAILABLE")


class FixedDashboardReviewTests(ReviewFixture, TestCase):
    def setUp(self):
        super().setUp()
        self.run.comparison = json.loads(
            (self.root / str(self.run.pk) / "evaluation/comparison.json").read_bytes()
        )
        self.run.save(update_fields=["comparison"])

    def summary(self, run=None):
        return self.client.get(f"/api/v1/ops/dashboard/runs/{(run or self.run).pk}/review-status")

    def test_read_only_unreviewed_and_promoted_status_matches_existing_detail(self):
        response = self.summary()
        self.assertEqual(response.status_code, 200)
        self.assertIn("no-store", response["Cache-Control"])
        self.assertEqual(response.json()["review"]["cases"]["unreviewed"], 1)
        self.assertEqual(response.json()["baseline"]["status"], "none")
        self.assertFalse(EvaluationCaseReview.objects.exists())
        self.assertFalse(QualityAssessment.objects.exists())
        self.assertFalse(EvaluationBaseline.objects.exists())
        self.promote()
        before = self.client.get(self.url + "/review").json()
        value = self.summary().json()
        self.assertEqual(value["review"]["approval"], "approved")
        self.assertEqual(value["review"]["quality"], "PASS")
        self.assertEqual(value["baseline"]["status"], "active")
        self.assertEqual(value["baseline"]["run_id"], str(self.run.pk))
        self.assertEqual(self.client.get(self.url + "/review").json(), before)

    def test_other_run_baseline_is_checked_and_policy_change_invalidates_it(self):
        self.promote()
        other = self.completed_run()
        other.comparison = self.run.comparison
        other.save(update_fields=["comparison"])
        value = self.summary(other).json()
        self.assertEqual(value["review"]["approval"], "pending")
        self.assertEqual(value["baseline"]["status"], "active")
        self.assertEqual(value["baseline"]["run_id"], str(self.run.pk))
        policy = deepcopy(QualityAssessment.objects.get().policy)
        policy["definition"]["version"] = "changed-policy"
        with patch("apps.evaluations.quality.current_policy", return_value=policy):
            value = self.summary(other).json()
        self.assertEqual(value["baseline"]["status"], "needs_review")

    def test_missing_current_artifact_is_error_not_unreviewed_and_baseline_error_is_distinct(self):
        self.promote()
        other = self.completed_run()
        other.comparison = self.run.comparison
        other.save(update_fields=["comparison"])
        (self.root / str(self.run.pk) / "capture/capture.json").unlink()
        self.assertEqual(self.summary().status_code, 503)
        self.assertEqual(self.summary(other).json()["baseline"]["status"], "unavailable")

    def test_admin_auth_not_found_and_get_only(self):
        url = f"/api/v1/ops/dashboard/runs/{self.run.pk}/review-status"
        self.assertEqual(self.client.post(url, {}, format="json").status_code, 405)
        self.assertEqual(
            self.client.get(url.replace(str(self.run.pk), str(uuid4()))).status_code, 404
        )
        with patch(
            "apps.evaluations.authentication.CoreSessionAuthentication.authenticate",
            side_effect=PermissionDenied,
        ):
            self.assertEqual(APIClient().get(url).status_code, 403)

    def test_policy_lookup_failure_does_not_claim_baseline_is_unsuitable(self):
        self.promote()
        with patch("apps.evaluations.quality.current_policy", side_effect=ResultsUnavailable):
            value = self.summary().json()
        self.assertEqual(value["review"]["quality"], "UNAVAILABLE")
        self.assertEqual(value["baseline"]["status"], "unavailable")


class RagDashboardReviewTests(BaselineFixture, TestCase):
    def setUp(self):
        super().setUp()
        self.run.comparison = {"scope": RAG_SCOPE}
        self.run.save(update_fields=["comparison"])

    def summary(self):
        return self.client.get(f"/api/v1/ops/dashboard/runs/{self.run.pk}/review-status")

    def test_rag_pass_baseline_then_revoked_reference(self):
        self.assertEqual(self.summary().json()["review"]["quality"], "NOT_EVALUATED")
        self.qualify()
        self.promote()
        value = self.summary().json()
        self.assertEqual(value["baseline"]["status"], "active")
        self.assertEqual(value["review"]["approval"], "not_required")
        self.assertEqual(value["review"]["cases"]["suitable"], len(self.material["cases"]))
        self.reference_post(decision="REVOKED", review_version=self.state()["review_version"])
        value = self.summary().json()
        self.assertFalse(value["review"]["reference_approved"])
        self.assertEqual(value["review"]["quality"], "STALE")
        self.assertEqual(value["baseline"]["status"], "none")

    def test_changed_material_cannot_reuse_case_approval_or_baseline(self):
        self.qualify()
        self.promote()
        self.material["material_sha256"] = "f" * 64
        value = self.summary().json()
        self.assertEqual(value["review"]["cases"]["suitable"], 0)
        self.assertEqual(value["review"]["cases"]["stale"], len(self.material["cases"]))
        self.assertEqual(value["review"]["quality"], "STALE")
        self.assertEqual(value["baseline"]["status"], "needs_review")

    def test_unavailable_material_is_not_reported_as_no_reviews(self):
        self.reader.side_effect = ResultsUnavailable
        self.assertEqual(self.summary().status_code, 503)
