"""Offline helper tests: no Docker, kubectl, cluster, or network operations."""

import io
import json
import subprocess
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import Mock, patch

import smoke_kubernetes as smoke


class AppImageResourcesTests(unittest.TestCase):
    def fixture(self):
        return [
            {
                "kind": "Deployment",
                "metadata": {"name": "ops-service"},
                "spec": {
                    "template": {
                        "spec": {
                            "containers": [
                                {
                                    "name": "ops-service",
                                    "image": "govbiz-ops-service:local-k8s",
                                }
                            ]
                        }
                    }
                },
            }
        ]

    def test_only_rendered_app_image_changes_without_mutating_input(self):
        original = self.fixture()
        rendered = smoke.app_image_resources(original, "govbiz-ops-service:checked-build")
        self.assertEqual(original, self.fixture())
        expected = self.fixture()
        expected[0]["spec"]["template"]["spec"]["containers"][0]["image"] = (
            "govbiz-ops-service:checked-build"
        )
        self.assertEqual(rendered, expected)

    def test_missing_duplicate_or_unexpected_image_is_rejected(self):
        for resources in ([], self.fixture() + self.fixture()):
            with self.subTest(resources=resources), self.assertRaises(RuntimeError):
                smoke.app_image_resources(resources, "govbiz-ops-service:test")
        resources = self.fixture()
        resources[0]["spec"]["template"]["spec"]["containers"][0]["image"] = (
            "unexpected:test"
        )
        with self.assertRaises(RuntimeError):
            smoke.app_image_resources(resources, "govbiz-ops-service:test")


class HttpBody(io.BytesIO):
    def __init__(self, status, body):
        super().__init__(body)
        self.status = status


class ImageValidationTests(unittest.TestCase):
    def test_explicit_non_latest_tags_are_accepted(self):
        for image in (
            "govbiz-ops-service:smoke-20260919",
            "localhost:5000/govbiz/ops:sha_2385107",
            "registry.example.test/team/ops:release.1",
        ):
            with self.subTest(image=image):
                smoke.validate_image(image)

    def test_ambiguous_or_unsafe_image_inputs_are_rejected(self):
        for image in (
            "",
            "govbiz-ops-service",
            "govbiz-ops-service:",
            "govbiz-ops-service:latest",
            "localhost:5000/govbiz/ops",
            "govbiz-ops-service:-invalid",
            "govbiz-ops-service:" + "a" * 129,
            "govbiz-ops-service@sha256:" + "a" * 64,
            "govbiz-ops-service:tag@sha256:" + "a" * 64,
            "https://registry.example.test/ops:tag",
            "govbiz-ops-service:tag with space",
            "govbiz-ops-service:tag\n",
            "govbiz-ops-service:tag;echo",
            "$(id):tag",
            "--help:tag",
        ):
            with self.subTest(image=image):
                with self.assertRaises(RuntimeError):
                    smoke.validate_image(image)


class SecretManifestTests(unittest.TestCase):
    def test_secret_is_namespaced_opaque_and_values_stay_in_stdin_payload(self):
        values = {
            "DB_PASSWORD": "test-only-password",
            "DJANGO_SECRET_KEY": "test-only-key",
        }
        with patch("builtins.print") as printed:
            payload = smoke.secret_manifest("govbiz-ops-runtime", values)
        printed.assert_not_called()
        self.assertEqual(
            json.loads(payload),
            {
                "apiVersion": "v1",
                "kind": "Secret",
                "type": "Opaque",
                "metadata": {
                    "name": "govbiz-ops-runtime",
                    "namespace": smoke.NAMESPACE,
                },
                "stringData": values,
            },
        )

    def test_run_passes_secret_on_stdin_without_shell_or_command_arguments(self):
        payload = smoke.secret_manifest(
            "govbiz-ops-runtime", {"DB_PASSWORD": "fixture-private"}
        )
        command = [
            "kubectl",
            "--kubeconfig",
            Path("/temporary/test-kubeconfig"),
            "create",
            "-f",
            "-",
        ]
        with patch.object(smoke.subprocess, "run") as execute:
            smoke.run(command, data=payload)
        args, kwargs = execute.call_args
        self.assertEqual(args[0], [str(part) for part in command])
        self.assertNotIn("fixture-private", " ".join(args[0]))
        self.assertEqual(kwargs["input"], payload)
        self.assertTrue(kwargs["check"])
        self.assertFalse(kwargs.get("shell", False))


