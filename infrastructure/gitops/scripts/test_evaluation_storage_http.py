"""Real loopback HTTP against the artifact app; bounded, read-only Pod forwarding."""

import base64
import copy
import hashlib
import importlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import Mock, patch
from wsgiref.simple_server import WSGIRequestHandler, make_server

import evaluation_storage_http as http

REQUEST = "11111111-1111-4111-8111-111111111111"
FLOW = "22222222-2222-4222-8222-222222222222"
DEPLOYMENT = "33333333-3333-4333-8333-333333333333"
TOKEN = "private-test-token-" + "x" * 32


class QuietHandler(WSGIRequestHandler):
    def log_message(self, *args):
        pass


class StorageHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Isolate the production WSGI app's relative imports from other test apps.
        package = "_storage_http_artifacts"
        directory = (
            Path(__file__).resolve().parents[3] / "backend/ops-service/apps/evaluations"
        )
        spec = importlib.util.spec_from_file_location(
            package,
            directory / "__init__.py",
            submodule_search_locations=[str(directory)],
        )
        module = importlib.util.module_from_spec(spec)
        sys.modules[package] = module
        spec.loader.exec_module(module)
        cls.artifacts = importlib.import_module(package + ".artifact_server")

        def cleanup():
            for name in list(sys.modules):
                if name == package or name.startswith(package + "."):
                    del sys.modules[name]

        cls.addClassCleanup(cleanup)

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        marker = {
            "request_id": REQUEST,
            "dataset_id": "fixture",
            "execution_mode": "replay",
            "execution_spec": {"mode": "replay"},
            "execution_spec_sha256": "a" * 64,
        }
        self.entries = {}
        for name, raw in zip(
            http.FILES,
            [
                json.dumps(marker).encode(),
                b'{"status":"completed"}',
                b"{}",
                "검증 보고서".encode(),
            ],
        ):
            path = self.root / REQUEST / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
            self.entries[REQUEST + "/" + name] = {
                "kind": "file",
                "size": len(raw),
                "sha256": hashlib.sha256(raw).hexdigest(),
                "data": base64.b64encode(raw).decode(),
            }
        self.expected = {
            REQUEST: {
                "flow_id": FLOW,
                "report_sha256": self.entries[REQUEST + "/evaluation/report.html"][
                    "sha256"
                ],
            }
        }
        flow = {
            "id": FLOW,
            "flow_id": "flow-definition",
            "deployment_id": DEPLOYMENT,
            "state_type": "COMPLETED",
            "state": {"type": "COMPLETED", "id": "state-id"},
            "parameters": marker,
        }
        self.routes = {
            "/api/health": True,
            "/api/flow_runs/" + FLOW: flow,
            "/api/deployments/" + DEPLOYMENT: {
                "id": DEPLOYMENT,
                "flow_id": "flow-definition",
            },
            "/api/flow_run_states/?flow_run_id=" + FLOW: [
                {
                    "id": "state-id",
                    "type": "COMPLETED",
                    "state_details": {"flow_run_id": FLOW},
                }
            ],
        }
        self.requests = []
        self.override = None
        artifact = self.artifacts.application(self.root, self.root, TOKEN)

        def app(environ, start_response):
            path = environ["PATH_INFO"]
            if environ["QUERY_STRING"]:
                path += "?" + environ["QUERY_STRING"]
            self.requests.append(
                (environ["REQUEST_METHOD"], path, environ.get("HTTP_AUTHORIZATION"))
            )
            if self.override:
                answer = self.override(environ, path)
                if answer:
                    status, headers, raw = answer
                    start_response(status, headers)
                    return [raw]
            if path.startswith("/v1/"):
                return artifact(environ, start_response)
            raw = json.dumps(self.routes.get(path)).encode()
            start_response("200 OK", [("Content-Length", str(len(raw)))])
            return [raw]

        self.server = make_server("127.0.0.1", 0, app, handler_class=QuietHandler)
        thread = threading.Thread(
            target=self.server.serve_forever, kwargs={"poll_interval": 0.01}
        )
        thread.start()

        def close():
            self.server.shutdown()
            thread.join(timeout=5)
            self.server.server_close()

        self.addCleanup(close)
        self.port = self.server.server_port
        self.sessions = []

        @contextmanager
        def forward(kube, pod, remote):
            self.sessions.append((pod, remote, "open"))
            try:
                yield self.port, Mock(poll=Mock(return_value=None))
            finally:
                self.sessions.append((pod, remote, "closed"))

        self.enterContext(patch.object(http, "forward", side_effect=forward))

    def verify(self):
        return http.verify(
            ["kubectl"],
            {"prefect": "prefect-pod", "ops-artifacts": "artifact-pod"},
            self.expected,
            self.entries,
            TOKEN,
        )

    def test_real_artifact_app_authentication_and_completed_prefect_gets(self):
        proof = self.verify()
        self.assertEqual(proof["matchedArtifacts"], 4)
        self.assertEqual(proof["matchedPrefectExecutions"], 1)
        self.assertEqual(proof["scope"], "pod_loopback_port_forward")
        self.assertTrue(proof["artifactAuthenticationVerified"])
        self.assertTrue(proof["forwardsClosed"])
        self.assertEqual(proof["modelApiCalls"], 0)
        self.assertEqual(len(self.requests), 19)
        self.assertTrue(all(method == "GET" for method, _, _ in self.requests))
        self.assertTrue(
            all(
                auth is None
                for _, path, auth in self.requests
                if path.startswith("/api/")
            )
        )
        self.assertNotIn(TOKEN, json.dumps(proof))

    def test_shared_copy_still_verifies_reports_but_not_foreign_prefect_history(self):
        self.expected[REQUEST]["shared_review_copy"] = {
            "seed_id": "verified-copy",
            "seed_sha256": "b" * 64,
            "artifacts_verified": 6,
        }
        result = self.verify()
        self.assertEqual(result["matchedReports"], 1)
        self.assertEqual(result["sharedReviewCopies"], 1)
        self.assertEqual(result["matchedPrefectExecutions"], 0)
        self.assertEqual(
            [path for _, path, _ in self.requests if path.startswith("/api/")],
            ["/api/health"],
        )

    def test_modified_or_missing_artifact_fails_and_closes_session(self):
        path = self.root / REQUEST / "evaluation/report.html"
        for raw in (b"tampered", None):
            with self.subTest(raw=raw):
                if raw is None:
                    path.unlink()
                else:
                    path.write_bytes(raw)
                with self.assertRaises(ValueError):
                    self.verify()
                self.assertEqual(self.sessions[-1][2], "closed")
                self.assertFalse(
                    any(path.startswith("/api/") for _, path, _ in self.requests)
                )

    def test_authentication_bypass_or_missing_response_protection_blocks(self):
        for status, headers in (
            (
                "200 OK",
                [("Cache-Control", "no-store"), ("X-Content-Type-Options", "nosniff")],
            ),
            ("401 Unauthorized", []),
        ):
            raw = b'{"code":"ARTIFACT_AUTH_REQUIRED"}'
            self.override = lambda e, p, s=status, h=headers, r=raw: (
                s,
                h + [("Content-Length", str(len(r)))],
                r,
            )
            with self.subTest(status=status), self.assertRaises(ValueError):
                self.verify()

    def test_prefect_state_parameters_deployment_and_history_must_match(self):
        original = copy.deepcopy(self.routes)
        flow_path = "/api/flow_runs/" + FLOW
        mutations = (
            lambda: self.routes.update({"/api/health": False}),
            lambda: self.routes[flow_path].update(state_type="FAILED"),
            lambda: self.routes[flow_path]["parameters"].update(
                execution_spec_sha256="b" * 64
            ),
            lambda: self.routes[flow_path]["parameters"].update(request_id=DEPLOYMENT),
            lambda: self.routes["/api/deployments/" + DEPLOYMENT].update(
                flow_id="foreign"
            ),
            lambda: self.routes["/api/flow_run_states/?flow_run_id=" + FLOW][0].update(
                type="FAILED"
            ),
            lambda: self.routes["/api/flow_run_states/?flow_run_id=" + FLOW][0][
                "state_details"
            ].update(flow_run_id=REQUEST),
        )
        for mutation in mutations:
            self.routes = copy.deepcopy(original)
            mutation()
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                self.verify()
            self.assertEqual(self.sessions[-1][2], "closed")

    def test_invalid_backup_evidence_is_rejected_before_opening_forward(self):
        for row in (
            {},
            {REQUEST: {**self.expected[REQUEST], "report_sha256": "c" * 64}},
        ):
            self.expected = row
            with self.assertRaises(ValueError):
                self.verify()
            self.assertEqual(self.sessions, [])

    def test_redirect_does_not_forward_token_and_environment_proxy_is_ignored(self):
        self.override = lambda e, p: (
            "302 Found",
            [
                ("Location", f"http://127.0.0.1:{self.port}/v1/sink"),
                ("Content-Length", "0"),
            ],
            b"",
        )
        with patch.dict(
            os.environ, {"http_proxy": "http://127.0.0.1:1", "no_proxy": ""}
        ):
            status, _, _ = http.response(self.port, "/v1/status", TOKEN)
        self.assertEqual(status, 302)
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.requests[0][1], "/v1/status")

    def test_oversized_body_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "limit"):
            http.response(self.port, "/v1/status", TOKEN, limit=4)

    def test_invalid_route_or_header_credential_never_contacts_server(self):
        for path, token in (
            ("//external", TOKEN),
            ("/api/health\r\nX: 1", TOKEN),
            ("/v1/status", "bad\nheader"),
        ):
            with self.subTest(path=path), self.assertRaises(ValueError):
                http.response(self.port, path, token)
        self.assertEqual(self.requests, [])

    def test_short_body_or_total_response_deadline_blocks(self):
        incoming = Mock(status=200, headers={"Content-Length": "5"})
        incoming.__enter__ = Mock(return_value=incoming)
        incoming.__exit__ = Mock(return_value=False)
        incoming.read1.side_effect = [b"123", b""]
        with patch.object(
            http, "build_opener", return_value=Mock(open=Mock(return_value=incoming))
        ):
            with self.assertRaisesRegex(ValueError, "length"):
                http.response(self.port, "/api/health")
            with (
                patch.object(http.time, "monotonic", side_effect=[0, 11]),
                self.assertRaises(TimeoutError),
            ):
                http.response(self.port, "/api/health")


