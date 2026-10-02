"""RAG 재계산 접수의 실제 DB·UUID·권한 경계를 확인한다."""

from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase, override_settings
from rest_framework.test import APIClient

from .catalog import public_datasets, validate_execution
from .execution_spec import make_spec, read_release
from .models import EvaluationBudgetReservation, EvaluationRun
from .prefect_client import PrefectUnavailable

DATASET = "rag-synthetic-multichunk-v1"
CAPTURE = "rag-synthetic-capture-v1"


class RagProfileTests(SimpleTestCase):
    def test_only_free_replay_profile_is_advertised_and_live_is_rejected(self):
        item = next(item for item in public_datasets() if item["id"] == DATASET)
        self.assertIsNone(item["live_config"])
        self.assertIsNone(item["execution_profiles"]["live"])
        spec = make_spec(read_release(), DATASET, "replay", {}, CAPTURE, CAPTURE)
        self.assertEqual(spec["evaluation_scope"], "source-chunks-retrieval-answer")
        self.assertEqual(spec["model_operations"], [])
        self.assertFalse(spec["quality_policy"]["definition"]["baseline_eligible"])
        self.assertIn(
            "evaluation/support-program-evidence/rag_evaluate.py", spec["evaluation"]["files"]
        )
        for mode, candidate, reference, config in (
            ("live", "new-model-response", CAPTURE, {}),
            ("replay", CAPTURE, "run:" + str(uuid4()), {}),
            ("replay", CAPTURE, CAPTURE, {"model": "not-approved"}),
        ):
            with self.subTest(mode=mode, reference=reference), self.assertRaises(ValueError):
                validate_execution(DATASET, candidate, reference, mode, config)


class RagSubmissionTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user("core:rag-operator")
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        item = next(item for item in public_datasets() if item["id"] == DATASET)
        self.payload = {
            "request_id": str(uuid4()),
            "dataset_id": DATASET,
            "candidate_capture_id": CAPTURE,
            "reference_capture_id": CAPTURE,
            "execution_profile": item["execution_profiles"]["replay"],
        }

    def post(self, payload=None):
        return self.client.post("/api/v1/ops/evaluations", payload or self.payload, format="json")

    @patch("apps.evaluations.prefect_client.create_run", return_value=uuid4())
    def test_replay_reuses_request_and_flow_without_a_paid_reservation(self, create):
        first, replay = self.post(), self.post()
        self.assertEqual((first.status_code, replay.status_code), (202, 200))
        self.assertEqual(first.data["prefect_flow_run_id"], replay.data["prefect_flow_run_id"])
        self.assertEqual(first.data["evaluation_scope"], "source-chunks-retrieval-answer")
        self.assertEqual(first.data["model_api_calls"], 0)
        self.assertEqual(EvaluationRun.objects.count(), 1)
        self.assertFalse(EvaluationBudgetReservation.objects.exists())
        create.assert_called_once()

    @patch(
        "apps.evaluations.prefect_client.create_run", side_effect=[PrefectUnavailable(), uuid4()]
    )
    def test_dispatch_loss_retries_original_spec_with_same_uuid(self, create):
        self.assertEqual(self.post().status_code, 503)
        original = EvaluationRun.objects.get(pk=self.payload["request_id"]).execution_spec
        with patch(
            "apps.evaluations.services.read_release", side_effect=AssertionError("repinned")
        ):
            self.assertEqual(self.post().status_code, 200)
        self.assertEqual(
            EvaluationRun.objects.get(pk=self.payload["request_id"]).execution_spec, original
        )
        self.assertEqual(create.call_count, 2)

    @override_settings(LLMOPS_LIVE_ENABLED=True)
    @patch("apps.evaluations.prefect_client.create_run")
    def test_forged_live_cross_scope_and_stale_profile_are_rejected(self, create):
        for changes in (
            {
                "execution_mode": "live",
                "candidate_capture_id": "new-model-response",
                "confirm_paid_run": True,
            },
            {"reference_capture_id": "target-coverage-20260907-v1"},
            {"execution_profile": "0" * 64},
        ):
            with self.subTest(changes=changes):
                self.assertEqual(self.post({**self.payload, **changes}).status_code, 400)
        self.assertFalse(EvaluationRun.objects.exists())
        self.assertFalse(EvaluationBudgetReservation.objects.exists())
        create.assert_not_called()
