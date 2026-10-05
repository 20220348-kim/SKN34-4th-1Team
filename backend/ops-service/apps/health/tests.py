import io
import json
from contextlib import ExitStack
from unittest.mock import patch
from uuid import uuid4

from django.core.management import CommandError, call_command
from django.db import OperationalError
from django.db.migrations.exceptions import InconsistentMigrationHistory
from django.db.migrations.recorder import MigrationRecorder
from django.test import SimpleTestCase, TestCase, TransactionTestCase

from apps.health.management.commands import migrate_deployment


class HealthTests(SimpleTestCase):
    def test_liveness_does_not_need_database(self):
        # SimpleTestCase는 DB 접근을 금지하므로 실수로 추가한 질의도 실패합니다.
        response = self.client.get("/api/v1/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "UP", "service": "govbiz-ops-service"})

    def test_health_is_read_only(self):
        self.assertEqual(self.client.post("/api/v1/health").status_code, 405)
        self.assertEqual(self.client.post("/api/v1/health/ready").status_code, 405)

    def test_readiness_returns_503_without_exposing_database_error(self):
        with patch("apps.health.views.connection") as database:
            database.cursor.side_effect = OperationalError("private-database-address")
            response = self.client.get("/api/v1/health/ready")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"status": "DOWN", "checks": {"database": "DOWN"}})
        self.assertNotIn(b"private-database-address", response.content)

    def test_missing_or_inconsistent_schema_is_not_ready_and_does_not_leak_details(self):
        for failure in (
            None,
            InconsistentMigrationHistory("private-table-name"),
            OperationalError("private-column"),
        ):
            with (
                self.subTest(failure=failure),
                patch("apps.health.views.connection"),
                patch("apps.health.views.schema_is_ready", return_value=False, side_effect=failure),
            ):
                response = self.client.get("/api/v1/health/ready")
            self.assertEqual(response.status_code, 503)
            self.assertEqual(
                response.json(), {"status": "DOWN", "checks": {"database": "UP", "schema": "DOWN"}}
            )
            self.assertNotIn(b"private", response.content)

    def test_unrecognized_host_is_rejected(self):
        response = self.client.get("/api/v1/health", HTTP_HOST="unrecognized.invalid")
        self.assertEqual(response.status_code, 400)


class DatabaseReadinessTests(TestCase):
    def test_readiness_against_real_mysql(self):
        response = self.client.get("/api/v1/health/ready")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(), {"status": "UP", "checks": {"database": "UP", "schema": "UP"}}
        )

    def test_pending_migration_history_blocks_readiness_on_mysql(self):
        MigrationRecorder.Migration.objects.filter(
            app="evaluations", name="0012_evaluation_cancellation"
        ).delete()
        response = self.client.get("/api/v1/health/ready")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["checks"]["schema"], "DOWN")

    def test_schema_probe_is_read_only_and_does_not_read_rows(self):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        from apps.health.schema import schema_is_ready

        with CaptureQueriesContext(connection) as queries:
            self.assertTrue(schema_is_ready())
        checks = [item["sql"] for item in queries if "WHERE 1=0" in item["sql"]]
        self.assertTrue(any("evaluations_evaluationrun" in sql for sql in checks))
        self.assertTrue(any("auth_user" in sql for sql in checks))
        self.assertFalse(
            any(
                sql["sql"].startswith(("INSERT", "UPDATE", "DELETE", "CREATE", "ALTER"))
                for sql in queries
            )
        )


class DeploymentMigrationTests(SimpleTestCase):
    def test_contended_lock_prevents_migrations(self):
        with (
            patch("apps.health.management.commands.migrate_deployment.connection") as database,
            patch("apps.health.management.commands.migrate_deployment.call_command") as migrate,
        ):
            database.vendor = "mysql"
            database.cursor.return_value.__enter__.return_value.fetchone.return_value = (0,)
            with self.assertRaisesRegex(CommandError, "Another Ops migration"):
                call_command("migrate_deployment", stdout=io.StringIO(), skip_checks=True)
        migrate.assert_not_called()

    def test_forward_only_migration_and_lock_release_on_success_or_failure(self):
        for failure in (None, RuntimeError("fixture migration failure")):
            with (
                self.subTest(failure=failure),
                patch("apps.health.management.commands.migrate_deployment.connection") as database,
                patch(
                    "apps.health.management.commands.migrate_deployment.call_command",
                    side_effect=failure,
                ) as migrate,
                patch(
                    "apps.health.management.commands.migrate_deployment.schema_is_ready",
                    return_value=True,
                ),
            ):
                database.vendor = "mysql"
                cursor = database.cursor.return_value.__enter__.return_value
                cursor.fetchone.return_value = (1,)
                if failure:
                    with self.assertRaisesRegex(RuntimeError, "fixture migration failure"):
                        call_command("migrate_deployment", stdout=io.StringIO(), skip_checks=True)
                else:
                    call_command("migrate_deployment", stdout=io.StringIO(), skip_checks=True)
                self.assertEqual(migrate.call_args.args, ("migrate",))
                self.assertFalse(migrate.call_args.kwargs["interactive"])
                self.assertEqual(
                    [call.args[0] for call in cursor.execute.call_args_list],
                    ["SELECT GET_LOCK(%s, 0)", "SELECT RELEASE_LOCK(%s)"],
                )