class HttpCheckTests(unittest.TestCase):
    def check_response(self, responses, *, expected, clock=None):
        opener = Mock()
        opener.open.side_effect = responses
        with (
            patch.object(smoke.urllib.request, "build_opener", return_value=opener),
            patch.object(smoke.urllib.request, "ProxyHandler") as proxy_handler,
            patch.object(smoke.time, "sleep"),
            patch.object(smoke.time, "monotonic", side_effect=clock or [0, 0, 1, 2, 3]),
        ):
            result = smoke.wait_http(
                "http://127.0.0.1:18001/api/v1/health/ready", expected, timeout=10
            )
        proxy_handler.assert_called_once_with({})
        return result, opener

    def test_health_success_returns_json_and_disables_environment_proxies(self):
        body, opener = self.check_response(
            [HttpBody(200, b'{"status":"UP"}')], expected=200
        )
        self.assertEqual(body, {"status": "UP"})
        opener.open.assert_called_once_with(
            "http://127.0.0.1:18001/api/v1/health/ready", timeout=9
        )

    def test_expected_http_error_is_a_valid_readiness_result(self):
        error = urllib.error.HTTPError(
            "http://127.0.0.1", 503, "unready", {}, io.BytesIO(b'{"status":"DOWN"}')
        )
        body, _ = self.check_response([error], expected=503)
        self.assertEqual(body, {"status": "DOWN"})

    def test_transient_connection_and_wrong_status_are_retried(self):
        body, opener = self.check_response(
            [
                OSError("port forward is starting"),
                HttpBody(200, b'{"status":"UP"}'),
                urllib.error.HTTPError(
                    "http://127.0.0.1",
                    503,
                    "unready",
                    {},
                    io.BytesIO(b'{"status":"DOWN"}'),
                ),
            ],
            expected=503,
        )
        self.assertEqual(body["status"], "DOWN")
        self.assertEqual(opener.open.call_count, 3)

    def test_invalid_success_json_is_retried(self):
        body, opener = self.check_response(
            [
                HttpBody(200, b"not-json"),
                HttpBody(200, b'{"status":"UP"}'),
            ],
            expected=200,
        )
        self.assertEqual(body["status"], "UP")
        self.assertEqual(opener.open.call_count, 2)

    def test_invalid_http_error_json_is_retried_not_treated_as_success(self):
        malformed = urllib.error.HTTPError(
            "http://127.0.0.1", 503, "unready", {}, io.BytesIO(b"not-json")
        )
        valid = urllib.error.HTTPError(
            "http://127.0.0.1", 503, "unready", {}, io.BytesIO(b'{"status":"DOWN"}')
        )
        body, opener = self.check_response([malformed, valid], expected=503)
        self.assertEqual(body["status"], "DOWN")
        self.assertEqual(opener.open.call_count, 2)

    def test_unrecovered_http_failure_expires_without_printing_response_body(self):
        opener = Mock()
        opener.open.return_value = HttpBody(
            500, b'{"detail":"private-response-fixture"}'
        )
        with (
            patch.object(smoke.urllib.request, "build_opener", return_value=opener),
            patch.object(smoke.time, "sleep"),
            patch.object(smoke.time, "monotonic", side_effect=[0, 0, 11]),
            patch("builtins.print") as printed,
        ):
            with self.assertRaisesRegex(RuntimeError, "did not reach 200") as raised:
                smoke.wait_http("http://127.0.0.1:18001", 200, timeout=10)
        self.assertNotIn("private-response-fixture", str(raised.exception))
        printed.assert_not_called()


class CommandHelpersTests(unittest.TestCase):
    def test_failed_command_stops_the_flow(self):
        error = subprocess.CalledProcessError(1, ["kubectl", "apply"])
        with patch.object(smoke.subprocess, "run", side_effect=error):
            with self.assertRaises(subprocess.CalledProcessError):
                smoke.run(["kubectl", "apply"])

    def test_capture_returns_stdout(self):
        with patch.object(smoke.subprocess, "run", return_value=Mock(stdout="ok\n")):
            self.assertEqual(smoke.run(["kind", "version"], capture=True), "ok\n")

    def test_documents_parse_multiple_yaml_resources(self):
        with patch.object(
            smoke, "run", return_value="kind: Namespace\n---\nkind: Service\n"
        ) as execute:
            self.assertEqual(
                smoke.documents(["kubectl", "kustomize", "fixture"]),
                [
                    {"kind": "Namespace"},
                    {"kind": "Service"},
                ],
            )
        execute.assert_called_once_with(
            ["kubectl", "kustomize", "fixture"], capture=True
        )


if __name__ == "__main__":
    unittest.main()
