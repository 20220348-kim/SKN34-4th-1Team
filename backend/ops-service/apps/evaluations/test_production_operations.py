"""여러 운영 기능의 표본 계약과 기존 근거 답변 표본의 격리를 검증한다."""

import json
from copy import deepcopy
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase, override_settings
from rest_framework.test import APIClient, APIRequestFactory, force_authenticate

from .models import ProductionQualitySample, ProductionSampleDay
from .production_quality import (
    OPERATION_SCOPES,
    SCOPE,
    ProductionQualityError,
    digest,
    ingest_sample,
    process_pending_samples,
    sample_dashboard,
    save_regression_candidate,
    save_review,
    structural_checks,
    validate_sample,
)
from .production_views import api_samples
from .test_production_quality import (
    COLLECTION,
    SETTINGS,
    candidate_payload,
    review_payload,
    sample_payload,
)


def operation_payload(scope="support-program-search", **changes):
    return sample_payload(
        schema_version=2,
        scope=scope,
        source_document_id="",
        material={
            "question": "서울의 창업 지원사업을 찾아 주세요.",
            "contexts": [
                {"id": "BIZINFO:PBLN_123", "label": "검색 후보 공고", "text": "서울 창업기업 지원"}
            ],
            "output": '{"results":[{"title":"서울 창업 지원","reason":"창업기업 대상"}]}',
            "output_status": "COMPLETED",
            "context_truncated": False,
            "output_truncated": False,
        },
        **changes,
    )


def operation_review(sample, **changes):
    return review_payload(
        sample, reference_answer="", expected_status=None, expected_citation_ids=[], **changes
    )


@override_settings(**SETTINGS)
class ProductionOperationValidationTests(SimpleTestCase):
    def test_all_four_scopes_preserve_material_and_never_infer_quality(self):
        for scope in OPERATION_SCOPES:
            with self.subTest(scope=scope):
                payload = operation_payload(scope)
                payload["material"]["output"] = "근거와 모순될 수도 있는 응답"
                clean = validate_sample(payload)
                self.assertEqual(clean["scope"], scope)
                self.assertEqual(clean["material"], payload["material"])
                self.assertEqual(clean["material_sha256"], digest(payload["material"]))
                self.assertEqual(structural_checks(clean["material"], scope), [])

    def test_versions_cannot_relabel_legacy_material_as_a_new_feature(self):
        for payload in (
            sample_payload(scope="assistant-agent"),
            operation_payload(scope=SCOPE),
            operation_payload(scope="unknown"),
            operation_payload(scope=[]),
            operation_payload(scope=None),
        ):
            with self.subTest(scope=payload["scope"]), self.assertRaises(ProductionQualityError):
                validate_sample(payload)
        self.assertEqual(validate_sample(sample_payload())["scope"], SCOPE)

    def test_redacts_all_new_text_fields_without_mutating_source(self):
        payload = operation_payload()
        private = "person@example.com 010-1234-5678 Bearer private-secret"
        material = payload["material"]
        material["question"] = private
        material["output"] = private
        material["contexts"][0].update(label=private, text=private)
        original = deepcopy(payload)
        result = validate_sample(payload)
        self.assertEqual(payload, original)
        self.assertTrue(result["redacted"])
        self.assertNotIn("person@example.com", json.dumps(result["material"]))
        self.assertNotIn("private-secret", json.dumps(result["material"]))
        self.assertEqual(result["payload_sha256"], digest(original))

    def test_rejects_unbounded_or_ambiguous_operation_material(self):
        for field, value in (
            ("question", "x" * 4001),
            ("output", "x" * 16001),
            ("output", ""),
            ("output_status", "PASS"),
            ("output_status", []),
            ("contexts", [{}]),
            ("contexts", "invalid"),
            ("context_truncated", 1),
            ("output_truncated", "false"),
            ("account_id", "private-account"),
        ):
            payload = operation_payload()
            payload["material"][field] = value
            with self.subTest(field=field), self.assertRaises(ProductionQualityError):
                validate_sample(payload)
        payload = operation_payload()
        payload["material"]["contexts"] *= 2
        with self.assertRaisesMessage(ProductionQualityError, "DUPLICATE_CONTEXT_ID"):
            validate_sample(payload)

    def test_cookie_and_signed_download_links_are_not_stored(self):
        payload = operation_payload()
        payload["material"]["output"] = (
            "Cookie: session-secret; second=another-secret\n"
            "https://example.test/file?X-Amz-Signature=signed-secret"
        )
        clean = validate_sample(payload)
        self.assertTrue(clean["redacted"])
        self.assertNotIn("session-secret", clean["material"]["output"])
        self.assertNotIn("another-secret", clean["material"]["output"])
        self.assertNotIn("signed-secret", clean["material"]["output"])

    def test_redaction_expansion_is_rejected_at_ingestion_not_in_the_worker(self):
        payload = operation_payload()
        payload["material"]["question"] = "x@y.io " * 570
        with self.assertRaisesMessage(ProductionQualityError, "INVALID_TEXT"):
            validate_sample(payload)

    def test_rejects_extra_context_fields_and_private_or_oversized_identity(self):
        for changes in (
            {"email": "person@example.com"},
            {"id": "person@example.com"},
            {"id": "x" * 129},
            {"label": "x" * 201},
            {"text": "x" * 12001},
        ):
            payload = operation_payload()
            payload["material"]["contexts"][0].update(changes)
            with self.subTest(changes=changes), self.assertRaises(ProductionQualityError):
                validate_sample(payload)

    def test_incomplete_capture_is_explicit_and_empty_results_are_valid(self):
        for scope in OPERATION_SCOPES:
            payload = operation_payload(scope)
            payload["material"].update(
                contexts=[],
                output_status="NO_RESULTS",
                context_truncated=True,
                output_truncated=True,
            )
            clean = validate_sample(payload)
            self.assertEqual(
                structural_checks(clean["material"], scope),
                ["CONTEXT_NOT_CAPTURED", "CONTEXT_TRUNCATED", "OUTPUT_TRUNCATED"],
            )

    def test_query_scope_is_passed_to_dashboard_and_ambiguous_queries_are_rejected(self):
        factory = APIRequestFactory()
        for query in ("?scope=a&scope=b", "?page=1&page=2", "?private=x"):
            request = factory.get(COLLECTION + query)
            force_authenticate(request, user=get_user_model()(username="core:1"))
            with patch("apps.evaluations.production_views.sample_dashboard") as dashboard:
                self.assertEqual(api_samples(request).status_code, 400)
                dashboard.assert_not_called()
        request = factory.get(COLLECTION + "?page=2&scope=assistant-agent")
        force_authenticate(request, user=get_user_model()(username="core:1"))
        with patch(
            "apps.evaluations.production_views.sample_dashboard", return_value={}
        ) as dashboard:
            self.assertEqual(api_samples(request).status_code, 200)
            dashboard.assert_called_once_with(2, "assistant-agent")
        with self.assertRaisesMessage(ProductionQualityError, "INVALID_SAMPLE_SCOPE"):
            sample_dashboard(1, "unknown")


