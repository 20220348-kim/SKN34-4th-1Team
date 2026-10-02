"""모델 호출 없는 격리 DB에서 RAG 합격 → 기준 → 재평가 → 철회를 검증한다."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from threading import Barrier
from unittest.mock import patch
from uuid import uuid4

from django.db import IntegrityError, close_old_connections, transaction
from django.test import TestCase, TransactionTestCase
from rest_framework.test import APIClient

from . import rag_quality_policy
from .catalog import public_datasets, validate_reference_config
from .models import EvaluationBaseline, EvaluationBaselineChange, EvaluationBudgetReservation
from .rag_baselines import baseline_choices, select_baseline
from .rag_reference_reviews import save_reference_review
from .services import RequestConflict, submit_run
from .test_rag_reference_reviews import ReferenceFixture


class BaselineFixture(ReferenceFixture):
    def qualify(self, kind="recorded-capture-replay"):
        # 검증된 자료 reader의 테스트 대역이다. 등록 캡처·실제 평가 이력은 바꾸지 않는다.
        self.material["candidate_measurement_kind"] = kind
        self.assertEqual(self.reference_post().status_code, 200)
        for version, case in enumerate(self.material["cases"], 1):
            self.assertEqual(
                self.post(
                    case_id=case["case_id"],
                    review_version=version,
                    answer_decision="SUITABLE",
                    citation_decision="SUITABLE",
                ).status_code,
                200,
            )
        return self.assess().json()["quality"]

    def baseline_payload(self):
        state = self.state()
        return {
            "assessment_id": state["quality"]["current_id"],
            "input_sha256": state["quality"]["input_sha256"],
            "baseline_version": state["baseline"]["version"],
            "reason": "검토 완료한 실제 기록을 비교 기준으로 지정",
        }

    def promote(self, payload=None):
        return self.client.post(
            self.url.replace("rag-reviews", "rag-baseline"),
            payload or self.baseline_payload(),
            format="json",
        )

    def submit(self, request_id=None):
        return submit_run(
            self.user,
            request_id or uuid4(),
            self.run.dataset_id,
            self.run.candidate_capture_id,
            f"run:{self.run.pk}",
            baseline_version=1,
            execution_profile=next(
                row for row in public_datasets() if row["id"] == self.run.dataset_id
            )["execution_profiles"]["replay"],
        )


class RagBaselineTests(BaselineFixture, TestCase):
    def test_pass_is_explicit_and_baseline_pins_assessment_for_next_submission(self):
        quality = self.qualify()
        self.assertEqual(quality["status"], "PASS")
        self.assertTrue(quality["baseline_eligible"])
        self.assertFalse(EvaluationBaseline.objects.exists())
        payload = self.baseline_payload()
        response = self.promote(payload)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["baseline"]["selected"])
        self.assertIn("no-store", response["Cache-Control"])
        self.assertEqual(self.promote(payload).status_code, 200)
        self.assertEqual(EvaluationBaselineChange.objects.count(), 1)
        choice = baseline_choices()[self.run.dataset_id]
        self.assertEqual((choice["id"], choice["version"]), (f"run:{self.run.pk}", 1))
        session = self.client.get("/api/v1/ops/session").json()
        self.assertEqual(
            next(row for row in session["datasets"] if row["id"] == self.run.dataset_id)[
                "baseline"
            ],
            choice,
        )
        with patch("apps.evaluations.services.dispatch_run", side_effect=lambda run: run):
            run, created = self.submit()
        self.assertTrue(created)
        self.assertIsNone(run.baseline_review_id)
        self.assertEqual(run.reference_config["assessment_id"], quality["current_id"])
        self.assertEqual(run.reference_config["assessment_input_sha256"], quality["input_sha256"])
        self.assertEqual(run.execution_spec["reference_config"], run.reference_config)
        self.assertEqual(
            run.execution_spec["reference_sha256"], self.material["candidate_capture_sha256"]
        )
        validate_reference_config(run.dataset_id, run.reference_capture_id, run.reference_config)
        self.assertFalse(EvaluationBudgetReservation.objects.exists())
        self.assertFalse(response.json()["material"]["baseline_eligible"])
        self.assertEqual(
            response.json()["material"]["reference_source"], "ai-authored-not-human-reviewed"
        )

    def test_synthetic_and_stub_cannot_be_promoted_even_with_all_reviews(self):
        self.qualify("synthetic-contract-check")
        self.assertEqual(self.promote().status_code, 409)
        self.material["candidate_measurement_kind"] = "integration-stub-replay"
        self.assertEqual(self.assess().json()["quality"]["status"], "NEEDS_REVIEW")
        self.assertEqual(self.promote().status_code, 409)
        self.assertFalse(EvaluationBaseline.objects.filter(rag_assessment__isnull=False).exists())

    def test_revocation_invalidates_baseline_but_keeps_same_request_retry(self):
        self.qualify()
        payload = self.baseline_payload()
        self.promote(payload)
        with patch("apps.evaluations.services.dispatch_run", side_effect=lambda run: run):
            run, _ = self.submit()
            pinned = deepcopy(run.execution_spec)
            response = self.reference_post(
                decision="REVOKED",
                review_version=self.state()["review_version"],
                comment="참조 오류 발견",
            )
            self.assertEqual(response.status_code, 200)
            self.assertFalse(response.json()["baseline"]["selected"])
            self.assertEqual(response.json()["baseline"]["version"], 2)
            self.assertEqual(baseline_choices(), {})
            with self.assertRaises(ValueError):
                self.submit()
            retry, created = self.submit(run.pk)
            self.assertFalse(created)
            self.assertEqual(retry.execution_spec, pinned)
        self.assertEqual(self.promote(payload).status_code, 200)
        self.assertIsNone(EvaluationBaseline.objects.get().rag_assessment_id)
        self.assertEqual(EvaluationBaselineChange.objects.count(), 2)
        self.assertEqual(self.assess().json()["quality"]["status"], "NEEDS_REVIEW")

    def test_case_change_invalidates_and_history_failure_rolls_back_review(self):
        self.qualify()
        self.promote()
        version = self.state()["review_version"]
        with patch(
            "apps.evaluations.baselines.EvaluationBaselineChange.objects.create",
            side_effect=IntegrityError,
        ):
            with self.assertRaises(IntegrityError):
                self.post(review_version=version)
        self.assertEqual(self.state()["review_version"], version)
        self.assertTrue(self.state()["baseline"]["selected"])
        response = self.post(review_version=version)
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["baseline"]["selected"])
        self.assertEqual(self.assess().json()["quality"]["status"], "FAIL")
        self.assertEqual(self.promote().status_code, 409)

    def test_changed_policy_hides_and_rejects_stale_baseline_and_allows_clear(self):
        self.qualify()
        self.promote()
        with patch.dict(rag_quality_policy.POLICY, {"version": "next-policy"}):
            self.assertFalse(self.state()["baseline"]["selected"])
            self.assertEqual(baseline_choices(), {})
            with self.assertRaises(RequestConflict):
                self.submit()
            data = {"baseline_version": 1, "reason": "정책 변경으로 기준 해제"}
            url = self.url.replace("rag-reviews", "rag-baseline")
            self.assertEqual(self.client.delete(url, data, format="json").status_code, 200)
            self.assertEqual(self.client.delete(url, data, format="json").status_code, 200)
        self.assertEqual(EvaluationBaselineChange.objects.count(), 2)

    def test_stale_material_actor_version_and_missing_reason_cannot_promote(self):
        self.qualify()
        payload = self.baseline_payload()
        for changes, status in (
            ({"input_sha256": "0" * 64}, 409),
            ({"assessment_id": 99999}, 409),
            ({"baseline_version": 1}, 409),
            ({"reason": " "}, 400),
        ):
            self.assertEqual(self.promote({**payload, **changes}).status_code, status)
        self.material["material_sha256"] = "e" * 64
        self.assertEqual(self.promote(payload).status_code, 409)
        self.assertFalse(EvaluationBaselineChange.objects.exists())

    def test_admin_authentication_and_csrf_are_required(self):
        self.qualify()
        client = APIClient(enforce_csrf_checks=True)
        url = self.url.replace("rag-reviews", "rag-baseline")
        payload = self.baseline_payload()
        self.assertEqual(client.post(url, payload, format="json").status_code, 401)
        client.cookies["govbiz_session"] = "core-admin-test"
        with patch(
            "apps.evaluations.authentication.read_core_admin",
            return_value={
                "accountId": 91,
                "email": self.user.email,
                "role": "ADMIN",
            },
        ):
            self.assertEqual(client.post(url, payload, format="json").status_code, 403)
            token = client.get("/api/v1/ops/session").json()["csrf_token"]
            self.assertEqual(
                client.post(url, payload, format="json", HTTP_X_CSRFTOKEN=token).status_code, 200
            )

    def test_database_disallows_mixing_fixed_and_rag_baseline_approvals(self):
        from .models import EvaluationReview

        self.qualify()
        self.promote()
        review = EvaluationReview.objects.create(
            run=self.run,
            reviewed_by=self.user,
            decision="APPROVED",
            version=1,
        )
        with self.assertRaises(IntegrityError), transaction.atomic():
            EvaluationBaseline.objects.filter(pk=self.run.dataset_id).update(review=review)


class RagBaselineConcurrencyTests(BaselineFixture, TransactionTestCase):
    def parallel(self, revoke):
        self.qualify()
        payload = self.baseline_payload()
        version = self.state()["review_version"]
        gate = Barrier(2)

        def material(_):
            gate.wait(timeout=10)
            return deepcopy(self.material)

        self.reader.side_effect = self.reference_reader.side_effect = material

        def save(action):
            close_old_connections()
            try:
                if action == "revoke":
                    save_reference_review(
                        self.run,
                        self.user,
                        **self.reference_payload(
                            decision="REVOKED",
                            review_version=version,
                        ),
                    )
                else:
                    select_baseline(self.run, self.user, **payload)
                return "saved"
            except RequestConflict:
                return "conflict"
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(save, ["select", "revoke" if revoke else "select"]))
        self.reader.side_effect = self.reference_reader.side_effect = lambda _: deepcopy(
            self.material
        )
        return results

    def test_duplicate_concurrent_promotion_is_idempotent(self):
        self.assertEqual(self.parallel(False), ["saved", "saved"])
        self.assertEqual(EvaluationBaselineChange.objects.count(), 1)
        self.assertTrue(self.state()["baseline"]["selected"])

    def test_revocation_racing_promotion_never_leaves_usable_baseline(self):
        self.parallel(True)
        self.assertEqual(baseline_choices(), {})
        self.assertFalse(EvaluationBaseline.objects.filter(rag_assessment__isnull=False).exists())
