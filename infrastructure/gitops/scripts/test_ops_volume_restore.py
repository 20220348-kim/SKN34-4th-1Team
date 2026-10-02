"""Real filesystem and SQLite tests; no Docker, network or model calls."""

import copy
import hashlib
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

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


if __name__ == "__main__":
    unittest.main()
