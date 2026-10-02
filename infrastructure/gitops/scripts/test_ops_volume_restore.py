"""Real filesystem and SQLite tests; no Docker, network or model calls."""

import copy
import hashlib
import json
import os
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.error import URLError

import ops_volume_restore_probe as probe

REQUEST = "11111111-1111-4111-8111-111111111111"
FLOW = "22222222-2222-4222-8222-222222222222"
RAW = "한글 복원 🧪\n<html>report</html>".encode()
EXPECTED = {
    REQUEST: {"flow_id": FLOW, "report_sha256": hashlib.sha256(RAW).hexdigest()}
}


class VolumeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "source"
        self.target = self.root / "target"
        self.source.mkdir()
        self.target.mkdir()

    def report_file(self):
        file = self.source / REQUEST / "evaluation" / "report.html"
        file.parent.mkdir(parents=True)
        file.write_bytes(RAW)
        file.chmod(0o640)
        return file

    def database(self, wal=False):
        database = sqlite3.connect(self.source / "prefect.db")
        self.addCleanup(database.close)
        if wal:
            database.execute("PRAGMA journal_mode=WAL")
            database.execute("PRAGMA wal_autocheckpoint=0")
        database.executescript("""
            CREATE TABLE alembic_version (version_num TEXT PRIMARY KEY);
            INSERT INTO alembic_version VALUES ('fixture-version');
            CREATE TABLE deployment (id TEXT PRIMARY KEY);
            INSERT INTO deployment VALUES ('deployment-fixture');
            CREATE TABLE deployment_schedule (active INTEGER);
            INSERT INTO deployment_schedule VALUES (0);
            CREATE TABLE flow_run (
                id TEXT PRIMARY KEY, state_type TEXT, parameters TEXT,
                deployment_id TEXT REFERENCES deployment(id));
            CREATE TABLE flow_run_state (
                id TEXT PRIMARY KEY, flow_run_id TEXT REFERENCES flow_run(id), type TEXT);
        """)
        database.execute(
            "INSERT INTO flow_run VALUES (?,?,?,?)",
            (
                FLOW,
                "COMPLETED",
                json.dumps({"request_id": REQUEST}),
                "deployment-fixture",
            ),
        )
        database.execute(
            "INSERT INTO flow_run_state VALUES (?,?,?)",
            ("state-fixture", FLOW, "COMPLETED"),
        )
        database.commit()
        return database

    def verify(self, kind):
        return probe.verify(self.source, self.target, kind, EXPECTED)

    def test_archive_restores_all_bytes_permissions_ownership_and_timestamps(self):
        self.report_file()
        (self.source / "입력.json").write_text(
            '{"내용": [null, "한글"]}', encoding="utf-8"
        )
        before = probe.tree(self.source)
        result = self.verify("results")
        self.assertEqual(result["matched_reports"], 1)
        self.assertTrue(result["source_preserved"])
        self.assertEqual(probe.tree(self.source), before)
        self.assertEqual(probe.tree(self.target), before)
        self.assertEqual(result["file_count"], 2)
        self.assertNotIn("입력.json", json.dumps(result))

    def test_existing_target_never_overwritten(self):
        self.report_file()
        keep = self.target / "keep"
        keep.write_bytes(b"preserve")
        with self.assertRaisesRegex(ValueError, "empty"):
            self.verify("results")
        self.assertEqual(keep.read_bytes(), b"preserve")

    def test_same_or_nested_target_is_rejected(self):
        self.report_file()
        for target in (self.source, self.source / "child", self.root):
            with (
                self.subTest(target=target),
                self.assertRaisesRegex(ValueError, "separate"),
            ):
                probe.restore(self.source, target)

    def test_symlinks_hardlinks_and_special_files_are_rejected(self):
        original = self.report_file()
        link = self.source / "link"
        for create in (
            lambda: link.symlink_to(original),
            lambda: link.symlink_to(self.target, target_is_directory=True),
            lambda: os.link(original, link),
            lambda: os.mkfifo(link),
        ):
            create()
            with self.assertRaises(ValueError):
                self.verify("results")
            link.unlink()
            self.assertEqual(list(self.target.iterdir()), [])

    def test_special_permissions_are_rejected(self):
        self.report_file().chmod(0o4755)
        with self.assertRaisesRegex(ValueError, "permissions"):
            self.verify("results")

    def test_empty_or_oversized_volume_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "no files"):
            self.verify("results")
        self.report_file()
        for constant in ("MAX_BYTES", "MAX_ENTRIES"):
            with (
                patch.object(probe, constant, 1),
                self.assertRaisesRegex(ValueError, "size limit"),
            ):
                self.verify("results")

    def test_missing_or_tampered_authenticated_report_fails(self):
        self.report_file().write_bytes(RAW + b"tampered")
        with self.assertRaisesRegex(ValueError, "digest"):
            self.verify("results")

    def test_invalid_execution_evidence_fails_before_copy(self):
        self.report_file()
        for expected in (
            {},
            {"../outside": EXPECTED[REQUEST]},
            {REQUEST: {"flow_id": FLOW, "report_sha256": "bad"}},
        ):
            with self.subTest(expected=expected), self.assertRaises(ValueError):
                probe.verify(self.source, self.target, "results", expected)
        self.assertEqual(list(self.target.iterdir()), [])

    def test_sqlite_integrity_migrations_deployment_and_completed_history(self):
        self.database().close()
        before = probe.tree(self.source)
        result = self.verify("prefect")
        self.assertTrue(result["sqlite_integrity"])
        self.assertEqual(result["migration_count"], 1)
        self.assertEqual(result["matched_executions"], 1)
        self.assertEqual(probe.tree(self.source), before)

    def test_committed_wal_data_is_included_without_reading_source_as_immutable(self):
        self.database(wal=True)
        self.assertGreater((self.source / "prefect.db-wal").stat().st_size, 0)
        result = self.verify("prefect")
        self.assertEqual(result["matched_executions"], 1)
        self.assertGreaterEqual(result["file_count"], 3)

    def test_corrupt_or_missing_sqlite_database_fails(self):
        (self.source / "prefect.db").write_bytes(b"corrupt")
        with self.assertRaises(sqlite3.DatabaseError):
            self.verify("prefect")

    def test_missing_history_or_active_schedule_or_unfinished_run_fails(self):
        mutations = (
            "DELETE FROM alembic_version",
            "DELETE FROM flow_run_state",
            "UPDATE flow_run SET state_type='RUNNING'",
            "UPDATE deployment_schedule SET active=1",
            "UPDATE flow_run SET deployment_id='missing'",
            "UPDATE flow_run SET parameters='{}'",
            "UPDATE flow_run SET id='missing'",
        )
        for mutation in mutations:
            with (
                self.subTest(mutation=mutation),
                tempfile.TemporaryDirectory() as folder,
            ):
                old_source, old_target = self.source, self.target
                self.source, self.target = (
                    Path(folder) / "source",
                    Path(folder) / "target",
                )
                self.source.mkdir()
                self.target.mkdir()
                database = self.database()
                database.execute(mutation)
                database.commit()
                database.close()
                with self.assertRaises(ValueError):
                    self.verify("prefect")
                self.source, self.target = old_source, old_target

    def test_source_change_during_copy_is_detected(self):
        original = self.report_file()
        before = probe.tree(self.source)
        changed = copy.deepcopy(before)
        changed[REQUEST + "/evaluation/report.html"]["sha256"] = "0" * 64
        with patch.object(probe, "tree", side_effect=[before, changed]):
            with self.assertRaisesRegex(ValueError, "changed"):
                self.verify("results")
        self.assertEqual(original.read_bytes(), RAW)

    def api_responses(self):
        deployment = "33333333-3333-4333-8333-333333333333"
        flow = {
            "id": FLOW,
            "flow_id": "flow-definition",
            "deployment_id": deployment,
            "state_type": "COMPLETED",
            "state": {"id": "completed-state", "type": "COMPLETED"},
            "parameters": {
                "request_id": REQUEST,
                "execution_mode": "replay",
                "live_config": {},
            },
        }
        return [
            True,
            flow,
            {"id": deployment, "flow_id": "flow-definition"},
            [
                {
                    "id": "completed-state",
                    "type": "COMPLETED",
                    "state_details": {"flow_run_id": FLOW},
                }
            ],
        ]

    def test_restored_api_reads_history_without_migrations_credentials_or_db_changes(
        self,
    ):
        self.database().close()
        before = probe.sqlite_digest(self.source)
        server = Mock()
        server.poll.return_value = None
        server.wait.return_value = 0
        with (
            patch.object(probe.subprocess, "Popen", return_value=server) as start,
            patch.object(
                probe, "prefect_json", side_effect=self.api_responses()
            ) as http,
            patch.dict(
                os.environ,
                {
                    "OPENAI_API_KEY": "must-not-propagate",
                    "PREFECT_API_URL": "https://external.invalid",
                },
            ),
        ):
            result = probe.check_prefect_api(self.source, EXPECTED)
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["matched_executions"], 1)
        self.assertTrue(result["database_unchanged"])
        self.assertIn("--no-services", start.call_args.args[0])
        env = start.call_args.kwargs["env"]
        for key in (
            "PREFECT_API_DATABASE_MIGRATE_ON_START",
            "PREFECT_API_BLOCKS_REGISTER_ON_START",
            "PREFECT_SERVER_SERVICES_SCHEDULER_ENABLED",
        ):
            self.assertEqual(env[key], "false")
        self.assertNotIn("PREFECT_API_URL", env)
        self.assertNotIn("OPENAI_API_KEY", env)
        self.assertTrue(
            env["PREFECT_SERVER_DATABASE_CONNECTION_URL"].endswith(
                str(self.source / "prefect.db")
            )
        )
        self.assertEqual(http.call_args_list[1].args, ("/flow_runs/" + FLOW,))
        self.assertEqual(
            http.call_args_list[3].args, ("/flow_run_states/?flow_run_id=" + FLOW,)
        )
        server.terminate.assert_called_once_with()
        server.kill.assert_not_called()
        self.assertEqual(probe.sqlite_digest(self.source), before)

    def test_api_rejects_wrong_execution_deployment_and_history(self):
        self.database().close()
        changes = [
            (1, lambda x: x.update(id=REQUEST)),
            (1, lambda x: x.update(state_type="RUNNING")),
            (1, lambda x: x["parameters"].update(request_id="wrong")),
            (1, lambda x: x["parameters"].update(execution_mode="live")),
            (1, lambda x: x["parameters"].update(live_config={"model": "unexpected"})),
            (2, lambda x: x.update(flow_id="wrong-flow")),
            (2, lambda x: x.update(id=FLOW)),
            (3, lambda x: x.clear()),
            (3, lambda x: x.append(copy.deepcopy(x[0]))),
            (3, lambda x: x[0]["state_details"].update(flow_run_id=REQUEST)),
            (3, lambda x: x[0].update(type="RUNNING")),
        ]
        for index, change in changes:
            responses = self.api_responses()
            change(responses[index])
            server = Mock(poll=Mock(return_value=None), wait=Mock(return_value=0))
            with (
                self.subTest(index=index, change=change),
                patch.object(probe.subprocess, "Popen", return_value=server),
                patch.object(probe, "prefect_json", side_effect=responses),
                self.assertRaises(ValueError),
            ):
                probe.check_prefect_api(self.source, EXPECTED)
            server.terminate.assert_called_once_with()

    def test_api_startup_exit_and_timeout_are_failures(self):
        self.database().close()
        for exited in (True, False):
            server = Mock(
                poll=Mock(return_value=1 if exited else None), wait=Mock(return_value=0)
            )
            with (
                self.subTest(exited=exited),
                patch.object(probe.subprocess, "Popen", return_value=server),
                patch.object(
                    probe, "prefect_json", side_effect=URLError("unavailable")
                ),
                patch.object(probe.time, "monotonic", side_effect=[0, 91]),
                self.assertRaisesRegex(ValueError, "exited|timed out"),
            ):
                probe.check_prefect_api(self.source, EXPECTED)
            server.terminate.assert_called_once_with()

    def test_api_shutdown_timeout_kills_process_and_cannot_pass(self):
        self.database().close()
        server = Mock(poll=Mock(return_value=None))
        server.wait.side_effect = [subprocess.TimeoutExpired("prefect", 15), -9]
        with (
            patch.object(probe.subprocess, "Popen", return_value=server),
            patch.object(probe, "prefect_json", side_effect=self.api_responses()),
            self.assertRaisesRegex(ValueError, "stop cleanly"),
        ):
            probe.check_prefect_api(self.source, EXPECTED)
        server.kill.assert_called_once_with()

    def test_invalid_api_health_or_unsuccessful_exit_cannot_pass(self):
        self.database().close()
        for healthy, code in ((False, 0), (True, 2)):
            responses = self.api_responses()
            responses[0] = healthy
            server = Mock(poll=Mock(return_value=None), wait=Mock(return_value=code))
            with (
                self.subTest(healthy=healthy, code=code),
                patch.object(probe.subprocess, "Popen", return_value=server),
                patch.object(probe, "prefect_json", side_effect=responses),
                self.assertRaises(ValueError),
            ):
                probe.check_prefect_api(self.source, EXPECTED)
            server.terminate.assert_called_once_with()

    def test_api_database_writes_are_detected_after_shutdown(self):
        self.database().close()

        def stop(**kwargs):
            with sqlite3.connect(self.source / "prefect.db") as db:
                db.execute(
                    "UPDATE alembic_version SET version_num='unexpected-migration'"
                )
            return 0

        server = Mock(poll=Mock(return_value=None), wait=Mock(side_effect=stop))
        with (
            patch.object(probe.subprocess, "Popen", return_value=server),
            patch.object(probe, "prefect_json", side_effect=self.api_responses()),
            self.assertRaisesRegex(ValueError, "changed database"),
        ):
            probe.check_prefect_api(self.source, EXPECTED)

    def test_prefect_volume_api_stage_checks_source_after_server_execution(self):
        self.database().close()

        def verify_api(root, expected):
            self.assertEqual(root, self.target)
            self.assertEqual(expected, EXPECTED)
            (self.source / "unexpected").write_text("changed")
            return {"status": "PASS"}

        with (
            patch.object(probe, "check_prefect_api", side_effect=verify_api),
            self.assertRaisesRegex(ValueError, "Source volume changed"),
        ):
            probe.verify(self.source, self.target, "prefect", EXPECTED, api=True)


if __name__ == "__main__":
    unittest.main()