@override_settings(**SETTINGS)
class ProductionOperationStorageTests(TestCase):
    """CI의 MySQL 8.4에서 실제 저장·필터·검토 및 구 버전 공존을 확인한다."""

    def setUp(self):
        self.user = get_user_model().objects.create_user("core:operation-reviewer")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_old_and_new_scopes_share_quota_but_filter_statistics_and_reviews(self):
        ingest_sample(sample_payload())
        samples = {}
        for scope in sorted(OPERATION_SCOPES):
            payload = operation_payload(scope)
            sample, created = ingest_sample(payload)
            self.assertTrue(created)
            self.assertFalse(ingest_sample(payload)[1])
            samples[scope] = sample
        self.assertEqual(ProductionSampleDay.objects.get().accepted, 5)
        self.assertEqual(process_pending_samples(), 5)
        for scope, sample in samples.items():
            sample.refresh_from_db()
            save_review(sample.pk, self.user, operation_review(sample))
            response = self.client.get(COLLECTION, {"scope": scope})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.data["scope"], scope)
            self.assertEqual(response.data["summary"]["stored"], 1)
            self.assertEqual(response.data["summary"]["reviewed"], 1)
            self.assertEqual(response.data["days"][0]["acceptable"], 1)
            row = response.data["results"][0]
            self.assertEqual(row["scope"], scope)
            self.assertFalse(row["regression_supported"])
            self.assertEqual(len(row["review_criteria"]), 3)
            detail = self.client.get(f"{COLLECTION}/{sample.pk}").data
            self.assertEqual(detail["material"], sample.material)
            self.assertEqual(detail["review"]["verdict"], "acceptable")
        self.assertEqual(sample_dashboard(1)["summary"]["stored"], 5)
        self.assertEqual(sample_dashboard(1, SCOPE)["summary"]["reviewed"], 0)

    def test_partial_material_cannot_be_marked_acceptable_but_can_be_reviewed(self):
        payload = operation_payload()
        payload["material"]["output_truncated"] = True
        sample, _ = ingest_sample(payload)
        process_pending_samples()
        sample.refresh_from_db()
        with self.assertRaisesMessage(ProductionQualityError, "STRUCTURAL_ISSUES_REQUIRE_REVIEW"):
            save_review(sample.pk, self.user, operation_review(sample))
        save_review(sample.pk, self.user, operation_review(sample, complete="unknown"))
        self.assertEqual(sample.reviews.get().verdict, "unassessable")

    def test_new_feature_cannot_enter_evidence_regression_contract(self):
        sample, _ = ingest_sample(operation_payload())
        process_pending_samples()
        sample.refresh_from_db()
        with self.assertRaisesMessage(ProductionQualityError, "REGRESSION_SCOPE_UNSUPPORTED"):
            save_review(sample.pk, self.user, review_payload(sample))
        sample = save_review(sample.pk, self.user, operation_review(sample))
        with self.assertRaisesMessage(ProductionQualityError, "REGRESSION_SCOPE_UNSUPPORTED"):
            save_regression_candidate(sample.pk, self.user, candidate_payload(sample))

    def test_same_id_cannot_be_reused_for_another_feature_or_silently_overwrite_review(self):
        payload = operation_payload()
        sample, _ = ingest_sample(payload)
        with self.assertRaisesMessage(ProductionQualityError, "SAMPLE_REQUEST_CONFLICT"):
            ingest_sample({**payload, "scope": "assistant-agent"})
        process_pending_samples()
        sample.refresh_from_db()
        review = operation_review(sample)
        save_review(sample.pk, self.user, review)
        save_review(sample.pk, self.user, review)
        self.assertEqual(sample.reviews.count(), 1)
        self.assertEqual(ProductionQualitySample.objects.count(), 1)
        self.assertEqual(self.client.get(COLLECTION, {"scope": "unknown"}).status_code, 400)
