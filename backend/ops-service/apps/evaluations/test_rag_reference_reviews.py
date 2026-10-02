"""실행별 참조 승인·철회와 후보 검토·품질 판정의 동시성 경계를 검증한다."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from threading import Barrier
from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db import IntegrityError, close_old_connections, connection, transaction
from django.db.migrations.executor import MigrationExecutor
from django.test import TestCase, TransactionTestCase
from rest_framework.exceptions import PermissionDenied
from rest_framework.test import APIClient

from .models import (
    EvaluationBaseline,
    EvaluationRun,
    FixtureReview,
    QualityAssessment,
    RagCaseReview,
    RagReferenceReview,
)
from .rag_reference_reviews import RUBRIC, save_reference_review
from .rag_reviews import review_state, save_review
from .services import RequestConflict, ResultsUnavailable
from .test_rag_reviews import RagReviewFixture


class ReferenceFixture(RagReviewFixture):
    def setUp(self):
        super().setUp()
        self.reference_url = self.url.replace("rag-reviews", "rag-reference-review")
        mocked = patch(
            "apps.evaluations.rag_reference_reviews.read_material",
            side_effect=lambda _: deepcopy(self.material),
        )
        self.reference_reader = mocked.start()
        self.addCleanup(mocked.stop)

    def reference_payload(self, **changes):
        return {
            "decision": "APPROVED",
            "comment": "전체 원문·질문과 기대 인용을 대조했습니다. 한글 및 예외 조건 확인.",
            "fixture_sha256": self.material["fixture_sha256"],
            "case_ids": [case["case_id"] for case in self.material["cases"]],
            "rubric_version": RUBRIC["version"],
            "review_version": 0,
            "confirmed_all_cases": True,
            **changes,
        }

    def reference_post(self, **changes):
        return self.client.post(
            self.reference_url, self.reference_payload(**changes), format="json"
        )

    def state(self):
        return self.client.get(self.url).json()

    def assess(self, stamp=None):
        return self.client.post(
            self.url.replace("rag-reviews", "rag-quality"),
            {"input_sha256": stamp or self.state()["quality"]["input_sha256"]},
            format="json",
        )


class RagReferenceReviewTests(ReferenceFixture, TestCase):
    def test_approval_is_bound_to_this_run_and_does_not_promote_quality_or_change_provenance(self):
        self.assertFalse(self.state()["reference_review"]["approved"])
        self.assertFalse(RagReferenceReview.objects.exists())
        original = deepcopy(self.run.execution_spec)
        response = self.reference_post()
        self.assertEqual(response.status_code, 200)
        self.assertIn("no-store", response["Cache-Control"])
        value = response.json()
        self.assertTrue(value["reference_review"]["approved"])
        self.assertEqual(value["review_version"], 1)
        row = value["reference_review"]["history"][0]
        for key in ("comment", "case_ids", "fixture_sha256", "rubric_version"):
            self.assertEqual(row[key], self.reference_payload()[key])
        self.assertEqual(row["execution_spec_sha256"], self.run.execution_spec_sha256)
        self.assertEqual(row["reviewed_by"], self.user.email)
        self.assertEqual(value["material"]["reference_source"], "ai-authored-not-human-reviewed")
        self.assertFalse(value["material"]["baseline_eligible"])
        self.assertFalse(QualityAssessment.objects.exists())
        self.assertFalse(FixtureReview.objects.exists())
        self.assertFalse(EvaluationBaseline.objects.exists())
        self.run.refresh_from_db()
        self.assertEqual(self.run.execution_spec, original)
        other = deepcopy(self.run)
        other.pk, other.review_version = uuid4(), 0
        other.save(force_insert=True)
        self.assertFalse(review_state(other, self.user)["reference_review"]["approved"])

    def test_partial_stale_unconfirmed_and_invalid_requests_do_not_write(self):
        case_ids = self.reference_payload()["case_ids"]
        for fields, status in (
            ({"case_ids": case_ids[:1]}, 409),
            ({"case_ids": case_ids[::-1]}, 409),
            ({"case_ids": case_ids + case_ids[:1]}, 409),
            ({"case_ids": []}, 400),
            ({"confirmed_all_cases": False}, 400),
            ({"fixture_sha256": "0" * 64}, 409),
            ({"rubric_version": "future"}, 409),
            ({"review_version": 1}, 409),
            ({"review_version": -1}, 400),
            ({"comment": " "}, 400),
            ({"comment": "a" * 3001}, 400),
            ({"decision": "PASS"}, 400),
        ):
            with self.subTest(fields=fields):
                self.assertEqual(self.reference_post(**fields).status_code, status)
        missing = self.reference_payload()
        del missing["confirmed_all_cases"]
        self.assertEqual(
            self.client.post(self.reference_url, missing, format="json").status_code, 400
        )
        self.run.refresh_from_db()
        self.assertEqual(self.run.review_version, 0)
        self.assertFalse(RagReferenceReview.objects.exists())

    def test_revocation_is_append_only_and_old_retry_cannot_restore_approval(self):
        first = self.reference_post().json()["reference_review"]["history"][0]
        self.assertEqual(self.post(review_version=1).status_code, 200)
        response = self.reference_post(
            decision="REVOKED", review_version=2, comment="예외 누락 발견"
        )
        self.assertEqual(response.status_code, 200)
        reference = response.json()["reference_review"]
        self.assertFalse(reference["approved"])
        self.assertFalse(reference["can_revoke"])
        self.assertEqual(reference["history"][0]["revoked_review_id"], first["id"])
        self.assertEqual(reference["history"][1]["comment"], first["comment"])
        retry = self.reference_post().json()
        self.assertFalse(retry["reference_review"]["approved"])
        self.assertEqual(retry["review_version"], 3)
        self.assertEqual(RagReferenceReview.objects.count(), 2)
        self.assertEqual(self.reference_post(comment="다른 근거").status_code, 409)
        self.client.force_authenticate(get_user_model().objects.create_user("core:92"))
        self.assertEqual(self.reference_post().status_code, 409)

    def test_only_latest_approval_can_be_revoked_and_reapproval_is_explicit(self):
        self.assertEqual(self.reference_post(decision="REVOKED").status_code, 409)
        self.reference_post()
        self.assertEqual(
            self.reference_post(decision="DEFERRED", review_version=1).status_code, 200
        )
        self.assertEqual(self.reference_post(decision="REVOKED", review_version=2).status_code, 409)
        self.assertTrue(
            self.reference_post(review_version=2).json()["reference_review"]["approved"]
        )

    def test_reference_changes_invalidate_old_assessment_without_automatic_reassessment(self):
        old = self.assess().json()["quality"]
        snapshot = deepcopy(QualityAssessment.objects.get().inputs)
        approved = self.reference_post().json()
        self.assertFalse(approved["quality"]["is_current"])
        self.assertEqual(approved["quality"]["status"], "NOT_EVALUATED")
        self.assertEqual(self.assess(old["input_sha256"]).status_code, 409)
        current = self.assess().json()["quality"]
        self.assertEqual(current["status"], "NEEDS_REVIEW")
        self.assertFalse(current["policy"]["definition"]["pass_enabled"])
        self.assertIn("PASS_POLICY_PENDING", [r["code"] for r in current["history"][0]["reasons"]])
        self.assertTrue(current["history"][0]["inputs"]["reference_review"]["approved"])
        self.reference_post(decision="REVOKED", review_version=1)
        self.assertEqual(self.assess(current["input_sha256"]).status_code, 409)
        revoked = self.assess().json()["quality"]
        self.assertIn("REFERENCE_REVOKED", [r["code"] for r in revoked["history"][0]["reasons"]])
        self.assertEqual(QualityAssessment.objects.order_by("id").first().inputs, snapshot)
        self.reference_post(decision="CHANGES_REQUESTED", review_version=2)
        changed = self.assess().json()["quality"]
        self.assertIn(
            "REFERENCE_CHANGES_REQUESTED", [r["code"] for r in changed["history"][0]["reasons"]]
        )

    def test_material_rubric_and_spec_changes_invalidate_approval_but_preserve_history(self):
        self.reference_post()
        for replacement in (
            patch.dict(self.material, {"fixture_sha256": "0" * 64}),
            patch.dict(RUBRIC, {"version": "future"}),
        ):
            with replacement:
                state = self.state()["reference_review"]
                self.assertFalse(state["approved"])
                self.assertIsNone(state["current_id"])
                self.assertEqual(len(state["history"]), 1)
        EvaluationRun.objects.filter(pk=self.run.pk).update(execution_spec_sha256="0" * 64)
        self.assertFalse(self.state()["reference_review"]["approved"])

    def test_revocation_between_quality_snapshot_and_lock_is_rejected(self):
        self.reference_post()
        stamp = self.state()["quality"]["input_sha256"]

        def changed(run, user):
            state = review_state(run, user)
            save_reference_review(
                run, user, **self.reference_payload(decision="REVOKED", review_version=1)
            )
            return state

        with patch("apps.evaluations.rag_quality.review_state", side_effect=changed):
            self.assertEqual(self.assess(stamp).status_code, 409)
        self.assertFalse(QualityAssessment.objects.exists())

    def test_authentication_and_csrf_are_required(self):
        client = APIClient(enforce_csrf_checks=True)
        body = self.reference_payload()
        self.assertEqual(client.post(self.reference_url, body, format="json").status_code, 401)
        client.cookies["govbiz_session"] = "core-admin-test"
        with patch("apps.evaluations.authentication.read_core_admin", side_effect=PermissionDenied):
            self.assertEqual(client.post(self.reference_url, body, format="json").status_code, 403)
        with patch(
            "apps.evaluations.authentication.read_core_admin",
            return_value={"accountId": 91, "email": self.user.email, "role": "ADMIN"},
        ):
            self.assertEqual(client.post(self.reference_url, body, format="json").status_code, 403)
            token = client.get("/api/v1/ops/session").json()["csrf_token"]
            self.assertEqual(
                client.post(
                    self.reference_url, body, format="json", HTTP_X_CSRFTOKEN=token
                ).status_code,
                200,
            )
        self.assertEqual(RagReferenceReview.objects.count(), 1)

    def test_unavailable_material_and_changed_spec_never_write(self):
        self.reference_reader.side_effect = ResultsUnavailable
        self.assertEqual(self.reference_post().status_code, 503)

        def changed(_):
            EvaluationRun.objects.filter(pk=self.run.pk).update(execution_spec_sha256="0" * 64)
            return self.material

        self.reference_reader.side_effect = changed
        self.assertEqual(self.reference_post().status_code, 409)
        self.assertFalse(RagReferenceReview.objects.exists())

    def test_failed_insert_rolls_back_shared_version(self):
        with (
            patch(
                "apps.evaluations.rag_reference_reviews.RagReferenceReview.objects.create",
                side_effect=IntegrityError,
            ),
            self.assertRaises(IntegrityError),
        ):
            save_reference_review(self.run, self.user, **self.reference_payload())
        self.run.refresh_from_db()
        self.assertEqual(self.run.review_version, 0)

    def test_database_rejects_duplicate_version_bad_decision_and_missing_revocation_target(self):
        self.reference_post()
        row = RagReferenceReview.objects.get()
        row.pk = None
        with self.assertRaises(IntegrityError), transaction.atomic():
            row.save(force_insert=True)
        for decision, version in (("PASS", 2), ("REVOKED", 2), ("APPROVED", 0)):
            row.decision, row.version = decision, version
            with self.assertRaises(IntegrityError), transaction.atomic():
                row.save(force_insert=True)


class RagReferenceConcurrencyTests(ReferenceFixture, TransactionTestCase):
    def parallel(self, other_action):
        other = get_user_model().objects.create_user("core:92")
        gate = Barrier(2)

        def material(_):
            self.assertFalse(connection.in_atomic_block)
            gate.wait(timeout=10)
            return deepcopy(self.material)

        self.reader.side_effect = self.reference_reader.side_effect = material

        def save(action):
            close_old_connections()
            try:
                run = EvaluationRun.objects.get(pk=self.run.pk)
                if action == "candidate":
                    return save_review(run, self.user, **self.payload()).pk
                user = other if action == "other" else self.user
                return save_reference_review(run, user, **self.reference_payload()).pk
            except RequestConflict:
                return "conflict"
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            values = list(pool.map(save, ["reference", other_action]))
        self.run.refresh_from_db()
        self.assertEqual(self.run.review_version, 1)
        self.assertEqual(RagReferenceReview.objects.count() + RagCaseReview.objects.count(), 1)
        return values

    def test_identical_concurrent_retry_creates_one_record(self):
        values = self.parallel("reference")
        self.assertEqual(values[0], values[1])

    def test_different_reviewers_cannot_write_same_version(self):
        self.assertEqual(self.parallel("other").count("conflict"), 1)

    def test_reference_and_candidate_share_one_version_lock(self):
        self.assertEqual(self.parallel("candidate").count("conflict"), 1)


class RagReferenceMigrationTests(TransactionTestCase):
    def test_upgrade_preserves_reviews_and_assessments_without_inventing_reference_approval(self):
        executor = MigrationExecutor(connection)
        latest = executor.loader.graph.leaf_nodes()
        old = [("evaluations", "0021_rag_case_reviews")]
        try:
            executor.migrate(old)
            apps = executor.loader.project_state(old).apps
            user = apps.get_model("auth", "User").objects.create(username="legacy-rag")
            run = apps.get_model("evaluations", "EvaluationRun").objects.create(
                dataset_id="rag", requested_by_id=user.pk, review_version=4
            )
            review = apps.get_model("evaluations", "RagCaseReview").objects.create(
                run_id=run.pk,
                version=4,
                case_id="R01",
                retrieval_decision="SUITABLE",
                answer_decision="DEFERRED",
                citation_decision="DEFERRED",
                comment="기존 검토",
                reviewed_by_id=user.pk,
            )
            assessment = apps.get_model("evaluations", "QualityAssessment").objects.create(
                run_id=run.pk,
                status="NEEDS_REVIEW",
                policy={"definition": {"version": "rag-review-quality-v1"}},
                inputs={"review_version": 4},
                reasons=[],
                assessed_by_id=user.pk,
            )
            MigrationExecutor(connection).migrate(latest)
            self.assertEqual(RagCaseReview.objects.get(pk=review.pk).comment, "기존 검토")
            self.assertEqual(
                QualityAssessment.objects.get(pk=assessment.pk).inputs, {"review_version": 4}
            )
            self.assertEqual(EvaluationRun.objects.get(pk=run.pk).review_version, 4)
            self.assertFalse(RagReferenceReview.objects.exists())
        finally:
            MigrationExecutor(connection).migrate(latest)
