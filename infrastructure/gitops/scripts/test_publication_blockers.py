"""Explain missing publications without interpreting diagnostics as approval."""

import io
import json
import subprocess
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

import deployment
import gitops_runtime
from test_sync_images import FORK, SHA, ci_results


class PublicationBlockerTests(unittest.TestCase):
    def test_real_gate_identifies_missing_failed_and_skipped_required_ci(self):
        for state, reason in (
            ("missing", "ci_run_missing"),
            ("failure", "ci_run_not_successful_or_untrusted"),
            ("skipped", "ci_jobs_not_successful_or_incomplete"),
        ):
            with self.subTest(state=state):
                result = deployment.publication_blocker(FORK, ci_results([state]))
                self.assertEqual(
                    result,
                    {
                        "status": "BLOCKED",
                        "stage": "required_ci",
                        "reason": reason,
                        "workflow": "llmops-ci.yml",
                        "observedSourceSha": SHA,
                        "advisoryOnly": True,
                    },
                )

    def test_pending_ci_is_not_reported_as_missing_images_after_success(self):
        fixture = ci_results(["success"])

        def get(path):
            result = fixture(path)
            if "/workflows/ci.yml/runs?" in path:
                result["workflow_runs"][0].update(status="in_progress", conclusion=None)
            return result

        result = deployment.publication_blocker(FORK, get)
        self.assertEqual(result["stage"], "required_ci")
        self.assertEqual(result["workflow"], "ci.yml")
        self.assertEqual(result["reason"], "ci_run_not_successful_or_untrusted")

    def test_successful_source_checks_do_not_confirm_publication(self):
        result = deployment.publication_blocker(FORK, ci_results(["success"]))
        self.assertEqual(result["status"], "BLOCKED")
        self.assertEqual(result["stage"], "publication")
        self.assertEqual(result["reason"], "verified_publication_missing")
        self.assertTrue(result["advisoryOnly"])
        self.assertNotIn("imagesVerified", result)

    def test_upstream_sync_is_distinguished_from_ci(self):
        fixture = ci_results(["success"])

        def get(path):
            if "SKNETWORKS-FAMILY-AICAMP" in path and "/git/ref/" in path:
                return {"object": {"sha": "b" * 40}}
            if "/compare/" in path:
                return {"status": "diverged"}
            return fixture(path)

        result = deployment.publication_blocker(FORK, get)
        self.assertEqual(result["stage"], "upstream")
        self.assertEqual(result["reason"], "upstream_not_merged")
        self.assertNotIn("workflow", result)

    def test_later_upstream_merge_keeps_ci_and_publication_checks_required(self):
        for state, stage, reason in (
            ("success", "publication", "verified_publication_missing"),
            ("missing", "required_ci", "ci_run_missing"),
            ("failure", "required_ci", "ci_run_not_successful_or_untrusted"),
            ("skipped", "required_ci", "ci_jobs_not_successful_or_incomplete"),
        ):
            fixture = ci_results([state])
            def get(path):
                if "SKNETWORKS-FAMILY-AICAMP" in path and "/git/ref/" in path:
                    return {"object": {"sha": "b" * 40}}
                if "/compare/" in path:
                    return {"status": "behind", "base_commit": {"sha": "b" * 40},
                            "merge_base_commit": {"sha": SHA}, "ahead_by": 0, "behind_by": 6,
                            "total_commits": 0, "commits": [], "files": []}
                return fixture(path)
            with self.subTest(ci=state):
                result = deployment.publication_blocker(FORK, get)
                self.assertEqual(result["stage"], stage)
                self.assertEqual(result["reason"], reason)
                self.assertTrue(result["advisoryOnly"])
                self.assertNotIn("imagesVerified", result)

    def test_source_change_discards_the_stale_diagnosis(self):
        fixture = ci_results(["failure"])
        reads = 0

        def get(path):
            nonlocal reads
            if path == f"repos/{FORK.repository}/git/ref/heads/main":
                reads += 1
                return {"object": {"sha": SHA if reads < 3 else "b" * 40}}
            return fixture(path)

        result = deployment.publication_blocker(FORK, get)
        self.assertEqual(result["status"], "UNKNOWN")
        self.assertEqual(result["reason"], "source_changed")
        self.assertNotIn("observedSourceSha", result)
        self.assertNotIn("workflow", result)

    def test_api_failures_invalid_sha_and_unknown_reasons_never_leak_details(self):
        failures = (
            OSError("PRIVATE"),
            subprocess.CalledProcessError(1, "PRIVATE", output="PRIVATE"),
            subprocess.TimeoutExpired("PRIVATE", 1),
        )
        for error in failures:
            with (
                self.subTest(error=type(error).__name__),
                patch.object(deployment, "head", side_effect=error),
            ):
                result = deployment.publication_blocker(FORK)
                self.assertEqual(result["status"], "UNKNOWN")
                self.assertNotIn("PRIVATE", json.dumps(result))
        result = deployment.publication_blocker(
            FORK, lambda path: {"object": {"sha": "PRIVATE"}}
        )
        self.assertEqual(result["reason"], "diagnostic_unavailable")
        for reason in ("PRIVATE", "ci_run_missing:PRIVATE", "PRIVATE:ci.yml"):
            with (
                patch.object(deployment, "head", return_value=SHA),
                patch.object(deployment, "blocked_reason", return_value=reason),
            ):
                result = deployment.publication_blocker(FORK)
                self.assertEqual(result["status"], "UNKNOWN")
                self.assertNotIn("PRIVATE", json.dumps(result))

    def test_missing_publication_never_downloads_or_renders_after_diagnosis(self):
        result = deployment.publication_blocker(FORK, ci_results(["failure"]))
        output = io.StringIO()
        with (
            patch("sys.argv", ["deployment.py", "verify-public"]),
            patch.object(deployment, "from_origin", return_value=FORK),
            patch.object(deployment, "select_release", return_value=None),
            patch.object(deployment, "publication_blocker", return_value=result),
            patch.object(deployment, "checked_receipts") as receipts,
            patch.object(deployment, "ensure_revision") as revision,
            patch.object(deployment, "release_files") as render,
            redirect_stdout(output),
        ):
            self.assertEqual(deployment.main(), 1)
        report = json.loads(output.getvalue())
        self.assertEqual(report["publicationBlocker"]["stage"], "required_ci")
        receipts.assert_not_called()
        revision.assert_not_called()
        render.assert_not_called()

    def test_cli_keeps_all_actions_blocked_with_advisory_diagnostics(self):
        for action in ("verify-public", "plan-gitops", "review-published-runtime"):
            args = ["deployment.py", action]
            if action == "review-published-runtime":
                args += ["--state-dir", "unused"]
            output = io.StringIO()
            with (
                self.subTest(action=action),
                patch("sys.argv", args),
                patch.object(deployment, "from_origin", return_value=FORK),
                patch.object(deployment, "select_release", return_value=None),
                patch.object(
                    deployment,
                    "publication_blocker",
                    return_value={
                        "status": "UNKNOWN",
                        "reason": "diagnostic_unavailable",
                        "advisoryOnly": True,
                    },
                ),
                patch.object(gitops_runtime, "preflight") as runtime,
                patch.object(deployment, "gitops_plan") as plan,
                redirect_stdout(output),
            ):
                self.assertEqual(deployment.main(), 1)
            report = json.loads(output.getvalue())
            self.assertEqual(report["status"], "BLOCKED")
            self.assertEqual(report["reason"], "publication_not_available")
            self.assertEqual(report["publicationBlocker"]["status"], "UNKNOWN")
            self.assertNotIn("sourceSha", report)
            self.assertNotIn("resources", report)
            self.assertFalse(report["clusterVerified"])
            self.assertNotIn("runtimePreflight", report)
            runtime.assert_not_called()
            plan.assert_not_called()

    def test_old_publication_and_blocked_source_also_explain_current_branch(self):
        for message, reason in (
            ("Source advanced: PRIVATE", "source_not_current"),
            (
                "Deployment source blocked: PRIVATE",
                "required_source_checks_not_verified",
            ),
        ):
            output = io.StringIO()
            result = deployment.publication_blocker(FORK, ci_results(["failure"]))
            with (
                self.subTest(reason=reason),
                patch("sys.argv", ["deployment.py", "verify-public"]),
                patch.object(deployment, "from_origin", return_value=FORK),
                patch.object(
                    deployment, "verified_release", side_effect=ValueError(message)
                ) as verify,
                patch.object(
                    deployment, "publication_blocker", return_value=result
                ) as diagnose,
                redirect_stdout(output),
            ):
                self.assertEqual(deployment.main(), 1)
            report = json.loads(output.getvalue())
            self.assertEqual(report["status"], "BLOCKED")
            self.assertEqual(report["reason"], reason)
            self.assertEqual(report["publicationBlocker"]["observedSourceSha"], SHA)
            self.assertNotIn("sourceSha", report)
            self.assertNotIn("PRIVATE", output.getvalue())
            verify.assert_called_once()
            diagnose.assert_called_once_with(FORK)


if __name__ == "__main__":
    unittest.main()
