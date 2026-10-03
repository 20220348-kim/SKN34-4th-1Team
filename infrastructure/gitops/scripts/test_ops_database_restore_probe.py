"""Restored application checks must fail closed and keep disposable isolation."""

import copy
import hashlib
import json
import os
import subprocess
import unittest
from unittest.mock import patch

import ops_database_restore_probe as probe
import smoke_ops_backup as smoke
from test_smoke_ops_backup import EXPECTED, IDENTITY, IMAGE_ID, RELEASE

READER = "a" * 64


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


class ResponseTests(unittest.TestCase):
    def test_invalid_or_incomplete_expectations_rejected(self):
        for expected, release in (
            ({}, RELEASE),
            (EXPECTED, "invalid"),
            (dict(list(EXPECTED.items())[:2]), RELEASE),
        ):
            with self.subTest(expected=expected), self.assertRaises(ValueError):
                probe.validate_expected(expected, release)
        expected = copy.deepcopy(EXPECTED)
        rows = list(expected.values())
        rows[1]["flow_id"] = rows[0]["flow_id"]
        with self.assertRaisesRegex(ValueError, "Repeated"):
            probe.validate_expected(expected, RELEASE)

    def test_uuid_and_digest_expectations_are_validated(self):
        for field, value in (
            ("flow_id", "not-a-uuid"),
            ("execution_spec_sha256", "invalid"),
        ):
            expected = copy.deepcopy(EXPECTED)
            next(iter(expected.values()))[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                probe.validate_expected(expected, RELEASE)
        probe.validate_expected(EXPECTED, RELEASE)

    def test_completed_response_and_spec_bytes_must_match(self):
        request, expected = next(iter(EXPECTED.items()))
        spec = {"한글": ["복원", None]}
        expected = {**expected, "execution_spec_sha256": digest(spec)}
        row = {
            "id": request,
            "prefect_flow_run_id": expected["flow_id"],
            "execution_spec_sha256": digest(spec),
            "execution_spec": spec,
            "status": "COMPLETED",
            "model_api_calls": 0,
            "requested_by_id": "core:1",
            "finished_at": "2026-10-03T00:00:00Z",
            "summary": {"passed": True},
            "report_url": "/report",
        }
        probe.verify_response(row, request, expected, digest)
        for field, value in (
            ("id", "other"),
            ("prefect_flow_run_id", "other"),
            ("execution_spec_sha256", "f" * 64),
            ("execution_spec", {"changed": True}),
            ("status", "RUNNING"),
            ("model_api_calls", 1),
            ("model_api_calls", None),
            ("requested_by_id", ""),
            ("finished_at", None),
            ("summary", {}),
            ("report_url", None),
        ):
            with (
                self.subTest(field=field),
                self.assertRaisesRegex(ValueError, "response differs"),
            ):
                probe.verify_response(row | {field: value}, request, expected, digest)


class ReaderContainerTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.evidence = {}
        self.fail = None
        self.created = READER
        self.proof = {
            "status": "PASS",
            "readiness": "UP",
            "evaluation_count": 3,
            "execution_release_sha256": RELEASE,
            "read_only_grants": True,
            "budget_lock_verified": True,
            "write_rejected": True,
            "response_serialization_verified": True,
            "relational_fixture_verified": True,
            "core_admin_auth_verified": False,
            "http_server_started": False,
            "model_api_calls": 0,
        }
        mocker = patch.object(smoke, "execute", side_effect=self.execute)
        mocker.start()
        self.addCleanup(mocker.stop)

    def execute(self, command, *, data=None, **kwargs):
        self.events.append((command, data, kwargs))
        if self.fail and self.fail(command):
            raise subprocess.CalledProcessError(1, command)
        if command[:2] == ["docker", "create"]:
            return self.created
        if command[:2] == ["docker", "start"]:
            compile(data, "ops-restore-reader", "exec")
            return json.dumps(self.proof)
        return ""

    def verify(self):
        smoke.application_read(
            ["restore-mysql"], IDENTITY, IMAGE_ID, EXPECTED, RELEASE, self.evidence
        )
        return self.evidence["application"]

    def removed(self):
        return [
            command for command, _, _ in self.events if command[:2] == ["docker", "rm"]
        ]

    def test_uses_pinned_image_read_only_user_and_only_restored_network(self):
        with patch.dict(
            os.environ, {"OPENAI_API_KEY": "never-forward", "DB_PASSWORD": "original"}
        ):
            result = self.verify()
        self.assertEqual(result["status"], "PASS")
        self.assertTrue(result["cleanup_complete"])
        create, _, options = next(
            event for event in self.events if event[0][:2] == ["docker", "create"]
        )
        self.assertEqual(create[create.index("--network") + 1], "container:" + IDENTITY)
        self.assertEqual(create[create.index("--user") + 1], "10001:10001")
        self.assertEqual(create[-3:], [IMAGE_ID, "-B", "-"])
        self.assertIn("--read-only", create)
        self.assertIn("no-new-privileges:true", create)
        self.assertEqual(
            [create[i + 1] for i, part in enumerate(create) if part == "--env"],
            ["DB_PASSWORD"],
        )
        self.assertFalse(
            {"--mount", "--volume", "-v", "--publish", "-p", "--env-file"} & set(create)
        )
        password = options["env"]["DB_PASSWORD"]
        self.assertNotEqual(password, "original")
        self.assertNotIn(password, " ".join(create))
        grant = self.events[0][1]
        self.assertIn("GRANT SELECT, LOCK TABLES ON govbiz_ops.*", grant)
        self.assertNotIn("GRANT UPDATE", grant)
        self.assertIn(password, grant)
        program = next(
            data
            for command, data, _ in self.events
            if command[:2] == ["docker", "start"]
        )
        self.assertNotIn(password, program)
        self.assertNotIn("never-forward", program)
        self.assertNotIn(password, json.dumps(result))
        self.assertEqual(
            self.removed(), [["docker", "rm", "--force", "--volumes", READER]]
        )

    def test_probe_failure_cleans_reader_and_fails(self):
        self.fail = lambda command: command[:2] == ["docker", "start"]
        with self.assertRaises(subprocess.CalledProcessError):
            self.verify()
        self.assertEqual(len(self.removed()), 1)
        self.assertEqual(self.evidence["application"]["status"], "FAIL")

    def test_cleanup_failure_is_not_success(self):
        self.fail = lambda command: command[:2] == ["docker", "rm"]
        with self.assertRaises(subprocess.CalledProcessError):
            self.verify()
        self.assertEqual(self.evidence["application"]["status"], "FAIL")
        self.assertFalse(self.evidence["application"]["cleanup_complete"])

    def test_invalid_identity_never_deletes_unknown_container(self):
        self.created = "unknown"
        with self.assertRaisesRegex(ValueError, "identity"):
            self.verify()
        self.assertEqual(self.removed(), [])

    def test_missing_failed_or_overclaimed_evidence_is_rejected(self):
        valid = self.proof.copy()
        for change in (
            {"status": "FAIL"},
            {"evaluation_count": 2},
            {"readiness": "DOWN"},
            {"write_rejected": False},
            {"core_admin_auth_verified": True},
            {"execution_release_sha256": "f" * 64},
            {"model_api_calls": 1},
            {"read_only_grants": None},
            {"budget_lock_verified": False},
            {"http_server_started": True},
        ):
            self.proof = valid | change
            with (
                self.subTest(change=change),
                self.assertRaisesRegex(ValueError, "evidence"),
            ):
                self.verify()
            self.assertEqual(self.evidence["application"]["status"], "FAIL")


if __name__ == "__main__":
    unittest.main()
