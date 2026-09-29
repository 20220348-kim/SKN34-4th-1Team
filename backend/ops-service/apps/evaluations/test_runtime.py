import io
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from django.conf import settings
from django.core.management import CommandError, call_command
from django.test import SimpleTestCase, TestCase, override_settings
from rest_framework.exceptions import AuthenticationFailed, PermissionDenied
from rest_framework.test import APIClient

from .authentication import CoreUnavailable
from .catalog import DATASETS
from .models import EvaluationRun
from .prefect_client import PrefectUnavailable
from .runtime_checks import inspect_runtime
from .services import ResultsUnavailable


class RuntimeChecksTests(SimpleTestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.evidence = self.root / "evidence"
        self.results = self.root / "results"
        self.results.mkdir()
        for dataset in DATASETS.values():
            for name in [dataset["fixture"], *[item["path"] for item in dataset["captures"]]]:
                target = self.evidence / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes((settings.LLMOPS_EVIDENCE_DIR / name).read_bytes())
        self.settings = override_settings(
            LLMOPS_EVIDENCE_DIR=self.evidence,
            LLMOPS_RESULTS_DIR=self.results,
            PREFECT_API_URL="http://prefect:4200/api",
        )
        self.settings.enable()
        self.addCleanup(self.settings.disable)
        self.transport = patch(
            "apps.evaluations.prefect_client.request_json",
            return_value={
                "id": str(uuid4()),
                "flow_id": str(uuid4()),
                "name": "saved-capture",
                "paused": False,
            },
        )
        self.request = self.transport.start()
        self.addCleanup(self.transport.stop)

    def test_valid_inputs_and_empty_results_do_not_claim_shared_storage_or_execution(self):
        result = inspect_runtime()
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["checks"]["result_artifact"], "NOT_CHECKED")
        self.assertFalse(result["result_artifact_verified"])
        self.assertFalse(result["evaluation_executed"])
        self.assertFalse(result["runner_liveness_verified"])
        self.request.assert_called_once_with(
            "/deployments/name/govbiz-ops-evidence-evaluation/saved-capture"
        )
        self.assertEqual(list(self.results.iterdir()), [])

    def test_missing_or_changed_capture_fails_without_repair_or_detail_leak(self):
        dataset = next(iter(DATASETS.values()))
        target = self.evidence / dataset["captures"][0]["path"]
        target.write_text("private corrupted bytes")
        self.assertEqual(inspect_runtime()["checks"]["evidence"], "FAIL")
        target.unlink()
        result = inspect_runtime()
        self.assertEqual(result["status"], "FAIL")
        self.assertNotIn(str(self.root), json.dumps(result))
        self.assertFalse(target.exists())

    def test_missing_results_is_not_created(self):
        self.results.rmdir()
        self.assertEqual(inspect_runtime()["checks"]["results_directory"], "FAIL")
        self.assertFalse(self.results.exists())

    def test_path_escape_and_release_mismatch_fail(self):
        from .execution_spec import read_release

        release = read_release()
        key = next(iter(DATASETS))
        for field, value in (("fixture_sha256", "0" * 64), ("case_ids", []), ("captures", {})):
            changed = {
                **release,
                "datasets": {
                    **release["datasets"],
                    key: {**release["datasets"][key], field: value},
                },
            }
            with (
                self.subTest(field=field),
                patch("apps.evaluations.runtime_checks.read_release", return_value=changed),
            ):
                self.assertEqual(inspect_runtime()["checks"]["evidence"], "FAIL")
        with patch.dict(DATASETS[key], fixture="../outside.json"):
            (self.root / "outside.json").write_bytes(b"untrusted")
            self.assertEqual(inspect_runtime()["checks"]["evidence"], "FAIL")

    def test_unconfigured_prefect_does_not_make_network_request(self):
        with override_settings(PREFECT_API_URL="http://disabled-prefect.invalid/api"):
            self.assertEqual(inspect_runtime()["checks"]["prefect_deployment"], "FAIL")
        self.request.assert_not_called()

    def test_invalid_paused_or_unreachable_deployment_is_failure(self):
        for value in ({}, {"id": "bad"}, {**self.request.return_value, "paused": True}):
            self.request.return_value = value
            self.assertEqual(inspect_runtime()["checks"]["prefect_deployment"], "FAIL")
        self.request.side_effect = PrefectUnavailable("private endpoint")
        self.assertNotIn("private", json.dumps(inspect_runtime()))

    def test_command_reports_failure_with_nonzero_exit_contract(self):
        output = io.StringIO()
        self.request.side_effect = PrefectUnavailable()
        with self.assertRaises(CommandError):
            call_command("check_evaluation_runtime", stdout=output, skip_checks=True)
        self.assertEqual(json.loads(output.getvalue())["status"], "FAIL")


