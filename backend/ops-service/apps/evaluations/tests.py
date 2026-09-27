import json
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.test import Client, SimpleTestCase, TestCase, override_settings

from . import prefect_client
from .models import EvaluationRun
from .services import DATASET_ID, ResultsUnavailable, artifact_path, sync_run
from .views import run_data


class PrefectClientTests(SimpleTestCase):
    @patch("apps.evaluations.prefect_client.request_json")
    def test_dispatch_uses_same_idempotency_key_without_paths_or_secrets(self, request):
        run = EvaluationRun(id=uuid4(), dataset_id=DATASET_ID)
        flow_id = uuid4()
        request.side_effect = [{"id": str(uuid4())}, {"id": str(flow_id)}]
        self.assertEqual(prefect_client.create_run(run), flow_id)
        payload = request.call_args.args[1]
        self.assertEqual(payload["idempotency_key"], f"ops-{run.id}")
        self.assertEqual(
            payload["parameters"], {"request_id": str(run.id), "dataset_id": DATASET_ID}
        )

    @patch("apps.evaluations.prefect_client.request_json", return_value={"id": 123})
    def test_invalid_remote_identifier_is_an_explicit_error(self, request):
        with self.assertRaises(prefect_client.PrefectUnavailable):
            prefect_client.create_run(EvaluationRun(id=uuid4(), dataset_id=DATASET_ID))

    def test_symlink_outside_run_directory_is_rejected(self):
        with (
            TemporaryDirectory() as directory,
            override_settings(LLMOPS_RESULTS_DIR=Path(directory)),
        ):
            run = EvaluationRun(id=uuid4())
            private = Path(directory) / "private.txt"
            private.write_text("private")
            folder = Path(directory) / str(run.id)
            folder.mkdir()
            (folder / "request.json").symlink_to(private)
            with self.assertRaises(ResultsUnavailable):
                artifact_path(run, "request.json")


