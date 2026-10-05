"""Frozen-source guards, real file/SQLite payloads and isolated Docker restores."""

import copy
import hashlib
import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import ExitStack, contextmanager
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import ops_state_snapshot as snapshot
from test_ops_database_login import accounts
from test_ops_db_snapshot import payload as db_payload
from test_ops_runtime_keys import payload as key_payload

files = snapshot.files
IMAGE = "sha256:" + "a" * 64
IDENTITY = "b" * 64
SOURCE = {
    "compose_project": "fixture",
    "writers": {
        "b" * 64: {"service": "evaluation-runner", "image": IMAGE},
        "c" * 64: {"service": "prefect", "image": IMAGE},
    },
}
SQLITE = """
CREATE TABLE alembic_version(version_num TEXT PRIMARY KEY);
INSERT INTO alembic_version VALUES ('합성 migration');
CREATE TABLE deployment_schedule(active INTEGER);
INSERT INTO deployment_schedule VALUES (0);
CREATE TABLE flow_run(id TEXT PRIMARY KEY,state_type TEXT);
INSERT INTO flow_run VALUES ('synthetic','COMPLETED');
"""


def fixture(root, kind):
    if kind == "results":
        (root / "빈 디렉터리").mkdir()
        (root / "한글 🧪.json").write_text('{"값": [null,"검증"]}', encoding="utf-8")
        (root / "한글 🧪.json").chmod(0o640)
    else:
        connection = sqlite3.connect(root / "prefect.db")
        connection.executescript(SQLITE)
        connection.close()
    return files.collect(root)


class FileTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.source, self.target = self.root / "source", self.root / "target"
        self.source.mkdir()
        self.target.mkdir()

    @unittest.skipUnless(os.name == "posix", "Ownership restoration requires Linux")
    def test_archive_round_trip_preserves_bytes_directories_and_metadata(self):
        entries = fixture(self.source, "results")
        result = files.restore(self.target, entries, "results")
        self.assertEqual(result["status"], "VERIFIED")
        self.assertTrue(result["permissions_verified"])
        self.assertEqual(files.collect(self.target), entries)
        self.assertEqual(files.collect(self.source), entries)

    @unittest.skipUnless(os.name == "posix", "Ownership restoration requires Linux")
    def test_committed_prefect_wal_is_restored_and_checked(self):
        connection = sqlite3.connect(self.source / "prefect.db")
        self.addCleanup(connection.close)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA wal_autocheckpoint=0")
        connection.executescript(SQLITE)
        entries = files.collect(self.source)
        self.assertGreater(entries["prefect.db-wal"]["size"], 0)
        result = files.restore(self.target, entries, "prefect")
        self.assertTrue(result["sqlite_integrity"])
        self.assertEqual(result["migration_count"], 1)

    @unittest.skipUnless(os.name == "posix", "Ownership restoration requires Linux")
    def test_active_schedules_unfinished_flows_and_corrupt_sqlite_fail(self):
        for sql in (
            "UPDATE deployment_schedule SET active=1",
            "UPDATE flow_run SET state_type='RUNNING'",
            "DELETE FROM alembic_version",
        ):
            with self.subTest(sql=sql), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                fixture(root, "prefect")
                with sqlite3.connect(root / "prefect.db") as connection:
                    connection.execute(sql)
                with tempfile.TemporaryDirectory() as target, self.assertRaises(ValueError):
                    files.restore(Path(target), files.collect(root), "prefect")
        (self.source / "prefect.db").write_bytes(b"corrupt")
        with self.assertRaises(sqlite3.DatabaseError):
            files.restore(self.target, files.collect(self.source), "prefect")

    def test_paths_conflicting_parents_and_tampering_rejected_before_restore(self):
        entries = fixture(self.source, "results")
        name = "한글 🧪.json"
        for path in ("../escape", "/absolute", "child//file", "child\\file", "./relative", ""):
            with self.subTest(path=path), self.assertRaises(ValueError):
                files.restore(self.target, entries | {path: entries[name]}, "results")
        for change in ({"sha256": "0" * 64}, {"mode": 0o4755}, {"size": True}):
            invalid = copy.deepcopy(entries)
            invalid[name].update(change)
            with self.assertRaises(ValueError):
                files.restore(self.target, invalid, "results")
        with self.assertRaises(ValueError):
            files.restore(self.target, entries | {name + "/child": entries[name]}, "results")
        self.assertEqual(list(self.target.iterdir()), [])

    @unittest.skipUnless(os.name == "posix", "Linux links and special files")
    def test_links_special_files_and_source_changes_fail(self):
        fixture(self.source, "results")
        link = self.source / "link"
        for create in (
            lambda: link.symlink_to(self.target, target_is_directory=True),
            lambda: os.link(self.source / "한글 🧪.json", link),
            lambda: os.mkfifo(link),
        ):
            create()
            with self.assertRaises(ValueError):
                files.collect(self.source)
            link.unlink()
        before = files.tree(self.source)
        with patch.object(files, "tree", side_effect=[before, {}]), self.assertRaises(ValueError):
            files.collect(self.source)

    def test_existing_restore_directory_is_never_overwritten(self):
        entries = fixture(self.source, "results")
        (self.target / "keep").write_bytes(b"existing")
        with self.assertRaises(ValueError):
            files.restore(self.target, entries, "results")
        self.assertEqual((self.target / "keep").read_bytes(), b"existing")


