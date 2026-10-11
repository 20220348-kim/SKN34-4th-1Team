from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.core.management import CommandError
from django.test import SimpleTestCase, TestCase

from apps.evaluations.admission import change_admission, status
from apps.evaluations.models import EvaluationAdmissionChange, EvaluationRun
from apps.health.management.commands import local_release as release

TAG = "govbiz-local/v1.100.1"


class LocalReleaseUnitTests(SimpleTestCase):
    def test_failed_runtime_check_prevents_postsync_resume(self):
        with (
            patch.object(release, "call_command", side_effect=CommandError("runtime failed")),
            patch.object(release, "resume") as resume,
            self.assertRaisesRegex(CommandError, "runtime failed"),
        ):
            release.Command().handle(phase="resume", release=TAG)
        resume.assert_not_called()

    def test_invalid_release_never_touches_database(self):
        for value in ("main", "govbiz-local/v1.0.1", "govbiz-local/v1.100.1;env"):
            with self.subTest(value=value), self.assertRaises(CommandError):
                release.prepare(value)

    def test_changed_admission_blocks_resume(self):
        pause = SimpleNamespace(version=3, actor=release.ACTOR)
        for state in (
            SimpleNamespace(version=4, accepting=False),
            SimpleNamespace(version=3, accepting=True),
        ):
            with self.subTest(state=state), self.assertRaises(CommandError):
                release.own_pause(state, pause)

    def test_busy_run_keeps_pause_and_prevents_migration(self):
        pause = SimpleNamespace(version=3, actor=release.ACTOR)
        with (
            patch.object(release.transaction, "atomic", side_effect=nullcontext),
            patch.object(
                release, "lock_admission", return_value=SimpleNamespace(version=3, accepting=False)
            ),
            patch.object(release.EvaluationAdmissionChange.objects, "filter") as changes,
            patch.object(release.EvaluationRun.objects, "filter") as runs,
            patch.object(release, "call_command") as migration,
        ):
            changes.return_value.exists.return_value = False
            changes.return_value.first.return_value = pause
            runs.return_value.exists.return_value = True
            with self.assertRaisesRegex(CommandError, "Active evaluations"):
                release.prepare(TAG)
            runs.assert_called_once_with(status__in=release.ACTIVE)
            migration.assert_not_called()
        self.assertEqual(set(release.ACTIVE), {"REQUESTED", "QUEUED", "RUNNING", "CANCELLING"})


class LocalReleaseDatabaseTests(TestCase):
    """CI runs these admission/audit transactions against MySQL 8.4."""

    def operator_change(self, accepting):
        return change_admission(
            accepting=accepting,
            expected_version=status()["version"],
            request_id=uuid4(),
            actor="operator",
            reason="maintenance",
        )

    @patch.object(release, "call_command")
    def test_open_admission_is_restored_and_postsync_replay_preserves_later_pause(self, migration):
        release.prepare(TAG)
        self.assertFalse(status()["accepting"])
        migration.assert_called_once_with("migrate_deployment")
        release.resume(TAG)
        self.assertTrue(status()["accepting"])
        self.operator_change(False)
        release.resume(TAG)
        self.assertFalse(status()["accepting"])
        self.assertEqual(EvaluationAdmissionChange.objects.count(), 3)

    @patch.object(release, "call_command")
    def test_manual_pause_stays_closed_across_multiple_releases(self, migration):
        self.operator_change(False)
        release.prepare(TAG)
        release.resume(TAG)
        release.prepare("govbiz-local/v1.101.1")
        release.resume("govbiz-local/v1.101.1")
        self.assertFalse(status()["accepting"])

    @patch.object(release, "call_command")
    def test_all_active_states_block_rollout_and_retry_can_drain(self, migration):
        user = get_user_model().objects.create_user(username="release-test")
        run = EvaluationRun.objects.create(dataset_id="fixture", requested_by=user)
        for state in release.ACTIVE:
            run.status = state
            run.save(update_fields=["status"])
            with (
                self.subTest(state=state),
                self.assertRaisesRegex(CommandError, "Active evaluations"),
            ):
                release.prepare(TAG)
            self.assertFalse(status()["accepting"])
        migration.assert_not_called()
        self.assertEqual(EvaluationAdmissionChange.objects.count(), 1)
        run.status = EvaluationRun.Status.COMPLETED
        run.save(update_fields=["status"])
        release.prepare(TAG)
        release.resume(TAG)
        self.assertTrue(status()["accepting"])

    @patch.object(release, "call_command", side_effect=CommandError("migration failed"))
    def test_migration_failure_and_new_release_cannot_reopen_or_steal_pause(self, migration):
        with self.assertRaisesRegex(CommandError, "migration failed"):
            release.prepare(TAG)
        self.assertFalse(status()["accepting"])
        with self.assertRaisesRegex(CommandError, "Another local release"):
            release.prepare("govbiz-local/v1.101.1")
        with self.assertRaisesRegex(CommandError, "No admission pause"):
            release.resume("govbiz-local/v1.101.1")
        self.operator_change(False)
        with self.assertRaisesRegex(CommandError, "Admission changed"):
            release.resume(TAG)
