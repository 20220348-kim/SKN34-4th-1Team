"""Core auth rehearsal must copy only owned data and fail closed on cleanup."""

import json
import subprocess
import unittest
from unittest.mock import patch

import ops_core_restore_fixture as fixture

DATABASE = "a" * 64
CONTAINER = "b" * 64
IMAGE = "sha256:" + "c" * 64
DUMP = "\n".join(
    "CREATE TABLE `" + name + "` (id int);"
    for name in ("account", "account_session", "flyway_schema_history")
)


class CoreRestoreTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.report = {}
        self.remaining = []
        self.deployed_image = IMAGE
        self.source_dump = DUMP
        self.copy_dump = DUMP
        self.state = {"Running": False, "OOMKilled": False, "ExitCode": 143}
        self.fail = None

    def execute(self, command, **options):
        self.events.append((command, options))
        if self.fail and command[:2] == ["docker", self.fail]:
            raise subprocess.CalledProcessError(1, command)
        if command[:3] == ["kubectl", "get", "deployment"]:
            return json.dumps(
                {
                    "spec": {
                        "template": {
                            "spec": {"containers": [{"image": self.deployed_image}]}
                        }
                    }
                }
            )
        if command[:3] == ["kubectl", "get", "pod"]:
            return json.dumps({"spec": {"containers": [{"image": "mysql:8.4"}]}})
        if command[:3] == ["kubectl", "get", "pods"]:
            return json.dumps({"items": self.remaining})
        if command[:3] == ["docker", "image", "inspect"]:
            return IMAGE
        if "mysqldump" in command:
            return self.copy_dump if command[0] == "target" else self.source_dump
        if command[:2] == ["docker", "create"]:
            return CONTAINER
        if command[:2] == ["docker", "inspect"]:
            return json.dumps(self.state)
        return ""

    def run_fixture(self, body=None):
        with patch.object(fixture, "execute", side_effect=self.execute):
            with fixture.restored_core(
                ["kubectl"], ["target"], DATABASE, IMAGE, self.report
            ):
                if body:
                    body()
        return self.report["core_auth_restore"]

    def test_copy_and_real_core_are_isolated_without_secret_or_full_backup_claims(self):
        evidence = self.run_fixture()
        self.assertEqual(evidence["status"], "PASS")
        self.assertTrue(evidence["cleanup_complete"])
        self.assertTrue(evidence["source_preserved"])
        self.assertFalse(evidence["backup_verified"])
        self.assertFalse(evidence["original_signing_key_restored"])
        command, options = next(
            event for event in self.events if event[0][:2] == ["docker", "create"]
        )
        self.assertEqual(
            command[command.index("--network") + 1], "container:" + DATABASE
        )
        self.assertFalse({"--publish", "--mount", "--volume"} & set(command))
        env = options["env"]
        self.assertEqual(env["SPRING_FLYWAY_ENABLED"], "false")
        self.assertEqual(env["SPRING_DATASOURCE_USERNAME"], "core_restore_fixture")
        self.assertEqual(env["APPLICATION_DOCUMENT_JOBS_ENABLED"], "false")
        self.assertEqual(env["APP_CORS_ALLOWED_ORIGIN"], "http://127.0.0.1:5173")
        for key in (
            "SPRING_DATASOURCE_PASSWORD",
            "ACCOUNT_JWT_SECRET",
            "ACCOUNT_DEV_LOGIN_PASSWORD",
        ):
            self.assertNotIn(env[key], " ".join(command))
            self.assertNotIn(env[key], json.dumps(evidence))
        self.assertNotIn("CREATE TABLE", json.dumps(evidence))
        sql = "\n".join(event[1].get("data", "") for event in self.events)
        self.assertIn("GRANT ALL ON govbiz_core.*", sql)
        self.assertNotIn("GRANT ALL ON govbiz_ops", sql)

    def test_wrong_image_or_remaining_writer_prevents_copy(self):
        for field, value in (("deployed_image", "other"), ("remaining", [{}])):
            self.setUp()
            setattr(self, field, value)
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.run_fixture()
            self.assertFalse(any("mysqldump" in cmd for cmd, _ in self.events))

    def test_incomplete_or_changed_copy_prevents_start(self):
        for field, value in (("source_dump", "empty"), ("copy_dump", DUMP + "changed")):
            self.setUp()
            setattr(self, field, value)
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.run_fixture()
            self.assertFalse(
                any(cmd[:2] == ["docker", "create"] for cmd, _ in self.events)
            )

    def test_changed_source_and_failed_http_cannot_pass_but_cleanup_runs(self):
        def failed():
            raise ValueError("HTTP failure")

        for body in (failed, lambda: setattr(self, "source_dump", DUMP + "changed")):
            self.setUp()
            with self.assertRaises(ValueError):
                self.run_fixture(body)
            self.assertEqual(self.report["core_auth_restore"]["status"], "FAIL")
            self.assertEqual(
                self.events[-1][0], ["docker", "rm", "--force", "--volumes", CONTAINER]
            )

    def test_stop_failure_or_bad_exit_still_removes_only_its_container(self):
        for stage in ("stop", "exit", "oom"):
            self.setUp()
            self.fail = "stop" if stage == "stop" else None
            self.state.update(
                ExitCode=137 if stage == "exit" else 143, OOMKilled=stage == "oom"
            )
            with (
                self.subTest(stage=stage),
                self.assertRaises((ValueError, subprocess.CalledProcessError)),
            ):
                self.run_fixture()
            self.assertEqual(
                self.events[-1][0], ["docker", "rm", "--force", "--volumes", CONTAINER]
            )

    def test_remove_failure_never_marks_cleanup_complete(self):
        self.fail = "rm"
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_fixture()
        self.assertFalse(self.report["core_auth_restore"]["cleanup_complete"])


if __name__ == "__main__":
    unittest.main()