class ForwardTests(unittest.TestCase):
    def setUp(self):
        self.expected = {"name": "prefect-abc", "uid": "pod-uid"}
        self.process = Mock(poll=Mock(return_value=None))
        self.guard = self.enterContext(patch.object(http, "require_pod"))

        def popen(args, **kwargs):
            kwargs["stdout"].write("Forwarding from 127.0.0.1:49123 -> 4200\n")
            kwargs["stdout"].flush()
            return self.process

        self.popen = self.enterContext(
            patch.object(http.subprocess, "Popen", side_effect=popen)
        )

    def test_only_owned_pod_allocated_loopback_listener_and_cleanup(self):
        with http.forward(["kubectl", "--context", "fixture"], self.expected, 4200) as (
            port,
            process,
        ):
            self.assertEqual(port, 49123)
            self.assertIs(process, self.process)
        args = self.popen.call_args.args[0]
        self.assertEqual(
            args[-3:], ["--address=127.0.0.1", "pod/prefect-abc", "0:4200"]
        )
        self.assertEqual(self.guard.call_count, 3)
        self.process.terminate.assert_called_once()
        self.process.wait.assert_called_once_with(timeout=5)

    def test_exception_or_pod_change_closes_forward(self):
        for error_at in ("body", "ready", "after"):
            self.guard.side_effect = {
                "body": None,
                "ready": [None, ValueError("changed")],
                "after": [None, None, ValueError("changed")],
            }[error_at]
            self.process.reset_mock()
            with (
                self.subTest(error_at=error_at),
                self.assertRaises(ValueError),
                http.forward(["kubectl"], self.expected, 4200),
            ):
                if error_at == "body":
                    raise ValueError("HTTP failed")
            self.process.terminate.assert_called_once()
            self.process.wait.assert_called_once()

    def test_preexisting_pod_change_blocks_before_process_start(self):
        self.guard.side_effect = ValueError("changed")
        with (
            self.assertRaises(ValueError),
            http.forward(["kubectl"], self.expected, 4200),
        ):
            self.fail("must not yield")
        self.popen.assert_not_called()

    def test_dead_process_and_readiness_timeout_are_not_success(self):
        self.process.poll.return_value = 1
        with (
            self.assertRaisesRegex(ValueError, "exited"),
            http.forward(["kubectl"], self.expected, 4200),
        ):
            self.fail("must not yield")
        self.process.poll.return_value = None
        self.popen.side_effect = None
        self.popen.return_value = self.process
        with (
            patch.object(http.time, "monotonic", side_effect=[0, 21]),
            self.assertRaises(TimeoutError),
            http.forward(["kubectl"], self.expected, 4200),
        ):
            self.fail("must not yield")

    def test_termination_timeout_kills_owned_process_and_cleanup_failure_raises(self):
        timeout = subprocess.TimeoutExpired("kubectl", 5)
        self.process.wait.side_effect = [timeout, 0]
        with http.forward(["kubectl"], self.expected, 4200):
            pass
        self.process.kill.assert_called_once()
        self.process.wait.side_effect = timeout
        with (
            self.assertRaises(subprocess.TimeoutExpired),
            http.forward(["kubectl"], self.expected, 4200),
        ):
            pass


