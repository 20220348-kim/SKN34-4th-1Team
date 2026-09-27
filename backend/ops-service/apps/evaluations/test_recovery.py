import json
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Barrier
from unittest.mock import patch
from uuid import uuid4

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import close_old_connections
from django.test import Client, TestCase, TransactionTestCase, override_settings
from rest_framework.test import APIClient

from . import prefect_client
from .catalog import DATASETS, LEGACY_DATASET_ID, live_config
from .models import EvaluationRun
from .recovery import submit_recovery
from .services import RequestConflict


class RecoveryFixture:
    def setUp(self):
        self.user = get_user_model().objects.create_user("core:1", email="reviewer@example.com")
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        override = override_settings(LLMOPS_RESULTS_DIR=self.root)
        override.enable()
        self.addCleanup(override.disable)
        self.source = EvaluationRun.objects.create(
            requested_by=self.user,
            dataset_id=LEGACY_DATASET_ID,
            status="FAILED",
            error_code="EVALUATION_FAILED",
            prefect_flow_run_id=uuid4(),
        )
        dataset = DATASETS[LEGACY_DATASET_ID]
        raw = (settings.LLMOPS_EVIDENCE_DIR / dataset["captures"][0]["path"]).read_bytes()
        self.capture = json.loads(raw)
        self.folder = self.root / str(self.source.pk)
        (self.folder / "evaluation").mkdir(parents=True)
        self.marker = {
            "request_id": str(self.source.pk),
            "dataset_id": LEGACY_DATASET_ID,
            "prefect_flow_run_id": str(self.source.prefect_flow_run_id),
            "candidate_capture_id": LEGACY_DATASET_ID,
            "reference_capture_id": LEGACY_DATASET_ID,
            "execution_mode": "replay",
            "live_config": {},
        }
        self.manifest = {
            "status": "failed",
            "stage": "publish",
            "model_api_calls": 0,
            "fixture_sha256": dataset["fixture_sha256"],
            "capture_sha256": sha256(raw).hexdigest(),
            "reference_capture_sha256": sha256(raw).hexdigest(),
        }
        self.write_inputs()
        self.url = f"/api/v1/ops/evaluations/{self.source.pk}/recover"
        create = patch("apps.evaluations.prefect_client.create_run", return_value=uuid4())
        self.create = create.start()
        self.addCleanup(create.stop)
        read = patch(
            "apps.evaluations.prefect_client.read_run",
            side_effect=lambda identifier: {
                "id": str(identifier),
                "state_type": "FAILED"
                if identifier == self.source.prefect_flow_run_id
                else "RUNNING",
            },
        )
        self.read = read.start()
        self.addCleanup(read.stop)

    def write_inputs(self):
        (self.folder / "request.json").write_text(json.dumps(self.marker))
        (self.folder / "evaluation/manifest.json").write_text(json.dumps(self.manifest))

    def post(self, request_id=None):
        return self.client.post(self.url, {"request_id": str(request_id or uuid4())}, format="json")


