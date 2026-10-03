"""HTTP restoration must use real auth paths and reject incomplete evidence."""

import hashlib
import io
import json
import os
import subprocess
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import ops_http_restore_probe as probe
import ops_volume_restore_probe
import smoke_ops_bridge
from test_smoke_ops_backup import EXPECTED, IDENTITY, IMAGE_ID

REPORT = "<html>복원 보고서</html>".encode()
RUNS = {
    key: {**row, "report_sha256": hashlib.sha256(REPORT).hexdigest()}
    for key, row in EXPECTED.items()
}
DATABASE = {
    "id": IDENTITY,
    "image": IMAGE_ID,
    "password": "fresh-read-only-password",
    "core_password": "fixture-admin-password",
}


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.artifact = Mock(poll=Mock(return_value=None), wait=Mock(return_value=0))
        self.ops = Mock(poll=Mock(return_value=None), wait=Mock(return_value=0))
        self.revoked = False
        self.defect = None
        self.user = SimpleNamespace(username="core:1", email="fixture@example.invalid")
        runs = Mock()
        runs.objects.select_related.return_value.get.return_value.requested_by = (
            self.user
        )
        self.modules = {
            "django": SimpleNamespace(setup=Mock()),
            "django.db": SimpleNamespace(connection=Mock()),
            "apps.evaluations.models": SimpleNamespace(EvaluationRun=runs),
        }

    def login(self, principal, password):
        self.assertEqual(
            principal, {"accountId": 1, "email": self.user.email, "role": "ADMIN"}
        )
        self.assertEqual(password, DATABASE["core_password"])
        self.revoked = False
        return "real-admin-token", "real-member-token"

    def response(self, path, token=None, **kwargs):
        if path.endswith("/logout"):
            self.assertEqual(kwargs, {"port": 8080, "method": "POST"})
            self.revoked = True
            return 204, {}, b""
        if path.endswith("/ready"):
            return (
                (503 if self.defect == "readiness" else 200),
                {},
                json.dumps(
                    {
                        "status": "UP",
                        "checks": {"database": "UP", "schema": "UP"},
                    }
                ).encode(),
            )
        if self.revoked:
            return (200 if self.defect == "revoked" else 401), {}, b"{}"
        if token is None:
            return (200 if self.defect == "auth" else 401), {}, b"{}"
        if token == "invalid-fixture":
            return 401, {}, b"{}"
        if token == "real-member-token":
            return 403, {}, b"{}"
        if self.artifact.terminate.called:
            return (200 if self.defect == "artifact_outage" else 404), {}, b"{}"
        return (
            200,
            {
                "Cache-Control": "private, no-store, max-age=0, no-cache, must-revalidate",
                "Content-Security-Policy": "sandbox allow-scripts; default-src 'none'",
            },
            b"tampered" if self.defect == "report" else REPORT,
        )

    def run_probe(self):
        reply = io.BytesIO(b'{"schema_version":1,"results_readable":true}')
        client = Mock()
        client.open.return_value = reply
        with (
            patch.dict(sys.modules, self.modules),
            patch.dict(
                os.environ,
                {
                    "PATH": "/app/.venv/bin",
                    "DB_PASSWORD": DATABASE["password"],
                    "CORE_LOGIN_PASSWORD": DATABASE["core_password"],
                    "OPENAI_API_KEY": "never-forward",
                },
            ),
            patch.object(probe.os, "getuid", return_value=10001, create=True),
            patch.object(probe.os, "getgid", return_value=10001, create=True),
            patch.object(
                ops_volume_restore_probe,
                "tree",
                side_effect=[{"file": 1}, {"file": 2 if self.defect == "files" else 1}],
            ),
            patch.object(probe, "core_login", side_effect=self.login),
            patch.object(probe, "response", side_effect=self.response),
            patch.object(probe, "build_opener", return_value=client),
            patch.object(
                probe.subprocess, "Popen", side_effect=[self.artifact, self.ops]
            ) as start,
        ):
            result = probe.check_http(RUNS)
            artifact_env = start.call_args_list[0].kwargs["env"]
            ops_env = start.call_args_list[1].kwargs["env"]
            self.assertNotIn("DB_PASSWORD", artifact_env)
            self.assertNotIn("OPENAI_API_KEY", ops_env)
            self.assertNotIn("CORE_LOGIN_PASSWORD", ops_env)
            self.assertEqual(ops_env["CORE_API_URL"], "http://127.0.0.1:8080")
            self.assertEqual(artifact_env["LLMOPS_RESULTS_DIR"], "/restore")
            self.assertNotEqual(ops_env["LLMOPS_RESULTS_DIR"], "/restore")
            self.assertEqual(ops_env["DB_USER"], "ops_restore_reader")
            return result

    def test_reports_real_auth_revocation_outage_and_cleanup(self):
        result = self.run_probe()
        self.assertEqual(result["matched_reports"], 3)
        self.assertTrue(result["core_admin_auth_verified"])
        self.assertEqual(result["auth_contract"], "restored_core_password_login")
        self.assertTrue(result["artifact_outage_rejected"])
        self.assertTrue(result["revoked_session_rejected"])
        self.assertTrue(self.artifact.terminate.called)
        self.assertTrue(self.ops.terminate.called)

    def test_http_defects_and_mutated_files_cannot_pass(self):
        for defect in (
            "readiness",
            "auth",
            "report",
            "artifact_outage",
            "revoked",
            "files",
        ):
            self.setUp()
            self.defect = defect
            with self.subTest(defect=defect), self.assertRaises(ValueError):
                self.run_probe()
            self.assertTrue(self.ops.terminate.called)
            self.assertTrue(self.artifact.terminate.called)

    def test_bad_server_exit_cannot_pass(self):
        self.ops.wait.return_value = 1
        with self.assertRaisesRegex(ValueError, "exit cleanly"):
            self.run_probe()


class ContainerTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.fail = None
        self.proof = {
            "status": "PASS",
            "matched_reports": 3,
            "readiness": "UP",
            "auth_contract": "restored_core_password_login",
            "core_admin_auth_verified": True,
            "unauthorized_rejected": True,
            "artifact_outage_rejected": True,
            "revoked_session_rejected": True,
            "files_unchanged": True,
            "servers_stopped": True,
            "runtime_uid": 10001,
            "model_api_calls": 0,
        }

    def execute(self, command, **kwargs):
        self.events.append((command, kwargs))
        if command[1] == self.fail:
            raise subprocess.CalledProcessError(1, command)
        if command[1] == "create":
            return "e" * 64
        if command[1] == "start":
            compile(kwargs["data"], "restored-http", "exec")
            self.assertNotIn(DATABASE["password"], kwargs["data"])
            return json.dumps(self.proof)
        return ""

    def run_probe(self):
        with patch.object(smoke_ops_bridge, "execute", side_effect=self.execute):
            return probe.verify(IMAGE_ID, "owned-restore-volume", RUNS, DATABASE)

    def test_only_restored_volume_and_database_are_connected(self):
        result = self.run_probe()
        self.assertTrue(result["cleanup_complete"])
        command, options = self.events[0]
        self.assertEqual(
            command[command.index("--network") + 1], "container:" + IDENTITY
        )
        self.assertEqual(
            command[command.index("--mount") + 1],
            "type=volume,source=owned-restore-volume,target=/restore,readonly",
        )
        self.assertNotIn("--publish", command)
        self.assertEqual(options["env"]["DB_PASSWORD"], DATABASE["password"])
        self.assertNotIn(DATABASE["password"], " ".join(command))
        self.assertEqual(
            options["env"]["CORE_LOGIN_PASSWORD"], DATABASE["core_password"]
        )
        self.assertNotIn(DATABASE["core_password"], " ".join(command))

    def test_probe_and_cleanup_failures_propagate(self):
        for stage in ("start", "rm"):
            self.fail = stage
            with (
                self.subTest(stage=stage),
                self.assertRaises(subprocess.CalledProcessError),
            ):
                self.run_probe()
            self.assertEqual(self.events[-1][0][1], "rm")

    def test_incomplete_or_overclaimed_proof_is_rejected(self):
        for key, value in (
            ("matched_reports", 2),
            ("servers_stopped", False),
            ("core_admin_auth_verified", False),
            ("model_api_calls", 1),
        ):
            original = self.proof[key]
            self.proof[key] = value
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "evidence"):
                self.run_probe()
            self.proof[key] = original


class CoreLoginTests(unittest.TestCase):
    principal = {"accountId": 2, "email": "admin@example.invalid", "role": "ADMIN"}

    def replies(self):
        return [
            (200, {}, b"{}"),
            (200, {"Set-Cookie": "govbiz_session=admin.jwt; HttpOnly; Path=/"}, b"{}"),
            (200, {"Set-Cookie": "govbiz_session=member.jwt; HttpOnly; Path=/"}, b"{}"),
            (200, {}, json.dumps(self.principal).encode()),
            (403, {}, b"{}"),
        ]

    def test_core_cookie_write_uses_the_explicit_fixture_origin(self):
        reply = io.BytesIO(b"")
        reply.status, reply.headers = 204, {}
        client = Mock()
        client.open.return_value = reply
        with patch.object(probe, "build_opener", return_value=client):
            self.assertEqual(
                probe.response(
                    "/api/v1/auth/logout", "real.jwt", port=8080, method="POST"
                )[0],
                204,
            )
        request = client.open.call_args.args[0]
        self.assertEqual(request.get_header("Origin"), "http://127.0.0.1:8080")
        self.assertEqual(request.get_header("Cookie"), "govbiz_session=real.jwt")

    def test_real_password_login_and_member_session_contract(self):
        with patch.object(probe, "response", side_effect=self.replies()) as response:
            self.assertEqual(
                probe.core_login(self.principal, "fresh-password"),
                ["admin.jwt", "member.jwt"],
            )
        self.assertEqual(response.call_args_list[1].args, ("/api/v1/auth/login",))
        self.assertEqual(
            response.call_args_list[1].kwargs["payload"],
            {"email": self.principal["email"], "password": "fresh-password"},
        )
        self.assertTrue(
            all(call.kwargs["port"] == 8080 for call in response.call_args_list)
        )

    def test_bad_login_cookie_identity_and_role_are_rejected(self):
        for index, reply in (
            (0, (503, {}, b"{}")),
            (1, (401, {}, b"{}")),
            (1, (200, {"Set-Cookie": "govbiz_session=admin.jwt"}, b"{}")),
            (3, (200, {}, json.dumps({**self.principal, "accountId": 99}).encode())),
            (4, (200, {}, b"{}")),
        ):
            replies = self.replies()
            replies[index] = reply
            with (
                self.subTest(index=index, reply=reply),
                patch.object(probe, "response", side_effect=replies),
                self.assertRaises(ValueError),
            ):
                probe.core_login(self.principal, "fresh-password")


if __name__ == "__main__":
    unittest.main()