class RuntimeApiTests(SimpleTestCase):
    def setUp(self):
        self.client = APIClient()

    def test_authentication_required_before_any_diagnostic(self):
        with patch("apps.evaluations.runtime_views.inspect_runtime") as inspect:
            self.assertEqual(self.client.get("/api/v1/ops/runtime").status_code, 401)
        inspect.assert_not_called()

    def test_expired_non_admin_and_unavailable_core_are_rejected(self):
        self.client.cookies["govbiz_session"] = "fixture"
        for error, expected in (
            (AuthenticationFailed(), 401),
            (PermissionDenied(), 403),
            (CoreUnavailable(), 503),
        ):
            with (
                self.subTest(expected=expected),
                patch("apps.evaluations.authentication.read_core_admin", side_effect=error),
                patch("apps.evaluations.runtime_views.inspect_runtime") as inspect,
            ):
                self.assertEqual(self.client.get("/api/v1/ops/runtime").status_code, expected)
            inspect.assert_not_called()

    def test_authenticated_get_is_no_cache_and_validates_run_id(self):
        self.client.force_authenticate(SimpleNamespace(is_authenticated=True))
        with patch(
            "apps.evaluations.runtime_views.inspect_runtime", return_value={"status": "FAIL"}
        ) as inspect:
            response = self.client.get("/api/v1/ops/runtime")
            self.assertEqual(response.status_code, 503)
            self.assertIn("no-store", response["Cache-Control"])
            self.assertEqual(self.client.post("/api/v1/ops/runtime", {}).status_code, 405)
            self.assertEqual(
                self.client.get("/api/v1/ops/runtime?run_id=not-a-uuid").status_code, 400
            )
            self.assertEqual(inspect.call_count, 1)
            inspect.return_value = {"status": "PASS"}
            run_id = uuid4()
            self.assertEqual(
                self.client.get(f"/api/v1/ops/runtime?run_id={run_id}").status_code, 200
            )
            inspect.assert_called_with(run_id)


class RuntimeArtifactTests(TestCase):
    @patch("apps.evaluations.runtime_checks.check_evidence", return_value=True)
    @patch("apps.evaluations.prefect_client.request_json", side_effect=PrefectUnavailable)
    def test_only_existing_completed_verified_result_confirms_artifact_access(
        self, request, evidence
    ):
        from django.contrib.auth import get_user_model

        user = get_user_model().objects.create_user("runtime-fixture")
        run = EvaluationRun.objects.create(requested_by=user, status="COMPLETED")
        with patch("apps.evaluations.services.read_result") as read:
            self.assertEqual(inspect_runtime(uuid4())["checks"]["result_artifact"], "FAIL")
            read.assert_not_called()
            self.assertTrue(inspect_runtime(run.id)["result_artifact_verified"])
            read.assert_called_once_with(run)
            read.side_effect = ResultsUnavailable
            self.assertFalse(inspect_runtime(run.id)["result_artifact_verified"])
            run.status = "RUNNING"
            run.save(update_fields=["status"])
            read.reset_mock()
            self.assertFalse(inspect_runtime(run.id)["result_artifact_verified"])
            read.assert_not_called()