@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class EvaluationTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.operator = get_user_model().objects.create_user(
            "운영자", password="test-password", is_staff=True
        )
        cls.viewer = get_user_model().objects.create_user("일반사용자", password="test-password")

    def setUp(self):
        self.client.force_login(self.operator)
        self.payload = {"request_id": str(uuid4()), "dataset_id": DATASET_ID}

    def post(self, payload=None):
        return self.client.post(
            "/api/v1/evaluations", payload or self.payload, content_type="application/json"
        )

    def queued_run(self):
        return EvaluationRun.objects.create(
            requested_by=self.operator,
            dataset_id=DATASET_ID,
            prefect_flow_run_id=uuid4(),
            status="QUEUED",
        )

    def result_files(self, root, run):
        folder = root / str(run.id)
        (folder / "evaluation").mkdir(parents=True)
        (folder / "request.json").write_text(
            json.dumps(
                {
                    "request_id": str(run.id),
                    "dataset_id": DATASET_ID,
                    "prefect_flow_run_id": str(run.prefect_flow_run_id),
                }
            )
        )
        report = folder / "evaluation/report.html"
        report.write_text("<!doctype html><html>평가 결과</html>")
        (folder / "evaluation/manifest.json").write_text(
            json.dumps(
                {
                    "status": "completed",
                    "evaluation_run_id": "a" * 32,
                    "model_api_calls": 0,
                    "artifact_sha256": {"report.html": sha256(report.read_bytes()).hexdigest()},
                }
            )
        )
        (folder / "evaluation/comparison.json").write_text(
            json.dumps(
                {
                    "evaluation_run_id": "a" * 32,
                    "current": {
                        "completed": True,
                        "caseCount": 6,
                        "observedCaseCount": 6,
                        "statusAccuracy": 1.0,
                        "referenceCitationRecall": 1.0,
                        "semanticFaithfulness": None,
                    },
                }
            )
        )
        return report

    def test_anonymous_and_non_staff_cannot_run_or_read(self):
        run = self.queued_run()
        for user in [None, self.viewer]:
            self.client.logout()
            if user:
                self.client.force_login(user)
            self.assertEqual(self.post().status_code, 403)
            self.assertEqual(self.client.get("/api/v1/evaluations").status_code, 403)
            self.assertEqual(self.client.get(f"/api/v1/evaluations/{run.id}").status_code, 403)
            self.assertEqual(self.client.get(f"/ops/evaluations/{run.id}/report").status_code, 302)

    def test_operator_login_and_post_only_logout(self):
        self.client.logout()
        response = self.client.post(
            "/ops/login", {"username": "일반사용자", "password": "test-password"}
        )
        self.assertContains(response, "운영자 계정")
        response = self.client.post(
            "/ops/login", {"username": "운영자", "password": "test-password"}
        )
        self.assertRedirects(response, "/ops/evaluations")
        self.assertEqual(self.client.get("/ops/logout").status_code, 405)
        self.assertRedirects(self.client.post("/ops/logout"), "/ops/login")

    def test_csrf_is_required_for_api_and_forms(self):
        client = Client(enforce_csrf_checks=True)
        client.force_login(self.operator)
        self.assertEqual(client.post("/api/v1/evaluations", self.payload).status_code, 403)
        self.assertEqual(client.post("/ops/evaluations", self.payload).status_code, 403)
        self.assertEqual(client.post("/ops/login", {}).status_code, 403)

    @patch("apps.evaluations.prefect_client.create_run")
    def test_duplicate_request_creates_one_run(self, create):
        create.return_value = uuid4()
        first, replay = self.post(), self.post()
        self.assertEqual(first.status_code, 202)
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(first.json()["prefect_flow_run_id"], replay.json()["prefect_flow_run_id"])
        self.assertEqual(EvaluationRun.objects.count(), 1)
        create.assert_called_once()

    @patch("apps.evaluations.prefect_client.create_run")
    def test_dispatch_timeout_is_recoverable_with_same_request(self, create):
        create.side_effect = [prefect_client.PrefectUnavailable("private-url"), uuid4()]
        failed = self.post()
        self.assertEqual(failed.status_code, 503)
        self.assertEqual(failed.json()["status"], "REQUESTED")
        self.assertNotIn("private-url", failed.content.decode())
        recovered = self.post()
        self.assertEqual(recovered.status_code, 200)
        self.assertEqual(recovered.json()["status"], "QUEUED")
        self.assertEqual(create.call_args_list[0].args[0].id, create.call_args_list[1].args[0].id)

    @patch("apps.evaluations.prefect_client.create_run")
    def test_invalid_input_and_another_operators_request_are_rejected(self, create):
        self.assertEqual(
            self.post({**self.payload, "dataset_id": "../../private"}).status_code, 400
        )
        self.assertEqual(self.post({**self.payload, "request_id": "invalid"}).status_code, 400)
        other = get_user_model().objects.create_user("다른운영자", is_staff=True)
        EvaluationRun.objects.create(
            id=self.payload["request_id"], requested_by=other, dataset_id=DATASET_ID
        )
        self.assertEqual(self.post().status_code, 409)
        create.assert_not_called()

    @patch("apps.evaluations.prefect_client.read_run")
    def test_running_failure_cancellation_and_crash_are_visible(self, read):
        for state, expected in [
            ("RUNNING", "RUNNING"),
            ("FAILED", "FAILED"),
            ("CANCELLED", "CANCELLED"),
            ("CRASHED", "CRASHED"),
        ]:
            with self.subTest(state=state):
                run = self.queued_run()
                read.return_value = {"state_type": state, "start_time": "2026-09-27T00:00:00Z"}
                response = self.client.get(f"/api/v1/evaluations/{run.id}")
                self.assertEqual(response.json()["status"], expected)
                self.assertIsNone(response.json()["report_url"])
                page = self.client.get(f"/ops/evaluations/{run.id}")
                self.assertContains(page, "Prefect 실행 로그")

    @patch(
        "apps.evaluations.prefect_client.read_run", side_effect=prefect_client.PrefectUnavailable
    )
    def test_status_outage_preserves_last_known_state(self, read):
        run = self.queued_run()
        result = sync_run(run)
        self.assertEqual(result.status, "QUEUED")
        self.assertEqual(result.error_code, "PREFECT_STATUS_UNAVAILABLE")

    @patch("apps.evaluations.prefect_client.read_run", return_value={"state_type": "COMPLETED"})
    def test_completion_requires_verified_artifacts_and_can_recover(self, read):
        with (
            TemporaryDirectory() as directory,
            override_settings(LLMOPS_RESULTS_DIR=Path(directory)),
        ):
            run = self.queued_run()
            self.assertEqual(sync_run(run).status, "RESULT_ERROR")
            report = self.result_files(Path(directory), run)
            result = sync_run(run)
            self.assertEqual(result.status, "COMPLETED")
            self.assertEqual(result.summary["caseCount"], 6)
            self.assertEqual(result.evaluation_run_id, "a" * 32)
            link = urlsplit(run_data(result)["langfuse_url"])
            self.assertTrue(link.path.endswith("/scores"))
            self.assertEqual(
                parse_qs(link.query)["filter"], ["sessionId;string;;contains;" + "a" * 32]
            )
            self.assertTrue(parse_qs(link.query)["dateRange"][0].startswith("0-"))
            response = self.client.get(f"/ops/evaluations/{run.id}/report")
            self.assertEqual(response.status_code, 200)
            self.assertIn("sandbox allow-scripts;", response["Content-Security-Policy"])
            self.assertNotIn("allow-same-origin", response["Content-Security-Policy"])
            self.assertIn("평가 결과".encode(), b"".join(response.streaming_content))
            page = self.client.get(f"/ops/evaluations/{run.id}")
            self.assertContains(page, "Evidently 보고서")
            self.assertContains(page, "Langfuse 평가 점수")
            report.write_text("tampered")
            self.assertEqual(self.client.get(f"/ops/evaluations/{run.id}/report").status_code, 404)

    @patch("apps.evaluations.prefect_client.read_run", return_value={"state_type": "COMPLETED"})
    def test_another_runs_artifacts_are_not_accepted(self, read):
        with (
            TemporaryDirectory() as directory,
            override_settings(LLMOPS_RESULTS_DIR=Path(directory)),
        ):
            run = self.queued_run()
            self.result_files(Path(directory), run)
            marker = Path(directory) / str(run.id) / "request.json"
            data = json.loads(marker.read_text())
            data["prefect_flow_run_id"] = str(uuid4())
            marker.write_text(json.dumps(data))
            self.assertEqual(sync_run(run).status, "RESULT_ERROR")

    def test_list_is_paginated_and_does_not_start_or_sync_evaluations(self):
        EvaluationRun.objects.bulk_create(
            [EvaluationRun(requested_by=self.operator, dataset_id=DATASET_ID) for _ in range(26)]
        )
        response = self.client.get("/api/v1/evaluations")
        self.assertEqual(response.json()["count"], 26)
        self.assertEqual(len(response.json()["results"]), 25)
        self.assertContains(self.client.get("/ops/evaluations"), "26건")
