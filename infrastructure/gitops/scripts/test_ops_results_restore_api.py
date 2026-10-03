"""Restored reports must be readable through authenticated, read-only HTTP."""

import copy
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, Mock, patch
from urllib.error import URLError

import ops_volume_restore_probe as probe
from test_ops_volume_restore import EXPECTED, RAW, REQUEST


class ResultsApiTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.report = self.root / REQUEST / "evaluation/report.html"
        self.report.parent.mkdir(parents=True)
        self.report.write_bytes(RAW)
        self.server = Mock(poll=Mock(return_value=None), wait=Mock(return_value=0))
        self.responses = [
            (
                200,
                {},
                json.dumps({"schema_version": 1, "results_readable": True}).encode(),
            ),
            (401, {}, b'{"code":"ARTIFACT_AUTH_REQUIRED"}'),
            (401, {}, b'{"code":"ARTIFACT_AUTH_REQUIRED"}'),
            *[(405, {"Allow": "GET"}, b'{"code":"READ_ONLY"}') for _ in range(3)],
            (200, {}, RAW),
        ]
        for name in ("getuid", "getgid"):
            mocker = patch.object(probe.os, name, return_value=10001)
            mocker.start()
            self.addCleanup(mocker.stop)
        mocker = patch.object(probe.subprocess, "Popen", return_value=self.server)
        self.start = mocker.start()
        self.addCleanup(mocker.stop)

    def verify(self):
        with patch.object(
            probe, "results_response", side_effect=self.responses
        ) as http:
            result = probe.check_results_api(self.root, EXPECTED)
        return result, http

    def test_authenticated_reports_reject_credentials_and_writes_without_inherited_secrets(
        self,
    ):
        with patch.dict(
            os.environ,
            {
                "OPENAI_API_KEY": "must-not-propagate",
                "MYSQL_PASSWORD": "must-not-propagate",
                "LLMOPS_ARTIFACT_TOKEN": "original-token-must-not-propagate",
                "HTTP_PROXY": "http://external.invalid",
            },
        ):
            result, http = self.verify()
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["matched_reports"], 1)
        self.assertTrue(result["files_unchanged"])
        self.assertEqual(result["runtime_uid"], 10001)
        env = self.start.call_args.kwargs["env"]
        self.assertEqual(
            set(env),
            {
                "PATH",
                "HOME",
                "PYTHONDONTWRITEBYTECODE",
                "LLMOPS_RESULTS_DIR",
                "LLMOPS_EVIDENCE_DIR",
                "LLMOPS_ARTIFACT_TOKEN",
            },
        )
        token = env["LLMOPS_ARTIFACT_TOKEN"]
        self.assertNotEqual(token, "original-token-must-not-propagate")
        self.assertNotIn(token, json.dumps(result))
        self.assertEqual(env["LLMOPS_RESULTS_DIR"], str(self.root))
        self.assertIn("127.0.0.1:8010", self.start.call_args.args[0])
        self.assertIn(
            "apps.evaluations.artifact_server:create_app()",
            self.start.call_args.args[0],
        )
        self.assertIsNone(http.call_args_list[1].args[1])
        self.assertEqual(http.call_args_list[-1].args[1], token)
        self.assertEqual(
            [call.kwargs["method"] for call in http.call_args_list[3:6]],
            ["POST", "PUT", "DELETE"],
        )
        self.server.terminate.assert_called_once_with()
        self.server.kill.assert_not_called()

    def test_invalid_health_auth_write_contract_or_report_bytes_cannot_pass(self):
        original = copy.deepcopy(self.responses)
        changes = (
            (0, (200, {}, b"{}")),
            (1, (200, {}, RAW)),
            (2, (200, {}, RAW)),
            (3, (200, {}, RAW)),
            (4, (405, {"Allow": "POST"}, b'{"code":"READ_ONLY"}')),
            (5, (405, {"Allow": "GET"}, b"{}")),
            (6, (200, {}, RAW + b"changed")),
            (6, (404, {}, b"{}")),
        )
        for index, value in changes:
            self.responses = copy.deepcopy(original)
            self.responses[index] = value
            self.server.reset_mock()
            with self.subTest(index=index), self.assertRaises(ValueError):
                self.verify()
            self.server.terminate.assert_called_once_with()

    def test_root_user_is_rejected_before_server_start(self):
        with (
            patch.object(probe.os, "getuid", return_value=0),
            self.assertRaisesRegex(ValueError, "UID/GID"),
        ):
            self.verify()
        self.start.assert_not_called()

    def test_server_startup_exit_and_timeout_cannot_pass(self):
        for exited in (True, False):
            self.server.poll.return_value = 1 if exited else None
            self.server.reset_mock()
            with (
                self.subTest(exited=exited),
                patch.object(
                    probe, "results_response", side_effect=URLError("unavailable")
                ),
                patch.object(probe.time, "monotonic", side_effect=[0, 31]),
                self.assertRaisesRegex(ValueError, "exited|timed out"),
            ):
                probe.check_results_api(self.root, EXPECTED)
            self.server.terminate.assert_called_once_with()

    def test_failed_shutdown_or_nonzero_exit_cannot_pass(self):
        for timeout in (True, False):
            self.server.wait.side_effect = (
                [subprocess.TimeoutExpired("gunicorn", 15), -9] if timeout else None
            )
            self.server.wait.return_value = 2
            with (
                self.subTest(timeout=timeout),
                self.assertRaisesRegex(
                    ValueError, "stop cleanly|exit was unsuccessful"
                ),
            ):
                self.verify()
        self.server.kill.assert_called_once_with()

    def test_file_mutation_is_rejected_after_shutdown(self):
        def stop(**kwargs):
            self.report.write_bytes(RAW + b"changed")
            return 0

        self.server.wait.side_effect = stop
        with self.assertRaisesRegex(ValueError, "changed files"):
            self.verify()


class ResultsHttpTests(unittest.TestCase):
    def test_http_reads_are_bounded_and_proxy_and_redirects_are_disabled(self):
        response = MagicMock(status=200)
        response.__enter__.return_value = response
        response.read.return_value = RAW
        response.headers = {
            "Content-Length": str(len(RAW)),
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        }
        with patch.object(probe, "build_opener") as build:
            build.return_value.open.return_value = response
            status, _, raw = probe.results_response("/v1/status", "test-token")
        self.assertEqual((status, raw), (200, RAW))
        response.read.assert_called_once_with(8 * 1024 * 1024 + 1)
        self.assertEqual(build.call_args.args[0].proxies, {})
        self.assertIsNone(
            build.call_args.args[1].redirect_request(None, None, None, None, None, None)
        )
        request = build.return_value.open.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:8010/v1/status")
        self.assertEqual(request.get_header("Authorization"), "Bearer test-token")

    def test_bad_headers_and_oversized_response_fail(self):
        for raw, headers in (
            (RAW, {}),
            (b"x" * (8 * 1024 * 1024 + 1), {}),
        ):
            response = MagicMock()
            response.__enter__.return_value = response
            response.read.return_value = raw
            response.headers = headers
            with (
                patch.object(probe, "build_opener") as build,
                self.assertRaisesRegex(ValueError, "HTTP response"),
            ):
                build.return_value.open.return_value = response
                probe.results_response("/v1/status")


if __name__ == "__main__":
    unittest.main()
