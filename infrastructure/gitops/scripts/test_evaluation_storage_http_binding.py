"""HTTP proof must retain publication, frozen source and rollout bindings."""

import copy
import io
import json
import sys
import unittest
from contextlib import nullcontext, redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

import evaluation_storage_start as start

release = start.release
secrets = start.dormant.evaluation_secrets


class HttpBindingTests(unittest.TestCase):
    def setUp(self):
        self.result = {
            "restoreReportSha256": "report-hash",
            "sourceHandoff": {"archiveSha256": "archive-hash"},
            "observation": {
                "storageWorkloads": {
                    "pods": {"prefect": "pod-a", "ops-artifacts": "pod-b"}
                }
            },
            "runtimeVerified": False,
            "clusterChanged": False,
            "storageDataReverified": False,
            "networkPolicyEnforcementVerified": False,
            "runnerActivationRequested": False,
            "opsRoutingChanged": False,
        }
        self.started = self.enterContext(
            patch.object(start, "verify_started", return_value=self.result)
        )
        self.enterContext(
            patch.object(
                release.fork_cluster,
                "load_settings",
                return_value={"stateId": "fixture"},
            )
        )
        self.report = self.enterContext(
            patch.object(
                release, "read_restore_report", return_value=({}, "report-hash")
            )
        )
        self.enterContext(
            patch.object(secrets.ops_runtime, "read_connection", return_value={})
        )
        self.entries = {"fixture": "validated-entries"}
        self.archive = self.enterContext(
            patch.object(
                secrets,
                "bound_archive",
                return_value=(
                    {"stores": {"results": {"entries": self.entries}}},
                    "archive-hash",
                    {"keys": {"artifact": "test-token-only-in-memory"}},
                    {"id": "frozen-source"},
                ),
            )
        )
        self.frozen = self.enterContext(
            patch.object(
                secrets.snapshot.database,
                "frozen_source",
                return_value=(
                    ["kubectl", "-n", "source"],
                    {"id": "frozen-source"},
                ),
            )
        )
        self.expected = {"completed-record": "validated-evidence"}
        self.evidence = self.enterContext(
            patch.object(
                secrets.snapshot, "completed_evidence", return_value=self.expected
            )
        )
        self.enterContext(
            patch.object(
                release.fork_cluster, "commands", return_value=(["kubectl"], [], [])
            )
        )
        self.enterContext(patch.object(release.fork_cluster, "verify_context"))
        self.http = self.enterContext(
            patch.object(
                start.storage_http,
                "verify",
                return_value={
                    "status": "VERIFIED",
                    "scope": "pod_loopback_port_forward",
                },
            )
        )

    def verify(self):
        return start.verify_http(
            "root",
            "fork",
            state="state",
            restore_report="report",
            archive="archive",
            key_file="key",
            langfuse_url="http://private",
        )

    def test_frozen_source_read_and_archive_key_bound_to_unchanged_rollout(self):
        result = self.verify()
        self.assertEqual(result["status"], "STORAGE_HTTP_VERIFIED")
        self.assertTrue(result["httpTrafficVerified"])
        for field in (
            "clusterServiceTrafficVerified",
            "runtimeVerified",
            "clusterChanged",
            "storageDataReverified",
            "networkPolicyEnforcementVerified",
            "runnerActivationRequested",
            "opsRoutingChanged",
        ):
            self.assertFalse(result[field])
        self.assertEqual(self.started.call_count, 2)
        self.http.assert_called_once_with(
            ["kubectl"],
            self.result["observation"]["storageWorkloads"]["pods"],
            self.expected,
            self.entries,
            "test-token-only-in-memory",
        )
        command = self.evidence.call_args.args[0]
        self.assertEqual(
            command[:9],
            [
                "kubectl",
                "-n",
                "source",
                "exec",
                "-i",
                "ops-mysql-0",
                "-c",
                "mysql",
                "--",
            ],
        )
        self.assertNotIn("test-token-only-in-memory", json.dumps(result))

    def test_changed_report_archive_or_source_blocks_before_http(self):
        original = self.archive.return_value
        for boundary in ("report", "archive", "source"):
            self.report.return_value = ({}, "report-hash")
            self.archive.return_value = original
            self.frozen.return_value = (["kubectl"], {"id": "frozen-source"})
            if boundary == "report":
                self.report.return_value = ({}, "changed")
            elif boundary == "archive":
                self.archive.return_value = (original[0], "changed", *original[2:])
            else:
                self.frozen.return_value = (["kubectl"], {"id": "other-source"})
            with self.subTest(boundary=boundary), self.assertRaises(ValueError):
                self.verify()
            self.http.assert_not_called()
            self.evidence.assert_not_called()

    def test_failed_admission_or_completed_record_binding_prevents_http(self):
        self.started.side_effect = ValueError("publication is stale")
        with self.assertRaises(ValueError):
            self.verify()
        self.http.assert_not_called()
        self.started.side_effect = None
        self.evidence.side_effect = ValueError("DB record differs from archive")
        with self.assertRaises(ValueError):
            self.verify()
        self.http.assert_not_called()

    def test_after_probe_rollout_or_source_change_is_not_success(self):
        after = copy.deepcopy(self.result)
        after["sourceHandoff"]["archiveSha256"] = "changed"
        self.started.side_effect = [self.result, after]
        with self.assertRaisesRegex(ValueError, "changed during"):
            self.verify()
        self.http.assert_called_once()


class HttpCliTests(unittest.TestCase):
    def arguments(self):
        return [
            "evaluation_storage_start.py",
            "--state-dir",
            "state",
            "--restore-report",
            "report",
            "--archive",
            "archive",
            "--key-file",
            "key",
            "--langfuse-url",
            "http://private",
            "--verify-http",
        ]

    def test_http_mode_cannot_be_combined_with_request_or_rollout_modes(self):
        for flag in ("--request-start", "--verify-started"):
            with (
                patch.object(sys, "argv", self.arguments() + [flag]),
                redirect_stderr(io.StringIO()),
                self.assertRaises(SystemExit) as error,
            ):
                start.main()
            self.assertEqual(error.exception.code, 2)

    @unittest.skipUnless(sys.platform == "linux", "CLI is WSL/Linux only")
    def test_dispatch_and_sanitized_failure_never_claim_http_success(self):
        with (
            patch.object(sys, "argv", self.arguments()),
            patch.object(release, "from_origin"),
            patch.object(release.fork_cluster, "locked", return_value=nullcontext()),
            patch.object(
                start, "verify_http", return_value={"status": "STORAGE_HTTP_VERIFIED"}
            ) as verify,
            patch.object(start, "verify_started") as rollout,
            patch.object(start, "request") as request,
        ):
            with redirect_stdout(io.StringIO()):
                self.assertEqual(start.main(), 0)
            self.assertEqual(verify.call_args.kwargs["archive"], Path("archive"))
            self.assertNotIn("start", verify.call_args.kwargs)
            rollout.assert_not_called()
            request.assert_not_called()
            verify.side_effect = ValueError("private-token-and-report-content")
            output = io.StringIO()
            with redirect_stdout(output):
                self.assertEqual(start.main(), 1)
            result = json.loads(output.getvalue())
            self.assertEqual(result["status"], "BLOCKED")
            self.assertFalse(result["httpTrafficVerified"])
            self.assertFalse(result["clusterChanged"])
            self.assertNotIn("private-token", output.getvalue())


if __name__ == "__main__":
    unittest.main()
