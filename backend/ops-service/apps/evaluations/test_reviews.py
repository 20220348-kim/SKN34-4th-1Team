import json
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from uuid import uuid4

from django.conf import settings
from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from .catalog import DATASETS, LIVE_CAPTURE_ID, live_config
from .models import EvaluationBaseline, EvaluationReview, EvaluationRun
from .reviews import review_material
from .services import ResultsUnavailable, read_result


class ReviewTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user("reviewer", email="reviewer@example.com")
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        override = override_settings(LLMOPS_RESULTS_DIR=self.root)
        override.enable()
        self.addCleanup(override.disable)
        self.dataset = "fixed-context-e01-v1"
        self.capture_id = "fixed-context-20260907-index-v1"
        self.run = self.completed_run()
        self.url = f"/api/v1/ops/evaluations/{self.run.id}"

    def completed_run(self):
        dataset = DATASETS[self.dataset]
        source = next(item for item in dataset["captures"] if item["id"] == self.capture_id)
        reference_raw = (settings.LLMOPS_EVIDENCE_DIR / source["path"]).read_bytes()
        reference_hash = sha256(reference_raw).hexdigest()
        capture = json.loads(reference_raw)
        capture.update(
            caseIds=["E01"],
            cases=capture["cases"][:1],
            model=live_config(self.dataset)["model"],
            modelApiCalls=1,
            maxModelCalls=1,
            maxOutputTokens=2000,
        )
        run = EvaluationRun.objects.create(
            requested_by=self.user,
            dataset_id=self.dataset,
            candidate_capture_id=LIVE_CAPTURE_ID,
            reference_capture_id=self.capture_id,
            status="COMPLETED",
            prefect_flow_run_id=uuid4(),
            execution_mode="live",
            live_config=live_config(self.dataset),
        )
        folder = self.root / str(run.id)
        (folder / "capture").mkdir(parents=True)
        (folder / "evaluation").mkdir()
        raw = json.dumps(capture).encode()
        (folder / "capture/capture.json").write_bytes(raw)
        capture_hash = sha256(raw).hexdigest()
        (folder / "request.json").write_text(
            json.dumps(
                {
                    "request_id": str(run.id),
                    "dataset_id": run.dataset_id,
                    "candidate_capture_id": run.candidate_capture_id,
                    "reference_capture_id": run.reference_capture_id,
                    "prefect_flow_run_id": str(run.prefect_flow_run_id),
                    "execution_mode": run.execution_mode,
                    "live_config": run.live_config,
                }
            )
        )
        # 실제 비교 JSON은 지표만 담으며 답변은 별도 capture.json에만 있다.
        summary = {"completed": True, "caseCount": 1, "observedCaseCount": 1}
        comparison = {
            "schema_version": 2,
            "evaluation_run_id": "a" * 32,
            "reference_run_id": "b" * 32,
            "fixture_sha256": dataset["fixture_sha256"],
            "case_ids": ["E01"],
            "current": summary,
            "reference": summary,
            "candidate_execution": {
                "run_id": "a" * 32,
                "capture_sha256": capture_hash,
                "model": capture["model"],
            },
            "reference_execution": {"run_id": "b" * 32, "capture_sha256": reference_hash},
        }
        raw_comparison = json.dumps(comparison).encode()
        (folder / "evaluation/comparison.json").write_bytes(raw_comparison)
        (folder / "evaluation/report.html").write_bytes(b"<html>test report</html>")
        (folder / "evaluation/manifest.json").write_text(
            json.dumps(
                {
                    "status": "completed",
                    "evaluation_run_id": "a" * 32,
                    "reference_run_id": "b" * 32,
                    "model_api_calls": 0,
                    "fixture_sha256": dataset["fixture_sha256"],
                    "capture_sha256": capture_hash,
                    "reference_capture_sha256": reference_hash,
                    "artifact_sha256": {
                        "comparison.json": sha256(raw_comparison).hexdigest(),
                        "report.html": sha256(b"<html>test report</html>").hexdigest(),
                    },
                }
            )
        )
        return run

    def review(self, decision="APPROVED", url=None):
        return self.client.post(
            (url or self.url) + "/review",
            {
                "decision": decision,
                "comment": "근거·지역·법인 조건 확인 <script>실행 금지</script>",
                "capture_sha256": review_material(self.run)["capture_sha256"],
            },
            format="json",
        )

    def promote(self):
        review = self.review().json()["reviews"][0]
        response = self.client.post(
            self.url + "/baseline", {"review_id": review["id"]}, format="json"
        )
        self.assertEqual(response.status_code, 200)
        return review

    def test_material_review_history_and_baseline_are_separate(self):
        data = self.client.get(self.url + "/review").json()
        self.assertEqual([item["case_id"] for item in data["material"]["cases"]], ["E01"])
        self.assertEqual(len(data["material"]["cases"][0]["evidence"]), 3)
        self.assertEqual(data["material"]["cases"][0]["cited_orders"], [0])
        self.assertEqual(data["reviews"], [])
        self.assertEqual(
            self.client.post(self.url + "/baseline", {"review_id": 1}, format="json").status_code,
            409,
        )
        first = self.review().json()["reviews"][0]
        self.assertFalse(EvaluationBaseline.objects.exists())
        self.assertEqual(self.review().json()["reviews"][0]["id"], first["id"])
        self.promote()
        session = self.client.get("/api/v1/ops/session").json()
        selected = next(item for item in session["datasets"] if item["id"] == self.dataset)
        self.assertEqual(selected["baseline"]["id"], f"run:{self.run.id}")
        response = self.review("CHANGES_REQUESTED")
        self.assertFalse(response.json()["is_baseline"])
        self.assertEqual(len(response.json()["reviews"]), 2)
        self.assertEqual(
            self.client.post(
                self.url + "/baseline", {"review_id": first["id"]}, format="json"
            ).status_code,
            409,
        )
        self.assertEqual(EvaluationReview.objects.count(), 2)

    @patch("apps.evaluations.prefect_client.create_run")
    def test_reference_is_pinned_and_retry_survives_baseline_revocation(self, create):
        create.return_value = uuid4()
        self.promote()
        payload = {
            "request_id": str(uuid4()),
            "dataset_id": self.dataset,
            "candidate_capture_id": self.capture_id,
            "reference_capture_id": f"run:{self.run.id}",
        }
        response = self.client.post("/api/v1/ops/evaluations", payload, format="json")
        self.assertEqual(response.status_code, 202)
        accepted = EvaluationRun.objects.get(pk=payload["request_id"])
        self.assertEqual(accepted.reference_config["run_id"], str(self.run.id))
        self.assertEqual(
            accepted.reference_config["capture_sha256"], review_material(self.run)["capture_sha256"]
        )
        self.review("CHANGES_REQUESTED")
        self.assertEqual(
            self.client.post("/api/v1/ops/evaluations", payload, format="json").status_code, 200
        )
        self.assertEqual(create.call_count, 1)
        payload["request_id"] = str(uuid4())
        self.assertEqual(
            self.client.post("/api/v1/ops/evaluations", payload, format="json").status_code, 400
        )

    def test_invalid_or_incomplete_material_cannot_be_reviewed_or_promoted(self):
        material = review_material(self.run)
        self.assertEqual(
            self.client.post(
                self.url + "/review",
                {
                    "decision": "APPROVED",
                    "comment": "검토",
                    "capture_sha256": "0" * 64,
                },
                format="json",
            ).status_code,
            409,
        )
        self.assertEqual(
            self.client.post(
                self.url + "/review",
                {
                    "decision": "APPROVED",
                    "comment": " ",
                    "capture_sha256": material["capture_sha256"],
                },
                format="json",
            ).status_code,
            400,
        )
        review = self.promote()
        capture = self.root / str(self.run.id) / "capture/capture.json"
        capture.write_text(capture.read_text() + " ")
        self.assertIsNone(self.client.get(self.url + "/review").json()["material"])
        self.assertEqual(
            self.client.post(
                self.url + "/baseline", {"review_id": review["id"]}, format="json"
            ).status_code,
            503,
        )
        self.run.status = "FAILED"
        self.run.save()
        with self.assertRaises(ResultsUnavailable):
            review_material(self.run)

    @patch("apps.evaluations.prefect_client.create_run")
    def test_cross_dataset_and_unapproved_references_do_not_dispatch(self, create):
        payload = {
            "request_id": str(uuid4()),
            "dataset_id": self.dataset,
            "candidate_capture_id": self.capture_id,
            "reference_capture_id": f"run:{self.run.id}",
        }
        self.assertEqual(
            self.client.post("/api/v1/ops/evaluations", payload, format="json").status_code, 400
        )
        self.promote()
        payload.update(
            dataset_id="target-coverage-20260907-v1",
            candidate_capture_id="target-coverage-20260907-v1",
        )
        self.assertEqual(
            self.client.post("/api/v1/ops/evaluations", payload, format="json").status_code, 400
        )
        create.assert_not_called()

    def test_pinned_reference_must_match_result_and_request_marker(self):
        self.run.reference_capture_id = f"run:{uuid4()}"
        self.run.reference_config = {
            "run_id": self.run.reference_capture_id[4:],
            "capture_sha256": "e" * 64,
            "fixture_sha256": DATASETS[self.dataset]["fixture_sha256"],
        }
        marker = self.root / str(self.run.id) / "request.json"
        data = json.loads(marker.read_text())
        data.update(
            reference_capture_id=self.run.reference_capture_id,
            reference_config=self.run.reference_config,
        )
        marker.write_text(json.dumps(data))
        with self.assertRaises(ResultsUnavailable):
            read_result(self.run)

    def test_review_reads_pinned_reference_snapshot_and_rejects_its_tampering(self):
        source = DATASETS[self.dataset]["captures"][1]
        raw = (settings.LLMOPS_EVIDENCE_DIR / source["path"]).read_bytes()
        self.run.reference_capture_id = f"run:{uuid4()}"
        self.run.reference_config = {
            "run_id": self.run.reference_capture_id[4:],
            "capture_sha256": sha256(raw).hexdigest(),
            "fixture_sha256": DATASETS[self.dataset]["fixture_sha256"],
        }
        folder = self.root / str(self.run.id)
        marker = json.loads((folder / "request.json").read_text())
        marker.update(
            reference_capture_id=self.run.reference_capture_id,
            reference_config=self.run.reference_config,
        )
        (folder / "request.json").write_text(json.dumps(marker))
        snapshot = folder / "reference-capture.json"
        snapshot.write_bytes(raw)
        self.assertEqual(
            review_material(self.run)["cases"][0]["reference_answer"],
            json.loads(raw)["cases"][0]["response"]["answer"],
        )
        snapshot.write_bytes(raw + b" ")
        with self.assertRaises(ResultsUnavailable):
            review_material(self.run)

    def test_admin_and_csrf_required_for_reviews_and_baselines(self):
        client = APIClient(enforce_csrf_checks=True)
        self.assertEqual(client.get(self.url + "/review").status_code, 401)
        with patch(
            "apps.evaluations.authentication.read_core_admin",
            return_value={
                "accountId": 99,
                "email": "admin@example.com",
                "role": "ADMIN",
            },
        ):
            client.cookies["govbiz_session"] = "test-session"
            self.assertEqual(client.post(self.url + "/review", {}, format="json").status_code, 403)
            self.assertEqual(
                client.post(self.url + "/baseline", {}, format="json").status_code, 403
            )
