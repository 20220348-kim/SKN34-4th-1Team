"""Private upgrade orchestration, row preservation, and opt-in real MySQL rehearsal."""

import copy
import hashlib
import inspect
import io
import json
import os
import secrets
import tempfile
import time
import unittest
from contextlib import ExitStack, contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

import ops_db_upgrade as upgrade
import ops_db_upgrade_probe as probe
import ops_initial_migration as initial
from test_ops_db_snapshot import payload as db_payload

IMAGE = "sha256:" + "a" * 64
IDENTITY = "b" * 64
HELPER = "c" * 64
PASSWORD = "d" * 64
DIGEST = "e" * 64
COMMAND = ["docker", "exec", "-i", IDENTITY, *upgrade.storage.AUTH]


def result():
    return {
        "status": "REHEARSED",
        "source_sha256": DIGEST,
        "from_evaluations": "0017_input_token_budget",
        "to_evaluations": "0028_daily_evaluation_schedules",
        "applied_migrations": 11,
        "preserved_tables": 4,
        "preserved_rows": 4,
        "schema_ready": True,
        "admission_paused": True,
        "admission_guard_rejected": True,
        "repeat_verified": True,
        "original_rows_preserved": True,
        "unknown_token_bounds_preserved": True,
    }


class RowTests(unittest.TestCase):
    def test_only_new_framework_rows_are_allowed_and_original_rows_cannot_change(self):
        for table in ("auth_user", "evaluations_evaluationrun", *probe.APPEND_ONLY):
            before = {table: {"rows": {"private-id": "original-hash"}}}
            probe.require_preserved(before, copy.deepcopy(before))
            for rows in (
                {},
                {"private-id": "changed"},
                {"private-id": "original-hash", "new": "hash"},
            ):
                after = {table: {"rows": rows}}
                if "new" in rows and table in probe.APPEND_ONLY:
                    probe.require_preserved(before, after)
                else:
                    with self.subTest(table=table, rows=rows), self.assertRaises(ValueError):
                        probe.require_preserved(before, after)

    def test_projection_keeps_original_columns_and_hashes_private_row_values(self):
        cursor = MagicMock()
        cursor.__enter__.return_value = cursor
        cursor.fetchmany.side_effect = [[(1, "한글 🧪", None)], []]
        database = SimpleNamespace(
            cursor=lambda: cursor,
            ops=SimpleNamespace(quote_name=lambda name: "`" + name + "`"),
        )
        previous = {"auth_user": {"columns": ["id", "name", "optional"], "primary": ["id"]}}
        value = probe.capture_rows(database, previous)
        self.assertNotIn("한글", json.dumps(value, ensure_ascii=False))
        cursor.execute.assert_called_once_with("SELECT `id`,`name`,`optional` FROM `auth_user`")
        self.assertEqual(len(value["auth_user"]["rows"]), 1)
        cursor.fetchmany.side_effect = [[(1, "one", None), (1, "duplicate", None)]]
        with self.assertRaises(ValueError):
            probe.capture_rows(database, previous)
        cursor.fetchmany.side_effect = [[(1, "oversized", None)]]
        with patch.object(probe, "MAX_BYTES", 1), self.assertRaises(ValueError):
            probe.capture_rows(database, previous)

    def test_source_digest_detects_code_migration_and_added_file_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "apps").mkdir()
            (root / "config").mkdir()
            (root / "manage.py").write_text("pass\n")
            before = probe.source_digest(root)
            (root / "apps/migration.py").write_text("# changed\n")
            self.assertNotEqual(probe.source_digest(root), before)

    def test_wrong_image_is_rejected_before_django_setup(self):
        with (
            patch.object(probe, "source_digest", return_value=DIGEST),
            self.assertRaises(ValueError),
        ):
            probe.exercise({"schema_version": 1, "password": PASSWORD, "source_sha256": "f" * 64})

    def test_inherited_external_routes_and_paid_flags_are_removed(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": "private", "LLMOPS_LIVE_ENABLED": "true"}):
            probe.configure(PASSWORD)
            self.assertNotIn("OPENAI_API_KEY", os.environ)
            self.assertEqual(os.environ["LLMOPS_LIVE_ENABLED"], "false")
            self.assertEqual(os.environ["LLMOPS_SCHEDULES_ENABLED"], "false")
            self.assertEqual(os.environ["DB_HOST"], "127.0.0.1")


class HelperTests(unittest.TestCase):
    def mocks(self, output=None, cleanup_fails=False):
        stack = ExitStack()
        stack.enter_context(
            patch.object(
                upgrade.database,
                "require_disposable_database",
                return_value={
                    "Id": IDENTITY,
                    "Config": {"Env": ["MYSQL_ROOT_PASSWORD=" + PASSWORD]},
                },
            )
        )
        stack.enter_context(patch.object(upgrade, "source_digest", return_value=DIGEST))
        stack.enter_context(
            patch.object(
                upgrade.database,
                "read_json",
                side_effect=lambda args: (
                    [{"Id": IMAGE, "Config": {"User": "10001:10001"}}]
                    if args[1] == "image"
                    else {"Running": False, "ExitCode": 0, "OOMKilled": False}
                ),
            )
        )
        self.calls = []

        def run(args, **kwargs):
            self.calls.append((args, kwargs))
            if args[1] == "create":
                return HELPER.encode()
            if args[1] == "start":
                return json.dumps(result() if output is None else output).encode()
            if cleanup_fails:
                raise ValueError("cleanup failed")
            return b""

        stack.enter_context(patch.object(upgrade.storage, "run", side_effect=run))
        return stack

    def test_private_stdin_and_isolated_database_network_are_required(self):
        with self.mocks():
            self.assertEqual(upgrade.run_upgrade(COMMAND, IMAGE, db_payload()), result())
        create, _ = self.calls[0]
        self.assertIn("--network=container:" + IDENTITY, create)
        self.assertIn("--read-only", create)
        self.assertIn("--log-driver=none", create)
        self.assertNotIn(PASSWORD, " ".join(create))
        self.assertNotIn("--mount", create)
        self.assertEqual(json.loads(self.calls[1][1]["data"])["password"], PASSWORD)
        self.assertEqual(self.calls[-1][0], ["docker", "rm", "--force", "--volumes", HELPER])

    def test_missing_failed_or_wrongly_typed_results_and_cleanup_failure_never_pass(self):
        for output in (
            {},
            result() | {"schema_ready": False},
            result() | {"preserved_rows": True},
            result() | {"source_sha256": "f" * 64},
        ):
            with self.mocks(output), self.assertRaises(ValueError):
                upgrade.run_upgrade(COMMAND, IMAGE, db_payload())
            self.assertEqual(self.calls[-1][0][1], "rm")
        with self.mocks(cleanup_fails=True), self.assertRaises(ValueError):
            upgrade.run_upgrade(COMMAND, IMAGE, db_payload())

    def test_foreign_database_and_mutable_image_are_rejected_before_helper_creation(self):
        with patch.object(upgrade.storage, "run") as run, self.assertRaises(ValueError):
            upgrade.run_upgrade(["kubectl", "exec", "source"], IMAGE, db_payload())
        run.assert_not_called()
        with self.mocks(), self.assertRaises(ValueError):
            upgrade.run_upgrade(COMMAND, "ops:latest", db_payload())
        self.assertEqual(self.calls, [])

    def test_cli_failure_is_redacted(self):
        with (
            patch(
                "sys.argv",
                ["probe", "--archive", "archive", "--key-file", "key", "--ops-image", IMAGE],
            ),
            patch.object(upgrade.os, "name", "posix"),
            patch.object(upgrade.os, "umask"),
            patch.object(upgrade, "rehearse", side_effect=ValueError("private-password")),
            patch("sys.stderr", new_callable=io.StringIO) as error,
            patch("builtins.print") as output,
            self.assertRaises(SystemExit),
        ):
            upgrade.main()
        self.assertNotIn("private-password", str(output.call_args_list) + error.getvalue())
        self.assertEqual(output.call_count, 1)


@unittest.skipUnless(os.name == "posix", "Private encrypted archives require Linux")
class ArchiveTests(unittest.TestCase):
    def test_encrypted_archive_cleanup_and_honest_report_scope(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            key = b"a" * 64
            upgrade.storage.exclusive(root / "key", key)
            upgrade.storage.exclusive(root / "archive", upgrade.storage.seal(db_payload(), key))
            for failed in (False, True):
                events = []

                @contextmanager
                def restored(value, failed=failed, events=events):
                    self.assertEqual(value, db_payload())
                    yield COMMAND
                    events.append("cleanup")
                    if failed:
                        raise ValueError("cleanup failed")

                with (
                    patch.object(upgrade.database, "restored_database", side_effect=restored),
                    patch.object(upgrade, "run_upgrade", return_value=result()),
                ):
                    if failed:
                        with self.assertRaises(ValueError):
                            upgrade.rehearse(root / "archive", root / "key", IMAGE)
                    else:
                        report = upgrade.rehearse(root / "archive", root / "key", IMAGE)
                        self.assertTrue(report["cleanup_complete"])
                        self.assertFalse(report["personal_environment_verified"])
                        self.assertFalse(report["full_backup_verified"])
                        self.assertFalse(report["services_changed"])
                self.assertEqual(events, ["cleanup"])


@unittest.skipUnless(
    os.environ.get("OPS_DB_UPGRADE_TEST_IMAGE") and os.environ.get("OPS_DB_SNAPSHOT_MYSQL_IMAGE"),
    "Real upgrade needs explicit immutable Ops and MySQL fixture images",
)
class DockerUpgradeTests(unittest.TestCase):
    def test_original_encrypted_legacy_db_upgrades_without_changing_its_source(self):
        database, storage = upgrade.database, upgrade.storage
        image = os.environ["OPS_DB_UPGRADE_TEST_IMAGE"]
        mysql = os.environ["OPS_DB_SNAPSHOT_MYSQL_IMAGE"]
        password = secrets.token_hex(32)
        identity = (
            storage.run(
                [
                    "docker",
                    "create",
                    "--pull=never",
                    "--network=none",
                    "--log-driver=none",
                    "--memory=512m",
                    "--pids-limit=128",
                    "--tmpfs=/var/lib/mysql:rw,nosuid,size=384m",
                    "--env",
                    "MYSQL_ROOT_PASSWORD",
                    "--env",
                    "MYSQL_DATABASE=govbiz_ops",
                    mysql,
                    "--mysqlx=0",
                    "--performance-schema=OFF",
                    "--innodb-buffer-pool-size=64M",
                    "--skip-log-bin",
                ],
                env={**os.environ, "MYSQL_ROOT_PASSWORD": password},
            )
            .decode()
            .strip()
        )
        self.assertRegex(identity, r"^[a-f0-9]{64}$")
        try:
            storage.run(["docker", "start", identity])
            command = ["docker", "exec", "-i", identity, *storage.AUTH]
            deadline = time.monotonic() + 90
            while True:
                try:
                    version = database.query(command, "SELECT VERSION();")
                    break
                except storage.SnapshotError:
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(1)
            source = (
                database.REPOSITORY_ROOT / "backend/ops-service/scripts/check-schema.py"
            ).read_text()
            fixture = (
                "import os,json,sys,secrets\n"
                + inspect.getsource(probe.configure)
                + "\nconfigure(json.load(sys.stdin)['password'])\nimport django\ndjango.setup()\n"
                + "scope={'__file__':'/app/scripts/check-schema.py','__name__':'fixture'}\n"
                + "exec(compile("
                + repr(source)
                + ",'fixture','exec'),scope)\n"
                + "from django.db import connection\nscope['prepare_legacy_fixture'](connection)\n"
            )
            helper = "govbiz-upgrade-fixture-" + uuid4().hex
            try:
                storage.run(
                    [
                        "docker",
                        "run",
                        "--name",
                        helper,
                        "--pull=never",
                        "--interactive",
                        "--network=container:" + identity,
                        "--read-only",
                        "--log-driver=none",
                        "--cap-drop=ALL",
                        "--security-opt=no-new-privileges:true",
                        "--memory=384m",
                        "--tmpfs=/tmp:rw,noexec,nosuid,size=32m,mode=1777",
                        "--entrypoint",
                        "python",
                        image,
                        "-B",
                        "-c",
                        fixture,
                    ],
                    data=json.dumps({"password": password}).encode(),
                )
            finally:
                storage.run(["docker", "rm", "--force", "--volumes", helper])
            sql = database.dump(command)
            value = db_payload() | {
                "mysql_image": mysql,
                "mysql_version": version,
                "sql": sql,
                "sql_sha256": hashlib.sha256(sql.encode()).hexdigest(),
                "table_counts": database.inventory(command),
            }
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                key = secrets.token_hex(32).encode()
                storage.exclusive(root / "key", key)
                storage.exclusive(root / "archive", storage.seal(value, key))
                execute_upgrade = upgrade.run_upgrade

                def verify_initial_pause(command, image, payload):
                    result = execute_upgrade(command, image, payload)
                    request = database.query(
                        command,
                        "SELECT request_id FROM evaluations_evaluationadmissionchange;",
                    )
                    pause = initial.pause_arguments(
                        request, "격리 DB 전환 검증", "복원본 전환 후 신규 접수 중지"
                    )
                    initial.verify_pause(command, pause)
                    with self.assertRaises(ValueError):
                        initial.verify_pause(command, {**pause, "actor": "다른 운영자"})
                    return result

                with patch.object(upgrade, "run_upgrade", side_effect=verify_initial_pause):
                    report = upgrade.rehearse(root / "archive", root / "key", image)
                self.assertEqual(report["to_evaluations"], "0028_daily_evaluation_schedules")
                self.assertTrue(report["original_rows_preserved"])
                self.assertTrue(report["admission_paused"])
                self.assertTrue(report["repeat_verified"])
                self.assertTrue(report["cleanup_complete"])
                self.assertEqual(report["preserved_rows"], sum(value["table_counts"].values()))
                self.assertFalse(report["personal_environment_verified"])
                self.assertNotIn("ci-legacy", json.dumps(report))
                self.assertNotIn(password, json.dumps(report))
                with (
                    patch.object(upgrade, "source_digest", return_value="f" * 64),
                    self.assertRaises(storage.SnapshotError),
                ):
                    upgrade.rehearse(root / "archive", root / "key", image)
            self.assertEqual(database.dump(command), sql)
        finally:
            storage.run(["docker", "rm", "--force", "--volumes", identity])


if __name__ == "__main__":
    unittest.main()
