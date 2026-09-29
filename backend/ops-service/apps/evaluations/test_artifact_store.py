import io
import json
import os
from hashlib import sha256
from http.client import IncompleteRead
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4
from wsgiref.simple_server import WSGIRequestHandler, make_server

from django.conf import settings
from django.test import SimpleTestCase, TestCase, override_settings

from . import artifact_store
from .artifact_files import MAX_FILE_BYTES, read_file
from .artifact_server import application
from .catalog import DATASETS, LEGACY_DATASET_ID
from .execution_spec import read_release
from .models import EvaluationRun
from .recovery import recovery_config
from .reviews import review_material
from .runtime_checks import inspect_runtime
from .services import read_result
from .test_reviews import ReviewFixture

TOKEN = "artifact-test-only-" + "a" * 32


class QuietHandler(WSGIRequestHandler):
    def log_message(self, *args):
        pass


class ArtifactServerMixin:
    def serve(self, app):
        server = make_server("127.0.0.1", 0, app, handler_class=QuietHandler)
        thread = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()

        def stop():
            server.shutdown()
            thread.join(timeout=5)
            server.server_close()

        self.addCleanup(stop)
        return f"http://127.0.0.1:{server.server_port}"


class ArtifactStoreTests(ArtifactServerMixin, SimpleTestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.results = self.root / "results"
        self.results.mkdir()
        self.evidence = self.root / "evidence"
        for dataset in DATASETS.values():
            for name in [dataset["fixture"], *[item["path"] for item in dataset["captures"]]]:
                path = self.evidence / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes((settings.LLMOPS_EVIDENCE_DIR / name).read_bytes())
        self.app = application(self.results, self.evidence, TOKEN)
        self.url = self.serve(self.app)
        self.run = EvaluationRun(
            id=uuid4(),
            status="COMPLETED",
            prefect_flow_run_id=uuid4(),
            dataset_id=LEGACY_DATASET_ID,
        )
        self.folder = self.results / str(self.run.id)
        (self.folder / "evaluation").mkdir(parents=True)
        override = override_settings(
            LLMOPS_ARTIFACT_URL=self.url,
            LLMOPS_ARTIFACT_TOKEN=TOKEN,
            LLMOPS_RESULTS_DIR=self.root / "not-mounted-results",
            LLMOPS_EVIDENCE_DIR=self.root / "not-mounted-evidence",
            PREFECT_API_URL="http://prefect:4200/api",
        )
        override.enable()
        self.addCleanup(override.disable)

    def write_complete(self):
        dataset = DATASETS[self.run.dataset_id]
        capture = read_file(self.evidence, dataset["captures"][0]["path"])
        capture_hash = sha256(capture).hexdigest()
        request = {
            "request_id": str(self.run.id),
            "prefect_flow_run_id": str(self.run.prefect_flow_run_id),
            "dataset_id": self.run.dataset_id,
            "candidate_capture_id": self.run.candidate_capture_id,
            "reference_capture_id": self.run.reference_capture_id,
        }
        summary = {"completed": True, "caseCount": len(dataset["case_ids"])}
        comparison = {
            "schema_version": 2,
            "scope": "fixed-answer-context-only",
            "retrieval_evaluated": False,
            "evaluation_run_id": "a" * 32,
            "reference_run_id": "b" * 32,
            "current": summary,
            "reference": summary,
            "fixture_sha256": dataset["fixture_sha256"],
            "case_ids": dataset["case_ids"],
            "candidate_execution": {"run_id": "a" * 32, "capture_sha256": capture_hash},
            "reference_execution": {"run_id": "b" * 32, "capture_sha256": capture_hash},
        }
        raw = json.dumps(comparison).encode()
        report = "<html>검증된 보고서</html>".encode()
        manifest = {
            "status": "completed",
            "evaluation_run_id": "a" * 32,
            "reference_run_id": "b" * 32,
            "evaluator_version": read_release()["evaluation"]["version"],
            "model_api_calls": 0,
            "fixture_sha256": dataset["fixture_sha256"],
            "capture_sha256": capture_hash,
            "reference_capture_sha256": capture_hash,
            "artifact_sha256": {
                "comparison.json": sha256(raw).hexdigest(),
                "report.html": sha256(report).hexdigest(),
            },
        }
        (self.folder / "request.json").write_text(json.dumps(request))
        (self.folder / "evaluation/manifest.json").write_text(json.dumps(manifest))
        (self.folder / "evaluation/comparison.json").write_bytes(raw)
        (self.folder / "evaluation/report.html").write_bytes(report)
        return report

    def request(self, path, *, token=TOKEN, method="GET"):
        request = Request(
            self.url + path, headers={"Authorization": f"Bearer {token}"}, method=method
        )
        try:
            with urlopen(request, timeout=3) as response:
                return response.status, response.read(), response.headers
        except HTTPError as error:
            with error:
                return error.code, error.read(), error.headers

    def test_http_report_review_and_recovery_without_any_local_mount(self):
        report = self.write_complete()
        self.assertEqual(read_result(self.run)[2], report)
        self.assertTrue(review_material(self.run)["cases"])
        self.assertEqual(recovery_config(self.run)["source_run_id"], str(self.run.id))
        self.assertFalse(settings.LLMOPS_RESULTS_DIR.exists())
        self.assertFalse(settings.LLMOPS_EVIDENCE_DIR.exists())
        # The verified report is returned from the same bytes, never re-opened after its hash check.
        (self.folder / "evaluation/report.html").write_bytes(b"changed")
        self.assertIn("검증된".encode(), report)
        with self.assertRaises(artifact_store.ResultsUnavailable):
            read_result(self.run)

    def test_comparison_and_recovery_tampering_remain_explicit_errors(self):
        self.write_complete()
        path = self.folder / "evaluation/comparison.json"
        path.write_bytes(path.read_bytes() + b" ")
        with self.assertRaises(artifact_store.ResultsUnavailable):
            read_result(self.run)
        path = self.evidence / DATASETS[self.run.dataset_id]["captures"][0]["path"]
        path.write_bytes(path.read_bytes() + b" ")
        with self.assertRaises(artifact_store.ResultsUnavailable):
            recovery_config(self.run)

    def test_runtime_checks_remote_storage_without_claiming_execution(self):
        with patch(
            "apps.evaluations.prefect_client.request_json",
            return_value={
                "id": str(uuid4()),
                "flow_id": str(uuid4()),
                "name": "saved-capture",
                "paused": False,
            },
        ):
            value = inspect_runtime()
        self.assertEqual(value["status"], "PASS")
        self.assertEqual(value["storage_transport"], "http")
        self.assertFalse(value["shared_volume_identity_verified"])
        self.assertFalse(value["evaluation_executed"])
        self.assertEqual(value["checks"]["result_artifact"], "NOT_CHECKED")
        with override_settings(LLMOPS_ARTIFACT_TOKEN="b" * 64):
            self.assertEqual(inspect_runtime()["checks"]["evidence"], "FAIL")
            self.assertFalse(artifact_store.check_results())

    def test_authentication_and_read_only_routes(self):
        for token in ("", "wrong", "b" * 64):
            self.assertEqual(self.request("/v1/status", token=token)[0], 401)
        for method in ("POST", "PUT", "PATCH", "DELETE", "HEAD"):
            self.assertEqual(self.request("/v1/status", method=method)[0], 405)
        for path in (
            "/",
            "/v1/results",
            "/v1/evidence/",
            "/v1/status?token=ignored",
            "/v1/evidence/../catalog.py",
            f"/v1/results/{self.run.id}/../request.json",
            f"/v1/results/{self.run.id}/other.json",
            "/v1/results/not-a-uuid/request.json",
        ):
            code, body, headers = self.request(path)
            self.assertEqual(code, 404, path)
            self.assertNotIn(str(self.root).encode(), body)
            self.assertEqual(headers["Cache-Control"], "no-store")

    def test_configured_http_failure_never_uses_valid_local_copy(self):
        self.write_complete()
        with override_settings(LLMOPS_RESULTS_DIR=self.results, LLMOPS_ARTIFACT_TOKEN="b" * 64):
            with self.assertRaises(artifact_store.ResultsUnavailable):
                artifact_store.read_artifact(self.run.id, "request.json")
        with override_settings(LLMOPS_RESULTS_DIR=self.results, LLMOPS_ARTIFACT_URL=""):
            self.assertEqual(
                artifact_store.read_artifact(self.run.id, "request.json"),
                (self.folder / "request.json").read_bytes(),
            )

    def test_symlinked_file_and_run_directory_are_rejected(self):
        private = self.root / "private"
        private.write_bytes(b"private bytes")
        (self.folder / "request.json").symlink_to(private)
        self.assertEqual(self.request(f"/v1/results/{self.run.id}/request.json")[0], 404)
        alias_id = uuid4()
        (self.results / str(alias_id)).symlink_to(self.folder, target_is_directory=True)
        self.assertEqual(self.request(f"/v1/results/{alias_id}/request.json")[0], 404)

    def test_missing_and_oversized_files_fail_without_writes(self):
        self.assertEqual(self.request(f"/v1/results/{self.run.id}/request.json")[0], 404)
        path = self.folder / "request.json"
        with path.open("wb") as output:
            output.truncate(MAX_FILE_BYTES + 1)
        self.assertEqual(self.request(f"/v1/results/{self.run.id}/request.json")[0], 404)
        with self.assertRaises(artifact_store.ResultsUnavailable):
            artifact_store.read_artifact(self.run.id, "request.json")
        self.assertEqual(path.stat().st_size, MAX_FILE_BYTES + 1)

    def test_invalid_config_is_rejected_before_http(self):
        for url, token in (
            (self.url, ""),
            ("file:///results", TOKEN),
            ("http://user:password@host", TOKEN),
            (self.url + "/nested", TOKEN),
            (self.url + "?x=1", TOKEN),
            (self.url + "#x", TOKEN),
        ):
            with (
                self.subTest(url=url),
                override_settings(LLMOPS_ARTIFACT_URL=url, LLMOPS_ARTIFACT_TOKEN=token),
            ):
                with patch.object(artifact_store, "build_opener") as build:
                    with self.assertRaises(artifact_store.ResultsUnavailable):
                        artifact_store.read_artifact(self.run.id, "request.json")
                    build.assert_not_called()
        for token in ("", "short", "line\nbreak", "x" * 257):
            with self.assertRaises(ValueError):
                application(self.results, self.evidence, token)

    def test_redirect_is_not_followed_or_sent_credentials(self):
        calls = []

        def redirect(environ, respond):
            calls.append(environ["PATH_INFO"])
            respond("302 Found", [("Location", self.url + "/v1/status"), ("Content-Length", "0")])
            return [b""]

        with override_settings(LLMOPS_ARTIFACT_URL=self.serve(redirect)):
            with self.assertRaises(artifact_store.ResultsUnavailable):
                artifact_store.read_artifact(self.run.id, "request.json")
        self.assertEqual(calls, [f"/v1/results/{self.run.id}/request.json"])

    def test_short_oversized_and_interrupted_http_responses_are_rejected(self):
        for length, raw in (
            ("5", b"x"),
            ("unknown", b"x"),
            (None, b"x"),
            (str(MAX_FILE_BYTES + 1), b"x" * (MAX_FILE_BYTES + 1)),
        ):
            response = io.BytesIO(raw)
            response.status = 200
            response.headers = {"Content-Length": length}
            opener = Mock()
            opener.open.return_value = response
            with patch.object(artifact_store, "build_opener", return_value=opener):
                with self.assertRaises(artifact_store.ResultsUnavailable):
                    artifact_store.read_artifact(self.run.id, "request.json")
        with patch.object(artifact_store, "build_opener", side_effect=IncompleteRead(b"private")):
            with self.assertRaises(artifact_store.ResultsUnavailable):
                artifact_store.read_artifact(self.run.id, "request.json")

    def test_fifo_is_rejected_without_blocking(self):
        if not hasattr(os, "mkfifo"):
            self.skipTest("FIFO guard is exercised by Linux CI")
        os.mkfifo(self.folder / "request.json")
        self.assertEqual(self.request(f"/v1/results/{self.run.id}/request.json")[0], 404)


class RemoteReviewTests(ArtifactServerMixin, ReviewFixture, TestCase):
    def setUp(self):
        super().setUp()
        url = self.serve(application(self.root, settings.LLMOPS_EVIDENCE_DIR, TOKEN))
        override = override_settings(
            LLMOPS_ARTIFACT_URL=url,
            LLMOPS_ARTIFACT_TOKEN=TOKEN,
            LLMOPS_RESULTS_DIR=self.root / "not-mounted-results",
            LLMOPS_EVIDENCE_DIR=self.root / "not-mounted-evidence",
        )
        override.enable()
        self.addCleanup(override.disable)

    def test_report_review_quality_and_baseline_use_remote_bytes(self):
        response = self.client.get(self.url + "/report")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"<html>test report</html>")
        self.assertIn("sandbox", response["Content-Security-Policy"])
        self.review()
        self.promote()

    def test_report_corruption_is_not_served(self):
        (self.root / str(self.run.id) / "evaluation/report.html").write_bytes(b"unverified")
        response = self.client.get(self.url + "/report")
        self.assertEqual(response.status_code, 404)
        self.assertNotIn(b"unverified", response.content)
