import io
import os
import runpy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from django.core.management import CommandError, call_command
from django.db import OperationalError
from django.db.migrations.exceptions import InconsistentMigrationHistory
from django.db.migrations.recorder import MigrationRecorder
from django.test import SimpleTestCase, TestCase


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


class LegacyUpgradeGuardTests(SimpleTestCase):
    def setUp(self):
        self.checks = runpy.run_path(
            str(Path(__file__).resolve().parents[2] / "scripts/check-schema.py")
        )

    def test_command_requires_both_ci_flags_before_django_setup(self):
        for ci, opted_in in (("false", "true"), ("true", "false"), ("", "")):
            with (
                self.subTest(ci=ci, opted_in=opted_in),
                patch.dict(os.environ, {"GITHUB_ACTIONS": ci, "OPS_SCHEMA_TEST_ONLY": opted_in}),
                patch("sys.argv", ["check-schema.py", "--legacy-evaluations"]),
                patch("django.setup") as setup,
                self.assertRaisesRegex(RuntimeError, "dedicated empty CI"),
            ):
                self.checks["main"]()
            setup.assert_not_called()

    def test_existing_schema_and_non_mysql_are_rejected_before_migration(self):
        for vendor, tables in (("mysql", ["existing_data"]), ("sqlite", [])):
            database = SimpleNamespace(
                vendor=vendor,
                introspection=SimpleNamespace(table_names=lambda tables=tables: tables),
            )
            with (
                self.subTest(vendor=vendor),
                patch("django.db.migrations.executor.MigrationExecutor") as executor,
                self.assertRaisesRegex(RuntimeError, "empty MySQL"),
            ):
                self.checks["prepare_legacy_fixture"](database)
            executor.assert_not_called()

    def test_backward_plan_is_rejected_before_any_fixture_write(self):
        database = SimpleNamespace(
            vendor="mysql", introspection=SimpleNamespace(table_names=lambda: [])
        )
        with (
            patch("django.db.migrations.executor.MigrationExecutor") as factory,
            self.assertRaisesRegex(AssertionError, "never reverse"),
        ):
            executor = factory.return_value
            executor.loader.graph.leaf_nodes.return_value = [("evaluations", "0028")]
            executor.migration_plan.return_value = [(object(), True)]
            self.checks["prepare_legacy_fixture"](database)
        executor.migrate.assert_not_called()