class HelperTests(unittest.TestCase):
    def test_disposable_helper_is_private_read_only_on_source_and_cleanup_is_required(self):
        with tempfile.TemporaryDirectory() as directory:
            entries = fixture(Path(directory), "results")
        proof = {
            "status": "VERIFIED",
            "permissions_verified": True,
            "files": 1,
            "bytes": sum(row["size"] for row in entries.values()),
            "tree_sha256": hashlib.sha256(json.dumps(entries, sort_keys=True).encode()).hexdigest(),
        }
        for phase in ("collect", "restore", "bad-proof", "bad-exit", "cleanup"):
            events = []

            def run(args, events=events, phase=phase, **kwargs):
                events.append((args, kwargs))
                if args[:2] == ["docker", "create"]:
                    return IDENTITY.encode()
                if args[:2] == ["docker", "start"]:
                    return json.dumps(
                        entries if phase == "collect" else {} if phase == "bad-proof" else proof
                    ).encode()
                if args[:2] == ["docker", "rm"] and phase == "cleanup":
                    raise snapshot.storage.SnapshotError("cleanup failed")
                return b"[]"

            with (
                self.subTest(phase=phase),
                patch.object(snapshot.storage, "run", side_effect=run),
                patch.object(
                    snapshot.database,
                    "read_json",
                    return_value={
                        "Running": False,
                        "ExitCode": int(phase == "bad-exit"),
                        "OOMKilled": False,
                    },
                ),
            ):
                kwargs = (
                    {"source": "fixture_ops-results"}
                    if phase == "collect"
                    else {"entries": entries}
                )
                if phase in {"bad-proof", "bad-exit", "cleanup"}:
                    with self.assertRaises(ValueError):
                        snapshot.volume_helper(IMAGE, "results", **kwargs)
                else:
                    snapshot.volume_helper(IMAGE, "results", **kwargs)
            create = next(args for args, kwargs in events if args[:2] == ["docker", "create"])
            self.assertIn("--network=none", create)
            self.assertIn("--log-driver=none", create)
            self.assertIn("--read-only", create)
            self.assertNotIn(entries["한글 🧪.json"]["data"], " ".join(create))
            if phase == "collect":
                self.assertIn(
                    "type=volume,source=fixture_ops-results,target=/source,readonly", create
                )
            else:
                self.assertNotIn("--mount", create)
                self.assertIn("--tmpfs=/restore:rw,noexec,nosuid,size=192m", create)
            self.assertEqual(events[-1][0], ["docker", "rm", "--force", "--volumes", IDENTITY])


