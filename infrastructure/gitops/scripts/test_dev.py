import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import dev


class DevTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        subprocess.run(["git", "init", "--quiet", self.root], check=True)
        self.state = self.root / ".local"
        self.state.mkdir()
        (self.root / ".gitignore").write_text(".local/\n.env*\n__pycache__/\nignored.py\n")
        self.context = self.root / "backend/ai-service"
        (self.context / "app").mkdir(parents=True)
        (self.context / "app/main.py").write_text("print('initial')\n")
        (self.context / "Dockerfile").write_text("FROM scratch\nCOPY app /app\n")
        (self.context / ".dockerignore").write_text("**\n!app/\n!app/**\n!uv.lock\n!pyproject.toml\n**/.env*\n**/__pycache__\n")
        (self.context / "uv.lock").write_text("version = 1\n")
        (self.context / "pyproject.toml").write_text("[project]\nname = 'fixture'\n")
        subprocess.run(["git", "-C", self.root, "add", "."], check=True)
        self.settings = self.make_settings("alice/project")
        self.current = "ghcr.io/alice/project-ai-service@sha256:" + "1" * 64
        self.initial = self.current
        self.calls = []
        self.labels = {}
        self.annotations = {}
        self.fail_build = False
        self.fail_rollouts = 0
        self.patchers = [patch("dev.run", side_effect=self.fake_run),
                         patch("dev.require_dev"),
                         patch("dev.load_settings", side_effect=lambda state: self.settings)]
        for item in self.patchers:
            item.start()
            self.addCleanup(item.stop)

    @staticmethod
    def make_settings(repository):
        return {"schemaVersion": 1, "repository": repository, "branch": "main",
                "cluster": "govbiz-" + hashlib.sha256(repository.lower().encode()).hexdigest()[:10],
                "namespace": "govbiz-msa", "mode": "dev", "platform": "linux/amd64"}

    def fake_run(self, command, data=None, capture=False, timeout=600):
        command = [str(part) for part in command]
        self.calls.append(command)
        if command[0] == "git":
            return subprocess.check_output(command, text=True)
        if command[:3] == ["docker", "image", "ls"]:
            return ""
        if command[:2] == ["docker", "build"]:
            context = Path(command[-1])
            self.assertTrue((context / "app/main.py").is_file())
            self.assertFalse((context / ".env").exists())
            self.assertFalse((context / "app/.env.production").exists())
            if self.fail_build:
                raise subprocess.CalledProcessError(1, command)
            return ""
        if command[:3] == ["kind", "load", "docker-image"]:
            return ""
        if command[0] == "kubectl":
            self.assertIn("--kubeconfig", command)
            self.assertIn(str(self.state / "kubeconfig"), command)
            self.assertIn("--context", command)
            self.assertIn("kind-" + self.settings["cluster"], command)
            self.assertIn(self.settings["namespace"], command)
            if "get" in command:
                return json.dumps({"metadata": {"labels": self.labels, "annotations": self.annotations},
                                   "spec": {"template": {"spec": {"containers": [{"name": "ai-service",
                                                 "image": self.current, "imagePullPolicy": "IfNotPresent"}]}}}})
            if "set" in command:
                self.current = command[-1].split("=", 1)[1]
                return ""
            if "rollout" in command:
                if self.fail_rollouts:
                    self.fail_rollouts -= 1
                    raise subprocess.CalledProcessError(1, command)
                return ""
        raise AssertionError("Unexpected command: " + repr(command))

    def sync(self):
        return dev.sync_service(self.root, self.state, self.settings, "ai-service")

    def test_saved_tracked_and_new_untracked_sources_change_fingerprint(self):
        initial = dev.snapshot(self.root, "ai-service")
        (self.context / "app/main.py").write_text("print('saved')\n")
        modified = dev.snapshot(self.root, "ai-service")
        self.assertNotEqual(initial, modified)
        (self.context / "app/new.py").write_text("answer = 42\n")
        added = dev.snapshot(self.root, "ai-service")
        self.assertNotEqual(modified, added)
        (self.context / "app/main.py").unlink()
        self.assertNotEqual(added, dev.snapshot(self.root, "ai-service"))

    def test_lock_and_dockerfile_changes_are_watched(self):
        for filename in ("uv.lock", "pyproject.toml", "Dockerfile", ".dockerignore"):
            before = dev.snapshot(self.root, "ai-service")
            with (self.context / filename).open("a") as file:
                file.write("\n# changed\n")
            self.assertNotEqual(before, dev.snapshot(self.root, "ai-service"))

    def test_git_ignored_env_keys_logs_caches_and_state_are_not_inputs(self):
        before = dev.snapshot(self.root, "ai-service")
        (self.context / "app/__pycache__").mkdir()
        for relative in (".env", "app/.env.production", "app/ignored.py", "app/__pycache__/main.pyc", "app/service.log", "app/private.key"):
            (self.context / relative).write_text("do-not-send")
        (self.state / "settings.json").write_text("{}")
        self.assertEqual(before, dev.snapshot(self.root, "ai-service"))
        # Even a mistakenly tracked dotenv file never enters the snapshot.
        subprocess.run(["git", "-C", self.root, "add", "--force", "backend/ai-service/app/.env.production"], check=True)
        self.assertEqual(before, dev.snapshot(self.root, "ai-service"))

    def test_only_allowlisted_inputs_enter_temporary_build_context(self):
        (self.context / "README.md").write_text("documentation")
        (self.context / "app/.env.production").write_text("never-in-image")
        self.assertTrue(self.sync())
        builds = [c for c in self.calls if c[:2] == ["docker", "build"]]
        self.assertEqual(len(builds), 1)
        self.assertIn("--platform", builds[0])
        self.assertFalse(Path(builds[0][-1]).exists())
        self.assertFalse(any("push" in c for c in self.calls))

    def test_unchanged_second_run_does_not_build_or_rollout(self):
        self.assertTrue(self.sync())
        self.calls.clear()
        self.assertFalse(self.sync())
        self.assertFalse(any(c[:2] == ["docker", "build"] or "set" in c for c in self.calls))

    def test_different_service_source_does_not_trigger_selected_service_build(self):
        self.sync()
        other = self.root / "backend/core-service/src"
        other.mkdir(parents=True)
        (other / "Changed.kt").write_text("// not an AI service input\n")
        self.calls.clear()
        self.assertFalse(self.sync())
        self.assertFalse(any(c[:2] == ["docker", "build"] for c in self.calls))

    def test_changed_settings_during_build_prevent_mutation(self):
        with patch("dev.load_settings", return_value=self.make_settings("bob/project")):
            with self.assertRaisesRegex(ValueError, "settings changed"):
                self.sync()
        self.assertEqual(self.current, self.initial)
        self.assertFalse(any("set" in c for c in self.calls))

    def test_existing_local_image_tag_is_never_overwritten(self):
        original = self.fake_run

        def image_exists(command, **kwargs):
            if list(command)[:3] == ["docker", "image", "ls"]:
                return "previous-image-id\n"
            return original(command, **kwargs)

        with patch("dev.run", side_effect=image_exists):
            with self.assertRaisesRegex(ValueError, "refusing overwrite"):
                self.sync()
        self.assertFalse(any(c[:2] == ["docker", "build"] for c in self.calls))

    def test_two_forks_get_different_clusters_and_local_image_names(self):
        self.sync()
        alice_image = self.current
        other_state = self.root / "bob-state"
        other_state.mkdir()
        self.state = other_state
        self.settings = self.make_settings("bob/project")
        self.sync()
        self.assertNotEqual(self.current.split("/")[0], alice_image.split("/")[0])
        self.assertTrue(self.current.startswith(self.settings["cluster"] + "/ai-service:dev-"))

    def test_build_failure_keeps_deployment_and_no_ledger(self):
        self.fail_build = True
        with self.assertRaises(subprocess.CalledProcessError):
            self.sync()
        self.assertEqual(self.current, self.initial)
        self.assertFalse(any("set" in c for c in self.calls))
        self.assertFalse((self.state / "dev-images.json").exists())

    def test_failed_rollout_restores_previous_image_and_reports_failure(self):
        self.fail_rollouts = 1
        with self.assertRaises(subprocess.CalledProcessError):
            self.sync()
        self.assertEqual(self.current, self.initial)
        self.assertEqual(dev.read_ledger(self.state, self.settings)["images"], {})
        self.assertEqual(len([c for c in self.calls if "set" in c]), 2)

    def test_rollback_to_earlier_dev_image_preserves_original_registry_image(self):
        self.sync()
        first = self.current
        (self.context / "app/main.py").write_text("print('new')\n")
        self.fail_rollouts = 1
        with self.assertRaises(subprocess.CalledProcessError):
            self.sync()
        self.assertEqual(self.current, first)
        entry = dev.read_ledger(self.state, self.settings)["images"]["ai-service"]
        self.assertEqual(entry["image"], first)
        self.assertEqual(entry["previousImage"], self.initial)

    def test_restore_baseline_removes_ledger_only_after_success(self):
        self.sync()
        dev.restore(self.state, self.settings, ("ai-service",))
        self.assertEqual(self.current, self.initial)
        self.assertFalse((self.state / "dev-images.json").exists())

    def test_restore_refuses_unrelated_deployment_change(self):
        self.sync()
        self.current = "somebody-elses-image:unique"
        with self.assertRaisesRegex(ValueError, "changed outside"):
            dev.restore(self.state, self.settings, ("ai-service",))
        self.assertEqual(self.current, "somebody-elses-image:unique")

    def test_gitops_mode_or_tracking_is_refused_before_build(self):
        with patch("dev.require_dev", side_effect=ValueError("GitOps mode")):
            with self.assertRaisesRegex(ValueError, "GitOps"):
                self.sync()
        for field in (self.labels, self.annotations):
            field["argocd.argoproj.io/tracking-id"] = "managed"
            with self.assertRaisesRegex(ValueError, "Argo CD tracks"):
                self.sync()
            field.clear()
        self.assertFalse(any(c[:2] == ["docker", "build"] for c in self.calls))

    def test_symlinks_and_new_copy_roots_refused(self):
        (self.context / "app/link.py").symlink_to(self.root / ".gitignore")
        with self.assertRaisesRegex(ValueError, "Symlink"):
            dev.snapshot(self.root, "ai-service")
        (self.context / "app/link.py").unlink()
        (self.context / "Dockerfile").write_text("FROM scratch\nCOPY . /app\n")
        with self.assertRaisesRegex(ValueError, "outside the watched"):
            dev.snapshot(self.root, "ai-service")

    def test_owner_mismatched_ledger_and_parallel_process_are_refused(self):
        self.sync()
        with self.assertRaisesRegex(ValueError, "different fork"):
            dev.read_ledger(self.state, self.make_settings("bob/project"))
        with dev.locked(self.state):
            with self.assertRaisesRegex(ValueError, "Another development"):
                with dev.locked(self.state):
                    self.fail("Must not acquire another watcher's lock")
        self.assertFalse((self.state / "dev.lock").exists())

    def test_failed_watch_does_not_retry_same_input_forever(self):
        with patch("dev.sync_service", side_effect=subprocess.CalledProcessError(1, ["docker", "build"])) as sync:
            with patch("dev.time.sleep", side_effect=[None, KeyboardInterrupt]):
                with self.assertRaises(KeyboardInterrupt):
                    dev.watch(self.root, self.state, self.settings, ("ai-service",))
        self.assertEqual(sync.call_count, 1)

    def test_real_service_dockerfiles_remain_within_allowlist(self):
        for service, roots in dev.INPUTS.items():
            dev.check_dockerfile((dev.REPOSITORY_ROOT / "backend" / service / "Dockerfile").read_text(), roots)

    def test_ignore_matching_current_allowlist_and_deep_exclusions(self):
        rules = "**\n!app/\n!app/**\n**/__pycache__\n**/*.py[cod]\n"
        self.assertTrue(dev.included("app/deep/new.py", rules))
        self.assertFalse(dev.included("app/deep/__pycache__/other", rules))
        self.assertFalse(dev.included("app/main.pyc", rules))
        self.assertFalse(dev.included("README.md", rules))


if __name__ == "__main__":
    unittest.main()