class PodIdentityTests(unittest.TestCase):
    def test_replacement_restart_or_spec_change_invalidates_target(self):
        status = {
            "name": "prefect",
            "imageID": "sha256:a",
            "containerID": "containerd://a",
            "restartCount": 0,
            "ready": True,
        }
        pod = {
            "metadata": {
                "name": "prefect-abc",
                "uid": "pod-uid",
                "namespace": http.release.NAMESPACE,
            },
            "spec": {"containers": [{"name": "prefect", "image": "image@sha256:a"}]},
            "status": {
                "phase": "Running",
                "conditions": [{"type": "Ready", "status": "True"}],
                "containerStatuses": [status],
            },
        }
        expected = {
            **pod["metadata"],
            "specSha256": http.release.digest(http.release.encoded(pod["spec"])),
            "containers": {
                "prefect": {
                    key: status[key]
                    for key in ("imageID", "containerID", "restartCount")
                }
            },
        }
        with patch.object(http.release.pvc_restore, "run", return_value=pod) as run:
            http.require_pod(["kubectl"], expected)
            self.assertEqual(
                run.call_args.args[0][-5:], ["get", "pod", "prefect-abc", "-o", "json"]
            )
            for mutation in (
                lambda p: p["metadata"].update(uid="new-pod"),
                lambda p: p["spec"].update(hostNetwork=True),
                lambda p: p["status"]["containerStatuses"][0].update(
                    containerID="new-container"
                ),
                lambda p: p["status"]["containerStatuses"][0].update(restartCount=1),
                lambda p: p["status"].update(phase="Pending"),
            ):
                changed = copy.deepcopy(pod)
                mutation(changed)
                run.return_value = changed
                with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                    http.require_pod(["kubectl"], expected)


if __name__ == "__main__":
    unittest.main()
