import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.test import TestCase, TransactionTestCase, override_settings
from rest_framework.test import APIClient

from .catalog import LEGACY_DATASET_ID, live_config, public_datasets
from .execution_spec import digest
from .models import EvaluationRun
from .prefect_client import PrefectUnavailable, run_parameters
from .services import dispatch_run, sync_run


class ExecutionSpecTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user("core:1")
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.payload = {
            "request_id": str(uuid4()),
            "dataset_id": LEGACY_DATASET_ID,
            "execution_profile": public_datasets()[0]["execution_profiles"]["replay"],
        }

    def post(self, payload=None):
        return self.client.post("/api/v1/ops/evaluations", payload or self.payload, format="json")

    @patch("apps.evaluations.prefect_client.create_run", return_value=uuid4())
    def test_missing_and_stale_browser_profiles_do_not_create_or_dispatch(self, create):
        for value in [None, "0" * 64]:
            self.assertEqual(
                self.post({**self.payload, "execution_profile": value}).status_code, 400
            )
        self.assertFalse(EvaluationRun.objects.exists())
        create.assert_not_called()

    @patch("apps.evaluations.prefect_client.create_run")
    def test_retry_preserves_original_spec_after_release_change_and_conflicts_on_new_profile(
        self, create
    ):
        create.side_effect = [PrefectUnavailable(), uuid4()]
        self.assertEqual(self.post().status_code, 503)
        run = EvaluationRun.objects.get(pk=self.payload["request_id"])
        original = run.execution_spec
        self.assertEqual(run.execution_spec_sha256, digest(original))
        self.assertEqual(run_parameters(run)["execution_spec"], original)
        with patch(
            "apps.evaluations.services.read_release", side_effect=AssertionError("recomputed")
        ):
            self.assertEqual(self.post().status_code, 200)
        self.assertEqual(
            self.post({**self.payload, "execution_profile": "0" * 64}).status_code, 409
        )
        run.refresh_from_db()
        self.assertEqual(run.execution_spec, original)
        self.assertEqual(create.call_count, 2)
        self.assertEqual(EvaluationRun.objects.count(), 1)

    @patch("apps.evaluations.prefect_client.create_run")
    def test_legacy_pending_live_request_is_not_upgraded_or_dispatched(self, create):
        run = EvaluationRun.objects.create(
            requested_by=self.user,
            dataset_id=LEGACY_DATASET_ID,
            execution_mode="live",
            live_config={"model": "past-model"},
            model_api_calls=None,
        )
        dispatch_run(run)
        self.assertEqual(run.error_code, "EXECUTION_SPEC_REQUIRED")
        self.assertEqual(run.execution_spec, {})
        self.assertIsNone(run.model_api_calls)
        create.assert_not_called()

    @override_settings(
        LLMOPS_LIVE_ENABLED=True, LLMOPS_BUDGET_TOKEN="offline-test-budget-token-32-characters"
    )
    @patch("apps.evaluations.prefect_client.read_run", return_value={"state_type": "FAILED"})
    @patch("apps.evaluations.prefect_client.create_run", return_value=uuid4())
    def test_only_correlated_preflight_rejection_confirms_zero_calls(self, create, read):
        from .models import EvaluationBudget

        EvaluationBudget.objects.create(call_limit=12, output_token_limit=24000)
        payload = {
            **self.payload,
            "execution_mode": "live",
            "candidate_capture_id": "new-model-response",
            "live_config": live_config(LEGACY_DATASET_ID),
            "confirm_paid_run": True,
            "execution_profile": public_datasets()[0]["execution_profiles"]["live"],
        }
        self.assertEqual(self.post(payload).status_code, 202)
        run = EvaluationRun.objects.get(pk=payload["request_id"])
        with (
            TemporaryDirectory() as directory,
            override_settings(LLMOPS_RESULTS_DIR=Path(directory)),
        ):
            folder = Path(directory) / str(run.pk)
            folder.mkdir()
            marker = {**run_parameters(run), "prefect_flow_run_id": str(run.prefect_flow_run_id)}
            (folder / "request.json").write_text(json.dumps(marker))
            preflight = {
                "phase": "before_model_call",
                "error_code": "EXECUTION_SPEC_MISMATCH",
                "model_api_calls": 0,
                "execution_spec_sha256": "0" * 64,
            }
            (folder / "preflight.json").write_text(json.dumps(preflight))
            sync_run(run)
            self.assertIsNone(run.model_api_calls)
            self.assertEqual(run.error_code, "EVALUATION_FAILED")
            preflight["execution_spec_sha256"] = run.execution_spec_sha256
            (folder / "preflight.json").write_text(json.dumps(preflight))
            sync_run(run)
            self.assertEqual(run.model_api_calls, 0)
            self.assertEqual(run.error_code, "EXECUTION_SPEC_MISMATCH")

    @patch("apps.evaluations.prefect_client.create_run", return_value=uuid4())
    def test_empty_or_replaced_result_spec_is_not_a_completed_result(self, create):
        from .services import ResultsUnavailable, read_request

        self.assertEqual(self.post().status_code, 202)
        run = EvaluationRun.objects.get(pk=self.payload["request_id"])
        with (
            TemporaryDirectory() as directory,
            override_settings(LLMOPS_RESULTS_DIR=Path(directory)),
        ):
            folder = Path(directory) / str(run.pk)
            folder.mkdir()
            marker = {**run_parameters(run), "prefect_flow_run_id": str(run.prefect_flow_run_id)}
            for replacement in [{}, {**run.execution_spec, "baseline_version": 99}]:
                (folder / "request.json").write_text(
                    json.dumps({**marker, "execution_spec": replacement})
                )
                with self.assertRaises(ResultsUnavailable):
                    read_request(run)


class ExecutionSpecMigrationTests(TransactionTestCase):
    def test_migration_keeps_legacy_run_and_review_without_inventing_spec(self):
        from django.db import connection
        from django.db.migrations.executor import MigrationExecutor

        executor = MigrationExecutor(connection)
        latest = executor.loader.graph.leaf_nodes()
        old = [("evaluations", "0008_case_reviews")]
        try:
            executor.migrate(old)
            apps = executor.loader.project_state(old).apps
            user = apps.get_model("auth", "User").objects.create(username="legacy-operator")
            run = apps.get_model("evaluations", "EvaluationRun").objects.create(
                requested_by_id=user.pk,
                dataset_id=LEGACY_DATASET_ID,
                status="COMPLETED",
                summary={"caseCount": 6},
            )
            review = apps.get_model("evaluations", "EvaluationCaseReview").objects.create(
                run_id=run.pk,
                case_id="TC01",
                version=1,
                decision="DEFERRED",
                comment="보존할 기존 검토",
                capture_sha256="a" * 64,
                fixture_sha256="b" * 64,
                rubric_version="evidence-review-v1",
                reviewed_by_id=user.pk,
            )
            executor = MigrationExecutor(connection)
            executor.migrate(latest)
            apps = executor.loader.project_state(latest).apps
            kept = apps.get_model("evaluations", "EvaluationRun").objects.get(pk=run.pk)
            self.assertEqual(kept.execution_spec, {})
            self.assertEqual(kept.execution_spec_sha256, "")
            self.assertEqual(kept.status, "COMPLETED")
            self.assertEqual(kept.summary, {"caseCount": 6})
            self.assertEqual(
                apps.get_model("evaluations", "EvaluationCaseReview")
                .objects.get(pk=review.pk)
                .comment,
                "보존할 기존 검토",
            )
        finally:
            MigrationExecutor(connection).migrate(latest)
