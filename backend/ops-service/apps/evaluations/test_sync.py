import json
from datetime import timedelta
from hashlib import sha256
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import SimpleTestCase, TransactionTestCase, override_settings
from django.utils import timezone

from . import prefect_client
from .models import EvaluationRun
from .services import DATASET_ID, sync_pending_runs, sync_run
from .views import run_data


class DispatchLookupTests(SimpleTestCase):
    @patch("apps.evaluations.prefect_client.request_json")
    def test_lost_response_lookup_filters_by_key_and_checks_parameters(self, request):
        run = EvaluationRun(
            dataset_id=DATASET_ID, execution_mode="live", live_config={"model": "old"}
        )
        flow_id = uuid4()
        row = {
            "id": str(flow_id),
            "idempotency_key": f"ops-{run.id}",
            "parameters": {**prefect_client.run_parameters(run), "recovery_config": None},
        }
        request.return_value = [row]
        self.assertEqual(prefect_client.find_run(run), flow_id)
        request.assert_called_once_with(
            "/flow_runs/filter",
            {"flow_runs": {"idempotency_key": {"any_": [f"ops-{run.id}"]}}, "limit": 2},
            expected_type=list,
        )
        for rows in [
            [row, row],
            [{**row, "idempotency_key": "other"}],
            [{**row, "parameters": {**row["parameters"], "live_config": {"model": "changed"}}}],
            [{**row, "id": "invalid"}],
            [None],
        ]:
            with self.subTest(rows=rows), self.assertRaises(prefect_client.PrefectUnavailable):
                request.return_value = rows
                prefect_client.find_run(run)
        request.return_value = []
        self.assertIsNone(prefect_client.find_run(run))


