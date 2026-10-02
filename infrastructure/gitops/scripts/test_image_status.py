"""Image metadata must not turn a matching tag or revision label into source proof."""

import copy
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import image_status as status


REVISION = "a" * 40
IDENTITY = "sha256:" + "b" * 64
OTHER_IDENTITY = "sha256:" + "c" * 64
TAG = "govbiz-ops-service:local"
POD_IMAGE = "docker.io/library/import@sha256:" + "d" * 64


def image(identity=IDENTITY, labels=None, digests=None):
    return json.dumps(
        {
            "status": {
                "id": identity,
                "repoDigests": ([POD_IMAGE] if identity == IDENTITY else [])
                if digests is None
                else digests,
            },
            "info": {
                "imageSpec": {
                    "config": {
                        "Env": ["SECRET=DO-NOT-PRINT"],
                        "Labels": labels
                        if labels is not None
                        else {"org.opencontainers.image.revision": REVISION},
                    }
                }
            },
        }
    )


def report():
    containers = [{"name": name, "image": TAG} for name in ("ops-service", "ops-sync")]
    return {
        "services": [
            {
                "name": "ops-service",
                "ready": True,
                "containers": containers,
                "pods": [
                    {
                        "name": "ops-pod",
                        "node": "owned-control-plane",
                        "terminating": False,
                        "containers": [dict(c, image_id=POD_IMAGE) for c in containers],
                    }
                ],
            }
        ]
    }


class ImageStatusTests(unittest.TestCase):
    def test_repo_digest_and_config_id_resolve_without_raw_id_equality_or_source_claim(self):
        original = report()
        before = copy.deepcopy(original)
        with (
            patch.object(status, "run", return_value=image()) as execute,
            patch.object(status, "compare_service_tree", return_value="UNCHANGED") as compare,
        ):
            result = status.audit({"cluster": "owned"}, original)
        self.assertEqual(original, before)
        self.assertTrue(result["runtime_images_match"])
        self.assertFalse(result["source_review_required"])
        self.assertFalse(result["image_source_verified"])
        self.assertEqual(len(result["containers"]), 2)
        self.assertEqual(result["containers"][0]["declared_revision"], REVISION)
        self.assertNotIn("DO-NOT-PRINT", json.dumps(result))
        compare.assert_called_once_with(status.REPOSITORY_ROOT, "ops-service", REVISION)
        self.assertEqual(
            execute.call_count, 1
        )  # CRI digest metadata also covers the shared API/sync.
        for call in execute.call_args_list:
            self.assertEqual(
                call.args[0][:5], ["docker", "exec", "owned-control-plane", "crictl", "inspecti"]
            )
            self.assertEqual(call.kwargs, {"capture": True, "timeout": 15})

    def test_unregistered_archive_digest_uses_exact_membership_without_alias_lookup(self):
        def execute(command, **kwargs):
            if command[-1] == POD_IMAGE:
                raise subprocess.CalledProcessError(1, command, stderr="no such image")
            return image()

        with (
            patch.object(status, "run", side_effect=execute) as run,
            patch.object(status, "compare_service_tree", return_value="UNCHANGED"),
        ):
            result = status.audit({"cluster": "owned"}, report())
        self.assertTrue(result["runtime_images_match"])
        self.assertEqual(run.call_count, 1)

    def test_digest_absent_from_tag_metadata_requires_resolving_running_image(self):
        with (
            patch.object(status, "run", side_effect=[image(digests=[]), image()]) as run,
            patch.object(status, "compare_service_tree", return_value="UNCHANGED"),
        ):
            result = status.audit({"cluster": "owned"}, report())
        self.assertTrue(result["runtime_images_match"])
        self.assertEqual(run.call_count, 2)

        with patch.object(
            status,
            "run",
            side_effect=[image(digests=[]), subprocess.CalledProcessError(1, "docker")],
        ):
            result = status.audit({"cluster": "owned"}, report())
        self.assertFalse(result["runtime_images_match"])
        self.assertTrue(result["source_review_required"])

    def test_reused_tag_does_not_hide_old_running_image_or_use_new_tag_revision(self):
        with (
            patch.object(
                status,
                "run",
                side_effect=[image(OTHER_IDENTITY), image(labels={"dev.govbiz.source": "e" * 40})],
            ),
            patch.object(status, "compare_service_tree", return_value="CHANGED") as compare,
        ):
            result = status.audit({"cluster": "owned"}, report())
        self.assertFalse(result["runtime_images_match"])
        self.assertTrue(result["source_review_required"])
        self.assertIn("RUNTIME_IMAGE_MISMATCH", result["containers"][0]["issues"])
        self.assertEqual(result["containers"][0]["declared_revision"], "e" * 40)
        compare.assert_called_once_with(status.REPOSITORY_ROOT, "ops-service", "e" * 40)

    def test_missing_malformed_or_conflicting_revision_is_unknown_and_not_leaked(self):
        for labels in (
            {},
            {"org.opencontainers.image.revision": "DO-NOT-PRINT"},
            {"org.opencontainers.image.revision": [REVISION]},
            {"org.opencontainers.image.revision": REVISION, "dev.govbiz.source": "e" * 40},
        ):
            with (
                self.subTest(labels=labels),
                patch.object(status, "run", return_value=image(labels=labels)),
            ):
                result = status.audit({"cluster": "owned"}, report())
            self.assertTrue(result["runtime_images_match"])
            self.assertTrue(result["source_review_required"])
            self.assertIsNone(result["containers"][0]["declared_revision"])
            self.assertEqual(result["containers"][0]["service_tree_comparison"], "UNKNOWN")
            self.assertNotIn("DO-NOT-PRINT", json.dumps(result))

    def test_prefixed_runtime_identity_is_resolved_by_cri(self):
        for prefix in ("containerd://", "docker-pullable://", ""):
            with patch.object(status, "run", return_value=image()) as execute:
                self.assertEqual(
                    status.inspect_image("owned-control-plane", prefix + IDENTITY)[0], IDENTITY
                )
            self.assertEqual(execute.call_args.args[0][-1], IDENTITY)

    def test_lookup_failure_timeout_or_invalid_response_never_becomes_success(self):
        failures = (
            subprocess.TimeoutExpired("docker", 15, output="DO-NOT-PRINT"),
            subprocess.CalledProcessError(1, ["docker"], stderr="DO-NOT-PRINT"),
            FileNotFoundError("DO-NOT-PRINT"),
            "invalid json DO-NOT-PRINT",
            image("invalid-id"),
            "[]",
        )
        for failure in failures:
            kwargs = (
                {"side_effect": failure}
                if isinstance(failure, Exception)
                else {"return_value": failure}
            )
            with self.subTest(failure=type(failure)), patch.object(status, "run", **kwargs):
                result = status.audit({"cluster": "owned"}, report())
            self.assertFalse(result["runtime_images_match"])
            self.assertTrue(result["source_review_required"])
            self.assertIn("IMAGE_INSPECTION_FAILED", result["containers"][0]["issues"])
            self.assertNotIn("DO-NOT-PRINT", json.dumps(result))

    def test_wrong_node_missing_images_and_absent_pods_do_not_report_success(self):
        for change in (
            lambda s: s["pods"][0].update(node="another-control-plane"),
            lambda s: s["pods"][0]["containers"][0].update(image_id=None),
            lambda s: s.update(pods=[]),
            lambda s: s.update(ready=False),
            lambda s: s["pods"][0].update(terminating=True),
            lambda s: s["pods"][0]["containers"][0].update(image="unrelated:tag"),
        ):
            original = report()
            change(original["services"][0])
            with (
                patch.object(status, "run", return_value=image()) as execute,
                patch.object(status, "compare_service_tree", return_value="UNCHANGED"),
            ):
                result = status.audit({"cluster": "owned"}, original)
            self.assertFalse(result["runtime_images_match"])
            for call in execute.call_args_list:
                self.assertEqual(call.args[0][2], "owned-control-plane")


class ServiceTreeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.service = self.root / "backend/ops-service"
        self.service.mkdir(parents=True)
        self.source = self.service / "app.py"
        self.source.write_text("initial\n")
        self.git("init", "--quiet")
        self.git("add", ".")
        self.git(
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-qm",
            "fixture",
        )
        self.revision = self.git("rev-parse", "HEAD").strip()

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.root), *args], text=True)

    def compare(self):
        return status.compare_service_tree(self.root, "ops-service", self.revision)

    def test_changes_include_dirty_staged_deleted_and_new_files_not_just_head(self):
        self.assertEqual(self.compare(), "UNCHANGED")
        self.source.write_text("modified\n")
        self.assertEqual(self.compare(), "CHANGED")
        self.git("add", ".")
        self.assertEqual(self.compare(), "CHANGED")
        self.git("restore", "--source=HEAD", "--staged", "--worktree", ".")
        self.source.unlink()
        self.assertEqual(self.compare(), "CHANGED")
        self.git("restore", ".")
        (self.service / "new.py").write_text("new\n")
        self.assertEqual(self.compare(), "CHANGED")
        self.assertEqual(self.git("rev-parse", "HEAD").strip(), self.revision)

    def test_unrelated_changes_ignored_files_and_unknown_commit(self):
        (self.root / "unrelated.txt").write_text("unrelated\n")
        (self.root / ".gitignore").write_text(".env\n")
        (self.service / ".env").write_text("PRIVATE\n")
        self.assertEqual(self.compare(), "UNCHANGED")
        self.assertEqual(status.compare_service_tree(self.root, "ops-service", "f" * 40), "UNKNOWN")

    def test_git_timeout_and_untracked_query_failure_are_unknown(self):
        with patch.object(
            status.subprocess, "run", side_effect=subprocess.TimeoutExpired("git", 15)
        ):
            self.assertEqual(self.compare(), "UNKNOWN")
        with patch.object(status, "run", side_effect=FileNotFoundError("PRIVATE")):
            self.assertEqual(self.compare(), "UNKNOWN")


if __name__ == "__main__":
    unittest.main()
