"""사람 검토의 권한·불변 자료·재전송·동시 저장과 품질 승격 경계를 검증한다."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from threading import Barrier
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db import IntegrityError, close_old_connections, connection, transaction
from django.test import TestCase, TransactionTestCase
from rest_framework.exceptions import PermissionDenied
from rest_framework.test import APIClient

from .models import (
    EvaluationBaseline,
    EvaluationCaseReview,
    EvaluationReview,
    EvaluationRun,
    RagCaseReview,
)
from .rag_reviews import RUBRIC, save_review
from .services import RequestConflict, ResultsUnavailable
from .test_rag_material import RagMaterialTests


class RagReviewFixture:
    def setUp(self):
        source = RagMaterialTests()
        source.setUp()
        self.material = source.read()
        self.user = get_user_model().objects.create_user("core:91", email="reviewer@example.com")
        self.run = source.run
        self.run.requested_by = self.user
        self.run.save()
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.url = f"/api/v1/ops/evaluations/{self.run.pk}/rag-reviews"
        mocked = patch(
            "apps.evaluations.rag_reviews.read_material",
            side_effect=lambda _: deepcopy(self.material),
        )
        self.reader = mocked.start()
        self.addCleanup(mocked.stop)

    def payload(self, **changes):
        return {
            "case_id": "R01",
            "material_sha256": self.material["material_sha256"],
            "rubric_version": RUBRIC["version"],
            "review_version": 0,
            "retrieval_decision": "SUITABLE",
            "answer_decision": "UNSUITABLE",
            "citation_decision": "DEFERRED",
            "comment": "지원 조건의 예외 누락. 인용은 추가 확인 필요.",
            **changes,
        }

    def post(self, **changes):
        return self.client.post(self.url, self.payload(**changes), format="json")


class RagReviewTests(RagReviewFixture, TestCase):
    def test_dimensions_provenance_and_actor_are_saved_without_quality_promotion(self):
        before = self.client.get(self.url)
        self.assertEqual(before.status_code, 200)
        self.assertIn("no-store", before["Cache-Control"])
        self.assertEqual(before.json()["reviewer_id"], "core:91")
        self.assertEqual(before.json()["case_reviews"], [])
        response = self.post()
        self.assertEqual(response.status_code, 200)
        value = response.json()
        self.assertEqual(value["review_version"], 1)
        row = value["case_reviews"][0]
        self.assertEqual(row["retrieval_decision"], "SUITABLE")
        self.assertEqual(row["answer_decision"], "UNSUITABLE")
        self.assertEqual(row["citation_decision"], "DEFERRED")
        self.assertEqual(row["reviewed_by"], self.user.email)
        self.assertTrue(row["is_current"])
        self.assertEqual(row["execution_spec_sha256"], self.run.execution_spec_sha256)
        for key in (
            "material_sha256",
            "fixture_sha256",
            "candidate_capture_sha256",
            "reference_capture_sha256",
        ):
            self.assertEqual(row[key], self.material[key])
        self.assertFalse(value["material"]["baseline_eligible"])
        self.assertEqual(value["material"]["reference_source"], "ai-authored-not-human-reviewed")
        self.assertFalse(EvaluationReview.objects.exists())
        self.assertFalse(EvaluationCaseReview.objects.exists())
        self.assertFalse(EvaluationBaseline.objects.exists())

    def test_invalid_or_stale_inputs_do_not_change_version(self):
        for fields, status in (
            ({"case_id": "unknown"}, 400),
            ({"comment": " "}, 400),
            ({"comment": "a" * 3001}, 400),
            ({"answer_decision": "PASS"}, 400),
            ({"material_sha256": "0" * 64}, 409),
            ({"rubric_version": "future"}, 409),
            ({"review_version": 1}, 409),
            ({"review_version": -1}, 400),
        ):
            with self.subTest(fields=fields):
                self.assertEqual(self.post(**fields).status_code, status)
        self.run.refresh_from_db()
        self.assertEqual(self.run.review_version, 0)
        self.assertFalse(RagCaseReview.objects.exists())

    def test_unmeasured_components_must_remain_deferred(self):
        candidate = self.material["cases"][0]["candidate"]
        candidate.update(
            answer=None, cited_chunk_ids=None, failure={"stage": "answer", "code": "timeout"}
        )
        self.assertEqual(self.post().status_code, 400)
        response = self.post(answer_decision="DEFERRED")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["case_reviews"][0]["retrieval_decision"], "SUITABLE")
        candidate.update(retrieved_chunk_ids=None, context_chunk_ids=None)
        self.assertEqual(self.post(review_version=1, answer_decision="DEFERRED").status_code, 400)
        self.assertEqual(
            self.post(
                review_version=1, retrieval_decision="DEFERRED", answer_decision="DEFERRED"
            ).status_code,
            200,
        )

    def test_lost_response_retry_is_idempotent_even_after_later_reviews(self):
        first = self.post().json()["case_reviews"][0]
        self.assertEqual(self.post(case_id="R02", review_version=1).status_code, 200)
        retry = self.post()
        self.assertEqual(retry.status_code, 200)
        self.assertEqual(retry.json()["review_version"], 2)
        self.assertEqual(RagCaseReview.objects.count(), 2)
        self.assertEqual(
            RagCaseReview.objects.get(pk=first["id"]).created_at.isoformat().replace("+00:00", "Z"),
            first["created_at"],
        )
        self.assertEqual(self.post(comment="다른 내용").status_code, 409)
        other = get_user_model().objects.create_user("core:92")
        self.client.force_authenticate(other)
        self.assertEqual(self.post().status_code, 409)

    def test_history_is_append_only_and_only_latest_matching_material_is_current(self):
        self.post()
        value = self.post(
            review_version=1, answer_decision="SUITABLE", comment="재검토 근거"
        ).json()
        self.assertEqual([row["is_current"] for row in value["case_reviews"]], [True, False])
        self.assertEqual(value["case_reviews"][1]["answer_decision"], "UNSUITABLE")
        self.material["material_sha256"] = "9" * 64
        value = self.client.get(self.url).json()
        self.assertTrue(all(not row["is_current"] for row in value["case_reviews"]))
        self.assertEqual(self.post(review_version=2, material_sha256="0" * 64).status_code, 409)

    def test_material_failure_or_concurrent_spec_change_never_writes(self):
        self.reader.side_effect = ResultsUnavailable
        self.assertEqual(self.post().status_code, 503)

        def changed(_):
            EvaluationRun.objects.filter(pk=self.run.pk).update(execution_spec_sha256="0" * 64)
            return self.material

        self.reader.side_effect = changed
        self.assertEqual(self.post().status_code, 409)
        self.assertFalse(RagCaseReview.objects.exists())

    def test_failed_insert_rolls_back_version(self):
        with (
            patch(
                "apps.evaluations.rag_reviews.RagCaseReview.objects.create",
                side_effect=IntegrityError,
            ),
            self.assertRaises(IntegrityError),
        ):
            save_review(self.run, self.user, **self.payload())
        self.run.refresh_from_db()
        self.assertEqual(self.run.review_version, 0)

    def test_admin_authentication_and_csrf_are_required_for_writes(self):
        client = APIClient(enforce_csrf_checks=True)
        self.assertEqual(client.get(self.url).status_code, 401)
        self.assertEqual(client.post(self.url, self.payload(), format="json").status_code, 401)
        client.cookies["govbiz_session"] = "core-admin-test"
        with patch("apps.evaluations.authentication.read_core_admin", side_effect=PermissionDenied):
            self.assertEqual(client.get(self.url).status_code, 403)
        with patch(
            "apps.evaluations.authentication.read_core_admin",
            return_value={"accountId": 91, "email": self.user.email, "role": "ADMIN"},
        ):
            self.assertEqual(client.post(self.url, self.payload(), format="json").status_code, 403)
            token = client.get("/api/v1/ops/session").json()["csrf_token"]
            self.assertEqual(
                client.post(
                    self.url, self.payload(), format="json", HTTP_X_CSRFTOKEN=token
                ).status_code,
                200,
            )
        self.assertEqual(RagCaseReview.objects.count(), 1)

    def test_database_rejects_duplicate_version_and_invalid_decision(self):
        self.post()
        row = RagCaseReview.objects.get()
        row.pk = None
        with self.assertRaises(IntegrityError), transaction.atomic():
            row.save(force_insert=True)
        row.version, row.answer_decision = 2, "PASS"
        with self.assertRaises(IntegrityError), transaction.atomic():
            row.save(force_insert=True)


class RagReviewConcurrencyTests(RagReviewFixture, TransactionTestCase):
    def parallel(self, same_user):
        second = self.user if same_user else get_user_model().objects.create_user("core:92")
        gate = Barrier(2)

        def material(_):
            self.assertFalse(connection.in_atomic_block)
            gate.wait(timeout=10)
            return deepcopy(self.material)

        self.reader.side_effect = material

        def save(user):
            close_old_connections()
            try:
                row = save_review(EvaluationRun.objects.get(pk=self.run.pk), user, **self.payload())
                return row.pk
            except RequestConflict:
                return "conflict"
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            values = list(pool.map(save, [self.user, second]))
        self.run.refresh_from_db()
        self.assertEqual(self.run.review_version, 1)
        self.assertEqual(RagCaseReview.objects.count(), 1)
        return values

    def test_different_reviewers_cannot_overwrite_same_version(self):
        self.assertEqual(self.parallel(False).count("conflict"), 1)

    def test_concurrent_retry_creates_one_record(self):
        values = self.parallel(True)
        self.assertEqual(values[0], values[1])