@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class EvaluationSyncTests(TransactionTestCase):
    def setUp(self):
        self.operator = get_user_model().objects.create_user("sync-admin", is_staff=True)

    def run_record(self, **values):
        return EvaluationRun.objects.create(
            requested_by=self.operator,
            dataset_id=DATASET_ID,
            **{"status": "QUEUED", "prefect_flow_run_id": uuid4(), **values},
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
        report.write_text("<!doctype html><html>완료</html>")
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
                    "current": {"completed": True, "caseCount": 6},
                }
            )
        )

    @patch("apps.evaluations.prefect_client.read_run", return_value={"state_type": "COMPLETED"})
    def test_command_updates_completion_without_detail_or_list_visits(self, read):
        with (
            TemporaryDirectory() as directory,
            override_settings(LLMOPS_RESULTS_DIR=Path(directory)),
        ):
            run = self.run_record()
            self.result_files(Path(directory), run)
            call_command("sync_evaluations", stdout=StringIO())
            run.refresh_from_db()
            self.assertEqual(run.status, "COMPLETED")
            self.assertEqual(run.summary["caseCount"], 6)
            self.assertIsNotNone(run.synced_at)
            self.assertIsNotNone(run.sync_attempted_at)
            read.assert_called_once()
            self.assertEqual(sync_pending_runs(), 0)

    @patch("apps.evaluations.prefect_client.create_run")
    @patch("apps.evaluations.prefect_client.read_run", return_value={"state_type": "RUNNING"})
    @patch("apps.evaluations.prefect_client.find_run")
    @override_settings(LLMOPS_LIVE_ENABLED=False)
    def test_lost_dispatch_only_links_existing_flow_with_live_disabled(self, find, read, create):
        run = self.run_record(
            status="REQUESTED",
            prefect_flow_run_id=None,
            execution_mode="live",
            live_config={"model": "old"},
            model_api_calls=None,
        )
        find.return_value = uuid4()
        sync_pending_runs()
        run.refresh_from_db()
        self.assertEqual(run.prefect_flow_run_id, find.return_value)
        self.assertEqual(run.status, "RUNNING")
        self.assertIsNone(run.model_api_calls)
        create.assert_not_called()

    @patch("apps.evaluations.prefect_client.create_run")
    @patch("apps.evaluations.prefect_client.find_run", return_value=None)
    def test_absent_dispatch_is_not_submitted_automatically(self, find, create):
        run = self.run_record(status="REQUESTED", prefect_flow_run_id=None)
        sync_pending_runs()
        run.refresh_from_db()
        self.assertEqual(run.status, "REQUESTED")
        self.assertEqual(run.error_code, "EXECUTION_SPEC_REQUIRED")
        self.assertIsNone(run.synced_at)
        self.assertIsNotNone(run.sync_attempted_at)
        self.assertEqual(sync_pending_runs(), 0)
        create.assert_not_called()

    @patch(
        "apps.evaluations.prefect_client.read_run", side_effect=prefect_client.PrefectUnavailable
    )
    def test_outages_keep_last_success_and_do_not_starve_other_runs(self, read):
        last_success = timezone.now() - timedelta(minutes=5)
        first = self.run_record(synced_at=last_success)
        second = self.run_record()
        self.run_record(status="FAILED", error_code="EVALUATION_FAILED")
        self.assertEqual(sync_pending_runs(batch_size=1), 1)
        first.refresh_from_db()
        self.assertEqual(first.status, "QUEUED")
        self.assertEqual(first.synced_at, last_success)
        self.assertEqual(first.error_code, "PREFECT_STATUS_UNAVAILABLE")
        self.assertTrue(run_data(first)["status_stale"])
        self.assertEqual(sync_pending_runs(batch_size=1), 1)
        second.refresh_from_db()
        self.assertIsNotNone(second.sync_attempted_at)
        self.assertEqual(sync_pending_runs(batch_size=1), 0)

    @patch("apps.evaluations.prefect_client.read_run")
    def test_late_status_or_outage_cannot_overwrite_concurrent_completion(self, read):
        for response in [{"state_type": "RUNNING"}, prefect_client.PrefectUnavailable]:
            run = self.run_record()

            def complete_elsewhere(*args, run=run, response=response):
                EvaluationRun.objects.filter(pk=run.pk).update(
                    status="COMPLETED",
                    synced_at=timezone.now(),
                    sync_attempted_at=timezone.now(),
                )
                if isinstance(response, type):
                    raise response
                return response

            read.side_effect = complete_elsewhere
            self.assertEqual(sync_run(run).status, "COMPLETED")
            self.assertEqual(run.error_code, "")

    @patch("apps.evaluations.prefect_client.read_run", return_value={"state_type": "COMPLETED"})
    def test_result_error_retries_after_files_are_restored(self, read):
        with (
            TemporaryDirectory() as directory,
            override_settings(LLMOPS_RESULTS_DIR=Path(directory)),
        ):
            run = self.run_record()
            sync_pending_runs()
            run.refresh_from_db()
            self.assertEqual(run.status, "RESULT_ERROR")
            self.result_files(Path(directory), run)
            EvaluationRun.objects.filter(pk=run.pk).update(
                sync_attempted_at=timezone.now() - timedelta(seconds=11)
            )
            sync_pending_runs()
            run.refresh_from_db()
            self.assertEqual(run.status, "COMPLETED")

    @patch("apps.evaluations.prefect_client.read_run")
    def test_list_reads_database_only_and_exposes_confirmation_time(self, read):
        run = self.run_record(synced_at=timezone.now())
        self.client.cookies["govbiz_session"] = "fixture"
        with patch(
            "apps.evaluations.authentication.read_core_admin",
            return_value={
                "accountId": 1,
                "email": "admin@example.com",
                "role": "ADMIN",
            },
        ):
            data = self.client.get("/api/v1/ops/evaluations").json()["results"][0]
        self.assertEqual(data["id"], str(run.pk))
        self.assertIsNotNone(data["synced_at"])
        self.assertFalse(data["status_stale"])
        read.assert_not_called()

    def test_command_rejects_unbounded_polling_configuration(self):
        for options in [{"interval": 0}, {"batch_size": 0}, {"batch_size": 101}]:
            with self.assertRaises(CommandError):
                call_command("sync_evaluations", stdout=StringIO(), **options)
