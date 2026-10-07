"""Failure stages and value-free differences for the real transition CLI."""

import copy
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

import gitops_transition as transition
import sync_images
from repository import Fork


class SectionTests(unittest.TestCase):
    def test_all_fields_are_compared_but_only_fixed_sections_are_reported(self):
        saved = {
            "sourceSha": "a" * 40,
            "runtimePreflight": {"PRIVATE": "old"},
            "resources": [{"PRIVATE": "old"}],
            "rendered": {"PRIVATE": "old"},
            "deploymentAuthorized": False,
            "PRIVATE unknown key": {"private": "old"},
            "generatedAt": "old",
        }
        for field, section in (
            ("sourceSha", "publication"),
            ("runtimePreflight", "runtime"),
            ("resources", "argo_resources"),
            ("rendered", "rendered_resources"),
            ("deploymentAuthorized", "safety_contract"),
            ("PRIVATE unknown key", "other_fields"),
        ):
            with self.subTest(field=field):
                fresh = copy.deepcopy(saved)
                fresh[field] = "PRIVATE changed value"
                self.assertEqual(transition.changed_sections(saved, fresh), [section])
        self.assertEqual(
            transition.changed_sections(saved, saved | {"generatedAt": "new"}), []
        )

    def test_missing_null_boolean_and_numeric_values_remain_distinct(self):
        for saved, fresh, section in (
            ({}, {"PRIVATE": None}, "other_fields"),
            ({"resources": None}, {}, "argo_resources"),
            ({"servicesChanged": False}, {"servicesChanged": 0}, "safety_contract"),
            ({"publisherRunId": 1}, {"publisherRunId": True}, "publication"),
            ({"images": {"a": 1}}, {"images": {"a": 1.0}}, "publication"),
        ):
            with self.subTest(section=section):
                self.assertEqual(transition.changed_sections(saved, fresh), [section])


