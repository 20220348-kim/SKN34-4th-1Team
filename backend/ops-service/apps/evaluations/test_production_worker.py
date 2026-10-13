from io import StringIO
from unittest.mock import patch

from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import DatabaseError
from django.test import SimpleTestCase, override_settings


@override_settings(LLMOPS_PRODUCTION_SAMPLES_ENABLED=False)
class ProductionSampleWorkerTests(SimpleTestCase):
    def test_collection_pause_keeps_existing_sample_checks_and_evaluation_sync_running(self):
        prefix = "apps.evaluations.management.commands.sync_evaluations."
        with (
            patch(prefix + "prune_expired_samples", return_value=2) as prune,
            patch(prefix + "process_pending_samples", return_value=3) as process,
            patch(prefix + "sync_pending_runs", return_value=1) as sync,
            patch(prefix + "dispatch_due_schedules", return_value=0),
        ):
            output = StringIO()
            call_command("sync_evaluations", batch_size=7, stdout=output)
        prune.assert_called_once_with()
        process.assert_called_once_with(batch_size=7)
        sync.assert_called_once_with(batch_size=7, interval_seconds=10)
        self.assertIn("운영 표본 3건 무료 구조 검사", output.getvalue())
        self.assertIn("평가 상태 1건 확인", output.getvalue())

    def test_database_error_is_reported_without_raw_driver_message(self):
        prefix = "apps.evaluations.management.commands.sync_evaluations."
        with (
            patch(prefix + "prune_expired_samples", side_effect=DatabaseError("private detail")),
            self.assertRaises(CommandError) as caught,
        ):
            call_command("sync_evaluations", stdout=StringIO())
        self.assertNotIn("private detail", str(caught.exception))
