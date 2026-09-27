import json
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.test import Client, SimpleTestCase, TestCase, override_settings
from rest_framework.exceptions import AuthenticationFailed, PermissionDenied

from . import prefect_client
from .authentication import CoreUnavailable, NoAuthRedirect, read_core_admin
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
            payload["parameters"],
            {
                "request_id": str(run.id),
                "dataset_id": DATASET_ID,
                "candidate_capture_id": DATASET_ID,
                "reference_capture_id": DATASET_ID,
                "reference_config": {},
                "execution_mode": "replay",
                "live_config": {},
            },
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
            "core:1", email="operator@example.com", password="test-password", is_staff=True
        )
        cls.viewer = get_user_model().objects.create_user("일반사용자", password="test-password")

    def setUp(self):
        self.auth = patch(
            "apps.evaluations.authentication.read_core_admin",
            return_value={
                "accountId": 1,
                "email": "operator@example.com",
                "role": "ADMIN",
            },
        ).start()
        self.addCleanup(patch.stopall)
        self.client.cookies["govbiz_session"] = "core-session"
        self.payload = {"request_id": str(uuid4()), "dataset_id": DATASET_ID}

    def post(self, payload=None):
        return self.client.post(
            "/api/v1/ops/evaluations", payload or self.payload, content_type="application/json"
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

    def test_anonymous_and_legacy_django_staff_session_cannot_read(self):
        run = self.queued_run()
        client = Client()
        client.force_login(self.operator)
        for path in [
            "/api/v1/ops/evaluations",
            f"/api/v1/ops/evaluations/{run.id}",
            f"/api/v1/ops/evaluations/{run.id}/report",
        ]:
            self.assertEqual(client.get(path).status_code, 401)
        self.assertIsNone(client.get("/api/v1/ops/session").json()["user"])
        self.assertEqual(client.post("/api/v1/ops/login", {}).status_code, 404)
        self.auth.assert_not_called()

    def test_non_admin_expired_and_unavailable_core_fail_closed_on_every_request(self):
        run = self.queued_run()
        self.assertEqual(
            self.client.get("/api/v1/ops/session").json()["user"],
            {"username": "operator@example.com"},
        )
        for failure, status in [
            (PermissionDenied(), 403),
            (AuthenticationFailed(), 401),
            (CoreUnavailable(), 503),
        ]:
            self.auth.side_effect = failure
            for path in [
                "/api/v1/ops/session",
                "/api/v1/ops/evaluations",
                f"/api/v1/ops/evaluations/{run.id}",
                f"/api/v1/ops/evaluations/{run.id}/report",
            ]:
                self.assertEqual(self.client.get(path).status_code, status)
            self.assertEqual(self.post().status_code, status)
        self.assertEqual(EvaluationRun.objects.count(), 1)

    def test_csrf_and_browser_origin_are_required_for_core_cookie_writes(self):
        client = Client(enforce_csrf_checks=True)
        client.cookies["govbiz_session"] = "core-session"
        token = client.get("/api/v1/ops/session").json()["csrf_token"]
        self.assertEqual(
            client.post(
                "/api/v1/ops/evaluations", self.payload, content_type="application/json"
            ).status_code,
            403,
        )
        self.assertEqual(
            client.post(
                "/api/v1/ops/evaluations",
                self.payload,
                content_type="application/json",
                HTTP_X_CSRFTOKEN=token,
                HTTP_ORIGIN="https://untrusted.invalid",
            ).status_code,
            403,
        )
        with patch("apps.evaluations.prefect_client.create_run", return_value=uuid4()):
            response = client.post(
                "/api/v1/ops/evaluations",
                self.payload,
                content_type="application/json",
                HTTP_X_CSRFTOKEN=token,
                HTTP_ORIGIN="http://localhost:5173",
                HTTP_HOST="localhost:5173",
            )
        self.assertEqual(response.status_code, 202)

    def test_core_account_id_preserves_ownership_when_email_changes(self):
        self.auth.return_value = {"accountId": 2, "email": "second@example.com", "role": "ADMIN"}
        session = self.client.get("/api/v1/ops/session")
        user = get_user_model().objects.get(username="core:2")
        self.assertFalse(user.has_usable_password())
        self.assertEqual(session.json()["user"]["username"], "second@example.com")
        self.auth.return_value["email"] = "renamed@example.com"
        self.client.get("/api/v1/ops/session")
        user.refresh_from_db()
        self.assertEqual(user.email, "renamed@example.com")
        self.assertEqual(get_user_model().objects.filter(username="core:2").count(), 1)

    @override_settings(OPS_WEB_URL="http://localhost:5173")
    def test_old_page_bookmarks_redirect_to_react(self):
        run = self.queued_run()
        for path in ["/", "/ops/login", "/ops/evaluations"]:
            self.assertRedirects(
                self.client.get(path),
                "http://localhost:5173/ops/evaluations",
                fetch_redirect_response=False,
            )
        self.assertRedirects(
            self.client.get(f"/ops/evaluations/{run.id}?next=https://untrusted.invalid"),
            f"http://localhost:5173/ops/evaluations/{run.id}",
            fetch_redirect_response=False,
        )

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
                response = self.client.get(f"/api/v1/ops/evaluations/{run.id}")
                self.assertEqual(response.json()["status"], expected)
                self.assertIsNone(response.json()["report_url"])
                self.assertIn(str(run.prefect_flow_run_id), response.json()["prefect_url"])

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
            response = self.client.get(f"/api/v1/ops/evaluations/{run.id}/report")
            self.assertEqual(response.status_code, 200)
            self.assertIn("sandbox allow-scripts;", response["Content-Security-Policy"])
            self.assertNotIn("allow-same-origin", response["Content-Security-Policy"])
            self.assertIn("평가 결과".encode(), b"".join(response.streaming_content))
            data = self.client.get(f"/api/v1/ops/evaluations/{run.id}").json()
            self.assertEqual(data["report_url"], f"/api/v1/ops/evaluations/{run.id}/report")
            self.assertIn("/scores?", data["langfuse_url"])
            report.write_text("tampered")
            self.assertEqual(
                self.client.get(f"/api/v1/ops/evaluations/{run.id}/report").status_code, 404
            )

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
        response = self.client.get("/api/v1/ops/evaluations")
        self.assertEqual(response.json()["count"], 26)
        self.assertEqual(len(response.json()["results"]), 25)
        self.assertIn("no-store", response["Cache-Control"])
        self.assertEqual(
            len(self.client.get("/api/v1/ops/evaluations?page=2").json()["results"]), 1
        )

    @patch("apps.evaluations.prefect_client.create_run", return_value=uuid4())
    def test_comparison_choices_are_validated_and_part_of_idempotency(self, create):
        reference, candidate = (
            "fixed-context-20260906-diagnostic-v1",
            "fixed-context-20260907-index-v1",
        )
        payload = {
            **self.payload,
            "dataset_id": "fixed-context-e01-v1",
            "reference_capture_id": reference,
            "candidate_capture_id": candidate,
        }
        data = self.client.get("/api/v1/ops/session").json()
        self.assertNotIn('"path"', json.dumps(data))
        self.assertEqual(data["datasets"][1]["case_ids"], ["E01"])
        self.assertEqual(
            self.post({**payload, "candidate_capture_id": "../../private"}).status_code, 400
        )
        self.assertEqual(
            self.post({**payload, "candidate_capture_id": DATASET_ID}).status_code, 400
        )
        self.assertEqual(EvaluationRun.objects.count(), 0)
        response = self.post(payload)
        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.json()["candidate_capture_id"], candidate)
        self.assertEqual(self.post(payload).status_code, 200)
        self.assertEqual(self.post({**payload, "reference_capture_id": candidate}).status_code, 409)
        create.assert_called_once()

    @patch("apps.evaluations.prefect_client.read_run", return_value={"state_type": "COMPLETED"})
    def test_comparison_hash_and_selected_sources_are_verified(self, read):
        with (
            TemporaryDirectory() as directory,
            override_settings(LLMOPS_RESULTS_DIR=Path(directory)),
        ):
            run = self.queued_run()
            self.result_files(Path(directory), run)
            folder = Path(directory) / str(run.id)
            path = folder / "evaluation/comparison.json"
            comparison = json.loads(path.read_text())
            comparison.update(
                schema_version=2,
                reference_run_id="b" * 32,
                fixture_sha256="c" * 64,
                case_ids=[f"TC0{i}" for i in range(1, 7)],
                reference={"completed": True},
                candidate_execution={"run_id": "a" * 32},
                reference_execution={"run_id": "b" * 32},
            )
            path.write_text(json.dumps(comparison))
            manifest_path = folder / "evaluation/manifest.json"
            manifest = json.loads(manifest_path.read_text())
            manifest.update(reference_run_id="b" * 32, fixture_sha256="c" * 64)
            manifest["artifact_sha256"]["comparison.json"] = sha256(path.read_bytes()).hexdigest()
            manifest_path.write_text(json.dumps(manifest))
            result = sync_run(run)
            self.assertEqual(result.status, "COMPLETED")
            self.assertEqual(result.comparison["reference_run_id"], "b" * 32)
            path.write_text(path.read_text() + " ")
            self.assertEqual(
                self.client.get(f"/api/v1/ops/evaluations/{run.id}/report").status_code, 404
            )
            for schema_version in (None, 3):
                altered = dict(comparison)
                if schema_version is None:
                    del altered["schema_version"]
                else:
                    altered["schema_version"] = schema_version
                path.write_text(json.dumps(altered))
                self.assertEqual(
                    self.client.get(f"/api/v1/ops/evaluations/{run.id}/report").status_code, 404
                )
            path.write_text(json.dumps(comparison))
            marker = folder / "request.json"
            data = json.loads(marker.read_text())
            data["reference_capture_id"] = "another-run"
            marker.write_text(json.dumps(data))
            self.assertEqual(
                self.client.get(f"/api/v1/ops/evaluations/{run.id}/report").status_code, 404
            )

    @override_settings(LLMOPS_LIVE_ENABLED=True)
    @patch("apps.evaluations.prefect_client.create_run", return_value=uuid4())
    def test_live_requires_exact_consent_and_is_idempotent(self, create):
        from .catalog import LIVE_CAPTURE_ID, live_config

        payload = {
            **self.payload,
            "execution_mode": "live",
            "candidate_capture_id": LIVE_CAPTURE_ID,
            "live_config": live_config(DATASET_ID),
            "confirm_paid_run": True,
        }
        for changes in [
            {"confirm_paid_run": False},
            {"live_config": {}},
            {"live_config": {**payload["live_config"], "max_model_calls": 7}},
            {"live_config": {**payload["live_config"], "fixture_sha256": "0" * 64}},
            {"live_config": {**payload["live_config"], "model": "unapproved"}},
            {"execution_mode": "replay"},
        ]:
            self.assertEqual(self.post({**payload, **changes}).status_code, 400)
        with override_settings(LLMOPS_LIVE_ENABLED=False):
            self.assertEqual(self.post(payload).status_code, 400)
        self.assertEqual(EvaluationRun.objects.count(), 0)
        first = self.post(payload)
        self.assertEqual(first.status_code, 202)
        self.assertIsNone(first.json()["model_api_calls"])
        self.assertEqual(first.json()["live_config"], payload["live_config"])
        self.assertEqual(self.post(payload).status_code, 200)
        self.assertEqual(self.post().status_code, 409)
        create.assert_called_once()

    @patch("apps.evaluations.prefect_client.read_run", return_value={"state_type": "FAILED"})
    def test_live_failed_attempts_are_visible_and_not_reported_as_zero(self, read):
        from .catalog import LIVE_CAPTURE_ID, live_config

        with (
            TemporaryDirectory() as directory,
            override_settings(LLMOPS_RESULTS_DIR=Path(directory)),
        ):
            run = self.queued_run()
            run.execution_mode = "live"
            run.candidate_capture_id = LIVE_CAPTURE_ID
            run.live_config = live_config(DATASET_ID)
            run.model_api_calls = None
            run.save()
            self.assertIsNone(sync_run(run).model_api_calls)
            folder = Path(directory) / str(run.id)
            (folder / "capture").mkdir(parents=True)
            marker = {
                "request_id": str(run.id),
                "dataset_id": run.dataset_id,
                "prefect_flow_run_id": str(run.prefect_flow_run_id),
                "candidate_capture_id": LIVE_CAPTURE_ID,
                "reference_capture_id": DATASET_ID,
                "reference_config": {},
                "execution_mode": "live",
                "live_config": run.live_config,
            }
            (folder / "request.json").write_text(json.dumps(marker))
            capture = {
                "model": run.live_config["model"],
                "fixtureSha256": run.live_config["fixture_sha256"],
                "caseIds": [f"TC0{i}" for i in range(1, 7)],
                "maxModelCalls": 6,
                "maxOutputTokens": 2000,
                "modelApiCalls": 1,
                "completed": False,
            }
            (folder / "capture/capture.json").write_text(json.dumps(capture))
            self.assertEqual(sync_run(run).model_api_calls, 1)
            self.assertEqual(run.status, "FAILED")
            self.assertIsNone(run_data(run)["report_url"])
            self.assertEqual(run_data(run)["trace_links"], [])

    @patch("apps.evaluations.prefect_client.read_run", return_value={"state_type": "COMPLETED"})
    def test_live_completion_requires_capture_hash_and_approved_model(self, read):
        from .catalog import LIVE_CAPTURE_ID, live_config

        with (
            TemporaryDirectory() as directory,
            override_settings(LLMOPS_RESULTS_DIR=Path(directory)),
        ):
            run = self.queued_run()
            run.execution_mode = "live"
            run.candidate_capture_id = LIVE_CAPTURE_ID
            run.live_config = live_config(DATASET_ID)
            run.model_api_calls = None
            run.save()
            self.result_files(Path(directory), run)
            folder = Path(directory) / str(run.id)
            marker_path = folder / "request.json"
            marker = json.loads(marker_path.read_text())
            marker.update(
                execution_mode="live",
                live_config=run.live_config,
                candidate_capture_id=LIVE_CAPTURE_ID,
                reference_capture_id=DATASET_ID,
            )
            marker_path.write_text(json.dumps(marker))
            (folder / "capture").mkdir()
            capture_path = folder / "capture/capture.json"
            capture = {
                "model": run.live_config["model"],
                "fixtureSha256": run.live_config["fixture_sha256"],
                "caseIds": [f"TC0{i}" for i in range(1, 7)],
                "maxModelCalls": 6,
                "maxOutputTokens": 2000,
                "modelApiCalls": 6,
                "completed": True,
            }
            capture_path.write_text(json.dumps(capture))
            capture_hash = sha256(capture_path.read_bytes()).hexdigest()
            comparison_path = folder / "evaluation/comparison.json"
            comparison = json.loads(comparison_path.read_text())
            comparison.update(
                schema_version=2,
                reference_run_id="b" * 32,
                fixture_sha256=run.live_config["fixture_sha256"],
                case_ids=capture["caseIds"],
                reference={"completed": True},
                candidate_execution={
                    "run_id": "a" * 32,
                    "capture_sha256": capture_hash,
                    "model": run.live_config["model"],
                },
                reference_execution={"run_id": "b" * 32},
                cases=[{"case_id": "TC01", "candidate": {"trace_id": "d" * 32}}],
            )
            comparison_path.write_text(json.dumps(comparison))
            manifest_path = folder / "evaluation/manifest.json"
            manifest = json.loads(manifest_path.read_text())
            manifest.update(
                reference_run_id="b" * 32,
                fixture_sha256=run.live_config["fixture_sha256"],
                capture_sha256=capture_hash,
            )
            manifest["artifact_sha256"]["comparison.json"] = sha256(
                comparison_path.read_bytes()
            ).hexdigest()
            manifest_path.write_text(json.dumps(manifest))
            self.assertEqual(sync_run(run).status, "COMPLETED")
            self.assertEqual(run.model_api_calls, 6)
            self.assertTrue(run_data(run)["trace_links"][0]["url"].endswith("/traces/" + "d" * 32))
            self.assertIsNone(run_data(run)["langfuse_url"])
            capture["model"] = "wrong-model"
            capture_path.write_text(json.dumps(capture))
            self.assertEqual(
                self.client.get(f"/api/v1/ops/evaluations/{run.id}/report").status_code, 404
            )


