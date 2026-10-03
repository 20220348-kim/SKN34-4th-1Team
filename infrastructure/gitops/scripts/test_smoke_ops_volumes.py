"""Orchestration must never stop personal writers or delete source volumes."""

import json
import subprocess
import unittest
from unittest.mock import patch

import smoke_ops_volumes as smoke
from test_ops_volume_restore import EXPECTED

PROJECT = "govbiz-bridge-smoke-0123456789"
SETTINGS = {"repository": "bridge-smoke/local", "cluster": PROJECT}
IMAGE = "sha256:" + "a" * 64
PREFECT_IMAGE = "sha256:" + "b" * 64
HELPER = "f" * 64
READER = "e" * 64
IDS = {name: str(index) * 64 for index, name in enumerate(smoke.SERVICES, 1)}


class VolumeSmokeTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.stopped = False
        self.extra_user = False
        self.unsafe_owner = False
        self.stop_exit = 0
        self.helper_exit = 0
        self.helper_failure = False
        self.missing_evidence = False
        self.api_defect = None
        self.results_api_defect = None
        self.reader_failure = False
        self.reader_exit = 0
        self.cleanup_failure = False
        self.name_collision = False
        self.volumes = {}
        self.expected_kind = None
        self.report = {
            "compose_project": PROJECT,
            "database_restore": {"status": "PASS", "source_writers_stopped": True},
        }
        for owner, name, options in (
            (smoke.fork_cluster, "require_dev", {}),
            (smoke.fork_cluster, "commands", {"return_value": ([], ["kubectl"], [])}),
            (smoke, "require_disposable", {}),
            (smoke, "execute", {"side_effect": self.execute}),
        ):
            mocker = patch.object(owner, name, **options)
            mocker.start()
            self.addCleanup(mocker.stop)

    def execute(self, command, *, data=None, **kwargs):
        self.events.append((command, data))
        if command[0] == "kubectl":
            return '{"items":[]}'
        if command[:2] == ["compose", "ps"]:
            return IDS[command[-1]]
        if command[:2] == ["docker", "inspect"]:
            if command[-1] in {HELPER, READER}:
                return json.dumps(
                    {
                        "Running": False,
                        "ExitCode": self.reader_exit
                        if command[-1] == READER
                        else self.helper_exit,
                        "OOMKilled": False,
                    }
                )
            service = next(
                name for name, identity in IDS.items() if identity == command[-1]
            )
            destination, suffix, rw = smoke.SERVICES[service]
            return json.dumps(
                {
                    "Id": command[-1],
                    "Image": PREFECT_IMAGE if service == "prefect" else IMAGE,
                    "Labels": {
                        "com.docker.compose.project": "foreign"
                        if self.unsafe_owner
                        else PROJECT,
                        "com.docker.compose.service": service,
                    },
                    "State": {
                        "Running": not self.stopped,
                        "ExitCode": self.stop_exit,
                        "OOMKilled": False,
                    },
                    "Mounts": [
                        {
                            "Destination": destination,
                            "Type": "volume",
                            "Name": PROJECT + "_" + suffix,
                            "RW": rw,
                        }
                    ],
                }
            )
        if command[:3] == ["docker", "volume", "inspect"]:
            name = command[-1]
            labels = self.volumes.get(name, {"com.docker.compose.project": PROJECT})
            return json.dumps([{"Name": name, "Labels": labels}])
        if command[:3] == ["docker", "volume", "ls"]:
            return "collision" if self.name_collision else ""
        if command[:3] == ["docker", "volume", "create"]:
            name = command[-1]
            self.volumes[name] = {"govbiz.restore": name}
            return name
        if command[:2] == ["docker", "ps"]:
            owners = (
                ("prefect",)
                if "prefect-data" in " ".join(command)
                else ("evaluation-runner", "ops-artifacts")
            )
            return "\n".join(
                [IDS[name] for name in owners]
                + (["unexpected"] if self.extra_user else [])
            )
        if command[:2] == ["docker", "stop"]:
            self.stopped = True
        if command[:2] == ["docker", "create"]:
            self.expected_kind = json.loads(command[-1])["kind"]
            if json.loads(command[-1]).get("phase") == "results-api":
                return READER
            return HELPER
        if command[:2] == ["docker", "start"]:
            if self.helper_failure:
                raise subprocess.CalledProcessError(1, command)
            compile(data, "restore-probe", "exec")
            if command[-1] == READER:
                if self.reader_failure:
                    raise subprocess.TimeoutExpired(command, 90)
                api = {
                    "status": "PASS",
                    "matched_reports": 1,
                    "unauthenticated_rejected": True,
                    "invalid_token_rejected": True,
                    "writes_rejected": True,
                    "files_unchanged": True,
                    "server_stopped": True,
                    "runtime_uid": 10001,
                }
                if self.results_api_defect is not None:
                    key, value = self.results_api_defect
                    api[key] = value
                return json.dumps(api)
            if self.missing_evidence:
                return '{"status":"PASS"}'
            api = {
                "status": "PASS",
                "matched_executions": 1,
                "database_unchanged": True,
                "server_stopped": True,
                "scheduling_disabled": True,
                "automatic_migrations": False,
            }
            if self.api_defect is not None:
                key, value = self.api_defect
                api[key] = value
            return json.dumps(
                {
                    "status": "PASS",
                    "source_preserved": True,
                    "permissions_preserved": True,
                    "file_count": 3,
                    "total_bytes": 4096,
                    "tree_sha256": "a" * 64,
                    "matched_reports": 1,
                    "matched_executions": 1,
                    "sqlite_integrity": True,
                    "api": api,
                }
            )
        if command[:2] == ["docker", "rm"] and self.cleanup_failure:
            raise subprocess.CalledProcessError(1, command)
        return ""

    def verify(self):
        return smoke.verify(
            "/temporary", SETTINGS, ["compose"], {}, EXPECTED, self.report
        )

    def commands(self, prefix):
        return [
            command for command, _ in self.events if command[: len(prefix)] == prefix
        ]

    def test_restores_with_matching_images_and_isolated_prefect_api(self):
        self.assertEqual(self.verify(), IMAGE)
        evidence = self.report["volume_restore"]
        self.assertEqual(evidence["status"], "PASS")
        self.assertFalse(evidence["backup_verified"])
        self.assertFalse(evidence["personal_environment_verified"])
        self.assertTrue(evidence["prefect_server_started"])
        self.assertTrue(evidence["results_server_started"])
        self.assertEqual(evidence["scope"], "disposable_results_http_and_prefect_api")
        self.assertEqual(len(self.commands(["docker", "stop"])), 1)
        helpers = self.commands(["docker", "create"])
        self.assertEqual(len(helpers), 3)
        self.assertEqual(helpers[0][-4], IMAGE)
        self.assertEqual(helpers[1][-4], IMAGE)
        self.assertEqual(helpers[2][-4], PREFECT_IMAGE)
        for command in helpers:
            self.assertEqual(command[command.index("--network") + 1], "none")
            self.assertEqual(command[command.index("--entrypoint") + 1], "python")
            mounts = [
                command[i + 1] for i, part in enumerate(command) if part == "--mount"
            ]
            if json.loads(command[-1]).get("phase") == "results-api":
                self.assertEqual(command[command.index("--user") + 1], "10001:10001")
                self.assertEqual(len(mounts), 1)
                self.assertTrue(mounts[0].endswith("target=/restore,readonly"))
                self.assertNotIn("--cap-add", command)
                self.assertNotIn("--env", command)
                self.assertNotIn(PROJECT, mounts[0])
            else:
                self.assertTrue(mounts[0].endswith("target=/source,readonly"))
                self.assertTrue(
                    mounts[1].startswith("type=volume,source=govbiz-volume-restore-")
                )
            self.assertNotIn("--publish", command)
        removed = self.commands(["docker", "volume", "rm"])
        self.assertEqual(len(removed), 2)
        self.assertTrue(all(command[-1] in self.volumes for command in removed))
        self.assertFalse(any(PROJECT in command[-1] for command in removed))

    def test_personal_environment_is_rejected_before_tools(self):
        with self.assertRaisesRegex(ValueError, "disposable"):
            smoke.verify(
                "/personal",
                SETTINGS | {"repository": "ilil1/SKN34-4th-1Team"},
                [],
                {},
                EXPECTED,
                self.report,
            )
        self.assertEqual(self.events, [])

    def test_failed_database_rehearsal_cannot_stop_compose(self):
        self.report["database_restore"]["status"] = "FAIL"
        with self.assertRaisesRegex(ValueError, "DB rehearsal"):
            self.verify()
        self.assertEqual(self.commands(["docker", "stop"]), [])

    def test_foreign_container_or_additional_volume_user_blocks_stop(self):
        for field in ("unsafe_owner", "extra_user"):
            setattr(self, field, True)
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.verify()
            self.assertEqual(self.commands(["docker", "stop"]), [])
            setattr(self, field, False)

    def test_unclean_stop_blocks_copy(self):
        self.stop_exit = 137
        with self.assertRaisesRegex(ValueError, "stop cleanly"):
            self.verify()
        self.assertEqual(self.commands(["docker", "create"]), [])

    def test_existing_target_name_is_not_adopted(self):
        self.name_collision = True
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.verify()
        self.assertEqual(self.commands(["docker", "volume", "create"]), [])
        self.assertEqual(self.commands(["docker", "volume", "rm"]), [])

    def test_helper_failure_removes_only_created_resources(self):
        self.helper_failure = True
        with self.assertRaises(subprocess.CalledProcessError):
            self.verify()
        self.assertEqual(len(self.commands(["docker", "rm"])), 1)
        self.assertEqual(len(self.commands(["docker", "volume", "rm"])), 1)
        self.assertEqual(self.report["volume_restore"]["status"], "FAIL")
        self.assertIsNone(self.report["volume_restore"]["prefect_server_started"])
        self.assertIsNone(self.report["volume_restore"]["results_server_started"])

    def test_nonzero_helper_exit_or_incomplete_success_cannot_pass(self):
        for field, value in (("helper_exit", 1), ("missing_evidence", True)):
            self.stopped = False
            setattr(self, field, value)
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.verify()
            self.assertEqual(self.report["volume_restore"]["status"], "FAIL")
            setattr(self, field, 0 if field == "helper_exit" else False)

    def test_cleanup_failure_still_attempts_volume_cleanup_and_prevents_pass(self):
        self.cleanup_failure = True
        with self.assertRaises(subprocess.CalledProcessError):
            self.verify()
        self.assertEqual(len(self.commands(["docker", "volume", "rm"])), 1)
        self.assertEqual(self.report["volume_restore"]["status"], "FAIL")

    def test_prefect_api_requires_complete_evidence_and_cleanup_on_failure(self):
        for key, value in (
            ("status", "FAIL"),
            ("matched_executions", True),
            ("matched_executions", 0),
            ("database_unchanged", False),
            ("server_stopped", False),
            ("scheduling_disabled", False),
            ("automatic_migrations", True),
        ):
            self.stopped = False
            self.events.clear()
            self.api_defect = (key, value)
            with (
                self.subTest(key=key),
                self.assertRaisesRegex(ValueError, "Prefect API evidence"),
            ):
                self.verify()
            self.assertEqual(self.report["volume_restore"]["status"], "FAIL")
            self.assertEqual(len(self.commands(["docker", "volume", "rm"])), 2)

    def test_results_api_requires_complete_evidence(self):
        for key, value in (
            ("status", "FAIL"),
            ("matched_reports", True),
            ("matched_reports", 0),
            ("unauthenticated_rejected", False),
            ("invalid_token_rejected", False),
            ("writes_rejected", False),
            ("files_unchanged", False),
            ("server_stopped", False),
            ("runtime_uid", 0),
        ):
            self.stopped = False
            self.events.clear()
            self.results_api_defect = (key, value)
            with (
                self.subTest(key=key),
                self.assertRaisesRegex(ValueError, "results API evidence"),
            ):
                self.verify()
            self.assertEqual(self.report["volume_restore"]["status"], "FAIL")
            self.assertIsNone(self.report["volume_restore"]["results_server_started"])
            self.assertEqual(len(self.commands(["docker", "rm"])), 2)
            self.assertEqual(len(self.commands(["docker", "volume", "rm"])), 1)

    def test_reader_timeout_or_bad_exit_cleans_both_helpers(self):
        for field in ("reader_failure", "reader_exit"):
            self.stopped = False
            self.events.clear()
            setattr(self, field, True if field == "reader_failure" else 137)
            with (
                self.subTest(field=field),
                self.assertRaises((subprocess.TimeoutExpired, ValueError)),
            ):
                self.verify()
            self.assertEqual(len(self.commands(["docker", "rm"])), 2)
            self.assertEqual(len(self.commands(["docker", "volume", "rm"])), 1)
            setattr(self, field, False if field == "reader_failure" else 0)

    def test_reader_cleanup_error_still_removes_copy_helper(self):
        self.cleanup_failure = True
        with self.assertRaises(subprocess.CalledProcessError):
            self.verify()
        self.assertEqual(
            [command[-1] for command in self.commands(["docker", "rm"])],
            [READER, HELPER],
        )
        self.assertEqual(self.report["volume_restore"]["status"], "FAIL")


if __name__ == "__main__":
    unittest.main()