class PausedDeploymentTests(SimpleTestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.database = self.stack.enter_context(patch.object(migrate_deployment, "connection"))
        self.database.vendor = "mysql"
        self.cursor = self.database.cursor.return_value.__enter__.return_value
        self.cursor.fetchone.return_value = (1,)
        self.migrate = self.stack.enter_context(patch.object(migrate_deployment, "call_command"))
        self.ready = self.stack.enter_context(
            patch.object(migrate_deployment, "schema_is_ready", return_value=True)
        )
        self.guard = self.stack.enter_context(
            patch.object(migrate_deployment, "require_initial_pause")
        )
        self.options = {
            "pause_request_id": str(uuid4()),
            "pause_actor": " 담당자 ",
            "pause_reason": " 최초 전환 ",
        }
        self.result = {
            "accepting": False,
            "version": 1,
            "replayed": False,
            "change": {
                "request_id": self.options["pause_request_id"],
                "version": 1,
                "accepting": False,
            },
        }
        self.pause = self.stack.enter_context(
            patch.object(migrate_deployment, "change_admission", return_value=self.result)
        )

    def execute(self, **changes):
        output = io.StringIO()
        call_command(
            "migrate_deployment",
            **(self.options | changes),
            stdout=output,
            skip_checks=True,
            verbosity=0,
        )
        return output.getvalue()

    def test_input_is_checked_before_any_database_or_migration_work(self):
        for changes in (
            {"pause_request_id": None},
            {"pause_request_id": "invalid"},
            {"pause_actor": None},
            {"pause_actor": " "},
            {"pause_actor": "x" * 151},
            {"pause_reason": None},
            {"pause_reason": "bad\nreason"},
            {"pause_reason": "x" * 501},
        ):
            with self.subTest(changes=changes), self.assertRaises(CommandError):
                self.execute(**changes)
        self.database.cursor.assert_not_called()
        self.migrate.assert_not_called()
        self.pause.assert_not_called()

    def test_schema_and_pause_are_confirmed_before_releasing_the_migration_lock(self):
        events = []
        self.cursor.execute.side_effect = lambda sql, params: events.append(
            "release" if "RELEASE" in sql else "lock"
        )
        self.guard.side_effect = lambda change: events.append("guard")
        self.migrate.side_effect = lambda *args, **kwargs: events.append("migrate")
        self.ready.side_effect = lambda: events.append("schema") or True
        self.pause.side_effect = lambda **kwargs: events.append("pause") or self.result
        self.assertEqual(json.loads(self.execute()), self.result)
        self.assertEqual(events, ["lock", "guard", "migrate", "schema", "pause", "release"])
        self.assertEqual(self.pause.call_args.kwargs["expected_version"], 0)
        self.assertEqual(self.pause.call_args.kwargs["actor"], "담당자")
        self.assertEqual(self.pause.call_args.kwargs["reason"], "최초 전환")

    def test_conflicting_initial_state_blocks_ddl_and_pause(self):
        self.guard.side_effect = CommandError("Admission changed")
        with self.assertRaisesRegex(CommandError, "Admission changed"):
            self.execute()
        self.migrate.assert_not_called()
        self.pause.assert_not_called()
        self.assertIn("RELEASE_LOCK", self.cursor.execute.call_args.args[0])

    def test_migration_or_schema_failure_does_not_apply_pause(self):
        self.migrate.side_effect = RuntimeError("fixture migration failure")
        with self.assertRaises(RuntimeError):
            self.execute()
        self.pause.assert_not_called()
        self.assertIn("RELEASE_LOCK", self.cursor.execute.call_args.args[0])
        self.migrate.side_effect = None
        self.ready.return_value = False
        with self.assertRaisesRegex(CommandError, "without a ready"):
            self.execute()
        self.pause.assert_not_called()

    def test_admission_failure_is_redacted_and_never_prints_success(self):
        self.pause.side_effect = OperationalError("private-database-password")
        output = io.StringIO()
        with self.assertRaises(CommandError) as error:
            call_command("migrate_deployment", **self.options, stdout=output, skip_checks=True)
        self.assertNotIn("private", str(error.exception))
        self.assertEqual(output.getvalue(), "")
        self.assertIn("RELEASE_LOCK", self.cursor.execute.call_args.args[0])

    def test_changed_state_after_pause_and_unconfirmed_lock_release_fail(self):
        for changes in ({"accepting": True}, {"version": 2}, {"change": {}}):
            self.pause.return_value = self.result | changes
            with self.subTest(changes=changes), self.assertRaises(CommandError):
                self.execute()
        self.pause.return_value = self.result
        self.cursor.fetchone.side_effect = [(1,), (0,)]
        with self.assertRaisesRegex(CommandError, "release was not confirmed"):
            self.execute()


class InitialPauseGuardTests(SimpleTestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.database = self.stack.enter_context(patch.object(migrate_deployment, "connection"))
        self.status = self.stack.enter_context(
            patch.object(
                migrate_deployment, "status", return_value={"accepting": True, "version": 0}
            )
        )
        self.changes = self.stack.enter_context(
            patch.object(migrate_deployment.EvaluationAdmissionChange, "objects")
        )
        self.changes.exists.return_value = False
        self.changes.count.return_value = 1
        self.change = {"request_id": uuid4(), "actor": "담당자", "reason": "최초 전환"}
        self.tables = [
            migrate_deployment.EvaluationAdmission._meta.db_table,
            migrate_deployment.EvaluationAdmissionChange._meta.db_table,
        ]
        self.database.introspection.table_names.return_value = self.tables
        self.history = {"accepting": False, "version": 1, "actor": "담당자", "reason": "최초 전환"}
        self.changes.filter.return_value.values.return_value.first.return_value = self.history

    def test_absent_tables_and_uninitialized_admission_are_accepted_read_only(self):
        migrate_deployment.require_initial_pause(self.change)
        self.database.introspection.table_names.return_value = []
        migrate_deployment.require_initial_pause(self.change)
        self.changes.create.assert_not_called()

    def test_partial_schema_is_rejected(self):
        self.database.introspection.table_names.return_value = self.tables[:1]
        with self.assertRaises(CommandError):
            migrate_deployment.require_initial_pause(self.change)

    def test_only_exact_unchanged_first_pause_can_be_replayed(self):
        self.status.return_value = {"accepting": False, "version": 1}
        migrate_deployment.require_initial_pause(self.change)
        for previous in (
            None,
            self.history | {"actor": "다른 담당자"},
            self.history | {"reason": "다른 이유"},
            self.history | {"accepting": True},
        ):
            self.changes.filter.return_value.values.return_value.first.return_value = previous
            with self.subTest(previous=previous), self.assertRaises(CommandError):
                migrate_deployment.require_initial_pause(self.change)
        self.changes.filter.return_value.values.return_value.first.return_value = self.history
        self.changes.count.return_value = 2
        with self.assertRaises(CommandError):
            migrate_deployment.require_initial_pause(self.change)

    def test_resumed_or_later_paused_state_is_rejected(self):
        for state in ({"accepting": True, "version": 2}, {"accepting": False, "version": 3}):
            self.status.return_value = state
            with self.subTest(state=state), self.assertRaises(CommandError):
                migrate_deployment.require_initial_pause(self.change)


class PausedDeploymentDatabaseTests(TransactionTestCase):
    def test_same_request_repeats_once_but_cannot_override_later_resume(self):
        from apps.evaluations.admission import change_admission, status
        from apps.evaluations.models import EvaluationAdmissionChange

        request_id = str(uuid4())
        options = {
            "pause_request_id": request_id,
            "pause_actor": "통합 검증",
            "pause_reason": "첫 전환",
        }
        for repeated in (False, True):
            output = io.StringIO()
            call_command("migrate_deployment", **options, stdout=output, verbosity=0)
            result = json.loads(output.getvalue())
            self.assertIs(result["replayed"], repeated)
            self.assertFalse(result["accepting"])
            self.assertEqual(result["version"], 1)
            self.assertEqual(EvaluationAdmissionChange.objects.count(), 1)
        change_admission(
            accepting=True, expected_version=1, request_id=uuid4(), actor="통합 검증", reason="재개"
        )
        for identity in (request_id, str(uuid4())):
            with patch.object(migrate_deployment, "call_command") as migrate:
                with self.assertRaisesRegex(CommandError, "Admission changed"):
                    call_command(
                        "migrate_deployment",
                        **(options | {"pause_request_id": identity}),
                        stdout=io.StringIO(),
                    )
                migrate.assert_not_called()
        self.assertTrue(status()["accepting"])
        self.assertEqual(status()["version"], 2)
        self.assertEqual(EvaluationAdmissionChange.objects.count(), 2)
