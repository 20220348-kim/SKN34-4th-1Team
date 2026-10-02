"""RAG 판정의 근거·이력·충돌과 기존 고정 근거 품질 경계 검증."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from threading import Barrier
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db import close_old_connections, transaction
from django.test import SimpleTestCase, TestCase, TransactionTestCase
from rest_framework.test import APIClient

from . import rag_quality_policy
from .models import EvaluationBaseline, EvaluationRun, FixtureReview, QualityAssessment
from .quality import quality_pass
from .rag_quality import assess
from .rag_reviews import review_state, save_review
from .services import RequestConflict, ResultsUnavailable
from .test_rag_reviews import RagReviewFixture


class RagQualityPolicyTests(SimpleTestCase):
    def inputs(self):
        return {
            "measurement_kind": "recorded-capture-replay",
            "reference_review": {"approved": False, "current_id": None, "history": []},
            "cases": [
                {
                    "case_id": "R01",
                    "failure": None,
                    "dimensions": {
                        key: {"measured": True, "decision": "SUITABLE"}
                        for key in ("retrieval", "answer", "citation")
                    },
                }
            ],
        }

    def test_all_suitable_never_approves_unreviewed_rag_reference(self):
        inputs = self.inputs()
        for kind in (
            "recorded-capture-replay",
            "recorded-live-evaluation",
            "synthetic-contract-check",
            "integration-stub-replay",
        ):
            inputs["measurement_kind"] = kind
            status, reasons = rag_quality_policy.judge(inputs)
            self.assertEqual(status, "NEEDS_REVIEW")
            self.assertIn("REFERENCE_REVIEW_REQUIRED", [row["code"] for row in reasons])
            self.assertEqual(
                "NON_MODEL_CAPTURE" in [row["code"] for row in reasons],
                kind not in {"recorded-capture-replay", "recorded-live-evaluation"},
            )

    def test_each_measured_unsuitable_dimension_fails_independently(self):
        for key in ("retrieval", "answer", "citation"):
            inputs = self.inputs()
            inputs["cases"][0]["dimensions"][key]["decision"] = "UNSUITABLE"
            status, reasons = rag_quality_policy.judge(inputs)
            self.assertEqual(status, "FAIL")
            self.assertIn({"code": "HUMAN_UNSUITABLE", "case_id": "R01", "dimension": key}, reasons)

    def test_approved_reference_and_all_suitable_recorded_cases_pass(self):
        inputs = self.inputs()
        inputs["reference_review"] = {
            "approved": True,
            "current_id": 1,
            "history": [{"id": 1, "decision": "APPROVED"}],
        }
        status, reasons = rag_quality_policy.judge(inputs)
        self.assertEqual((status, reasons), ("PASS", []))
        inputs["measurement_kind"] = "recorded-live-evaluation"
        self.assertEqual(rag_quality_policy.judge(inputs), ("PASS", []))
        for kind in ("synthetic-contract-check", "integration-stub-replay"):
            inputs["measurement_kind"] = kind
            self.assertEqual(rag_quality_policy.judge(inputs)[0], "NEEDS_REVIEW")
        inputs["measurement_kind"] = "recorded-capture-replay"
        inputs["cases"] = []
        self.assertEqual(rag_quality_policy.judge(inputs)[0], "NEEDS_REVIEW")

    def test_unmeasured_and_original_failure_are_not_false_quality_failures(self):
        inputs = self.inputs()
        case = inputs["cases"][0]
        case["failure"] = {"stage": "answer", "code": "timeout"}
        case["dimensions"]["answer"] = {"measured": False, "decision": "UNSUITABLE"}
        case["dimensions"]["citation"] = {"measured": False, "decision": None}
        status, reasons = rag_quality_policy.judge(inputs)
        self.assertEqual(status, "NEEDS_REVIEW")
        self.assertEqual(sum(reason["code"] == "NOT_MEASURED" for reason in reasons), 2)
        self.assertIn("SOURCE_EXECUTION_FAILED", [row["code"] for row in reasons])


class RagQualityTests(RagReviewFixture, TestCase):
    def state(self):
        return self.client.get(self.url).json()["quality"]

    def calculate(self, stamp=None):
        return self.client.post(
            self.url.replace("rag-reviews", "rag-quality"),
            {"input_sha256": stamp or self.state()["input_sha256"]},
            format="json",
        )

    def test_read_is_not_assessment_and_snapshot_is_complete_and_idempotent(self):
        self.assertEqual(self.state()["status"], "NOT_EVALUATED")
        self.assertFalse(QualityAssessment.objects.exists())
        self.post()
        before_spec = deepcopy(self.run.execution_spec)
        response = self.calculate()
        self.assertEqual(response.status_code, 200)
        self.assertIn("no-store", response["Cache-Control"])
        quality = response.json()["quality"]
        self.assertEqual(quality["status"], "FAIL")
        self.assertTrue(quality["is_current"])
        record = QualityAssessment.objects.get()
        self.assertEqual(record.inputs["material_sha256"], self.material["material_sha256"])
        case = record.inputs["cases"][0]
        self.assertEqual(case["review"]["comment"], self.payload()["comment"])
        self.assertEqual(case["dimensions"]["answer"]["decision"], "UNSUITABLE")
        self.assertEqual(record.inputs["review_version"], 1)
        self.assertEqual(record.assessed_by, self.user)
        self.assertEqual(self.calculate().json()["quality"], quality)
        other = get_user_model().objects.create_user("core:92")
        self.client.force_authenticate(other)
        self.assertEqual(self.calculate().status_code, 200)
        self.assertEqual(QualityAssessment.objects.count(), 1)
        record.refresh_from_db()
        self.assertEqual(record.assessed_by, self.user)
        self.assertFalse(EvaluationBaseline.objects.exists())
        self.assertFalse(FixtureReview.objects.exists())
        self.assertFalse(quality_pass(self.run))
        self.run.refresh_from_db()
        self.assertEqual(self.run.execution_spec, before_spec)
        self.assertEqual(self.run.status, "COMPLETED")

    def test_review_change_marks_old_assessment_stale_and_requires_explicit_reassessment(self):
        old = self.calculate().json()["quality"]
        original = deepcopy(QualityAssessment.objects.get().inputs)
        self.post()
        changed = self.state()
        self.assertFalse(changed["is_current"])
        self.assertEqual(changed["status"], "NOT_EVALUATED")
        self.assertNotEqual(changed["input_sha256"], old["input_sha256"])
        self.assertEqual(self.calculate(old["input_sha256"]).status_code, 409)
        self.assertEqual(self.calculate().json()["quality"]["status"], "FAIL")
        self.assertEqual(QualityAssessment.objects.count(), 2)
        self.assertEqual(QualityAssessment.objects.order_by("id").first().inputs, original)

    def test_unmeasured_failure_and_empty_measured_results_remain_distinct(self):
        self.material["cases"][0]["candidate"].update(
            answer=None, cited_chunk_ids=None, failure={"stage": "answer", "code": "timeout"}
        )
        self.post(answer_decision="DEFERRED")
        quality = self.calculate().json()["quality"]
        self.assertEqual(quality["status"], "NEEDS_REVIEW")
        record = QualityAssessment.objects.get()
        case = record.inputs["cases"][0]
        self.assertTrue(case["dimensions"]["retrieval"]["measured"])
        self.assertFalse(case["dimensions"]["answer"]["measured"])
        self.assertEqual(case["failure"]["stage"], "answer")
        self.material["cases"][0]["candidate"]["retrieved_chunk_ids"] = []
        self.assertTrue(
            self.calculate().json()["quality"]["history"][0]["inputs"]["cases"][0]["dimensions"][
                "retrieval"
            ]["measured"]
        )

    def test_material_rubric_and_policy_changes_invalidate_previous_input(self):
        original = self.state()["input_sha256"]
        self.assertEqual(self.calculate(original).status_code, 200)
        for target, value in (
            (self.material, {"material_sha256": "0" * 64}),
            (rag_quality_policy.POLICY, {"version": "rag-review-quality-next"}),
        ):
            with patch.dict(target, value):
                self.assertFalse(self.state()["is_current"])
                self.assertEqual(self.calculate(original).status_code, 409)
        with patch("apps.evaluations.rag_reviews.RUBRIC", {"version": "new", "criteria": []}):
            self.assertEqual(self.calculate(original).status_code, 409)
        self.assertEqual(QualityAssessment.objects.count(), 1)

    def test_changed_review_between_validation_and_lock_is_rejected(self):
        stamp = self.state()["input_sha256"]

        def changed(run, user):
            state = review_state(run, user)
            save_review(run, user, **self.payload())
            return state

        with patch("apps.evaluations.rag_quality.review_state", side_effect=changed):
            self.assertEqual(self.calculate(stamp).status_code, 409)
        self.assertFalse(QualityAssessment.objects.exists())

    def test_authentication_csrf_and_material_failure_never_write(self):
        stamp = self.state()["input_sha256"]
        client = APIClient(enforce_csrf_checks=True)
        url = self.url.replace("rag-reviews", "rag-quality")
        self.assertEqual(client.post(url, {"input_sha256": stamp}, format="json").status_code, 401)
        client.cookies["govbiz_session"] = "core-admin-test"
        with patch(
            "apps.evaluations.authentication.read_core_admin",
            return_value={"accountId": 91, "email": self.user.email, "role": "ADMIN"},
        ):
            self.assertEqual(
                client.post(url, {"input_sha256": stamp}, format="json").status_code, 403
            )
            token = client.get("/api/v1/ops/session").json()["csrf_token"]
            self.assertEqual(
                client.post(
                    url, {"input_sha256": stamp}, format="json", HTTP_X_CSRFTOKEN=token
                ).status_code,
                200,
            )
        self.reader.side_effect = ResultsUnavailable
        self.assertEqual(self.calculate(stamp).status_code, 503)
        self.assertEqual(QualityAssessment.objects.count(), 1)


class RagQualityConcurrencyTests(RagReviewFixture, TransactionTestCase):
    def test_concurrent_same_input_stores_one_assessment(self):
        stamp = review_state(self.run, self.user)["quality"]["input_sha256"]
        barrier = Barrier(2)

        def snapshot(run, user):
            state = review_state(run, user)
            barrier.wait(timeout=10)
            return state

        def store(_):
            close_old_connections()
            try:
                return assess(EvaluationRun.objects.get(pk=self.run.pk), self.user, stamp).pk
            finally:
                close_old_connections()

        with (
            patch("apps.evaluations.rag_quality.review_state", side_effect=snapshot),
            ThreadPoolExecutor(max_workers=2) as pool,
        ):
            result = list(pool.map(store, range(2)))
        self.assertEqual(result[0], result[1])
        self.assertEqual(QualityAssessment.objects.count(), 1)

    def test_failed_insert_does_not_leave_assessment_or_version_change(self):
        stamp = review_state(self.run, self.user)["quality"]["input_sha256"]
        with (
            patch(
                "apps.evaluations.rag_quality.QualityAssessment.objects.get_or_create",
                side_effect=RequestConflict,
            ),
            self.assertRaises(RequestConflict),
            transaction.atomic(),
        ):
            assess(self.run, self.user, stamp)
        self.run.refresh_from_db()
        self.assertEqual(self.run.review_version, 0)
        self.assertFalse(QualityAssessment.objects.exists())
