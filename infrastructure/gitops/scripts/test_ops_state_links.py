"""Completed evaluation links, including real encrypted MySQL/SQLite/file restore."""

import copy
import gzip
import hashlib
import json
import os
import secrets
import sqlite3
import tempfile
import time
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import ops_state_links as links
import ops_state_snapshot as snapshot
from test_ops_db_snapshot import payload as db_payload
from test_ops_runtime_keys import payload as key_payload

REQUEST = "12345678-1234-4234-8234-123456789abc"
FLOW = "23456789-1234-4234-8234-123456789abc"
EVALUATION = "a" * 32
SPEC = {"schema_version": 1, "dataset": {"name": "합성 🧪"}}
SPEC_HASH = hashlib.sha256(
    json.dumps(SPEC, sort_keys=True, separators=(",", ":")).encode()
).hexdigest()
SUMMARY = {"completed": True, "한글": [None, "검증"]}
ROW = {
    "id": REQUEST.replace("-", ""),
    "flow_id": FLOW.replace("-", ""),
    "evaluation_run_id": EVALUATION,
    "dataset_id": "fixture",
    "execution_mode": "replay",
    "execution_spec": SPEC,
    "execution_spec_sha256": SPEC_HASH,
    "summary": SUMMARY,
}


def artifacts(root):
    target = root / REQUEST / "evaluation"
    target.mkdir(parents=True)
    marker = {key: ROW[key] for key in ("dataset_id", "execution_mode", "execution_spec")}
    marker.update(request_id=REQUEST, prefect_flow_run_id=FLOW, execution_spec_sha256=SPEC_HASH)
    (target.parent / "request.json").write_text(json.dumps(marker), encoding="utf-8")
    raw = json.dumps({"evaluation_run_id": EVALUATION, "current": SUMMARY}).encode()
    report = "<html>복원 검사 🧪</html>".encode()
    (target / "comparison.json").write_bytes(raw)
    (target / "report.html").write_bytes(report)
    manifest = {
        "status": "completed",
        "execution_spec_sha256": SPEC_HASH,
        "evaluation_run_id": EVALUATION,
        "artifact_sha256": {
            "comparison.json": hashlib.sha256(raw).hexdigest(),
            "report.html": hashlib.sha256(report).hexdigest(),
        },
    }
    (target / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return snapshot.files.collect(root)


def prefect(root):
    db = sqlite3.connect(root / "prefect.db")
    db.executescript("""
CREATE TABLE alembic_version(version_num TEXT PRIMARY KEY);
INSERT INTO alembic_version VALUES ('synthetic');
CREATE TABLE deployment_schedule(active INTEGER);
INSERT INTO deployment_schedule VALUES (0);
CREATE TABLE deployment(id TEXT PRIMARY KEY);
INSERT INTO deployment VALUES ('deployment');
CREATE TABLE flow_run(id TEXT PRIMARY KEY, state_type TEXT, parameters TEXT, deployment_id TEXT);
CREATE TABLE flow_run_state(id TEXT PRIMARY KEY, flow_run_id TEXT, type TEXT);
""")
    db.execute(
        "INSERT INTO flow_run VALUES (?,?,?,?)",
        (FLOW.replace("-", ""), "COMPLETED", json.dumps({"request_id": REQUEST}), "deployment"),
    )
    db.execute("INSERT INTO flow_run_state VALUES (?,?,?)", ("state", FLOW, "COMPLETED"))
    db.commit()
    db.close()
    return snapshot.files.collect(root)


class LinkTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.entries = artifacts(self.root)

    def evidence(self, rows=None, entries=None):
        with patch.object(
            links.database,
            "query",
            return_value="\n".join(json.dumps(row) for row in ([ROW] if rows is None else rows)),
        ) as query:
            result = links.completed_evidence(["restored-db"], entries or self.entries)
        query.assert_called_once_with(["restored-db"], links.COMPLETED)
        return result

    def test_db_ids_select_artifacts_and_no_private_data_is_returned(self):
        expected = self.evidence()
        self.assertEqual(
            expected,
            {
                REQUEST: {
                    "flow_id": FLOW,
                    "report_sha256": self.entries[REQUEST + "/evaluation/report.html"]["sha256"],
                }
            },
        )
        self.assertNotIn("execution_spec", json.dumps(expected))

    def shared_rows(self):
        seed = json.loads(links.SEED.read_bytes())
        for item in seed["artifacts"]:
            source = links.SEED.parent / item["file"]
            raw = (
                gzip.decompress(source.read_bytes())
                if source.suffix == ".gz"
                else source.read_bytes()
            )
            target = self.root / item["path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
        rows = []
        for item in seed["records"]:
            if item["model"] == "evaluations.evaluationrun":
                fields = item["fields"]
                rows.append(
                    {
                        **{
                            key: fields[key]
                            for key in (
                                "evaluation_run_id",
                                "dataset_id",
                                "execution_mode",
                                "execution_spec",
                                "execution_spec_sha256",
                                "summary",
                            )
                        },
                        "id": item["pk"],
                        "flow_id": fields["prefect_flow_run_id"],
                        "requester_username": seed["reviewer"],
                        "requester_active": 0,
                    }
                )
        return rows, snapshot.files.collect(self.root)

    def test_exact_shared_seed_and_local_history_are_distinguished(self):
        shared, entries = self.shared_rows()
        expected = self.evidence([ROW, *shared], entries)
        self.assertNotIn("shared_review_copy", expected[REQUEST])
        self.assertEqual(snapshot.probe.prefect_runs(expected), {REQUEST: expected[REQUEST]})
        for row in shared:
            proof = expected[row["id"]]["shared_review_copy"]
            self.assertEqual(
                proof["seed_sha256"],
                hashlib.sha256(links.SEED.read_bytes()).hexdigest(),
            )
            self.assertGreaterEqual(proof["artifacts_verified"], 6)

    def test_same_ids_from_active_or_different_requester_still_require_prefect(self):
        shared, entries = self.shared_rows()
        for change in (
            {"requester_active": 1},
            {"requester_username": "local-operator"},
        ):
            with self.subTest(change=change):
                row = shared[0] | change
                expected = self.evidence([row], entries)
                self.assertNotIn("shared_review_copy", expected[row["id"]])
                self.assertEqual(snapshot.probe.prefect_runs(expected), expected)

    def test_shared_identity_or_any_seed_artifact_mismatch_is_rejected(self):
        shared, entries = self.shared_rows()
        for change in (
            {"flow_id": str(uuid4())},
            {"summary": {}},
            {"dataset_id": "other"},
        ):
            with self.subTest(change=change), self.assertRaises(ValueError):
                links.shared_review_copy(shared[0] | change, entries)
        # This file is outside the four normal DB/report linkage checks. Even a
        # self-consistently rehashed archive must match the reviewed seed bytes.
        path = self.root / shared[0]["id"] / "evaluation/results.json"
        path.write_bytes(b'{"changed":true}')
        with self.assertRaisesRegex(ValueError, "source seed"):
            self.evidence(shared, snapshot.files.collect(self.root))
        path.unlink()
        with self.assertRaises(KeyError):
            self.evidence(shared, snapshot.files.collect(self.root))

    @unittest.skipUnless(os.name == "posix", "Ownership restoration requires Linux")
    def test_mixed_shared_copies_preserve_reports_without_fabricating_prefect_history(
        self,
    ):
        shared, entries = self.shared_rows()
        expected = self.evidence([ROW, *shared], entries)
        with (
            tempfile.TemporaryDirectory() as source,
            tempfile.TemporaryDirectory() as target,
        ):
            pref = prefect(Path(source))
            result = snapshot.files.restore(Path(target), pref, "prefect", expected)
            self.assertEqual(result["matched_executions"], 1)
        with tempfile.TemporaryDirectory() as target:
            result = snapshot.files.restore(Path(target), entries, "results", expected)
            self.assertEqual(result["matched_executions"], 3)
        # Removing the real local execution remains a hard failure.
        with (
            tempfile.TemporaryDirectory() as source,
            tempfile.TemporaryDirectory() as target,
        ):
            root = Path(source)
            prefect(root)
            with closing(sqlite3.connect(root / "prefect.db")) as db, db:
                db.execute("DELETE FROM flow_run")
            with self.assertRaisesRegex(ValueError, "not preserved"):
                snapshot.files.restore(
                    Path(target), snapshot.files.collect(root), "prefect", expected
                )

    def test_empty_duplicate_unsupported_or_changed_db_evidence_fails(self):
        for rows in (
            [],
            [ROW, ROW],
            [ROW, ROW | {"id": uuid4().hex}],
            [ROW | {"execution_spec": {}}],
            [ROW | {"execution_spec_sha256": "0" * 64}],
            [ROW | {"evaluation_run_id": "b" * 32}],
            [ROW | {"dataset_id": "other"}],
            [ROW | {"summary": {"completed": True}}],
            [ROW | {"flow_id": None}],
        ):
            with self.subTest(rows=rows), self.assertRaises((ValueError, KeyError, TypeError)):
                self.evidence(rows)

    def test_all_completed_rows_are_checked_and_missing_files_fail(self):
        with self.assertRaises(KeyError):
            self.evidence([ROW, ROW | {"id": uuid4().hex, "flow_id": uuid4().hex}])
        for name in self.entries:
            if self.entries[name]["kind"] == "file":
                entries = copy.deepcopy(self.entries)
                del entries[name]
                with self.subTest(name=name), self.assertRaises(KeyError):
                    self.evidence(entries=entries)

    def test_rehashed_file_tampering_still_fails_db_or_manifest_link(self):
        base = self.root / REQUEST
        for name, change in (
            ("request.json", lambda row: row.update(prefect_flow_run_id=str(uuid4()))),
            ("request.json", lambda row: row.update(execution_spec={"changed": True})),
            ("evaluation/manifest.json", lambda row: row.update(status="failed")),
            ("evaluation/comparison.json", lambda row: row.update(evaluation_run_id="b" * 32)),
        ):
            target = base / name
            original = target.read_bytes()
            row = json.loads(original)
            change(row)
            target.write_text(json.dumps(row), encoding="utf-8")
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.evidence(entries=snapshot.files.collect(self.root))
            target.write_bytes(original)
        (base / "evaluation/report.html").write_bytes(b"a different report")
        with self.assertRaises(ValueError):
            self.evidence(entries=snapshot.files.collect(self.root))

    @unittest.skipUnless(os.name == "posix", "Ownership restoration requires Linux")
    def test_restored_prefect_matches_request_deployment_and_completed_history(self):
        expected = self.evidence()
        for change in (
            None,
            "DELETE FROM flow_run",
            "UPDATE flow_run SET parameters='{}'",
            "DELETE FROM deployment",
            "DELETE FROM flow_run_state",
            "UPDATE flow_run SET state_type='FAILED'",
        ):
            with (
                self.subTest(change=change),
                tempfile.TemporaryDirectory() as source,
                tempfile.TemporaryDirectory() as target,
            ):
                root = Path(source)
                entries = prefect(root)
                if change:
                    with sqlite3.connect(root / "prefect.db") as db:
                        db.execute(change)
                    entries = snapshot.files.collect(root)
                    with self.assertRaises(ValueError):
                        snapshot.files.restore(Path(target), entries, "prefect", expected)
                else:
                    result = snapshot.files.restore(Path(target), entries, "prefect", expected)
                    self.assertEqual(result["matched_executions"], 1)
                self.assertEqual(snapshot.files.collect(root), entries)

    @unittest.skipUnless(os.name == "posix", "Ownership restoration requires Linux")
    def test_result_restore_requires_every_expected_report(self):
        expected = self.evidence()
        for changed in (False, True):
            with tempfile.TemporaryDirectory() as target:
                if changed:
                    expected[REQUEST]["report_sha256"] = "0" * 64
                    with self.assertRaises(ValueError):
                        snapshot.files.restore(Path(target), self.entries, "results", expected)
                else:
                    result = snapshot.files.restore(Path(target), self.entries, "results", expected)
                    self.assertEqual(result["matched_executions"], 1)


@unittest.skipUnless(
    os.environ.get("OPS_DB_SNAPSHOT_MYSQL_IMAGE")
    and os.environ.get("OPS_VOLUME_SNAPSHOT_TEST_IMAGE"),
    "Real cross-store restore requires both explicitly selected fixture images",
)
class DockerLinkTests(unittest.TestCase):
    def test_encrypted_mysql_results_prefect_bundle_verifies_links_and_preserves_source(self):
        database = snapshot.database
        image = os.environ["OPS_DB_SNAPSHOT_MYSQL_IMAGE"]
        helper = os.environ["OPS_VOLUME_SNAPSHOT_TEST_IMAGE"]
        root_password = secrets.token_hex(32)
        app_password = "synthetic_복원_'_\\_$_password_1234567890"
        identity = (
            database.storage.run(
                [
                    "docker",
                    "create",
                    "--pull=never",
                    "--network=none",
                    "--memory=512m",
                    "--pids-limit=128",
                    "--tmpfs=/var/lib/mysql:rw,nosuid,size=384m",
                    "--env",
                    "MYSQL_ROOT_PASSWORD",
                    "--env",
                    "MYSQL_DATABASE=govbiz_ops",
                    image,
                    "--mysqlx=0",
                    "--performance-schema=OFF",
                    "--innodb-buffer-pool-size=64M",
                    "--skip-log-bin",
                ],
                env={**os.environ, "MYSQL_ROOT_PASSWORD": root_password},
            )
            .decode()
            .strip()
        )
        self.assertRegex(identity, r"^[a-f0-9]{64}$")
        try:
            database.storage.run(["docker", "start", identity])
            command = ["docker", "exec", "-i", identity, *database.storage.AUTH]
            deadline = time.monotonic() + 90
            while True:
                try:
                    version = database.query(command, "SELECT VERSION();")
                    break
                except database.storage.SnapshotError:
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(1)
            database.query(
                command,
                "SET SESSION sql_mode=''; SET @create_account=CONCAT("
                "'CREATE USER ''govbiz_ops''@''%'' IDENTIFIED WITH caching_sha2_password BY ',"
                "QUOTE(UNHEX('" + app_password.encode().hex() + "')));"
                "PREPARE create_account FROM @create_account; EXECUTE create_account;"
                "DEALLOCATE PREPARE create_account;",
            )
            authentication = database.read_accounts(command)
            database.query(
                command,
                """
CREATE TABLE django_migrations (id int PRIMARY KEY, name varchar(255)) CHARACTER SET utf8mb4;
INSERT INTO django_migrations VALUES (1,'0017_input_token_budget');
CREATE TABLE auth_user (
 id int PRIMARY KEY, username varchar(255), is_active boolean) CHARACTER SET utf8mb4;
INSERT INTO auth_user VALUES (1,'합성 사용자',true);
CREATE TABLE evaluations_evaluationrun (
 id char(32) PRIMARY KEY, prefect_flow_run_id char(32), evaluation_run_id varchar(32),
 dataset_id varchar(64), execution_mode varchar(16), execution_spec json,
 execution_spec_sha256 varchar(64), summary json, status varchar(16), requested_by_id int);
CREATE TABLE evaluations_evaluationbudgetreservation (id int PRIMARY KEY, closed_at datetime);
""",
            )
            values = [
                ROW[key]
                for key in (
                    "id",
                    "flow_id",
                    "evaluation_run_id",
                    "dataset_id",
                    "execution_mode",
                    "execution_spec",
                    "execution_spec_sha256",
                    "summary",
                )
            ] + ["COMPLETED", "1"]
            literals = [
                "_utf8mb4 0x"
                + (json.dumps(value) if isinstance(value, dict) else value).encode().hex()
                for value in values
            ]
            database.query(
                command,
                "INSERT INTO evaluations_evaluationrun VALUES (" + ",".join(literals) + ");",
            )
            sql = database.dump(command)
            data = db_payload() | {
                "mysql_image": image,
                "mysql_version": version,
                "sql": sql,
                "sql_sha256": hashlib.sha256(sql.encode()).hexdigest(),
                "table_counts": database.inventory(command),
            }
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                stores = {}
                for kind, fixture in (("results", artifacts), ("prefect", prefect)):
                    target = root / kind
                    target.mkdir()
                    stores[kind] = {"image": helper, "entries": fixture(target)}
                payload = {
                    "schema_version": 1,
                    "scope": snapshot.SCOPE,
                    "database": data,
                    "stores": stores,
                }
                runtime = key_payload() | {"image": helper, "database_accounts": authentication}
                runtime["keys"].update(database=app_password, mysql_root=root_password)
                runtime["proof"] = snapshot.runtime_keys.run_probe(runtime, "capture")
                payload["runtime_keys"] = runtime
                key = secrets.token_hex(32).encode()
                database.storage.exclusive(root / "key", key)
                database.storage.exclusive(root / "state.enc", database.storage.seal(payload, key))
                result = snapshot.verify(
                    root / "state.enc",
                    root / "key",
                    completed_links=True,
                    verify_runtime_keys=True,
                    database_login=True,
                )
                self.assertTrue(result["cross_store_business_links_verified"])
                self.assertEqual(result["matched_completed_evaluations"], 1)
                self.assertTrue(result["cleanup_complete"])
                self.assertFalse(result["full_backup_verified"])
                self.assertFalse(result["application_started"])
                login = result["runtime_key_checks"]["database_login_checks"]
                self.assertTrue(result["runtime_key_checks"]["database_login_verified"])
                self.assertTrue(login["source_authentication_hashes_restored"])
                self.assertTrue(login["root_login_verified"])
                self.assertTrue(login["application_login_verified"])
                self.assertTrue(login["wrong_passwords_rejected"])
                self.assertFalse(login["source_grants_restored"])
                for store in result["stores"].values():
                    self.assertEqual(store["matched_executions"], 1)
                self.assertNotIn(REQUEST, json.dumps(result))
                self.assertNotIn(SPEC_HASH, json.dumps(result))
                for password in (root_password, app_password):
                    self.assertNotIn(password, json.dumps(result))
                for account in authentication["accounts"]:
                    self.assertNotIn(account["authentication_hex"], json.dumps(result))
                for field in ("database", "mysql_root"):
                    broken = copy.deepcopy(payload)
                    broken["runtime_keys"]["keys"][field] = secrets.token_hex(32)
                    bad_archive = root / (field + ".enc")
                    database.storage.exclusive(bad_archive, database.storage.seal(broken, key))
                    with (
                        self.subTest(field=field),
                        self.assertRaisesRegex(ValueError, "cannot authenticate"),
                    ):
                        snapshot.verify(
                            bad_archive, root / "key", verify_runtime_keys=True, database_login=True
                        )
                for kind, store in stores.items():
                    self.assertEqual(snapshot.files.collect(root / kind), store["entries"])
            self.assertEqual(database.dump(command), sql)
            self.assertEqual(database.read_accounts(command), authentication)
        finally:
            database.storage.run(["docker", "rm", "--force", "--volumes", identity])


if __name__ == "__main__":
    unittest.main()
