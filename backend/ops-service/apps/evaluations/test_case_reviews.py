from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db import close_old_connections, connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TestCase, TransactionTestCase

from .catalog import DATASETS
from .models import EvaluationBaseline, EvaluationCaseReview, EvaluationReview, EvaluationRun
from .review_eligibility import RUBRIC_VERSION, current_approval
from .reviews import promote_baseline, review_material, save_case_review
from .services import RequestConflict
from .test_reviews import ReviewFixture


class CaseReviewTests(ReviewFixture, TestCase):
    def payload(self, **changes):
        state = self.client.get(self.url + "/review").json()
        return {
            "case_id": "E01",
            "decision": "SUITABLE",
            "comment": "근거와 조건 모두 적합",
            "capture_sha256": state["material"]["capture_sha256"],
            "fixture_sha256": state["material"]["fixture_sha256"],
            "rubric_version": RUBRIC_VERSION,
            "review_version": state["review_version"],
            **changes,
        }

    def save(self, **changes):
        return self.client.post(self.url + "/case-review", self.payload(**changes), format="json")

    def approve(self, **changes):
        payload = self.payload(**changes)
        payload.pop("case_id")
        payload["decision"] = "APPROVED"
        return self.client.post(self.url + "/review", payload, format="json")

    def test_missing_deferred_and_unsuitable_cases_cannot_be_approved(self):
        self.assertEqual(self.approve().status_code, 409)
        for decision in ["DEFERRED", "UNSUITABLE"]:
            response = self.save(decision=decision)
            self.assertEqual(response.status_code, 200)
            self.assertFalse(response.json()["can_approve"])
            self.assertEqual(self.approve().status_code, 409)
        self.save()
        response = self.approve()
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["approval_current"])
        self.assertEqual(EvaluationReview.objects.get().case_reviews.count(), 1)

    def test_only_full_dataset_can_be_approved(self):
        self.dataset = self.capture_id = "target-coverage-20260907-v1"
        self.run = self.completed_run()
        self.url = f"/api/v1/ops/evaluations/{self.run.pk}"
        for case_id in DATASETS[self.dataset]["case_ids"][:-1]:
            self.assertEqual(self.save(case_id=case_id).status_code, 200)
        self.assertEqual(self.approve().status_code, 409)
        self.save(case_id="TC06")
        self.assertEqual(self.approve().status_code, 200)
        self.assertEqual(EvaluationReview.objects.get().case_reviews.count(), 6)

    def test_invalid_case_hash_rubric_and_blank_reason_are_rejected(self):
        for values, status in [
            ({"case_id": "UNKNOWN"}, 400),
            ({"comment": " "}, 400),
            ({"capture_sha256": "0" * 64}, 409),
            ({"fixture_sha256": "0" * 64}, 409),
            ({"rubric_version": "future-version"}, 409),
            ({"decision": "APPROVED"}, 400),
        ]:
            with self.subTest(values=values):
                self.assertEqual(self.save(**values).status_code, status)
        self.assertEqual(EvaluationCaseReview.objects.count(), 0)
        self.run.refresh_from_db()
        self.assertEqual(self.run.review_version, 0)

    def test_retry_is_idempotent_and_another_admin_cannot_reuse_stale_version(self):
        payload = self.payload()
        first = self.client.post(self.url + "/case-review", payload, format="json")
        repeated = self.client.post(self.url + "/case-review", payload, format="json")
        self.assertEqual(first.json()["case_reviews"], repeated.json()["case_reviews"])
        other = get_user_model().objects.create_user("second-reviewer")
        self.client.force_authenticate(other)
        self.assertEqual(
            self.client.post(self.url + "/case-review", payload, format="json").status_code, 409
        )
        self.assertEqual(EvaluationCaseReview.objects.count(), 1)

    def test_case_change_preserves_history_invalidates_approval_and_clears_baseline(self):
        review = self.promote()
        response = self.save(decision="UNSUITABLE", comment="근거에 없는 조건 발견")
        state = response.json()
        self.assertFalse(state["is_baseline"])
        self.assertFalse(state["approval_current"])
        self.assertFalse(state["can_approve"])
        self.assertEqual([r["decision"] for r in state["case_reviews"]], ["UNSUITABLE", "SUITABLE"])
        self.assertEqual(EvaluationReview.objects.get(pk=review["id"]).decision, "APPROVED")
        self.assertEqual(
            self.client.post(
                self.url + "/baseline",
                {
                    "review_id": review["id"],
                    "baseline_version": state["baseline_version"],
                },
                format="json",
            ).status_code,
            409,
        )
        self.assertIn("사례별 검토 변경", state["baseline_history"][0]["reason"])

    @patch("apps.evaluations.prefect_client.create_run")
    def test_legacy_approval_is_preserved_but_cannot_be_used_for_new_runs(self, create):
        material = review_material(self.run)
        review = EvaluationReview.objects.create(
            run=self.run,
            reviewed_by=self.user,
            decision="APPROVED",
            comment="기존 전체 승인",
            capture_sha256=material["capture_sha256"],
        )
        EvaluationBaseline.objects.create(
            dataset_id=self.dataset, version=1, review=review, selected_by=self.user
        )
        state = self.client.get(self.url + "/review").json()
        self.assertTrue(state["is_baseline"])
        self.assertTrue(state["baseline_requires_review"])
        self.assertFalse(state["approval_current"])
        self.assertEqual(state["case_reviews"], [])
        choices = self.client.get("/api/v1/ops/session").json()["datasets"]
        self.assertIsNone(next(item for item in choices if item["id"] == self.dataset)["baseline"])
        self.assertEqual(
            self.client.post(
                "/api/v1/ops/evaluations",
                {
                    "request_id": str(uuid4()),
                    "dataset_id": self.dataset,
                    "candidate_capture_id": self.capture_id,
                    "reference_capture_id": f"run:{self.run.pk}",
                    "baseline_version": 1,
                },
                format="json",
            ).status_code,
            400,
        )
        create.assert_not_called()

    def test_approval_retry_is_idempotent_but_stale_approval_after_case_change_is_rejected(self):
        self.save()
        payload = self.payload()
        payload.pop("case_id")
        payload["decision"] = "APPROVED"
        first = self.client.post(self.url + "/review", payload, format="json")
        again = self.client.post(self.url + "/review", payload, format="json")
        self.assertEqual(first.json()["reviews"], again.json()["reviews"])
        self.save(comment="조건 재확인")
        self.assertEqual(
            self.client.post(self.url + "/review", payload, format="json").status_code, 409
        )

    def test_baseline_history_failure_rolls_back_case_record_and_version(self):
        self.promote()
        before = self.client.get(self.url + "/review").json()
        with patch(
            "apps.evaluations.baselines.EvaluationBaselineChange.objects.create",
            side_effect=RuntimeError,
        ):
            with self.assertRaises(RuntimeError):
                self.save(decision="UNSUITABLE")
        after = self.client.get(self.url + "/review").json()
        self.assertEqual(after, before)

    def test_changed_rubric_requires_review_again(self):
        self.promote()
        with patch("apps.evaluations.review_eligibility.RUBRIC_VERSION", "evidence-review-v2"):
            self.run.refresh_from_db()
            self.assertFalse(current_approval(self.run.reviews.first(), self.run))


