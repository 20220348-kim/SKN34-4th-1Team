"""CI tooling guards; these scripts are not shipped in the Ops runtime image."""

import os
import runpy
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


class LegacyUpgradeGuardTests(unittest.TestCase):
    def setUp(self):
        self.checks = runpy.run_path(str(Path(__file__).with_name("check-schema.py")))

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


if __name__ == "__main__":
    unittest.main()
