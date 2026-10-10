"""Actions setup guards; no network, real token or registry mutation."""

import copy
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

import bootstrap_runner_actions as setup
from repository import Fork

FORK = Fork("alice/Example")
SHA = "a" * 40
TOKEN = "temporary-workflow-token"


def package(visibility="private", **changes):
    return {
        "visibility": visibility,
        "owner": {"login": "alice"},
        "repository": {"full_name": FORK.repository},
        **changes,
    }


class RunnerSetupTests(unittest.TestCase):
    def setUp(self):
        self.env = {
            "GITHUB_ACTIONS": "true",
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_REPOSITORY": FORK.repository,
            "GOVBIZ_RELEASE_BRANCH": "main",
            "GITHUB_REF": "refs/heads/main",
            "GITHUB_SHA": SHA,
            "GITHUB_WORKFLOW_REF": f"{FORK.repository}/{setup.WORKFLOW}@refs/heads/main",
            "MSA_RELEASE_ENABLED": "true",
            "MSA_PACKAGE_VISIBILITY": "public",
        }
        self.event = {
            "repository": {"full_name": FORK.repository},
            "inputs": {"confirm_package": FORK.image(setup.SERVICE)},
        }
        self.repository = {
            "full_name": FORK.repository,
            "default_branch": "main",
            "fork": True,
            "owner": {"type": "User", "login": "alice"},
            "parent": {"full_name": setup.gate.UPSTREAM},
        }
        self.report = {"upload": "not_attempted"}
        self.commands = []
        self.metadata = None
        self.visibility = "private"
        for obj, name, options in (
            (
                setup.local,
                "api",
                {"side_effect": lambda *a, **kw: (self.repository, {})},
            ),
            (
                setup.local,
                "metadata",
                {"side_effect": lambda *a: copy.deepcopy(self.metadata)},
            ),
            (setup.local, "docker", {"side_effect": self.docker}),
            (setup.gate, "eligible", {"return_value": True}),
        ):
            patcher = patch.object(obj, name, **options)
            setattr(self, "mock_" + name, patcher.start())
            self.addCleanup(patcher.stop)

    def docker(self, *args, env, data=None):
        self.commands.append((args, env, data))
        if args[0] == "push":
            self.metadata = package(self.visibility)

    def prepare(self):
        setup.prepare(self.env, self.event, TOKEN, self.report)

    def test_new_empty_package_uses_temporary_token_and_requires_public_configuration(
        self,
    ):
        self.prepare()
        self.assertEqual(self.report["status"], "AWAITING_PUBLIC_CONFIGURATION")
        self.assertEqual(self.report["upload"], "completed")
        self.assertEqual(self.report["sourceSha"], SHA)
        self.assertEqual(self.mock_eligible.call_count, 3)
        builds = [item for item in self.commands if item[0][0] == "build"]
        self.assertEqual(len(builds), 1)
        args, env, dockerfile = builds[0]
        self.assertEqual(args[-1], "-")
        self.assertIn("FROM scratch\n", dockerfile)
        self.assertIn(
            'LABEL org.opencontainers.image.source="' + FORK.source_url + '"',
            dockerfile,
        )
        for forbidden in ("COPY", "ADD", "RUN ", "ARG ", TOKEN):
            self.assertNotIn(forbidden, dockerfile)
        self.assertNotIn(TOKEN, str([args for args, _, _ in self.commands]))
        self.assertEqual(self.commands[0][0][-1], "--password-stdin")
        self.assertEqual(self.commands[0][2], TOKEN)
        self.assertEqual(sum(args[0] == "push" for args, _, _ in self.commands), 1)
        self.assertTrue(
            all(
                FORK.image(setup.SERVICE) in args[1]
                for args, _, _ in self.commands
                if args[0] == "push"
            )
        )
        self.assertEqual(self.commands[-1][0], ("logout", "ghcr.io"))
        self.assertFalse(Path(env["DOCKER_CONFIG"]).exists())

    def test_existing_package_is_read_only_and_public_state_is_not_assumed(self):
        for visibility in ("private", "public"):
            self.metadata = package(visibility)
            self.prepare()
            expected = (
                "PUBLIC_METADATA_VERIFIED"
                if visibility == "public"
                else "AWAITING_PUBLIC_CONFIGURATION"
            )
            self.assertEqual(self.report["status"], expected)
        self.mock_docker.assert_not_called()
        self.visibility = "public"
        self.metadata = None
        self.prepare()
        self.assertEqual(self.report["status"], "PUBLIC_METADATA_VERIFIED")

    def test_web_selection_creates_only_the_confirmed_web_package(self):
        self.event["inputs"] = {
            "component": "web",
            "confirm_package": FORK.image("web"),
        }
        self.prepare()
        self.assertEqual(self.report["service"], "web")
        self.assertEqual(self.report["package"], FORK.image("web"))
        self.assertTrue(
            all(call.args[1] == "web" for call in self.mock_metadata.call_args_list)
        )
        self.assertTrue(
            all(
                args[1].startswith(FORK.image("web") + ":bootstrap-")
                for args, _, _ in self.commands
                if args[0] == "push"
            )
        )
        self.mock_docker.reset_mock()
        for inputs in (
            {"component": "web", "confirm_package": FORK.image(setup.SERVICE)},
            {"component": "ops-service", "confirm_package": FORK.image("ops-service")},
        ):
            self.event["inputs"] = inputs
            with self.subTest(inputs=inputs), self.assertRaises(ValueError):
                self.prepare()
        self.mock_docker.assert_not_called()

    def test_wrong_event_ref_target_policy_repository_and_local_run_are_rejected(self):
        for change in (
            {"GITHUB_ACTIONS": "false"},
            {"GITHUB_EVENT_NAME": "push"},
            {"GITHUB_EVENT_NAME": "workflow_run"},
            {"GITHUB_REF": "refs/heads/topic"},
            {"GITHUB_WORKFLOW_REF": "other/workflow@refs/heads/main"},
            {"MSA_RELEASE_ENABLED": "false"},
            {"MSA_PACKAGE_VISIBILITY": "private"},
            {"GITHUB_SHA": "invalid"},
            {"GITHUB_REPOSITORY": setup.gate.UPSTREAM},
        ):
            with self.subTest(change=change), self.assertRaises(ValueError):
                setup.prepare(self.env | change, self.event, TOKEN, {})
        self.event["inputs"]["confirm_package"] = FORK.image("ops-service")
        with self.assertRaises(ValueError):
            self.prepare()
        self.mock_docker.assert_not_called()
        self.mock_metadata.assert_not_called()
        self.event["inputs"]["confirm_package"] = FORK.image(setup.SERVICE)
        original = self.repository
        for change in (
            {"fork": False},
            {"default_branch": "develop"},
            {"parent": {"full_name": "other/repo"}},
            {"owner": {"type": "Organization", "login": "alice"}},
        ):
            self.repository = original | change
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.prepare()
        self.mock_docker.assert_not_called()

    def test_ci_failure_before_login_and_source_change_before_push_are_blocked(self):
        self.mock_eligible.return_value = False
        with self.assertRaises(ValueError):
            self.prepare()
        self.mock_docker.assert_not_called()
        self.mock_metadata.assert_not_called()
        self.mock_eligible.side_effect = [True, False]
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertFalse(any(args[0] == "push" for args, _, _ in self.commands))
        self.assertEqual(self.commands[-1][0], ("logout", "ghcr.io"))
        self.assertFalse(Path(self.commands[0][1]["DOCKER_CONFIG"]).exists())

    def test_wrong_package_or_read_failure_cannot_trigger_creation(self):
        for current in (
            package(owner={"login": "bob"}),
            package(repository=None),
            package(repository={"full_name": "alice/Other"}),
        ):
            self.metadata = current
            with self.subTest(package=current), self.assertRaises(ValueError):
                self.prepare()
        self.mock_docker.assert_not_called()
        self.mock_metadata.side_effect = ValueError("API inaccessible")
        with self.assertRaises(ValueError):
            self.prepare()
        self.mock_docker.assert_not_called()

    def test_package_appearing_during_build_is_not_uploaded_or_adopted_if_foreign(self):
        for current in (package(), package(repository={"full_name": "alice/Other"})):
            self.commands.clear()
            self.mock_metadata.side_effect = [None, current]
            if current["repository"]["full_name"] == FORK.repository:
                self.prepare()
            else:
                with self.assertRaises(ValueError):
                    self.prepare()
            self.assertFalse(any(args[0] == "push" for args, _, _ in self.commands))
            self.assertEqual(self.commands[-1][0], ("logout", "ghcr.io"))

    def test_failed_upload_still_cleans_credentials_and_records_uncertainty(self):
        def failed(*args, **kwargs):
            self.docker(*args, **kwargs)
            if args[0] == "push":
                raise ValueError("Network response lost")

        self.mock_docker.side_effect = failed
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertEqual(self.report["upload"], "attempted")
        self.assertEqual(self.commands[-1][0], ("logout", "ghcr.io"))
        self.assertFalse(Path(self.commands[0][1]["DOCKER_CONFIG"]).exists())

    def test_cli_diagnostics_never_contain_raw_error_or_application_receipts(self):
        with tempfile.TemporaryDirectory() as directory:
            event, report = (
                Path(directory) / "event.json",
                Path(directory) / "report.json",
            )
            event.write_text(json.dumps(self.event), encoding="utf-8")
            output = io.StringIO()
            with (
                patch.dict(
                    os.environ,
                    self.env
                    | {
                        "GITHUB_EVENT_PATH": str(event),
                        "GH_TOKEN": TOKEN,
                        "GITHUB_STEP_SUMMARY": "",
                    },
                ),
                patch.object(setup, "prepare", side_effect=ValueError(TOKEN)),
                patch(
                    "sys.argv", ["bootstrap_runner_actions.py", "--report", str(report)]
                ),
                redirect_stdout(output),
            ):
                self.assertEqual(setup.main(), 1)
            self.assertNotIn(TOKEN, output.getvalue())
            result = json.loads(report.read_text())
            self.assertEqual(result["status"], "BLOCKED")
            for name in (
                "applicationImagePublished",
                "receiptWritten",
                "clusterChanged",
            ):
                self.assertIs(result[name], False)


if __name__ == "__main__":
    unittest.main()