class ConcurrentCaseReviewTests(ReviewFixture, TransactionTestCase):
    def test_case_change_and_baseline_promotion_cannot_leave_stale_baseline(self):
        review = self.review().json()["reviews"][0]
        material = review_material(self.run)
        barrier = Barrier(2)

        def action(kind):
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                if kind == "case":
                    save_case_review(
                        self.run,
                        self.user,
                        "E01",
                        "UNSUITABLE",
                        "동시 검토 수정",
                        material["capture_sha256"],
                        material["fixture_sha256"],
                        RUBRIC_VERSION,
                        review["version"],
                    )
                else:
                    promote_baseline(self.run, self.user, review["id"], 0)
                return "accepted"
            except RequestConflict:
                return "conflict"
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            case, promotion = pool.map(action, ["case", "promotion"])
        self.assertEqual(case, "accepted")
        self.assertIn(promotion, ["accepted", "conflict"])
        self.assertFalse(EvaluationBaseline.objects.filter(review__isnull=False).exists())
        self.run.refresh_from_db()
        self.assertFalse(current_approval(self.run.reviews.first(), self.run))


class CaseReviewMigrationTests(TransactionTestCase):
    def test_legacy_reviews_and_baseline_are_not_converted_to_case_approvals(self):
        executor = MigrationExecutor(connection)
        latest = executor.loader.graph.leaf_nodes()
        old = [("evaluations", "0007_baseline_versions")]
        try:
            executor.migrate(old)
            apps = executor.loader.project_state(old).apps
            user = apps.get_model("auth", "User").objects.create(username="legacy")
            run = apps.get_model("evaluations", "EvaluationRun").objects.create(
                dataset_id="legacy", requested_by_id=user.pk
            )
            review = apps.get_model("evaluations", "EvaluationReview").objects.create(
                run_id=run.pk,
                reviewed_by_id=user.pk,
                decision="APPROVED",
                comment="기존 승인",
                capture_sha256="a" * 64,
            )
            apps.get_model("evaluations", "EvaluationBaseline").objects.create(
                dataset_id="legacy", review_id=review.pk, selected_by_id=user.pk, version=3
            )
            MigrationExecutor(connection).migrate(latest)
            preserved = EvaluationReview.objects.get(pk=review.pk)
            self.assertEqual(preserved.comment, "기존 승인")
            self.assertIsNone(preserved.version)
            self.assertEqual(preserved.rubric_version, "")
            self.assertEqual(EvaluationRun.objects.get(pk=run.pk).review_version, 0)
            self.assertEqual(EvaluationBaseline.objects.get(pk="legacy").version, 3)
            self.assertEqual(EvaluationCaseReview.objects.count(), 0)
        finally:
            MigrationExecutor(connection).migrate(latest)