class RecoveryTests(RecoveryFixture, TestCase):
    def test_completed_recovery_uses_own_verified_artifacts_and_can_be_reviewed(self):
        child = EvaluationRun.objects.get(pk=self.post().json()["id"])
        folder = self.root / str(child.pk)
        (folder / "evaluation").mkdir(parents=True)
        (folder / "capture").mkdir()
        dataset = DATASETS[child.dataset_id]
        raw = (settings.LLMOPS_EVIDENCE_DIR / dataset["captures"][0]["path"]).read_bytes()
        (folder / "capture/capture.json").write_bytes(raw)
        (folder / "reference-capture.json").write_bytes(raw)
        (folder / "recovery-fixture.json").write_bytes(
            (settings.LLMOPS_EVIDENCE_DIR / dataset["fixture"]).read_bytes()
        )
        (folder / "request.json").write_text(
            json.dumps(
                {
                    **self.marker,
                    "request_id": str(child.pk),
                    "execution_mode": "recovery",
                    "prefect_flow_run_id": str(child.prefect_flow_run_id),
                    "recovery_config": child.recovery_config,
                }
            )
        )
        report = b"<html>recovered report</html>"
        comparison = json.dumps(
            {
                "schema_version": 2,
                "evaluation_run_id": "a" * 32,
                "reference_run_id": "b" * 32,
                "fixture_sha256": dataset["fixture_sha256"],
                "case_ids": dataset["case_ids"],
                "current": {"completed": True},
                "reference": {"completed": True},
                "candidate_execution": {
                    "run_id": "a" * 32,
                    "capture_sha256": sha256(raw).hexdigest(),
                },
                "reference_execution": {
                    "run_id": "b" * 32,
                    "capture_sha256": sha256(raw).hexdigest(),
                },
            }
        ).encode()
        (folder / "evaluation/report.html").write_bytes(report)
        (folder / "evaluation/comparison.json").write_bytes(comparison)
        (folder / "evaluation/manifest.json").write_text(
            json.dumps(
                {
                    **self.manifest,
                    "status": "completed",
                    "stage": "completed",
                    "evaluation_run_id": "a" * 32,
                    "reference_run_id": "b" * 32,
                    "artifact_sha256": {
                        "report.html": sha256(report).hexdigest(),
                        "comparison.json": sha256(comparison).hexdigest(),
                    },
                }
            )
        )
        self.read.side_effect = lambda identifier: {"state_type": "COMPLETED"}
        url = f"/api/v1/ops/evaluations/{child.pk}"
        data = self.client.get(url).json()
        self.assertEqual(data["status"], "COMPLETED")
        self.assertEqual(data["model_api_calls"], 0)
        self.assertIn("/scores?", data["langfuse_url"])
        self.assertEqual(self.client.get(url + "/report").status_code, 200)
        self.assertEqual(
            self.client.post(
                url + "/recover", {"request_id": str(uuid4())}, format="json"
            ).status_code,
            409,
        )
        self.assertEqual(len(self.client.get(url + "/review").json()["material"]["cases"]), 6)
        (folder / "evaluation/report.html").write_bytes(b"corrupted report")
        damaged = self.client.get(url).json()
        self.assertEqual(damaged["status"], "RESULT_ERROR")
        self.assertTrue(damaged["postprocessing"]["can_recover"])
        (folder / "evaluation/report.html").write_bytes(report)
        self.assertEqual(self.client.get(url).json()["status"], "COMPLETED")
        (folder / "reference-capture.json").write_bytes(raw + b" ")
        self.assertEqual(self.client.get(url + "/report").status_code, 404)
        self.assertIsNone(self.client.get(url + "/review").json()["material"])

    def test_dispatch_loss_retry_keeps_source_and_same_request_without_paid_consent(self):
        self.create.side_effect = [prefect_client.PrefectUnavailable(), uuid4()]
        request_id = uuid4()
        self.assertEqual(self.post(request_id).status_code, 503)
        response = self.post(request_id)
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["source_run_id"], str(self.source.pk))
        self.assertEqual(data["model_api_calls"], 0)
        self.assertEqual(data["execution_mode"], "recovery")
        self.assertIsNone(data["live_config"])
        self.assertEqual(self.source.recoveries.count(), 1)
        self.source.refresh_from_db()
        self.assertEqual(self.source.status, "FAILED")
        self.assertEqual(self.source.error_code, "EVALUATION_FAILED")
        self.assertEqual(
            json.loads((self.folder / "evaluation/manifest.json").read_text()), self.manifest
        )
        self.assertEqual(self.post(request_id).status_code, 200)
        self.assertEqual(self.create.call_count, 2)

    def test_active_attempt_blocks_new_ids_and_detail_links_both_attempts(self):
        result = self.post()
        self.assertEqual(result.status_code, 202)
        self.assertEqual(self.post().status_code, 409)
        detail = self.client.get(self.url.removesuffix("/recover")).json()
        state = detail["postprocessing"]
        self.assertTrue(state["inputs_ready"])
        self.assertFalse(state["can_recover"])
        self.assertEqual(state["stage"], "publish")
        self.assertEqual(state["attempts"][0]["id"], result.json()["id"])
        self.assertEqual(self.create.call_count, 1)

    def test_running_or_unreachable_sources_cannot_be_recovered(self):
        for state in ["RUNNING", "PENDING"]:
            with self.subTest(state=state):
                self.read.return_value = None
                self.read.side_effect = lambda identifier, s=state: {"state_type": s}
                self.assertEqual(self.post().status_code, 409)
        self.read.side_effect = prefect_client.PrefectUnavailable()
        self.assertEqual(self.post().status_code, 409)
        self.create.assert_not_called()

    def test_missing_changed_and_incomplete_inputs_are_rejected(self):
        for key in ["fixture_sha256", "capture_sha256", "reference_capture_sha256"]:
            with self.subTest(key=key):
                before = self.manifest[key]
                self.manifest[key] = "0" * 64
                self.write_inputs()
                self.assertEqual(self.post().status_code, 409)
                self.manifest[key] = before
        self.marker["execution_mode"] = "live"
        self.marker["candidate_capture_id"] = "new-model-response"
        self.marker["live_config"] = live_config(LEGACY_DATASET_ID)
        self.source.execution_mode = "live"
        self.source.candidate_capture_id = "new-model-response"
        self.source.live_config = self.marker["live_config"]
        self.source.save()
        (self.folder / "capture").mkdir()
        raw = json.dumps({**self.capture, "completed": False}).encode()
        (self.folder / "capture/capture.json").write_bytes(raw)
        self.manifest["capture_sha256"] = sha256(raw).hexdigest()
        self.write_inputs()
        self.assertEqual(self.post().status_code, 409)
        (self.folder / "evaluation/manifest.json").unlink()
        self.assertEqual(self.post().status_code, 409)
        self.create.assert_not_called()

    def test_malformed_manifest_is_not_reported_as_ready_or_a_server_error(self):
        self.manifest.update(stage=["publish"], model_api_calls=False)
        self.write_inputs()
        response = self.client.get(self.url.removesuffix("/recover"))
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["postprocessing"]["inputs_ready"])
        self.assertEqual(response.json()["postprocessing"]["stage"], "unverified")
        self.assertEqual(self.post().status_code, 409)
        self.create.assert_not_called()

    def test_existing_uuid_cannot_be_reassigned_or_used_by_another_operator(self):
        request_id = uuid4()
        self.assertEqual(self.post(request_id).status_code, 202)
        other = get_user_model().objects.create_user("core:2")
        self.client.force_authenticate(other)
        self.assertEqual(self.post(request_id).status_code, 409)
        self.assertEqual(self.post(self.source.pk).status_code, 409)
        self.assertEqual(self.create.call_count, 1)

    def test_core_admin_and_csrf_are_required(self):
        client = Client(enforce_csrf_checks=True)
        self.assertEqual(client.post(self.url, {"request_id": uuid4()}).status_code, 401)
        client.cookies["govbiz_session"] = "test-core-session"
        with patch(
            "apps.evaluations.authentication.read_core_admin",
            return_value={
                "accountId": 1,
                "email": "reviewer@example.com",
                "role": "ADMIN",
            },
        ):
            token = client.get("/api/v1/ops/session").json()["csrf_token"]
            payload = {"request_id": str(uuid4())}
            self.assertEqual(
                client.post(self.url, payload, content_type="application/json").status_code, 403
            )
            self.assertEqual(
                client.post(
                    self.url,
                    payload,
                    content_type="application/json",
                    HTTP_X_CSRFTOKEN=token,
                    HTTP_ORIGIN="https://invalid.example",
                ).status_code,
                403,
            )
            self.assertEqual(
                client.post(
                    self.url, payload, content_type="application/json", HTTP_X_CSRFTOKEN=token
                ).status_code,
                202,
            )


class ConcurrentRecoveryTests(RecoveryFixture, TransactionTestCase):
    def test_simultaneous_requests_create_only_one_active_recovery(self):
        barrier = Barrier(2)

        def submit():
            close_old_connections()
            try:
                user = get_user_model().objects.get(pk=self.user.pk)
                source = EvaluationRun.objects.get(pk=self.source.pk)
                barrier.wait(timeout=10)
                try:
                    return str(submit_recovery(user, source, uuid4())[0].pk)
                except RequestConflict:
                    return "conflict"
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: submit(), range(2)))
        self.assertEqual(results.count("conflict"), 1)
        self.assertEqual(self.source.recoveries.count(), 1)
        self.assertEqual(self.create.call_count, 1)
