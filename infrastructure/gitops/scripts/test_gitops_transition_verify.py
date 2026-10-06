"""Revalidate stored transition files without trusting their flags or hashes."""

import copy
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

import gitops_transition as transition
from repository import Fork


@unittest.skipUnless(os.name == "posix", "Private state uses POSIX permissions")
class SavedPlanTests(unittest.TestCase):
    def setUp(self):
        self.state = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.fork = Fork("alice/project", "main")
        self.name = "gitops-transition-verify"
        self.root = Path("fixture-root")
        self.settings = transition.runtime.cluster.initial_settings(self.fork)
        self.plan = {
            "schema": "msa-gitops-transition-v1",
            "status": "PREPARED_NOT_APPLIED",
            "repository": self.fork.repository,
            "stateId": self.settings["stateId"],
            "sourceSha": "a" * 40,
            "publisherRunId": 123,
            "generatedAt": "2026-10-01T00:00:00+00:00",
            "automaticSyncEnabled": False,
            "existingRuntimeVerified": False,
            "deploymentAuthorized": False,
            "publishedReferenceVerified": True,
            "sharedBootstrapPolicyVerified": False,
            "secretValuesRead": False,
            "servicesChanged": False,
            "databaseChanged": False,
            "configurationValuesIncluded": True,
            "pendingChecks": ["backup_and_restore", "manual_argo_handoff"],
            "resources": [{"spec": {"env": {"EMAIL": "PRIVATE@example.test"}}}],
            "rendered": {"core-service": [{"image": "old-image", "env": "PRIVATE"}]},
        }
        self.plan["resourcesSha256"] = transition.digest(
            transition.encoded(self.plan["resources"])
        )
        self.plan["renderedSha256"] = {
            "core-service": transition.digest(
                transition.encoded(self.plan["rendered"]["core-service"])
            )
        }
        transition.write_plan(self.state / self.name, self.plan)
        self.path = self.state / self.name / "transition.json"
        self.fresh = copy.deepcopy(self.plan)
        self.fresh["generatedAt"] = "2026-10-07T01:00:00+00:00"
        self.enterContext(
            patch.object(
                transition.runtime.cluster, "load_settings", return_value=self.settings
            )
        )
        self.current = self.enterContext(
            patch.object(transition, "current_plan", return_value=self.fresh)
        )

    def verify(self):
        return transition.verify_saved(self.root, self.fork, self.state, self.name)

    def replace(self, value):
        self.path.write_bytes(transition.encoded(value))

    def test_rebuilds_and_compares_without_rewriting_or_exposing_values(self):
        before = self.path.read_bytes()
        with patch.object(
            transition, "write_plan", side_effect=AssertionError("write")
        ):
            result = self.verify()
        self.current.assert_called_once_with(self.root, self.fork, self.state, "helm")
        self.assertEqual(result["status"], "REVALIDATED_NOT_APPLIED")
        self.assertTrue(result["savedPlanMatched"])
        for key in (
            "automaticSyncEnabled",
            "deploymentAuthorized",
            "existingRuntimeVerified",
            "configurationValuesIncluded",
            "databaseChanged",
            "servicesChanged",
        ):
            self.assertFalse(result[key])
        self.assertNotIn("PRIVATE", json.dumps(result))
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(
            set((self.state / self.name).iterdir()),
            {self.path, self.path.parent / ".gitignore"},
        )

    def test_recomputed_hashes_do_not_authorize_changed_resources_or_rendered_objects(
        self,
    ):
        for field in ("resources", "rendered"):
            candidate = copy.deepcopy(self.plan)
            if field == "resources":
                candidate[field][0]["spec"]["env"]["EMAIL"] = (
                    "modified-private@example.test"
                )
                candidate["resourcesSha256"] = transition.digest(
                    transition.encoded(candidate[field])
                )
            else:
                candidate[field]["core-service"][0]["image"] = "unverified-image"
                candidate["renderedSha256"] = {
                    "core-service": transition.digest(
                        transition.encoded(candidate[field]["core-service"])
                    )
                }
            self.replace(candidate)
            with (
                self.subTest(field=field),
                self.assertRaisesRegex(ValueError, "differs from the current"),
            ):
                self.verify()

    def test_unknown_fields_and_forged_approval_or_sync_flags_fail(self):
        for change in (
            {"deploymentAuthorized": True},
            {"automaticSyncEnabled": True},
            {"existingRuntimeVerified": True},
            {"pendingChecks": []},
            {"operation": {"sync": {"prune": True}}},
            {"servicesChanged": 0},
            {"publisherRunId": True},
        ):
            self.replace(self.plan | change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.verify()

    def test_wrong_identity_and_invalid_metadata_are_rejected_before_external_checks(
        self,
    ):
        for change in (
            {"schema": "other"},
            {"status": "PASS"},
            {"repository": "other/project"},
            {"stateId": "b" * 32},
            {"sourceSha": "main"},
            {"publisherRunId": 0},
            {"generatedAt": "not-a-date"},
            {"generatedAt": "2026-10-07"},
            {"generatedAt": None},
        ):
            self.replace(self.plan | change)
            with (
                self.subTest(change=change),
                self.assertRaises((ValueError, TypeError)),
            ):
                self.verify()
        self.current.assert_not_called()

    def test_new_source_publisher_or_runtime_settings_invalidate_old_plan(self):
        for key, value in (
            ("sourceSha", "b" * 40),
            ("publisherRunId", 124),
            ("resources", [{"spec": {"env": {"EMAIL": "new@example.test"}}}]),
        ):
            self.current.return_value = self.fresh | {key: value}
            with (
                self.subTest(key=key),
                self.assertRaisesRegex(ValueError, "differs from the current"),
            ):
                self.verify()

    def test_failed_fresh_checks_cannot_reuse_saved_success(self):
        before = self.path.read_bytes()
        for failure in (
            ValueError("No complete verified publication"),
            ValueError("Runtime changed"),
        ):
            self.current.side_effect = failure
            with self.subTest(failure=failure), self.assertRaises(ValueError):
                self.verify()
            self.assertEqual(self.path.read_bytes(), before)

    def test_file_replacement_or_edit_during_external_checks_is_rejected(self):
        for replace in (False, True):
            self.replace(self.plan)

            def changed(*args, replace=replace):
                if replace:
                    new_file = self.state / "replacement"
                    new_file.write_bytes(self.path.read_bytes())
                    new_file.chmod(0o600)
                    new_file.replace(self.path)
                else:
                    self.replace(
                        self.plan | {"generatedAt": "2026-10-06T01:00:00+00:00"}
                    )
                return self.fresh

            self.current.side_effect = changed
            with (
                self.subTest(replace=replace),
                self.assertRaisesRegex(ValueError, "changed during verification"),
            ):
                self.verify()

    def test_state_changed_after_fresh_checks_is_rejected(self):
        with (
            patch.object(
                transition.runtime.cluster,
                "load_settings",
                side_effect=[self.settings, self.settings | {"stateId": "changed"}],
            ),
            self.assertRaisesRegex(ValueError, "Local state changed"),
        ):
            self.verify()

    def test_cli_verify_routes_to_read_only_verification(self):
        output = io.StringIO()
        with (
            patch(
                "sys.argv",
                [
                    "gitops_transition.py",
                    "--verify",
                    "--state-dir",
                    str(self.state),
                    "--output-name",
                    self.name,
                ],
            ),
            patch.object(transition, "from_origin", return_value=self.fork),
            patch.object(transition, "prepare", side_effect=AssertionError("prepare")),
            redirect_stdout(output),
        ):
            self.assertEqual(transition.main(), 0)
        self.assertEqual(
            json.loads(output.getvalue())["status"], "REVALIDATED_NOT_APPLIED"
        )
        self.assertNotIn("PRIVATE", output.getvalue())

    def test_cli_invalid_json_never_leaks_the_private_file(self):
        self.path.write_text('{"PRIVATE": invalid}', encoding="utf-8")
        output = io.StringIO()
        with (
            patch(
                "sys.argv",
                [
                    "gitops_transition.py",
                    "--verify",
                    "--state-dir",
                    str(self.state),
                    "--output-name",
                    self.name,
                ],
            ),
            patch.object(transition, "from_origin", return_value=self.fork),
            redirect_stdout(output),
        ):
            self.assertEqual(transition.main(), 1)
        report = json.loads(output.getvalue())
        self.assertEqual(report["reason"], "transition_verification_failed")
        self.assertFalse(report["deploymentAuthorized"])
        self.assertNotIn("PRIVATE", output.getvalue())
        self.current.assert_not_called()


@unittest.skipUnless(os.name == "posix", "Private state uses POSIX permissions")
class PrivateFileTests(unittest.TestCase):
    def setUp(self):
        self.state = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.name = "gitops-transition-private"
        transition.write_plan(self.state / self.name, {"private": "example"})
        self.path = self.state / self.name / "transition.json"

    def read(self):
        return transition.read_plan(self.state, self.name)

    def test_read_is_bounded_and_returns_a_stable_identity(self):
        first = self.read()
        self.assertEqual(first[0], {"private": "example"})
        self.assertEqual(first, self.read())
        with (
            patch.object(transition, "MAX_PLAN_BYTES", 1),
            self.assertRaises(ValueError),
        ):
            self.read()
        self.path.write_bytes(b"")
        with self.assertRaises(ValueError):
            self.read()

    def test_duplicate_json_keys_and_nonfinite_numbers_are_rejected(self):
        for payload in (
            b'{"status":false,"status":true}',
            b'{"a":{"b":1,"b":2}}',
            b'{"x":NaN}',
            b'{"x":Infinity}',
            b'{"x":-Infinity}',
            b'{"x":1e309}',
            b"\xff",
        ):
            self.path.write_bytes(payload)
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                self.read()

    def test_writer_cannot_create_a_file_the_reader_would_reject_for_size(self):
        output = self.state / "gitops-transition-large"
        with (
            patch.object(transition, "MAX_PLAN_BYTES", 1),
            self.assertRaises(ValueError),
        ):
            transition.write_plan(output, {"large": "example"})
        self.assertFalse(output.exists())

    def test_shared_directory_or_file_permissions_are_rejected(self):
        for target in (self.path.parent, self.path):
            mode = target.stat().st_mode
            target.chmod(0o755 if target.is_dir() else 0o644)
            try:
                with self.subTest(target=target), self.assertRaises(ValueError):
                    self.read()
            finally:
                target.chmod(mode)

    def test_other_file_owner_is_rejected(self):
        uid = os.getuid()
        with (
            patch.object(transition.os, "getuid", side_effect=[uid, uid, uid + 1]),
            self.assertRaises(ValueError),
        ):
            self.read()

    def test_symlink_and_hardlink_files_are_rejected(self):
        source = self.state / "source"
        self.path.rename(source)
        self.path.symlink_to(source)
        with self.assertRaises(ValueError):
            self.read()
        self.path.unlink()
        os.link(source, self.path)
        with self.assertRaises(ValueError):
            self.read()

    def test_symlink_directory_and_fifo_are_rejected_without_blocking(self):
        directory = self.path.parent
        target = self.state / "moved"
        directory.rename(target)
        directory.symlink_to(target, target_is_directory=True)
        with self.assertRaises(OSError):
            self.read()
        directory.unlink()
        target.rename(directory)
        self.path.unlink()
        os.mkfifo(self.path, 0o600)
        with self.assertRaises(ValueError):
            self.read()

    def test_file_replaced_between_stat_and_open_is_rejected(self):
        original = transition.os.open

        def changed(path, *args, **kwargs):
            if path == "transition.json":
                replacement = self.state / "replacement"
                replacement.write_bytes(self.path.read_bytes())
                replacement.chmod(0o600)
                replacement.replace(self.path)
            return original(path, *args, **kwargs)

        with (
            patch.object(transition.os, "open", side_effect=changed),
            self.assertRaisesRegex(ValueError, "changed while opening"),
        ):
            self.read()


if __name__ == "__main__":
    unittest.main()
