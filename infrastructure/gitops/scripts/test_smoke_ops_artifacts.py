"""Offline checks for fault isolation, restoration and strict HTTP evidence."""

import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import contextmanager, nullcontext
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

import smoke_ops_artifacts as smoke

RUN_ID = "8f54ebfc-8692-4f71-836e-8ad9debce471"
PROJECT = "govbiz-bridge-smoke-0123456789"
NK = ["kubectl", "--context", "kind-" + PROJECT, "-n", "govbiz-msa"]
RUN = {
    "id": RUN_ID,
    "status": "COMPLETED",
    "model_api_calls": 0,
    "prefect_flow_run_id": RUN_ID,
    "execution_spec_sha256": "a" * 64,
}
RAW = b"<html>" + b"report" * 200 + b"</html>"
FINGERPRINT = hashlib.sha256(RAW).hexdigest()


class ArtifactFaultTests(unittest.TestCase):
    def deployment(self):
        return {
            "metadata": {"uid": "owned-deployment"},
            "spec": {
                "template": {
                    "spec": {
                        "containers": [
                            {
                                "name": "ops-sync",
                                "env": [{"name": "UNCHANGED", "value": "true"}],
                            },
                            {
                                "name": "ops-service",
                                "env": [
                                    {"name": "DATABASE", "value": "unchanged"},
                                    {
                                        "name": smoke.TOKEN_KEY,
                                        "valueFrom": {
                                            "secretKeyRef": {
                                                "name": "ops-runtime",
                                                "key": smoke.TOKEN_KEY,
                                            }
                                        },
                                    },
                                ],
                            },
                        ]
                    }
                }
            },
        }

    def test_token_restored_after_failed_assertion_without_changing_secret_or_sync(
        self,
    ):
        deployment = self.deployment()
        with (
            patch.object(
                smoke, "execute", return_value=json.dumps(deployment)
            ) as command,
            self.assertRaisesRegex(RuntimeError, "check failed"),
            smoke.rejected_token(NK),
        ):
            raise RuntimeError("check failed")
        patches = [
            json.loads(call.kwargs["data"])
            for call in command.call_args_list
            if "data" in call.kwargs
        ]
        self.assertEqual(len(patches), 2)
        before = deployment["spec"]["template"]["spec"]["containers"][1]["env"][1]
        self.assertEqual(patches[0][1]["value"], before)
        self.assertEqual(patches[1][2]["value"], before)
        self.assertEqual(
            patches[0][2]["path"], "/spec/template/spec/containers/1/env/1"
        )
        self.assertEqual(
            patches[0][0],
            {"op": "test", "path": "/metadata/uid", "value": "owned-deployment"},
        )
        self.assertEqual(patches[1][1]["value"], patches[0][2]["value"])

    def test_token_restored_if_fault_rollout_fails(self):
        replies = [json.dumps(self.deployment()), "", RuntimeError("rollout"), "", ""]
        with (
            patch.object(smoke, "execute", side_effect=replies) as command,
            self.assertRaisesRegex(RuntimeError, "rollout"),
            smoke.rejected_token(NK),
        ):
            self.fail("rollout failure must not start assertions")
        self.assertEqual(command.call_count, 5)

    def test_unexpected_token_source_prevents_mutation(self):
        deployment = self.deployment()
        deployment["spec"]["template"]["spec"]["containers"][1]["env"][1] = {
            "name": smoke.TOKEN_KEY,
            "value": "unexpected",
        }
        with (
            patch.object(
                smoke, "execute", return_value=json.dumps(deployment)
            ) as command,
            self.assertRaises(AssertionError),
            smoke.rejected_token(NK),
        ):
            self.fail("must not mutate")
        self.assertEqual(command.call_count, 1)

    def run_move(self, root, restore=False, fingerprint=FINGERPRINT):
        return subprocess.run(
            [sys.executable, "-c", smoke.MOVE_REPORT],
            input=json.dumps(
                {"run_id": RUN_ID, "sha256": fingerprint, "restore": restore}
            ),
            text=True,
            capture_output=True,
            check=False,
            env={**os.environ, "LLMOPS_RESULTS_DIR": str(root)},
        )

    def make_report(self, root):
        folder = Path(root) / RUN_ID / "evaluation"
        folder.mkdir(parents=True)
        path = folder / "report.html"
        path.write_bytes(RAW)
        return path

    def test_missing_report_restores_exact_bytes_even_when_http_check_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.make_report(directory)

            def execute(command, *, env, data):
                result = self.run_move(directory, json.loads(data)["restore"])
                result.check_returncode()
                return result.stdout

            with (
                patch.object(smoke, "execute", side_effect=execute),
                self.assertRaisesRegex(RuntimeError, "HTTP"),
                smoke.missing_report(["docker", "compose"], {}, RUN_ID, FINGERPRINT),
            ):
                self.assertFalse(path.exists())
                raise RuntimeError("HTTP")
            self.assertEqual(path.read_bytes(), RAW)
            self.assertFalse(path.with_name("report.html.smoke-held").exists())

    def test_report_hash_mismatch_and_existing_backup_never_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.make_report(directory)
            self.assertNotEqual(
                self.run_move(directory, fingerprint="0" * 64).returncode, 0
            )
            backup = path.with_name("report.html.smoke-held")
            backup.write_bytes(b"keep backup")
            self.assertNotEqual(self.run_move(directory).returncode, 0)
            self.assertEqual(path.read_bytes(), RAW)
            self.assertEqual(backup.read_bytes(), b"keep backup")

    def test_restore_refuses_to_overwrite_a_new_report(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.make_report(directory)
            self.assertEqual(self.run_move(directory).returncode, 0)
            path.write_bytes(b"new writer")
            self.assertNotEqual(self.run_move(directory, restore=True).returncode, 0)
            self.assertEqual(path.read_bytes(), b"new writer")
            self.assertEqual(path.with_name("report.html.smoke-held").read_bytes(), RAW)

    @unittest.skipIf(os.name == "nt", "Linux deployed path guard")
    def test_symlink_directory_cannot_move_another_runs_report(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            other = root / "other"
            other.mkdir()
            (other / "report.html").write_bytes(RAW)
            (root / RUN_ID).mkdir()
            (root / RUN_ID / "evaluation").symlink_to(other, target_is_directory=True)
            self.assertNotEqual(self.run_move(directory).returncode, 0)
            self.assertEqual((other / "report.html").read_bytes(), RAW)

    def test_invalid_run_id_is_rejected_before_exec(self):
        with (
            patch.object(smoke, "execute") as command,
            self.assertRaises(ValueError),
            smoke.missing_report(["docker", "compose"], {}, "../other", FINGERPRINT),
        ):
            self.fail("invalid path")
        command.assert_not_called()


class AccessEvidenceTests(unittest.TestCase):
    def replies(self, failed=()):
        checks = {
            key: "FAIL" if key in failed else "PASS"
            for key in (
                "evidence",
                "results_directory",
                "prefect_deployment",
                "result_artifact",
            )
        }
        return [
            (200, {}, json.dumps({"status": "UP"}).encode()),
            (200, {}, json.dumps({"status": "UP"}).encode()),
            (
                503 if failed else 200,
                {},
                json.dumps(
                    {
                        "status": "FAIL" if failed else "PASS",
                        "storage_transport": "http",
                        "checks": checks,
                    }
                ).encode(),
            ),
            (404, {}, b'{"detail":"unavailable"}')
            if failed
            else (200, {"Content-Security-Policy": "sandbox allow-scripts;"}, RAW),
        ]

    def check(self, replies, failed=(), run=None):
        with (
            patch.object(smoke, "authenticated_client"),
            patch.object(
                smoke,
                "completed_run",
                return_value=run or {**RUN, "report_url": "/report"},
            ),
            patch.object(smoke, "response", side_effect=replies),
        ):
            return smoke.check_access("password", RUN, FINGERPRINT, failed)

    def test_fault_requires_report_error_and_specific_diagnostic_failure(self):
        failed = ("result_artifact",)
        evidence = self.check(self.replies(failed), failed)
        self.assertEqual(evidence["report_http_status"], 404)
        self.assertEqual(evidence["runtime_http_status"], 503)
        replies = self.replies(failed)
        replies[3] = (200, {}, RAW)
        with self.assertRaises(AssertionError):
            self.check(replies, failed)
        with self.assertRaises(AssertionError):
            self.check(self.replies(), failed)

    def test_record_mutation_and_probe_failure_are_not_recovery(self):
        with self.assertRaises(AssertionError):
            self.check(self.replies(), run={**RUN, "model_api_calls": 1})
        replies = self.replies()
        replies[0] = (503, {}, b'{"status":"DOWN"}')
        with self.assertRaises(AssertionError):
            self.check(replies)

    def test_recovery_requires_original_report_and_sandbox(self):
        self.assertEqual(self.check(self.replies())["report_http_status"], 200)
        for headers, raw in (
            ({"Content-Security-Policy": "sandbox allow-scripts;"}, RAW + b"changed"),
            ({}, RAW),
        ):
            replies = self.replies()
            replies[3] = (200, headers, raw)
            with self.assertRaises((AssertionError, KeyError)):
                self.check(replies)

    def test_http_error_body_is_read_and_connection_closed(self):
        body = io.BytesIO(b'{"detail":"unavailable"}')
        error = HTTPError("http://localhost/report", 404, "missing", {}, body)
        with patch.object(smoke, "build_opener") as opener:
            client = opener.return_value
            client.open.side_effect = error
            self.assertEqual(
                smoke.response(client, "/report", allow_error=True)[0], 404
            )
        self.assertTrue(body.closed)

    def test_startup_http_error_remains_retryable_and_closes_connection(self):
        body = io.BytesIO(b"proxy starting")
        error = HTTPError("http://localhost/login", 503, "starting", {}, body)
        with patch.object(smoke, "build_opener") as opener:
            client = opener.return_value
            client.open.side_effect = error
            with self.assertRaises(HTTPError):
                smoke.response(client, "/login")
        self.assertTrue(body.closed)


class RecoveryEvidenceTests(unittest.TestCase):
    def test_wrong_project_cluster_or_runner_blocks_all_faults(self):
        for project, nk, owner in (
            ("govbiz-ops-preview", NK, PROJECT),
            (PROJECT, ["kubectl", "--context", "kind-user"], PROJECT),
            (PROJECT, NK, "govbiz-ops-preview"),
        ):
            with (
                patch.object(smoke, "execute", side_effect=["container", owner]),
                patch.object(smoke, "rejected_token") as inject,
                self.assertRaises(ValueError),
            ):
                smoke.verify(
                    nk,
                    [],
                    {},
                    "password",
                    RUN,
                    FINGERPRINT,
                    {"compose_project": project},
                )
            inject.assert_not_called()

    def test_failed_fault_assertion_restores_and_never_reports_pass(self):
        restored = []

        @contextmanager
        def fault(nk):
            try:
                yield
            finally:
                restored.append(True)

        report = {"compose_project": PROJECT}
        with (
            patch.object(smoke, "execute", side_effect=["container", PROJECT]),
            patch.object(smoke, "rejected_token", side_effect=fault),
            patch.object(smoke.fork_web, "forwards", return_value=nullcontext()),
            patch.object(smoke, "artifact_status", return_value=401),
            patch.object(smoke, "check_access", side_effect=AssertionError("HTTP")),
            self.assertRaisesRegex(AssertionError, "HTTP"),
        ):
            smoke.verify(NK, [], {}, "password", RUN, FINGERPRINT, report)
        self.assertEqual(restored, [True])
        self.assertEqual(report["artifact_recovery"]["status"], "FAIL")
        self.assertEqual(report["evaluation_phase"], "artifact_token_rejected")

    def test_both_faults_and_recoveries_required_for_pass(self):
        report = {"compose_project": PROJECT}
        with (
            patch.object(smoke, "execute", side_effect=["container", PROJECT]),
            patch.object(smoke, "rejected_token", side_effect=lambda nk: nullcontext()),
            patch.object(smoke, "missing_report", side_effect=lambda *a: nullcontext()),
            patch.object(
                smoke.fork_web, "forwards", side_effect=lambda nk: nullcontext()
            ),
            patch.object(smoke, "artifact_status", side_effect=[401, 404]),
            patch.object(
                smoke, "check_access", return_value={"checked": True}
            ) as check,
        ):
            smoke.verify(NK, [], {}, "password", RUN, FINGERPRINT, report)
        self.assertEqual(check.call_count, 4)
        self.assertEqual(report["artifact_recovery"]["status"], "PASS")
        self.assertEqual(
            set(report["artifact_recovery"]["scenarios"]),
            {"token_rejected", "report_missing"},
        )
        self.assertTrue(
            all(
                item["recovery_verified"]
                for item in report["artifact_recovery"]["scenarios"].values()
            )
        )


if __name__ == "__main__":
    unittest.main()