class SourceTests(unittest.TestCase):
    def setUp(self):
        stack = ExitStack()
        self.addCleanup(stack.close)
        self.containers = {}
        for identity, writer in SOURCE["writers"].items():
            kind = "prefect" if writer["service"] == "prefect" else "results"
            _, destination, suffix = snapshot.STORES[kind]
            self.containers[identity] = {
                "Id": identity,
                "Image": IMAGE,
                "RestartCount": 0,
                "Config": {
                    "Labels": {
                        "com.docker.compose.project": "fixture",
                        "com.docker.compose.service": writer["service"],
                    },
                    "Env": ["PREFECT_HOME=/var/lib/prefect"],
                },
                "State": {
                    "Running": False,
                    "Status": "exited",
                    "StartedAt": "start",
                    "FinishedAt": "end",
                },
                "Mounts": [
                    {
                        "Name": "fixture_" + suffix,
                        "Type": "volume",
                        "Destination": destination,
                        "RW": True,
                    }
                ],
            }
        self.volume_options = {}
        stack.enter_context(
            patch.object(
                snapshot.database,
                "read_json",
                side_effect=lambda args: [
                    {
                        "Name": args[-1],
                        "Driver": "local",
                        "Options": self.volume_options,
                        "CreatedAt": "created",
                        "Labels": {
                            "com.docker.compose.project": "fixture",
                            "com.docker.compose.volume": args[-1].removeprefix("fixture_"),
                        },
                    }
                ],
            )
        )
        self.ids = {"fixture_ops-results": ["b" * 64], "fixture_prefect-data": ["c" * 64]}
        stack.enter_context(
            patch.object(
                snapshot.storage,
                "run",
                side_effect=lambda args: "\n".join(
                    self.ids[args[-1].removeprefix("volume=")]
                ).encode(),
            )
        )
        stack.enter_context(
            patch.object(
                snapshot.storage, "inspect", side_effect=lambda identity: self.containers[identity]
            )
        )

    def test_owned_stopped_volumes_are_accepted(self):
        result = snapshot.volume_sources(SOURCE)
        self.assertEqual(set(result), {"results", "prefect"})
        self.assertEqual(result["results"]["volume"], "fixture_ops-results")

    def test_unlabelled_or_foreign_volume_is_rejected(self):
        for labels in (None, {"com.docker.compose.project": "another-project"}):
            with (
                self.subTest(labels=labels),
                patch.object(
                    snapshot.database,
                    "read_json",
                    return_value=[
                        {
                            "Name": "fixture_ops-results",
                            "Driver": "local",
                            "Options": None,
                            "Labels": labels,
                        }
                    ],
                ),
                self.assertRaisesRegex(ValueError, "ownership"),
            ):
                snapshot.volume_sources(SOURCE)

    def test_foreign_running_or_replaced_writer_is_rejected(self):
        original = copy.deepcopy(self.containers)
        for section, key, value in (
            ("State", "Running", True),
            ("State", "Paused", True),
            ("State", "Status", "restarting"),
            ("Config", "Labels", {}),
        ):
            self.containers = copy.deepcopy(original)
            self.containers[IDENTITY][section][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                snapshot.volume_sources(SOURCE)
        self.containers = copy.deepcopy(original)
        self.containers[IDENTITY]["Image"] = "sha256:" + "d" * 64
        with self.assertRaises(ValueError):
            snapshot.volume_sources(SOURCE)

    def test_unknown_consumers_external_sqlite_and_bind_backed_volumes_rejected(self):
        self.ids["fixture_ops-results"] += ["d" * 64]
        self.containers["d" * 64] = copy.deepcopy(self.containers[IDENTITY])
        self.containers["d" * 64]["Id"] = "d" * 64
        with self.assertRaises(ValueError):
            snapshot.volume_sources(SOURCE)
        self.ids["fixture_ops-results"] = [IDENTITY]
        self.volume_options = {"device": "/private", "o": "bind", "type": "none"}
        with self.assertRaises(ValueError):
            snapshot.volume_sources(SOURCE)
        self.volume_options = {}
        self.containers["c" * 64]["Config"]["Env"] += [
            "PREFECT_API_DATABASE_CONNECTION_URL=postgresql://external"
        ]
        with self.assertRaises(ValueError):
            snapshot.volume_sources(SOURCE)


@unittest.skipUnless(os.name == "posix", "Private archives and OpenSSL require Linux")
class ArchiveTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="ops-state-test-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.key, self.db_archive, self.output = (
            self.root / name for name in ("key", "db.enc", "stores.enc")
        )
        self.key_bytes = b"a" * 64
        snapshot.storage.exclusive(self.key, self.key_bytes)
        self.db = db_payload() | {"source": SOURCE}
        snapshot.storage.exclusive(self.db_archive, snapshot.storage.seal(self.db, self.key_bytes))
        self.stores = {}
        for kind in snapshot.STORES:
            target = self.root / kind
            target.mkdir()
            self.stores[kind] = {"image": IMAGE, "entries": fixture(target, kind)}
        self.sources = {
            kind: {"image": IMAGE, "volume": "fixture_" + spec[2]}
            for kind, spec in snapshot.STORES.items()
        }

    def mocks(self):
        stack = ExitStack()
        stack.enter_context(patch.object(snapshot.database, "load_settings", return_value={}))
        stack.enter_context(
            patch.object(snapshot.database, "frozen_source", return_value=([], SOURCE))
        )
        stack.enter_context(patch.object(snapshot.database, "dump", return_value=self.db["sql"]))
        stack.enter_context(patch.object(snapshot, "volume_sources", return_value=self.sources))
        stack.enter_context(
            patch.object(
                snapshot,
                "volume_helper",
                side_effect=lambda image, kind, **kwargs: self.stores[kind]["entries"],
            )
        )
        return stack

    def backup(self):
        return snapshot.backup(self.root, self.db_archive, self.key, self.output)

    def test_bundle_keeps_db_and_both_stores_encrypted_and_refuses_overwrite(self):
        with self.mocks():
            result = self.backup()
        self.assertEqual(result["status"], "BACKED_UP")
        self.assertFalse(result["full_backup_verified"])
        raw = self.output.read_bytes()
        payload = snapshot.validate(snapshot.storage.open_payload(raw, self.key_bytes))
        self.assertEqual(payload["database"], self.db)
        self.assertEqual(payload["stores"], self.stores)
        self.assertNotIn(self.db["sql"].encode(), raw)
        with self.assertRaises(ValueError):
            self.backup()
        self.assertEqual(self.output.read_bytes(), raw)

    def test_stale_db_writer_change_or_volume_change_prevents_publication(self):
        for name, options in (
            ("dump", {"side_effect": [self.db["sql"], "changed"]}),
            ("frozen_source", {"side_effect": [([], SOURCE), ([], SOURCE | {"changed": True})]}),
        ):
            with (
                self.mocks(),
                patch.object(snapshot.database, name, **options),
                self.assertRaises(ValueError),
            ):
                self.backup()
            self.assertFalse(self.output.exists())
        with (
            self.mocks(),
            patch.object(snapshot.database, "frozen_source", return_value=([], {})),
            self.assertRaises(ValueError),
        ):
            self.backup()
        with (
            self.mocks(),
            patch.object(
                snapshot,
                "volume_helper",
                side_effect=[
                    self.stores["results"]["entries"],
                    self.stores["prefect"]["entries"],
                    {},
                ],
            ),
            self.assertRaises(ValueError),
        ):
            self.backup()
        self.assertFalse(self.output.exists())

    def test_verify_requires_all_stores_and_cannot_succeed_on_partial_failure(self):
        with self.mocks():
            self.backup()
        for failure in (False, True):
            with (
                patch.object(
                    snapshot.database, "restore_database", return_value={"status": "VERIFIED"}
                ) as restore_db,
                patch.object(
                    snapshot,
                    "volume_helper",
                    side_effect=ValueError("cleanup") if failure else None,
                    return_value={"status": "VERIFIED"},
                ) as restore_files,
            ):
                if failure:
                    with self.assertRaises(ValueError):
                        snapshot.verify(self.output, self.key)
                else:
                    result = snapshot.verify(self.output, self.key)
                    self.assertFalse(result["full_backup_verified"])
                    self.assertFalse(result["application_started"])
                    self.assertFalse(result["cross_store_business_links_verified"])
                    self.assertEqual(restore_files.call_count, 2)
                restore_db.assert_called_once_with(self.db)

    def test_malformed_store_and_wrong_key_fail_before_docker(self):
        for stores in ({}, {"results": self.stores["results"]}, self.stores | {"other": {}}):
            with self.assertRaises(ValueError):
                snapshot.validate(
                    {
                        "schema_version": 1,
                        "scope": snapshot.SCOPE,
                        "database": self.db,
                        "stores": stores,
                    }
                )
        with self.mocks():
            self.backup()
        self.key.write_bytes(b"b" * 64)
        with patch.object(snapshot.storage, "run") as run, self.assertRaises(ValueError):
            snapshot.verify(self.output, self.key)
        run.assert_not_called()

    def test_completed_link_failures_and_database_cleanup_cannot_report_success(self):
        with self.mocks():
            self.backup()
        expected = {"private-request-id": {"flow_id": "private-flow-id"}}
        for failure in (None, "links", "db-cleanup", "prefect"):
            events = []

            @contextmanager
            def restored(_, events=events, failure=failure):
                try:
                    yield ["restored-db"]
                finally:
                    events.append("db-cleanup")
                    if failure == "db-cleanup":
                        raise ValueError("cleanup failed")

            def volume(image, kind, events=events, failure=failure, **kwargs):
                self.assertEqual(events, ["db-cleanup"])
                self.assertEqual(kwargs["expected"], expected)
                if failure == "prefect" and kind == "prefect":
                    raise ValueError("missing completed history")
                return {"matched_executions": 1}

            with (
                self.subTest(failure=failure),
                patch.object(snapshot.database, "restored_database", side_effect=restored),
                patch.object(
                    snapshot,
                    "completed_evidence",
                    return_value=expected,
                    side_effect=ValueError("links") if failure == "links" else None,
                ),
                patch.object(snapshot, "volume_helper", side_effect=volume) as helper,
            ):
                if failure:
                    with self.assertRaises(ValueError):
                        snapshot.verify(self.output, self.key, completed_links=True)
                    if failure in {"links", "db-cleanup"}:
                        helper.assert_not_called()
                else:
                    result = snapshot.verify(self.output, self.key, completed_links=True)
                    self.assertTrue(result["cross_store_business_links_verified"])
                    self.assertEqual(result["matched_completed_evaluations"], 1)
                    self.assertEqual(result["cross_store_scope"], "completed_evaluations")
                    self.assertFalse(result["full_backup_verified"])
                    self.assertNotIn("private-request-id", json.dumps(result))
            self.assertEqual(events, ["db-cleanup"])

    def test_custom_prefect_profile_is_not_mistaken_for_the_default_database(self):
        (self.root / "prefect" / "profiles.toml").write_text("[profiles.custom]\n")
        self.stores["prefect"]["entries"] = files.collect(self.root / "prefect")
        with self.mocks(), self.assertRaises(ValueError):
            self.backup()
        self.assertFalse(self.output.exists())

    def test_runtime_keys_are_optional_encrypted_and_verified_without_exposing_values(self):
        value = key_payload()
        with (
            self.mocks(),
            patch.object(snapshot.runtime_keys, "capture", return_value=value) as capture,
            patch.object(snapshot.runtime_keys, "run_probe", return_value={"synthetic": True}),
        ):
            result = snapshot.backup(
                self.root, self.db_archive, self.key, self.output, include_runtime_keys=True
            )
        self.assertTrue(result["runtime_keys_included"])
        self.assertEqual(capture.call_count, 2)
        for key in value["keys"].values():
            self.assertNotIn(key.encode(), self.output.read_bytes())
        with (
            patch.object(
                snapshot.database, "restore_database", return_value={"status": "VERIFIED"}
            ),
            patch.object(snapshot, "volume_helper", return_value={"status": "VERIFIED"}),
            patch.object(
                snapshot.runtime_keys, "run_probe", return_value={"status": "VERIFIED"}
            ) as probe,
        ):
            result = snapshot.verify(self.output, self.key, verify_runtime_keys=True)
        self.assertTrue(result["runtime_keys_verified"])
        self.assertEqual(probe.call_args.args[1], "verify")
        self.assertFalse(result["runtime_key_checks"]["usage_receipt_signatures_verified"])
        self.assertFalse(result["runtime_key_checks"]["database_login_verified"])
        self.assertFalse(result["full_backup_verified"])
        for key in value["keys"].values():
            self.assertNotIn(key, json.dumps(result))

    def test_key_rotation_during_capture_prevents_archive_and_missing_keys_fail_before_restore(
        self,
    ):
        value = key_payload()
        with (
            self.mocks(),
            patch.object(
                snapshot.runtime_keys, "capture", side_effect=[value, value | {"changed": True}]
            ),
            patch.object(snapshot.runtime_keys, "run_probe", return_value={}),
            self.assertRaises(ValueError),
        ):
            snapshot.backup(
                self.root, self.db_archive, self.key, self.output, include_runtime_keys=True
            )
        self.assertFalse(self.output.exists())
        with self.mocks():
            self.backup()
        with (
            patch.object(snapshot.database, "restore_database") as restore,
            self.assertRaises(ValueError),
        ):
            snapshot.verify(self.output, self.key, verify_runtime_keys=True)
        restore.assert_not_called()

    def test_database_login_requires_keys_and_original_hashes_before_restore(self):
        with (
            patch.object(snapshot.storage, "key_bytes") as key,
            self.assertRaisesRegex(ValueError, "requires runtime key"),
        ):
            snapshot.verify(self.output, self.key, database_login=True)
        key.assert_not_called()
        # Previous archives remain usable for key-only verification, not DB login.
        value = {
            "schema_version": 1,
            "scope": snapshot.SCOPE,
            "database": self.db,
            "stores": self.stores,
            "runtime_keys": key_payload(),
        }
        snapshot.storage.exclusive(self.output, snapshot.storage.seal(value, self.key_bytes))
        with (
            patch.object(snapshot.database, "restored_database") as restore,
            self.assertRaisesRegex(ValueError, "Missing source MySQL"),
        ):
            snapshot.verify(self.output, self.key, verify_runtime_keys=True, database_login=True)
        restore.assert_not_called()

    def test_database_login_runs_after_link_reads_and_requires_successful_cleanup(self):
        value = {
            "schema_version": 1,
            "scope": snapshot.SCOPE,
            "database": self.db,
            "stores": self.stores,
            "runtime_keys": key_payload() | {"database_accounts": accounts()},
        }
        snapshot.storage.exclusive(self.output, snapshot.storage.seal(value, self.key_bytes))
        for failure in (None, "login", "cleanup"):
            events = []

            @contextmanager
            def restored(_, events=events, failure=failure):
                try:
                    yield ["restored-db"]
                finally:
                    events.append("cleanup")
                    if failure == "cleanup":
                        raise ValueError("cleanup failed")

            def links(*args, events=events):
                events.append("links")
                return {}

            def login(*args, events=events, failure=failure):
                events.append("login")
                if failure == "login":
                    raise ValueError("login failed")
                return {"database_login_verified": True}

            with (
                self.subTest(failure=failure),
                patch.object(snapshot.database, "restored_database", side_effect=restored),
                patch.object(snapshot, "completed_evidence", side_effect=links),
                patch.object(snapshot.database, "verify_database_login", side_effect=login),
                patch.object(snapshot, "volume_helper", return_value={}) as helper,
                patch.object(snapshot.runtime_keys, "run_probe", return_value={}) as probe,
            ):
                if failure:
                    with self.assertRaises(ValueError):
                        snapshot.verify(
                            self.output,
                            self.key,
                            completed_links=True,
                            verify_runtime_keys=True,
                            database_login=True,
                        )
                    helper.assert_not_called()
                    probe.assert_not_called()
                else:
                    result = snapshot.verify(
                        self.output,
                        self.key,
                        completed_links=True,
                        verify_runtime_keys=True,
                        database_login=True,
                    )
                    self.assertTrue(result["runtime_key_checks"]["database_login_verified"])
                    self.assertFalse(result["runtime_key_checks"]["core_authentication_verified"])
                    self.assertFalse(result["full_backup_verified"])
            self.assertEqual(events, ["links", "login", "cleanup"])

    def test_cli_redacts_failure_and_prints_no_success(self):
        with (
            patch(
                "sys.argv",
                ["ops_state_snapshot.py", "verify", "--archive", "private", "--key-file", "key"],
            ),
            patch.object(snapshot, "verify", side_effect=ValueError("private content")),
            patch.object(snapshot.os, "umask"),
            patch("builtins.print") as output,
            patch("sys.stderr") as error,
        ):
            with self.assertRaises(SystemExit) as status:
                snapshot.main()
        self.assertEqual(status.exception.code, 1)
        output.assert_not_called()
        self.assertNotIn("private content", str(error.write.call_args_list))


