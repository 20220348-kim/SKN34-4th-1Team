import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import gate
import outcome
import publish
from repository import Fork

SHA = "a" * 40
REVISION = "b" * 40
ENV = {
    "GITHUB_REPOSITORY": "alice/Example",
    "GOVBIZ_RELEASE_BRANCH": "main",
    "GITHUB_EVENT_NAME": "workflow_run",
    "GITHUB_RUN_ID": "21",
    "GITHUB_RUN_ATTEMPT": "2",
    "MSA_RELEASE_ENABLED": "true",
    "MSA_PROMOTION_ENABLED": "true",
}
EVENT = {
    "repository": {
        "full_name": "alice/Example",
        "fork": True,
        "owner": {"type": "User"},
    },
    "workflow_run": {"head_sha": SHA},
}


class OutcomeTests(unittest.TestCase):
    def report(
        self, stage, outputs=None, result="success", publish_result="success", env=None
    ):
        job = "gate" if stage == "publication" else "promote"
        return outcome.workflow_report(
            stage,
            {
                job: {"result": result, "outputs": outputs or {}},
                "publish": {"result": publish_result},
            },
            EVENT,
            ENV | (env or {}),
        )

    def test_gate_only_success_is_blocked_not_publication(self):
        report = self.report(
            "publication",
            {"reason": "ci_run_missing:llmops-ci.yml", "source_sha": SHA},
            publish_result="skipped",
        )
        self.assertEqual(report["state"], "blocked")
        self.assertEqual(report["reason"], "ci_run_missing:llmops-ci.yml")
        self.assertFalse(report["imagesVerified"])
        self.assertEqual(report["sourceSha"], SHA)
        self.assertFalse(report["clusterVerified"])

    def test_verified_requires_successful_gate_source_and_all_matrix_jobs(self):
        outputs = {"ready": "true", "source_sha": SHA}
        self.assertTrue(self.report("publication", outputs)["imagesVerified"])
        for state in ("failure", "cancelled", "skipped", "unknown"):
            with self.subTest(state=state):
                self.assertFalse(
                    self.report("publication", outputs, publish_result=state)[
                        "imagesVerified"
                    ]
                )
                self.assertFalse(
                    self.report("publication", outputs, result=state)["imagesVerified"]
                )
        self.assertFalse(
            self.report("publication", {"ready": "true"})["imagesVerified"]
        )
        self.assertFalse(
            self.report("publication", outputs, env={"MSA_RELEASE_ENABLED": "false"})[
                "imagesVerified"
            ]
        )

    def test_success_without_gate_evidence_is_never_a_success_state(self):
        report = self.report("publication", {"ready": "true"})
        self.assertEqual(report["state"], "unverified")
        self.assertEqual(report["reason"], "missing_gate_evidence")

    def test_disabled_skipped_job_keeps_trigger_sha_without_inventing_source(self):
        report = self.report(
            "publication",
            result="skipped",
            publish_result="skipped",
            env={"MSA_RELEASE_ENABLED": "false"},
        )
        self.assertEqual(report["reason"], "disabled")
        self.assertEqual(report["triggerSha"], SHA)
        self.assertIsNone(report["sourceSha"])

    def test_foreign_event_and_invalid_sha_do_not_confirm_publication(self):
        report = outcome.workflow_report(
            "publication",
            {
                "gate": {
                    "result": "success",
                    "outputs": {"ready": "true", "source_sha": SHA},
                },
                "publish": {"result": "success"},
            },
            {},
            ENV,
        )
        self.assertFalse(report["imagesVerified"])
        self.assertIsNone(
            self.report("publication", {"source_sha": "main; echo bad"})["sourceSha"]
        )

    def test_promotion_needs_confirmed_push_not_just_successful_job(self):
        report = self.report(
            "promotion", {"source_sha": SHA, "reason": "no_complete_release"}
        )
        self.assertEqual(report["state"], "blocked")
        self.assertFalse(report["pushed"])
        confirmed = self.report(
            "promotion", {"source_sha": SHA, "pushed": "true", "revision": REVISION}
        )
        self.assertEqual(confirmed["state"], "pushed")
        self.assertTrue(confirmed["pushed"])
        self.assertFalse(confirmed["clusterVerified"])

    def test_failed_or_cancelled_push_is_unknown_not_false_success(self):
        for state in ("failure", "cancelled"):
            report = self.report(
                "promotion",
                {"source_sha": SHA, "push_attempted": "true", "reason": "prepared"},
                result=state,
            )
            self.assertIsNone(report["pushed"])
            self.assertEqual(report["reason"], "push_unconfirmed")
            self.assertEqual(report["state"], state)

    def test_later_job_failure_does_not_erase_confirmed_push_fact(self):
        report = self.report(
            "promotion",
            {"source_sha": SHA, "pushed": "true", "revision": REVISION},
            result="failure",
        )
        self.assertTrue(report["pushed"])
        self.assertEqual(report["jobResult"], "failure")

    def test_selection_and_validation_failures_remain_failures(self):
        for phase in ("selection", "validation", "commit"):
            report = self.report(
                "promotion",
                {"source_sha": SHA, "reason": "prepared", phase + "_result": "failure"},
                result="failure",
            )
            self.assertEqual(report["state"], "failure")
            self.assertEqual(report["reason"], phase + "_failure")
            self.assertFalse(report["pushed"])

    def test_unchanged_requires_source_and_revision_and_is_not_push(self):
        report = self.report(
            "promotion", {"source_sha": SHA, "unchanged": "true", "revision": REVISION}
        )
        self.assertEqual(report["state"], "unchanged")
        self.assertFalse(report["pushed"])
        self.assertNotEqual(
            self.report("promotion", {"unchanged": "true"})["state"], "unchanged"
        )

    def test_summary_and_json_are_same_facts_without_environment_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "report.json"
            summary = Path(directory) / "summary.md"
            report = self.report(
                "publication",
                {"reason": "event_not_eligible"},
                publish_result="skipped",
            )
            with (
                patch.dict(
                    os.environ,
                    {
                        "GITHUB_STEP_SUMMARY": str(summary),
                        "GH_TOKEN": "never-print-this-token",
                    },
                ),
                contextlib.redirect_stdout(io.StringIO()) as console,
            ):
                saved = outcome.write_report(path, report)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), saved)
            self.assertIn(
                '"imagesVerified": false', summary.read_text(encoding="utf-8")
            )
            self.assertNotIn(
                "never-print-this-token",
                console.getvalue() + summary.read_text(encoding="utf-8"),
            )

    def test_publish_exception_records_safe_type_and_reraises(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "report.json"

            def failed(*args, result, **kwargs):
                result.update(upload="confirmed", receiptWritten=False)
                raise ValueError("fixture-sensitive-error-text")

            with (
                patch.dict(
                    os.environ,
                    ENV | {"GITHUB_ACTOR": "alice", "GH_TOKEN": "fixture-token"},
                    clear=True,
                ),
                patch(
                    "sys.argv",
                    [
                        "publish.py",
                        "--service",
                        "ai-service",
                        "--sha",
                        SHA,
                        "--output",
                        str(Path(directory) / "receipt.json"),
                        "--report",
                        str(path),
                    ],
                ),
                patch.object(publish, "publish", side_effect=failed),
                contextlib.redirect_stdout(io.StringIO()),
                self.assertRaises(ValueError),
            ):
                publish.main()
            saved = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(saved["upload"], "confirmed")
            self.assertFalse(saved["receiptWritten"])
            self.assertEqual(saved["errorType"], "ValueError")
            self.assertNotIn(
                "fixture-sensitive-error-text", path.read_text(encoding="utf-8")
            )

    def test_gate_api_failure_keeps_failure_and_safe_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            event = Path(directory) / "event.json"
            output = Path(directory) / "output.txt"
            event.write_text(json.dumps(EVENT))
            env = ENV | {
                "GITHUB_EVENT_NAME": "workflow_dispatch",
                "GITHUB_EVENT_PATH": str(event),
                "GITHUB_OUTPUT": str(output),
                "GITHUB_REF": "refs/heads/main",
                "GITHUB_SHA": SHA,
            }
            with (
                patch.dict(os.environ, env, clear=True),
                patch("sys.argv", ["gate.py"]),
                patch.object(
                    gate,
                    "blocked_reason",
                    side_effect=RuntimeError("private error details"),
                ),
                self.assertRaises(RuntimeError),
            ):
                gate.main()
            text = output.read_text(encoding="utf-8")
            self.assertIn("ready=false", text)
            self.assertIn("reason=gate_error", text)
            self.assertIn("source_sha=" + SHA, text)
            self.assertNotIn("private error details", text)

    def test_report_cannot_overwrite_image_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"
            path.write_text("existing receipt", encoding="utf-8")
            with (
                patch(
                    "sys.argv",
                    [
                        "publish.py",
                        "--service",
                        "ai-service",
                        "--sha",
                        SHA,
                        "--output",
                        str(path),
                        "--report",
                        str(path),
                    ],
                ),
                patch.object(publish, "publish") as operation,
                contextlib.redirect_stderr(io.StringIO()),
                self.assertRaises(SystemExit) as error,
            ):
                publish.main()
            self.assertEqual(error.exception.code, 2)
            operation.assert_not_called()
            self.assertEqual(path.read_text(encoding="utf-8"), "existing receipt")

    def test_reuse_does_not_claim_new_upload(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(publish, "git", side_effect=[SHA, "b" * 40, "c" * 40]),
            patch.object(publish, "eligible", return_value=True),
            patch.object(publish, "package_exists", return_value=True),
            patch.object(publish, "lookup", return_value="sha256:" + "d" * 64),
            patch.object(publish, "run"),
            patch.object(publish.subprocess, "run"),
        ):
            result = {}
            publish.publish(
                "ai-service",
                SHA,
                Path(directory) / "receipt.json",
                "alice",
                "fixture-token",
                Fork("alice/Example"),
                result=result,
            )
            self.assertEqual(result["state"], "reused")
            self.assertEqual(result["upload"], "not_attempted")
            self.assertTrue(result["receiptWritten"])


if __name__ == "__main__":
    unittest.main()