class CoreAuthClientTests(SimpleTestCase):
    @patch("apps.evaluations.authentication.build_opener")
    @override_settings(CORE_API_URL="http://core-service:8080")
    def test_only_core_cookie_is_sent_and_response_is_validated(self, opener):
        response = opener.return_value.open.return_value.__enter__.return_value
        response.status = 200
        response.read.return_value = b'{"accountId":12,"email":"admin@example.com","role":"ADMIN"}'
        self.assertEqual(read_core_admin("signed-session")["accountId"], 12)
        request = opener.return_value.open.call_args.args[0]
        self.assertEqual(request.full_url, "http://core-service:8080/api/v1/admin/session")
        self.assertEqual(request.get_header("Cookie"), "govbiz_session=signed-session")
        self.assertEqual(opener.return_value.open.call_args.kwargs["timeout"], 3)
        self.assertIsInstance(opener.call_args.args[0], NoAuthRedirect)
        self.assertIsNone(
            NoAuthRedirect().redirect_request(None, None, 302, "", {}, "https://outside.invalid")
        )
        for data in [
            b"{}",
            b'{"accountId":true,"email":"x","role":"ADMIN"}',
            b'{"accountId":1,"email":"x","role":"USER"}',
            b"not-json",
        ]:
            response.read.return_value = data
            with self.assertRaises(CoreUnavailable):
                read_core_admin("signed-session")
        with self.assertRaises(AuthenticationFailed):
            read_core_admin("invalid\r\nCookie: value")

    @patch("apps.evaluations.authentication.build_opener")
    def test_core_http_failure_is_not_a_local_auth_fallback(self, opener):
        for code, failure in [
            (401, AuthenticationFailed),
            (403, PermissionDenied),
            (302, CoreUnavailable),
            (500, CoreUnavailable),
        ]:
            opener.return_value.open.side_effect = HTTPError("private", code, "private", {}, None)
            with self.assertRaises(failure):
                read_core_admin("signed-session")
        opener.return_value.open.side_effect = URLError("private-host")
        with self.assertRaises(CoreUnavailable) as error:
            read_core_admin("signed-session")
        self.assertNotIn("private-host", str(error.exception))
