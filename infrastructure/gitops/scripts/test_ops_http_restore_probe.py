"""HTTP restoration must use real auth paths and reject incomplete evidence."""

import hashlib
import io
import json
import os
import subprocess
import sys
import unittest
from email.message import Message
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from typing import ClassVar
from unittest.mock import Mock, patch

import ops_http_restore_probe as probe
import ops_volume_restore_probe
import smoke_ops_bridge
from test_ops_browser_login import PROOF
from test_smoke_ops_backup import EXPECTED, IDENTITY, IMAGE_ID

REPORT = "<html>복원 보고서</html>".encode()
REPORT_HEADERS = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "private, no-store, max-age=0, no-cache, must-revalidate",
    "content-security-policy": "sandbox allow-scripts; default-src 'none'",
}
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
MANAGEMENT = {
    "status": "PASS",
    "session_verified": True,
    "listed_run_count": 4,
    "matched_details": 3,
    "pagination_complete": True,
    "budget_reads_verified": True,
    "unauthorized_reads_rejected": True,
    "browser_rendered": False,
}


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.artifact = Mock(poll=Mock(return_value=None), wait=Mock(return_value=0))
        self.ops = Mock(poll=Mock(return_value=None), wait=Mock(return_value=0))
        self.revoked = False
        self.defect = None
        self.stages = []
        self.user = SimpleNamespace(username="core:1", email="fixture@example.invalid")
        runs = Mock()
        runs.objects.count.return_value = 4
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
                "Content-Type": "text/html; charset=utf-8",
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
                side_effect=[
                    {"file": 1},
                    {"evidence": 1},
                    {"file": 2 if self.defect == "files" else 1},
                    {"evidence": 2 if self.defect == "evidence_files" else 1},
                ],
            ),
            patch.object(probe, "verify_evidence") as evidence,
            patch.object(probe, "core_login", side_effect=self.login),
            patch.object(
                probe,
                "browser_requests",
                side_effect=ValueError("browser") if self.defect == "browser" else None,
            ) as browser,
            patch.object(
                probe,
                "check_management",
                return_value={"evidence": MANAGEMENT, "responses": {}},
            ),
            patch.object(probe, "response", side_effect=self.response),
            patch.object(probe, "build_opener", return_value=client),
            patch.object(
                probe.subprocess, "Popen", side_effect=[self.artifact, self.ops]
            ) as start,
        ):
            result = probe.check_http(RUNS, self.stages.append)
            artifact_env = start.call_args_list[0].kwargs["env"]
            ops_env = start.call_args_list[1].kwargs["env"]
            self.assertNotIn("DB_PASSWORD", artifact_env)
            self.assertNotIn("OPENAI_API_KEY", ops_env)
            self.assertNotIn("CORE_LOGIN_PASSWORD", ops_env)
            self.assertEqual(ops_env["CORE_API_URL"], "http://127.0.0.1:8080")
            self.assertEqual(artifact_env["LLMOPS_RESULTS_DIR"], "/restore")
            self.assertEqual(artifact_env["LLMOPS_EVIDENCE_DIR"], "/evidence")
            self.assertNotEqual(ops_env["LLMOPS_EVIDENCE_DIR"], "/evidence")
            evidence.assert_called_once_with(Path("/evidence"))
            self.assertNotEqual(ops_env["LLMOPS_RESULTS_DIR"], "/restore")
            self.assertEqual(ops_env["DB_USER"], "ops_restore_reader")
            self.assertEqual(browser.call_args.args[0]["email"], self.user.email)
            self.assertEqual(browser.call_args.args[1], set(result["report_responses"]))
            return result

    def test_reports_real_auth_revocation_outage_and_cleanup(self):
        result = self.run_probe()
        self.assertEqual(
            self.stages,
            [
                "SETUP",
                "CORE_LOGIN",
                "SERVERS",
                "MANAGEMENT",
                "REPORTS",
                "BROWSER",
                "REVOCATION",
                "ARTIFACT_OUTAGE",
                "FILES",
            ],
        )
        self.assertEqual(result["matched_reports"], 3)
        self.assertTrue(result["core_admin_auth_verified"])
        self.assertEqual(result["auth_contract"], "restored_core_password_login")
        self.assertTrue(result["artifact_outage_rejected"])
        self.assertTrue(result["revoked_session_rejected"])
        self.assertEqual(result["management_http"], MANAGEMENT)
        for request in RUNS:
            self.assertEqual(
                result["report_responses"][
                    "/api/v1/ops/evaluations/" + request + "/report"
                ],
                {"body": REPORT.decode(), "headers": REPORT_HEADERS},
            )
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
            "evidence_files",
            "browser",
        ):
            self.setUp()
            self.defect = defect
            with self.subTest(defect=defect), self.assertRaises(ValueError):
                self.run_probe()
            self.assertTrue(self.ops.terminate.called)
            self.assertTrue(self.artifact.terminate.called)
            self.assertEqual(
                self.stages[-1],
                {
                    "readiness": "SERVERS",
                    "auth": "REPORTS",
                    "report": "REPORTS",
                    "artifact_outage": "ARTIFACT_OUTAGE",
                    "revoked": "REVOCATION",
                    "files": "FILES",
                    "evidence_files": "FILES",
                    "browser": "BROWSER",
                }[defect],
            )

    def test_bad_server_exit_cannot_pass(self):
        self.ops.wait.return_value = 1
        with self.assertRaisesRegex(ValueError, "exit cleanly"):
            self.run_probe()


class ContainerTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.fail = None
        self.web_proof = {
            "status": "PASS",
            "matched_details": 3,
            "listed_run_count": 4,
            "browser_rendered": True,
            "browser_ui": {
                "status": "PASS",
                "response_source": "captured_restore_http",
                "browser_version": "149.0.0.0",
                "listed_run_count": 4,
                "pages_verified": 1,
                "budget_view_verified": True,
                "details_verified": 3,
                "report_documents_verified": 3,
                "report_sandbox_verified": True,
                "report_denials_verified": 3,
                "denied_view_verified": True,
                "browser_rendered": True,
                "browser_closed": True,
            },
            "proxy_http": {
                "status": "PASS",
                "mode": "portfolio",
                "response_source": "captured_restore_http",
                "routes_verified": True,
                "credentials_forwarded": True,
                "unauthorized_status_preserved": True,
                "outage_rejected": True,
                "document_served": True,
                "report_documents_verified": 3,
                "servers_stopped": True,
                "browser_rendered": False,
            },
        }
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
            "browser_login": {
                **PROOF,
                "response_source": "restored_core_ops_http",
                "transport": "docker_attached_stdio",
                "listed_run_count": 4,
                "pages_verified": 1,
                "details_verified": 3,
                "reports_verified": 3,
                "proxy_stopped": True,
                "helper_exited": True,
            },
            "management_http": MANAGEMENT.copy(),
            "management_responses": {},
            "report_responses": {
                "/api/v1/ops/evaluations/" + request + "/report": {
                    "body": REPORT.decode(),
                    "headers": REPORT_HEADERS,
                }
                for request in RUNS
            },
        }

    def execute(self, command, **kwargs):
        self.events.append((command, kwargs))
        if (
            command[1] == self.fail
            or self.fail == "live"
            and command[0] == "node"
            and isinstance(command[1], Path)
        ):
            raise subprocess.CalledProcessError(1, command)
        if command[0] == "node":
            if isinstance(command[1], Path):
                self.assertEqual(command[1].name, "ops_restore_live_browser.mjs")
                value = json.loads(kwargs["data"])
                compile(value["program"], "restored-http", "exec")
                self.assertEqual(value["identity"], "e" * 64)
                self.assertEqual(value["password"], DATABASE["core_password"])
                self.assertNotIn(DATABASE["core_password"], value["program"])
                self.assertEqual(value["expected"], RUNS)
                return json.dumps(self.proof)
            value = json.loads(Path(command[-1]).read_text(encoding="utf-8"))
            self.assertEqual(value["total_runs"], 4)
            self.assertEqual(value["expected"], RUNS)
            self.assertEqual(value["reports"], self.proof["report_responses"])
            self.assertNotIn(DATABASE["core_password"], json.dumps(value))
            return json.dumps(self.web_proof)
        if command[1] == "create":
            return "e" * 64
        return ""

    def run_probe(self):
        with patch.object(smoke_ops_bridge, "execute", side_effect=self.execute):
            return probe.verify(IMAGE_ID, "owned-restore-volume", RUNS, DATABASE)

    def test_only_restored_volume_and_database_are_connected(self):
        result = self.run_probe()
        self.assertTrue(result["cleanup_complete"])
        self.assertNotIn("management_responses", result)
        self.assertNotIn("report_responses", result)
        self.assertNotIn(REPORT.decode(), json.dumps(result, ensure_ascii=False))
        self.assertEqual(result["management_web_contract"]["status"], "PASS")
        command, options = self.events[0]
        self.assertEqual(
            command[command.index("--network") + 1], "container:" + IDENTITY
        )
        self.assertEqual(
            command[command.index("--mount") + 1],
            "type=volume,source=owned-restore-volume,target=/restore,readonly",
        )
        self.assertNotIn("--publish", command)
        mount = next(value for value in command if value.startswith("type=bind,"))
        self.assertTrue(mount.endswith(",target=/evidence,readonly"))
        self.assertFalse(
            Path(mount.split("source=", 1)[1].split(",target=", 1)[0]).exists()
        )
        self.assertEqual(options["env"]["DB_PASSWORD"], DATABASE["password"])
        self.assertNotIn(DATABASE["password"], " ".join(command))
        self.assertEqual(
            options["env"]["CORE_LOGIN_PASSWORD"], DATABASE["core_password"]
        )
        self.assertNotIn(DATABASE["core_password"], " ".join(command))

    def test_probe_and_cleanup_failures_propagate(self):
        for stage in ("live", "rm", "--experimental-transform-types"):
            self.fail = stage
            with (
                self.subTest(stage=stage),
                self.assertRaises(subprocess.CalledProcessError),
            ):
                self.run_probe()
            self.assertEqual(self.events[-1][0][1], "rm")

    def test_web_contract_failure_cannot_pass_and_removes_private_snapshot(self):
        for key, value in (
            ("status", "FAIL"),
            ("matched_details", 2),
            ("browser_rendered", False),
            ("browser_rendered", 1),
            ("browser_ui", {**self.web_proof["browser_ui"], "pages_verified": 0}),
            (
                "browser_ui",
                {**self.web_proof["browser_ui"], "denied_view_verified": False},
            ),
            ("browser_ui", {**self.web_proof["browser_ui"], "browser_closed": False}),
            ("browser_ui", {**self.web_proof["browser_ui"], "response_source": "live"}),
            ("browser_ui", {**self.web_proof["browser_ui"], "details_verified": 2}),
            (
                "browser_ui",
                {**self.web_proof["browser_ui"], "report_documents_verified": 2},
            ),
            (
                "browser_ui",
                {**self.web_proof["browser_ui"], "report_sandbox_verified": False},
            ),
            (
                "browser_ui",
                {**self.web_proof["browser_ui"], "report_denials_verified": 0},
            ),
            ("proxy_http", None),
            ("proxy_http", {**self.web_proof["proxy_http"], "servers_stopped": False}),
            ("proxy_http", {**self.web_proof["proxy_http"], "response_source": "live"}),
            ("proxy_http", {**self.web_proof["proxy_http"], "outage_rejected": False}),
        ):
            original = self.web_proof[key]
            self.web_proof[key] = value
            with (
                self.subTest(key=key),
                self.assertRaisesRegex(ValueError, "web contract"),
            ):
                self.run_probe()
            contract = next(
                command[-1]
                for command, _ in reversed(self.events)
                if command[0] == "node"
            )
            self.assertFalse(Path(contract).exists())
            self.assertEqual(self.events[-1][0][1], "rm")
            self.web_proof[key] = original

    def test_live_browser_failure_or_replay_evidence_cannot_pass(self):
        original = self.proof["browser_login"]
        for key, value in (
            ("response_source", "captured_restore_http"),
            ("transport", "http_replay"),
            ("listed_run_count", 3),
            ("details_verified", 2),
            ("revoked_session_rejected", False),
            ("proxy_stopped", False),
            ("helper_exited", 1),
            ("cookie", "must-not-export"),
        ):
            self.proof["browser_login"] = {**original, key: value}
            with (
                self.subTest(key=key),
                self.assertRaisesRegex(ValueError, "live browser evidence"),
            ):
                self.run_probe()
            self.assertEqual(self.events[-1][0][1], "rm")
        self.proof["browser_login"] = {}
        with self.assertRaisesRegex(ValueError, "live browser version"):
            self.run_probe()

    def test_missing_or_invalid_browser_version_cannot_pass(self):
        for value in (None, {}, {"browser_version": ""}, {"browser_version": 149}):
            self.web_proof["browser_ui"] = value
            with (
                self.subTest(value=value),
                self.assertRaisesRegex(ValueError, "browser version"),
            ):
                self.run_probe()
            self.assertEqual(self.events[-1][0][1], "rm")

    def test_incomplete_or_overclaimed_proof_is_rejected(self):
        for key, value in (
            ("matched_reports", 2),
            ("servers_stopped", False),
            ("core_admin_auth_verified", False),
            ("model_api_calls", 1),
            ("management_http", {**MANAGEMENT, "browser_rendered": True}),
            ("management_http", {**MANAGEMENT, "pagination_complete": False}),
            ("management_http", {**MANAGEMENT, "matched_details": 2}),
        ):
            original = self.proof[key]
            self.proof[key] = value
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "evidence"):
                self.run_probe()
            self.proof[key] = original


