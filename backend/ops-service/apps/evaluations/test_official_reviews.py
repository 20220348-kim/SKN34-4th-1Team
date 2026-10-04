import json
from hashlib import sha256
from types import SimpleNamespace
from unittest.mock import patch

from django.conf import settings
from django.test import SimpleTestCase, TestCase

from .catalog import DATASETS, public_datasets
from .models import EvaluationBaseline
from .reviews import review_material
from .services import ResultsUnavailable
from .test_reviews import ReviewFixture

DATASET = "official-answer-20260907-v2"


class OfficialMaterialTests(SimpleTestCase):
    def test_registered_history_preserves_source_and_original_citation_ids(self):
        dataset = DATASETS[DATASET]
        raw = (settings.LLMOPS_EVIDENCE_DIR / dataset["captures"][0]["path"]).read_bytes()
        capture = json.loads(raw)
        comparison = {
            "scope": "fixed-answer-context-only",
            "reference_execution": {"capture_sha256": sha256(raw).hexdigest()},
        }
        run = SimpleNamespace(
            dataset_id=DATASET,
            candidate_capture_id=DATASET,
            reference_capture_id=DATASET,
            reference_config={},
            execution_mode="replay",
        )
        with patch(
            "apps.evaluations.reviews.read_candidate",
            return_value=(capture, sha256(raw).hexdigest(), comparison),
        ):
            material = review_material(run)
            self.assertEqual(material["data_type"], "official-html-snapshot")
            self.assertEqual(material["candidate_origin"], "historical-answer-projection")
            self.assertEqual(material["recorded_model"], "gpt-5.6-luna")
            self.assertEqual(len(material["cases"]), 6)
            self.assertEqual(material["cases"][0]["cited_orders"], [0])
            self.assertEqual(material["cases"][1]["cited_orders"], [])
            self.assertTrue(
                material["cases"][0]["source"]["url"].startswith("https://www.bizinfo.go.kr/")
            )
            with patch("apps.evaluations.reviews.read_evidence", return_value=b"{}"):
                with self.assertRaises(ResultsUnavailable):
                    review_material(run)

    def test_registry_exposes_free_replay_with_separate_live_profile(self):
        item = next(row for row in public_datasets() if row["id"] == DATASET)
        self.assertEqual(item["case_ids"], [f"H0{i}" for i in range(1, 7)])
        self.assertNotEqual(
            item["execution_profiles"]["replay"], item["execution_profiles"]["live"]
        )


class OfficialReviewGateTests(ReviewFixture, TestCase):
    """MySQL CI에서 실제 새 데이터셋의 조회·미검토 승인 차단을 확인한다."""

    def completed_run(self):
        self.dataset = self.capture_id = DATASET
        run = super().completed_run()
        # Reuse only the test artifact builder, then restore the exact historical bytes.
        source = DATASETS[DATASET]["captures"][0]["path"]
        raw = (settings.LLMOPS_EVIDENCE_DIR / source).read_bytes()
        capture_hash = sha256(raw).hexdigest()
        folder = self.root / str(run.id)
        run.execution_mode = "replay"
        run.live_config = {}
        run.candidate_capture_id = DATASET
        run.save()
        (folder / "capture/capture.json").write_bytes(raw)
        request_path = folder / "request.json"
        request = json.loads(request_path.read_bytes())
        request.update(execution_mode="replay", live_config={}, candidate_capture_id=DATASET)
        request_path.write_text(json.dumps(request))
        comparison_path = folder / "evaluation/comparison.json"
        comparison = json.loads(comparison_path.read_bytes())
        comparison["candidate_execution"].update(capture_sha256=capture_hash, model="gpt-5.6-luna")
        comparison_raw = json.dumps(comparison).encode()
        comparison_path.write_bytes(comparison_raw)
        manifest_path = folder / "evaluation/manifest.json"
        manifest = json.loads(manifest_path.read_bytes())
        manifest["capture_sha256"] = capture_hash
        manifest["artifact_sha256"]["comparison.json"] = sha256(comparison_raw).hexdigest()
        manifest_path.write_text(json.dumps(manifest))
        # Legacy replay requests without a specification are only allowed for the first dataset.
        from .execution_spec import digest, make_spec, read_release

        run.execution_spec = make_spec(read_release(), DATASET, "replay", {}, DATASET, DATASET)
        run.execution_spec_sha256 = digest(run.execution_spec)
        run.save()
        manifest.update(
            scope="fixed-answer-context-only",
            execution_spec_sha256=run.execution_spec_sha256,
            evaluator_version=run.execution_spec["evaluation"]["version"],
        )
        manifest_path.write_text(json.dumps(manifest))
        request["execution_spec"] = run.execution_spec
        request["execution_spec_sha256"] = run.execution_spec_sha256
        request_path.write_text(json.dumps(request))
        return run

    def test_unreviewed_official_history_cannot_pass_or_become_baseline(self):
        response = self.client.get(self.url + "/review")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["material_error"], "")
        self.assertEqual(data["material"]["candidate_origin"], "historical-answer-projection")
        self.assertFalse(data["can_approve"])
        self.assertFalse(data["can_promote"])
        result = self.client.post(
            self.url + "/quality", {"input_sha256": data["quality"]["input_sha256"]}, format="json"
        )
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()["quality"]["status"], "NEEDS_REVIEW")
        approval = self.client.post(
            self.url + "/review",
            {
                "decision": "APPROVED",
                "comment": "미검토 자동 승인은 거절되어야 한다",
                "capture_sha256": data["material"]["capture_sha256"],
                "fixture_sha256": data["material"]["fixture_sha256"],
                "rubric_version": data["rubric"]["version"],
                "review_version": data["review_version"],
            },
            format="json",
        )
        self.assertEqual(approval.status_code, 409)
        self.assertFalse(
            EvaluationBaseline.objects.filter(dataset_id=DATASET, review__isnull=False).exists()
        )
