"""Restore rehearsal must isolate writes, detect corruption and fail on cleanup."""

import json
import subprocess
import unittest
from unittest.mock import patch

import smoke_ops_backup as smoke

SETTINGS = {
    "repository": "bridge-smoke/local",
    "cluster": "govbiz-bridge-smoke-0123456789",
    "namespace": "govbiz-msa",
}
IDENTITY = "b" * 64
IMAGE = "govbiz-ops-service:bridge-fixture"
IMAGE_ID = "sha256:" + "d" * 64
RELEASE = "e" * 64
EXPECTED = {
    f"00000000-0000-4000-8000-{n:012d}": {
        "flow_id": f"00000000-0000-4000-8001-{n:012d}",
        "execution_spec_sha256": "c" * 64,
        "report_sha256": "f" * 64,
    }
    for n in range(3)
}
DUMP = "CREATE TABLE `django_migrations` (id int);\n-- synthetic UTF-8 복원 🧪\n"


class RestoreTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.report = {}
        self.source_dump = DUMP
        self.target_dump = DUMP
        self.target_counts = None
        self.source_tables = sorted(smoke.REQUIRED_TABLES)
        self.constraint_rejected = True
        self.tamper_changes = True
        self.fail_command = None
        self.readiness_failures = 0
        self.remaining_pods = []
        self.target_version = "8.4.8"
        self.preflight = {"status": "PASS"}
        for owner, name, options in (
            (smoke.fork_cluster, "require_dev", {}),
            (
                smoke.fork_cluster,
                "commands",
                {"return_value": ([], ["kubectl", "fixture"], [])},
            ),
            (
                smoke.ops_runtime,
                "upgrade_preflight",
                {"side_effect": lambda *a: self.preflight},
            ),
            (smoke, "execute", {"side_effect": self.execute}),
            (smoke, "application_read", {"side_effect": self.application_read}),
            (smoke.ops_core_restore_fixture, "restored_core", {}),
            (smoke.smoke_ops_volumes, "verify", {"side_effect": self.volume_read}),
            (smoke.time, "sleep", {}),
        ):
            mocker = patch.object(owner, name, **options)
            mocker.start()
            self.addCleanup(mocker.stop)

    def execute(self, command, *, data=None, **kwargs):
        command = [str(part) for part in command]
        self.events.append((command, data, kwargs))
        if self.fail_command and self.fail_command(command, data):
            raise subprocess.CalledProcessError(1, command, stderr="private-error")
        if command[:3] == ["kubectl", "fixture", "get"]:
            if command[3] == "deployment":
                return json.dumps(
                    {
                        "spec": {
                            "template": {
                                "spec": {
                                    "containers": [
                                        {"name": "ops-service", "image": IMAGE}
                                    ]
                                }
                            }
                        }
                    }
                )
            return json.dumps(
                {"spec": {"containers": [{"name": "mysql", "image": "mysql:8.4"}]}}
                if command[3] == "pod"
                else {"items": self.remaining_pods}
            )
        if command[-2:] == ["python", "-"]:
            compile(data, "backup-fixtures", "exec")
            return "backup-fixtures-ready\n"
        if command[:2] == ["docker", "create"]:
            return IDENTITY
        if command[:3] == ["docker", "image", "inspect"]:
            return IMAGE_ID
        target = command[:2] == ["docker", "exec"]
        if "mysqldump" in command:
            return self.target_dump if target else self.source_dump
        if "mysql" in command and command[-1] == smoke.DATABASE:
            if data == "SELECT VERSION();":
                if target and self.readiness_failures:
                    self.readiness_failures -= 1
                    raise subprocess.CalledProcessError(1, command)
                return self.target_version if target else "8.4.8"
            if data == smoke.TABLES:
                return "\n".join(self.source_tables)
            if data.startswith("SELECT '"):
                return (
                    self.target_counts
                    if target and self.target_counts is not None
                    else "\n".join(name + "\t1" for name in self.source_tables)
                )
            if data.startswith("UPDATE evaluations_evaluationreview SET run_id="):
                if self.constraint_rejected:
                    raise subprocess.CalledProcessError(
                        1, command, stderr="ERROR 1452 (23000)"
                    )
            if (
                data.startswith("UPDATE evaluations_evaluationreview SET comment=")
                and self.tamper_changes
            ):
                self.target_dump += "tampered"
        return ""

    def application_read(
        self, target, database_id, image_id, expected, release, evidence
    ):
        self.assertEqual(database_id, IDENTITY)
        self.assertEqual(image_id, IMAGE_ID)
        self.assertEqual(expected, EXPECTED)
        self.assertEqual(release, RELEASE)
        evidence["application"] = {"status": "PASS"}
        return "temporary-reader-password"

    def volume_read(self, state, settings, compose, env, expected, report, *, database):
        self.assertEqual(
            database,
            {
                "id": IDENTITY,
                "image": IMAGE_ID,
                "password": "temporary-reader-password",
                "core_password": "fixture-admin-password",
            },
        )
        self.assertEqual(report["database_restore"]["status"], "FAIL")
        self.assertFalse(report["database_restore"]["cleanup_complete"])
        self.assertTrue(report["database_restore"]["restored_database_ready"])
        self.assertEqual(self.removed(), [])
        report["volume_restore"] = {"results": {"ops_http": {"status": "PASS"}}}
        return IMAGE_ID

    def verify(self):
        smoke.verify(
            "/temporary-fixture",
            SETTINGS,
            self.report,
            ops_image=IMAGE,
            core_image="fixture-core-image",
            core_password="fixture-admin-password",
            expected=EXPECTED,
            release_sha256=RELEASE,
            compose=["compose"],
            compose_env={},
        )
        return self.report["database_restore"]

    def removed(self):
        return [event[0] for event in self.events if event[0][:2] == ["docker", "rm"]]

    def test_full_dump_restore_uses_no_network_or_shared_storage_and_preserves_source(
        self,
    ):
        result = self.verify()
        self.assertEqual(result["status"], "PASS")
        for key in (
            "source_preserved",
            "foreign_key_enforced",
            "tampering_detected",
            "cleanup_complete",
        ):
            self.assertTrue(result[key])
        for key in (
            "backup_verified",
            "personal_environment_verified",
            "artifacts_restored",
            "prefect_restored",
        ):
            self.assertFalse(result[key])
        create, _, options = next(
            event for event in self.events if event[0][:2] == ["docker", "create"]
        )
        self.assertEqual(create[create.index("--network") + 1], "none")
        self.assertIn("/var/lib/mysql:rw,nosuid,size=512m", create)
        self.assertNotIn(options["env"]["MYSQL_ROOT_PASSWORD"], " ".join(create))
        self.assertFalse({"--publish", "-p", "--volume", "-v", "--mount"} & set(create))
        self.assertEqual(
            self.removed(), [["docker", "rm", "--force", "--volumes", IDENTITY]]
        )
        dumps = [event for event in self.events if "mysqldump" in event[0]]
        self.assertEqual(len(dumps), 6)
        self.assertTrue(result["application"]["database_unchanged"])
        self.assertTrue(
            self.report["volume_restore"]["results"]["ops_http"]["database_unchanged"]
        )
        self.assertTrue(all(event[0][-1] == smoke.DATABASE for event in dumps))
        self.assertTrue(
            all("--routines" in event[0] and "--events" in event[0] for event in dumps)
        )
        restores = [event for event in self.events if event[1] == DUMP]
        self.assertEqual(len(restores), 1)
        self.assertEqual(restores[0][0][:4], ["docker", "exec", "-i", IDENTITY])
        self.assertNotIn("CREATE TABLE", json.dumps(result))
        self.assertNotIn("MYSQL_ROOT_PASSWORD", json.dumps(result))
        scale = next(i for i, event in enumerate(self.events) if "scale" in event[0])
        dump = next(i for i, event in enumerate(self.events) if "mysqldump" in event[0])
        self.assertLess(scale, dump)

    def test_personal_environment_is_rejected_before_any_command(self):
        for change in (
            {"repository": "ilil1/SKN34-4th-1Team"},
            {"cluster": "govbiz-f218b0ac1c"},
            {"namespace": "default"},
        ):
            with (
                self.subTest(change=change),
                self.assertRaisesRegex(ValueError, "disposable"),
            ):
                smoke.verify(
                    "/unused",
                    SETTINGS | change,
                    self.report,
                    ops_image=IMAGE,
                    core_image="fixture-core-image",
                    core_password="fixture-admin-password",
                    expected=EXPECTED,
                    release_sha256=RELEASE,
                    compose=["compose"],
                    compose_env={},
                )
            self.assertEqual(self.events, [])

    def test_ownership_failure_prevents_data_writes(self):
        with patch.object(
            smoke.fork_cluster, "require_dev", side_effect=ValueError("owner")
        ):
            with self.assertRaisesRegex(ValueError, "owner"):
                self.verify()
        self.assertEqual(self.events, [])

    def test_blocked_preflight_prevents_stopping_writers_and_dump(self):
        self.preflight = {"status": "BLOCKED"}
        with self.assertRaisesRegex(ValueError, "Outstanding"):
            self.verify()
        self.assertFalse(
            any(
                "scale" in command or "mysqldump" in command
                for command, _, _ in self.events
            )
        )

    def test_remaining_writer_prevents_dump(self):
        self.remaining_pods = [{"metadata": {"name": "still-running"}}]
        with self.assertRaisesRegex(ValueError, "writers remain"):
            self.verify()
        self.assertFalse(any("mysqldump" in command for command, _, _ in self.events))

    def test_missing_tables_or_empty_dump_cannot_pass(self):
        with patch.object(smoke, "inventory", return_value={"django_migrations": 1}):
            self.source_dump = ""
            with self.assertRaisesRegex(ValueError, "Incomplete"):
                self.verify()
        self.source_dump = DUMP
        self.source_tables = ["django_migrations"]
        with self.assertRaisesRegex(ValueError, "inventory"):
            self.verify()
        self.assertEqual(self.removed(), [])

    def test_zero_missing_duplicate_or_invalid_counts_cannot_pass(self):
        rows = [name + "\t1" for name in self.source_tables]
        for invalid in (
            [row.replace("\t1", "\t0") for row in rows],
            rows[:-1],
            rows + [rows[0]],
            [rows[0].replace("\t1", "\t-1"), *rows[1:]],
        ):
            self.target_counts = "\n".join(invalid)
            with self.subTest(rows=invalid), self.assertRaises(ValueError):
                self.verify()
            self.assertEqual(self.report["database_restore"]["status"], "FAIL")

    def test_unexpected_table_identifier_is_never_interpolated_into_sql(self):
        self.source_tables.append("bad`; DROP DATABASE govbiz_ops; --")
        with self.assertRaisesRegex(ValueError, "inventory"):
            self.verify()
        self.assertFalse(
            any(data and "DROP DATABASE" in data for _, data, _ in self.events)
        )

    def test_changed_target_rows_or_schema_cannot_pass(self):
        self.target_dump = DUMP + "changed schema or row"
        with self.assertRaisesRegex(ValueError, "comparison"):
            self.verify()
        self.assertEqual(self.report["database_restore"]["status"], "FAIL")
        self.assertEqual(len(self.removed()), 1)

    def test_changed_row_counts_cannot_pass(self):
        self.target_counts = "\n".join(name + "\t2" for name in self.source_tables)
        with self.assertRaisesRegex(ValueError, "counts differ"):
            self.verify()
        self.assertEqual(len(self.removed()), 1)

    def test_foreign_key_must_reject_invalid_reference(self):
        self.constraint_rejected = False
        with self.assertRaisesRegex(ValueError, "foreign key"):
            self.verify()
        self.assertEqual(len(self.removed()), 1)

    def test_tampering_must_be_detected(self):
        self.tamper_changes = False
        with self.assertRaisesRegex(ValueError, "tampering was not detected"):
            self.verify()

    def test_changed_source_cannot_pass(self):
        original = self.execute
        calls = 0

        def changing(command, **kwargs):
            nonlocal calls
            if "mysqldump" in command and command[0] == "kubectl":
                calls += 1
                if calls > 1:
                    self.source_dump += "changed source"
            return original(command, **kwargs)

        with patch.object(smoke, "execute", side_effect=changing):
            with self.assertRaisesRegex(ValueError, "comparison"):
                self.verify()
        self.assertEqual(self.report["database_restore"]["status"], "FAIL")

    def test_mysql_version_mismatch_blocks_import(self):
        self.target_version = "8.4.9"
        with self.assertRaisesRegex(ValueError, "versions differ"):
            self.verify()
        self.assertFalse(any(data == DUMP for _, data, _ in self.events))
        self.assertEqual(len(self.removed()), 1)

    def test_readiness_retries_and_rejects_timeout(self):
        self.readiness_failures = 1
        self.assertEqual(self.verify()["status"], "PASS")
        self.readiness_failures = 2
        with patch.object(smoke.time, "monotonic", side_effect=[0, 121]):
            with self.assertRaisesRegex(ValueError, "startup timed out"):
                self.verify()

    def test_import_failure_still_cleans_only_created_container(self):
        self.fail_command = lambda command, data: data == DUMP
        with self.assertRaises(subprocess.CalledProcessError):
            self.verify()
        self.assertEqual(
            self.removed(), [["docker", "rm", "--force", "--volumes", IDENTITY]]
        )
        self.assertEqual(self.report["database_restore"]["status"], "FAIL")

    def test_create_failure_never_deletes_unknown_container(self):
        self.fail_command = lambda command, data: command[:2] == ["docker", "create"]
        with self.assertRaises(subprocess.CalledProcessError):
            self.verify()
        self.assertEqual(self.removed(), [])

    def test_cleanup_failure_prevents_success(self):
        self.fail_command = lambda command, data: command[:2] == ["docker", "rm"]
        with self.assertRaises(subprocess.CalledProcessError):
            self.verify()
        self.assertEqual(self.report["database_restore"]["status"], "FAIL")
        self.assertFalse(self.report["database_restore"]["cleanup_complete"])

    def test_application_failure_still_removes_mysql_and_cannot_pass(self):
        with patch.object(
            smoke, "application_read", side_effect=ValueError("readiness")
        ):
            with self.assertRaisesRegex(ValueError, "readiness"):
                self.verify()
        self.assertEqual(self.report["database_restore"]["status"], "FAIL")
        self.assertEqual(len(self.removed()), 1)

    def test_database_changed_during_application_read_cannot_pass(self):
        def changed(*args):
            self.application_read(*args)
            self.target_dump += "unexpected application write"

        with patch.object(smoke, "application_read", side_effect=changed):
            with self.assertRaisesRegex(ValueError, "comparison"):
                self.verify()
        self.assertEqual(self.report["database_restore"]["status"], "FAIL")

    def test_other_deployed_image_rejected_before_fixtures_or_stop(self):
        with self.assertRaisesRegex(ValueError, "image differs"):
            smoke.verify(
                "/temporary-fixture",
                SETTINGS,
                self.report,
                ops_image="another-image",
                core_image="fixture-core-image",
                core_password="fixture-admin-password",
                expected=EXPECTED,
                release_sha256=RELEASE,
                compose=["compose"],
                compose_env={},
            )
        self.assertFalse(
            any(
                "scale" in command or data == smoke.FIXTURES
                for command, data, _ in self.events
            )
        )

    def test_core_cleanup_failure_cannot_pass_and_still_removes_mysql(self):
        with patch.object(smoke.ops_core_restore_fixture, "restored_core") as core:
            core.return_value.__exit__.side_effect = ValueError("Core cleanup failed")
            with self.assertRaisesRegex(ValueError, "Core cleanup"):
                self.verify()
        self.assertEqual(self.report["database_restore"]["status"], "FAIL")
        self.assertTrue(self.report["database_restore"]["cleanup_complete"])
        self.assertEqual(
            self.removed(), [["docker", "rm", "--force", "--volumes", IDENTITY]]
        )

    def test_http_or_volume_failure_still_cleans_mysql(self):
        with patch.object(
            smoke.smoke_ops_volumes, "verify", side_effect=ValueError("HTTP")
        ):
            with self.assertRaisesRegex(ValueError, "HTTP"):
                self.verify()
        self.assertEqual(len(self.removed()), 1)
        self.assertEqual(self.report["database_restore"]["status"], "FAIL")

    def test_http_database_write_blocks_success(self):
        def changed(*args, **kwargs):
            image = self.volume_read(*args, **kwargs)
            self.target_dump += "changed during HTTP"
            return image

        with patch.object(smoke.smoke_ops_volumes, "verify", side_effect=changed):
            with self.assertRaisesRegex(ValueError, "comparison"):
                self.verify()
        self.assertEqual(self.report["database_restore"]["status"], "FAIL")
        self.assertNotIn(
            "database_unchanged", self.report["volume_restore"]["results"]["ops_http"]
        )


if __name__ == "__main__":
    unittest.main()