class EvidenceTests(unittest.TestCase):
    def test_snapshot_contains_only_catalog_inputs_and_is_readable_by_runtime(self):
        with TemporaryDirectory() as directory:
            repository = Path(directory)
            catalog = (
                repository / "backend/ops-service/apps/evaluations/capture_catalog.json"
            )
            source = repository / "evaluation/support-program-evidence"
            target = repository / "snapshot"
            catalog.parent.mkdir(parents=True)
            (source / "runs").mkdir(parents=True)
            target.mkdir(mode=0o700)
            catalog.write_text(
                json.dumps(
                    [
                        {
                            "fixture": "fixture.json",
                            "captures": [{"path": "runs/capture.json"}],
                        }
                    ]
                ),
                encoding="utf-8",
            )
            (source / "fixture.json").write_bytes(b'{"fixture":1}')
            (source / "runs/capture.json").write_bytes(b'{"capture":1}')
            (source / "unrelated.env").write_text("never-copy", encoding="utf-8")
            with patch.object(
                probe,
                "__file__",
                str(repository / "infrastructure/gitops/scripts/probe.py"),
            ):
                probe.copy_evidence(target)
                self.assertEqual(
                    {
                        path.relative_to(target).as_posix()
                        for path in target.rglob("*")
                        if path.is_file()
                    },
                    {"fixture.json", "runs/capture.json"},
                )
                self.assertEqual(
                    (target / "fixture.json").read_bytes(), b'{"fixture":1}'
                )
                if os.name != "nt":
                    self.assertEqual(target.stat().st_mode & 0o777, 0o755)
                    self.assertEqual((target / "runs").stat().st_mode & 0o777, 0o755)
                    self.assertEqual(
                        (target / "fixture.json").stat().st_mode & 0o777, 0o644
                    )
                for name in (
                    "../../outside.json",
                    "/outside.json",
                    "runs\\capture.json",
                ):
                    catalog.write_text(
                        json.dumps([{"fixture": name, "captures": []}]),
                        encoding="utf-8",
                    )
                    with (
                        self.subTest(name=name),
                        self.assertRaisesRegex(ValueError, "evidence path"),
                    ):
                        probe.copy_evidence(target)

    def test_missing_or_changed_fixture_and_capture_fail_against_image_release(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            values = {"fixture.json": b"fixture", "capture.json": b"capture"}
            dataset = {
                "id": "test",
                "fixture": "fixture.json",
                "captures": [{"id": "saved", "path": "capture.json"}],
            }
            release = {
                "datasets": {
                    "test": {
                        "fixture_sha256": hashlib.sha256(
                            values["fixture.json"]
                        ).hexdigest(),
                        "captures": {
                            "saved": hashlib.sha256(values["capture.json"]).hexdigest()
                        },
                    }
                }
            }
            modules = {
                "apps.evaluations.artifact_files": SimpleNamespace(
                    read_file=lambda folder, name: (folder / name).read_bytes()
                ),
                "apps.evaluations.catalog": SimpleNamespace(DATASETS={"test": dataset}),
                "apps.evaluations.execution_spec": SimpleNamespace(
                    read_release=lambda: release
                ),
            }
            for name, raw in values.items():
                (root / name).write_bytes(raw)
            with patch.dict(sys.modules, modules):
                probe.verify_evidence(root)
                for name, raw in values.items():
                    (root / name).write_bytes(b"tampered")
                    with (
                        self.subTest(name=name),
                        self.assertRaisesRegex(ValueError, "execution release"),
                    ):
                        probe.verify_evidence(root)
                    (root / name).unlink()
                    with (
                        self.subTest(missing=name),
                        self.assertRaises(FileNotFoundError),
                    ):
                        probe.verify_evidence(root)
                    (root / name).write_bytes(raw)


class CoreLoginTests(unittest.TestCase):
    principal: ClassVar = {
        "accountId": 2,
        "email": "admin@example.invalid",
        "role": "ADMIN",
    }

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
        self.assertEqual(request.get_header("Origin"), probe.BROWSER_ORIGIN)
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


class BrowserTransportTests(unittest.TestCase):
    principal: ClassVar = {"email": "admin@example.invalid"}
    route = "/api/v1/ops/evaluations?page=1"

    def run_transport(self, requests, reply=None):
        if reply is None:
            reply = (200, Message(), b"{}")
        output = io.StringIO()
        with (
            patch.object(
                sys,
                "stdin",
                io.StringIO("".join(json.dumps(value) + "\n" for value in requests)),
            ),
            patch.object(sys, "stdout", output),
            patch.object(probe, "response", return_value=reply) as request,
        ):
            probe.browser_requests(self.principal, {self.route})
        return request, [json.loads(line) for line in output.getvalue().splitlines()]

    def test_forwards_actual_status_bytes_cookie_and_origin(self):
        headers = Message()
        headers["Content-Type"] = "application/json"
        headers["Set-Cookie"] = "govbiz_session=issued-fixture; HttpOnly; Path=/"
        headers["Connection"] = "close"
        payload = {
            "email": self.principal["email"],
            "password": "test-only",
            "rememberMe": False,
        }
        request, frames = self.run_transport(
            [
                {
                    "port": 8080,
                    "method": "POST",
                    "path": "/api/v1/auth/login",
                    "cookie": "",
                    "origin": probe.BROWSER_ORIGIN,
                    "payload": payload,
                },
                {"phase": "browser_done"},
            ],
            (200, headers, "한글 응답".encode()),
        )
        self.assertEqual(request.call_args.kwargs["payload"], payload)
        self.assertEqual(
            request.call_args.kwargs["headers"]["Origin"], probe.BROWSER_ORIGIN
        )
        self.assertEqual(frames[0]["phase"], "browser_ready")
        self.assertEqual(frames[1]["headers"]["set-cookie"], [headers["Set-Cookie"]])
        self.assertNotIn("connection", frames[1]["headers"])
        self.assertEqual(
            probe.base64.b64decode(frames[1]["body"]), "한글 응답".encode()
        )

    def test_denied_http_status_is_preserved_and_ops_host_matches_browser(self):
        request, frames = self.run_transport(
            [
                {
                    "port": 8000,
                    "method": "GET",
                    "path": self.route,
                    "cookie": "govbiz_session=revoked",
                    "origin": None,
                    "payload": None,
                },
                {"phase": "browser_done"},
            ],
            (401, Message(), b"{}"),
        )
        self.assertEqual(frames[1]["status"], 401)
        self.assertEqual(
            request.call_args.kwargs["headers"],
            {"Host": "127.0.0.1:5173", "Cookie": "govbiz_session=revoked"},
        )

    def test_external_routes_writes_headers_and_incomplete_transport_are_rejected(self):
        valid = {
            "port": 8000,
            "method": "GET",
            "path": self.route,
            "cookie": "",
            "origin": None,
            "payload": None,
        }
        for key, value in (
            ("port", True),
            ("port", 8010),
            ("method", "POST"),
            ("path", "http://external.invalid"),
            ("path", "/api/v1/ops/unknown"),
            ("cookie", "bad\r\nHost: external.invalid"),
            ("origin", "http://external.invalid"),
            ("payload", {"run": "new"}),
        ):
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.run_transport([{**valid, key: value}])
        for requests in ([], [{"phase": "browser_abort"}], [valid]):
            with self.subTest(requests=requests), self.assertRaises(ValueError):
                self.run_transport(requests)


if __name__ == "__main__":
    unittest.main()