@unittest.skipUnless(os.name == "posix", "Private files require POSIX permissions")
class DiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.state = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.name = "gitops-transition-diagnostics"
        self.fork = Fork("alice/project", "main")
        self.origin = self.enterContext(
            patch.object(transition, "from_origin", return_value=self.fork)
        )
        self.publication = ({"runId": 123}, {}, "a" * 40)
        self.publish = self.enterContext(
            patch.object(
                transition.deployment, "verified_release", return_value=self.publication
            )
        )
        self.observe = self.enterContext(
            patch.object(transition.runtime, "preflight", return_value={})
        )
        self.plan = {
            "schema": "msa-gitops-transition-v1",
            "status": "PREPARED_NOT_APPLIED",
            "repository": self.fork.repository,
            "sourceSha": "a" * 40,
            "publisherRunId": 123,
            "stateId": "fixture",
            "generatedAt": "2026-10-07T00:00:00+00:00",
            "resources": [{"PRIVATE@example.test": "PRIVATE"}],
            "deploymentAuthorized": False,
        }
        self.build = self.enterContext(
            patch.object(transition, "build_plan", return_value=self.plan)
        )
        self.settings = self.enterContext(
            patch.object(
                transition.runtime.cluster,
                "load_settings",
                return_value={
                    "stateId": "fixture",
                    "repository": self.fork.repository,
                },
            )
        )

    def failure(self, stage, verify=False):
        output = io.StringIO()
        with (
            patch(
                "sys.argv",
                [
                    "gitops_transition.py",
                    "--state-dir",
                    str(self.state),
                    "--output-name",
                    self.name,
                ]
                + (["--verify"] if verify else []),
            ),
            redirect_stdout(output),
        ):
            self.assertEqual(transition.main(), 1)
        report = json.loads(output.getvalue())
        self.assertEqual(report["status"], "BLOCKED")
        self.assertEqual(report["failureStage"], stage)
        self.assertNotIn("PRIVATE", output.getvalue())
        for key in (
            "deploymentAuthorized",
            "configurationValuesIncluded",
            "servicesChanged",
            "databaseChanged",
        ):
            self.assertFalse(report[key])
        return report

    def test_repository_failure_stops_before_publication(self):
        self.origin.side_effect = subprocess.TimeoutExpired(
            ["PRIVATE"], 15, stderr="PRIVATE"
        )
        report = self.failure("repository_identity")
        self.assertEqual(report["failureKind"], "external_command_timeout")
        self.assertEqual(report["externalTool"], "unknown")
        self.publish.assert_not_called()

    def test_external_tool_is_allowlisted_without_arguments_or_private_paths(self):
        for command, expected in (
            (["gh", "api", "PRIVATE"], "gh"),
            (["/PRIVATE/path/helm", "PRIVATE"], "helm"),
            (["/PRIVATE/path/gh.exe", "PRIVATE"], "gh"),
            (["/PRIVATE/tool", "PRIVATE"], "unknown"),
            ("PRIVATE shell command", "unknown"),
        ):
            with self.subTest(expected=expected):
                self.publish.side_effect = subprocess.CalledProcessError(
                    1, command, stderr="PRIVATE"
                )
                self.assertEqual(
                    self.failure("publication_verification")["externalTool"], expected
                )

    def test_existing_output_stops_before_publication_without_touching_file(self):
        transition.write_plan(self.state / self.name, self.plan)
        before = (self.state / self.name / "transition.json").read_bytes()
        self.failure("output_path_check")
        self.publish.assert_not_called()
        self.assertEqual(
            (self.state / self.name / "transition.json").read_bytes(), before
        )

    def test_preparation_failure_stage_and_type_prevent_output(self):
        for stage, target in (
            ("publication_verification", self.publish),
            ("runtime_preservation", self.observe),
            ("plan_rendering", self.build),
        ):
            with self.subTest(stage=stage):
                target.side_effect = subprocess.CalledProcessError(
                    1, ["PRIVATE"], stderr=b"PRIVATE"
                )
                report = self.failure(stage)
                self.assertEqual(report["errorType"], "CalledProcessError")
                self.assertEqual(report["failureKind"], "external_command_failed")
                self.assertEqual(list(self.state.iterdir()), [])
                target.side_effect = None

    def test_publication_recheck_failure_and_changed_receipts_prevent_output(self):
        for result in (ValueError("PRIVATE"), ({"runId": 456}, {}, "b" * 40)):
            self.publish.side_effect = [self.publication, result]
            self.failure("publication_revalidation")
            self.assertEqual(list(self.state.iterdir()), [])

    def test_write_failure_reports_stage_and_retains_siblings(self):
        sibling = self.state / "keep"
        sibling.write_text("unchanged")
        with patch.object(transition, "write_plan", side_effect=OSError("PRIVATE")):
            report = self.failure("plan_write")
        self.assertEqual(report["errorType"], "OSError")
        self.assertEqual(sibling.read_text(), "unchanged")

    def test_saved_read_and_identity_fail_before_external_verification(self):
        self.failure("saved_plan_read", verify=True)
        transition.write_plan(
            self.state / self.name, self.plan | {"repository": "other/project"}
        )
        self.failure("saved_plan_identity", verify=True)
        self.publish.assert_not_called()

    def test_mismatch_reports_sections_without_private_keys_or_values_or_rewriting(
        self,
    ):
        transition.write_plan(
            self.state / self.name, self.plan | {"PRIVATE unknown key": "value"}
        )
        path = self.state / self.name / "transition.json"
        before = path.read_bytes()
        self.build.return_value = self.plan | {
            "resources": [{"PRIVATE changed": "new"}]
        }
        report = self.failure("plan_comparison", verify=True)
        self.assertEqual(report["changedSections"], ["argo_resources", "other_fields"])
        self.assertEqual(path.read_bytes(), before)

    def test_final_state_and_file_rechecks_report_distinct_stages(self):
        transition.write_plan(self.state / self.name, self.plan)
        settings = self.settings.return_value
        self.settings.side_effect = [settings, settings | {"stateId": "PRIVATE"}]
        self.failure("state_revalidation", verify=True)
        self.settings.side_effect = None
        real_read = transition.read_plan
        calls = []

        def read(*args):
            calls.append(args)
            if len(calls) == 2:
                raise PermissionError("PRIVATE")
            return real_read(*args)

        with patch.object(transition, "read_plan", side_effect=read):
            self.failure("saved_plan_revalidation", verify=True)

    def test_wrapped_publication_failure_preserves_advisory_diagnostic(self):
        self.publish.side_effect = ValueError(
            "No complete verified publication: PRIVATE"
        )
        blocker = {"status": "BLOCKED", "stage": "required_ci", "advisoryOnly": True}
        with patch.object(
            transition.deployment, "publication_blocker", return_value=blocker
        ):
            report = self.failure("publication_verification")
        self.assertEqual(report["reason"], "publication_not_verified")
        self.assertEqual(report["publicationBlocker"], blocker)
        self.observe.assert_not_called()


class GitHubCommandTests(unittest.TestCase):
    def test_api_preserves_json_and_binary_receipt_contracts(self):
        for api in (transition.deployment.api, sync_images.api):
            with patch.object(subprocess, "check_output", return_value=b'{"ok":true}'):
                self.assertEqual(api("repos/alice/project"), {"ok": True})
        with patch.object(subprocess, "check_output", return_value=b"PK\x00receipt"):
            self.assertEqual(
                sync_images.api("repos/alice/project/zip", binary=True),
                b"PK\x00receipt",
            )

    def test_external_stderr_is_captured_and_real_timeout_is_propagated(self):
        real_output = subprocess.check_output
        for api in (transition.deployment.api, sync_images.api):
            for timeout in (False, True):

                def execute(command, *, should_timeout=timeout, timeout=90, **kwargs):
                    self.assertEqual(command[:2], ["gh", "api"])
                    self.assertEqual(timeout, 90)
                    self.assertEqual(kwargs.get("stderr"), subprocess.PIPE)
                    script = (
                        "import time; time.sleep(10)"
                        if should_timeout
                        else "import sys; sys.stderr.write('PRIVATE'); sys.exit(3)"
                    )
                    return real_output(
                        [sys.executable, "-c", script],
                        timeout=0.2 if should_timeout else 10,
                        **kwargs,
                    )

                expected = (
                    subprocess.TimeoutExpired
                    if timeout
                    else subprocess.CalledProcessError
                )
                with (
                    self.subTest(api=api.__module__, timeout=timeout),
                    patch.object(subprocess, "check_output", side_effect=execute),
                ):
                    with self.assertRaises(expected) as caught:
                        api("repos/alice/project")
                    if not timeout:
                        self.assertIn("PRIVATE", str(caught.exception.stderr))


if __name__ == "__main__":
    unittest.main()