@unittest.skipUnless(
    os.environ.get("OPS_VOLUME_SNAPSHOT_TEST_IMAGE"),
    "Docker fixture image is explicitly enabled in CI",
)
class DockerVolumeTests(unittest.TestCase):
    def test_real_named_volumes_round_trip_without_source_mutation_or_persistent_restore(self):
        image = os.environ["OPS_VOLUME_SNAPSHOT_TEST_IMAGE"]
        self.assertRegex(image, r"^sha256:[a-f0-9]{64}$")
        for kind in snapshot.STORES:
            with self.subTest(kind=kind):
                volume = "govbiz-state-fixture-" + uuid4().hex
                snapshot.storage.run(["docker", "volume", "create", volume])
                identity = None
                try:
                    program = (
                        "from pathlib import Path\nimport os, sqlite3\nroot=Path('/fixture')\n"
                        + (
                            "(root/'빈 디렉터리').mkdir()\n"
                            "(root/'report.html').write_text('한글 🧪')\n"
                            if kind == "results"
                            else "db=sqlite3.connect(root/'prefect.db')\ndb.executescript("
                            + repr(SQLITE)
                            + ")\ndb.close()\n"
                        )
                        + "for path in [*root.rglob('*'), root]: os.chown(path, 10001, 10001)\n"
                    )
                    identity = (
                        snapshot.storage.run(
                            [
                                "docker",
                                "create",
                                "--pull=never",
                                "--user=0:0",
                                "--network=none",
                                "--log-driver=none",
                                "--mount",
                                "type=volume,source=" + volume + ",target=/fixture",
                                "--entrypoint",
                                "python",
                                image,
                                "-B",
                                "-c",
                                program,
                            ]
                        )
                        .decode()
                        .strip()
                    )
                    self.assertRegex(identity, r"^[a-f0-9]{64}$")
                    snapshot.storage.run(["docker", "start", "--attach", identity])
                    state = snapshot.database.read_json(
                        ["docker", "inspect", "--format", "{{json .State}}", identity]
                    )
                    self.assertEqual(state["ExitCode"], 0)
                    before = snapshot.volume_helper(image, kind, source=volume)
                    self.assertTrue(all(row["uid"] == 10001 for row in before.values()))
                    key = b"a" * 64
                    restored = snapshot.storage.open_payload(
                        snapshot.storage.seal({"entries": before}, key), key
                    )["entries"]
                    result = snapshot.volume_helper(image, kind, entries=restored)
                    self.assertEqual(result["status"], "VERIFIED")
                    if kind == "prefect":
                        self.assertTrue(result["sqlite_integrity"])
                    self.assertEqual(snapshot.volume_helper(image, kind, source=volume), before)
                finally:
                    try:
                        if identity:
                            snapshot.storage.run(["docker", "rm", "--force", "--volumes", identity])
                    finally:
                        snapshot.storage.run(["docker", "volume", "rm", volume])


if __name__ == "__main__":
    unittest.main()
