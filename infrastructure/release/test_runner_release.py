"""Tracked cross-service inputs and fail-closed publication of the evaluation runner."""

import hashlib
import io
import json
import shlex
import subprocess
import tempfile
import unittest
from contextlib import ExitStack, redirect_stdout
from pathlib import Path
from unittest.mock import patch

import bootstrap_packages as bootstrap
import publish
from repository import SERVICES, Fork

FORK = Fork("alice/Example")
DIGEST = "sha256:" + "d" * 64
REAL_RUN = subprocess.run


class RunnerSourceTests(unittest.TestCase):
    def test_web_copy_inputs_and_build_mode_are_bound_to_publication(self):
        source = (publish.ROOT / publish.WEB_DOCKERFILE).read_text(encoding="utf-8")
        for line in source.splitlines():
            if not line.startswith("COPY ") or "--from=" in line:
                continue
            words = [
                word for word in shlex.split(line)[1:] if not word.startswith("--")
            ]
            for path in words[:-1]:
                self.assertTrue(
                    any(
                        path == root or path.startswith(root + "/")
                        for root in publish.WEB_PATHS
                    ),
                    path,
                )
        inputs = dict.fromkeys(publish.WEB_PATHS, "a" * 40)
        original = publish.workspace_input_key(publish.WEB, inputs, "b" * 40)
        for path in publish.WEB_PATHS:
            self.assertNotEqual(
                original,
                publish.workspace_input_key(
                    publish.WEB, inputs | {path: "c" * 40}, "b" * 40
                ),
            )
        self.assertNotEqual(
            original, publish.workspace_input_key(publish.WEB, inputs, "c" * 40)
        )
        with patch.object(publish, "WEB_MODE", "connected"):
            self.assertNotEqual(
                original, publish.workspace_input_key(publish.WEB, inputs, "b" * 40)
            )
        with self.assertRaises(ValueError):
            publish.workspace_input_key(publish.WEB, {}, "b" * 40)

    def test_every_copy_input_is_archived_and_runtime_manifest_is_verified(self):
        source = (publish.ROOT / publish.RUNNER_DOCKERFILE).read_text(encoding="utf-8")
        inputs = {publish.RUNNER_DOCKERFILE}
        for line in source.splitlines():
            if not line.startswith("COPY "):
                continue
            words = shlex.split(line)
            if words and words[0] == "COPY" and not words[1].startswith("--from="):
                inputs.update(words[1:-1])
        self.assertEqual(inputs, set(publish.RUNNER_PATHS))
        self.assertIn(
            "RUN .venv/bin/python /app/"
            + publish.RUNNER_RELEASE.replace(
                "execution_release.json", "execution_spec.py"
            ),
            source,
        )
        self.assertNotIn("execution_spec.py --write", source)
        self.assertNotIn(publish.RUNNER, SERVICES)
        self.assertEqual(
            FORK.image(publish.RUNNER), "ghcr.io/alice/example-evaluation-runner"
        )

    def test_each_input_and_publication_policy_changes_the_reuse_key(self):
        inputs = dict.fromkeys(publish.RUNNER_PATHS, "a" * 40)
        original = publish.runner_input_key(inputs, "b" * 40)
        for path in publish.RUNNER_PATHS:
            with self.subTest(path=path):
                self.assertNotEqual(
                    original,
                    publish.runner_input_key(inputs | {path: "c" * 40}, "b" * 40),
                )
        self.assertNotEqual(original, publish.runner_input_key(inputs, "c" * 40))
        for invalid in (
            {},
            inputs | {".env": "a" * 40},
            inputs | {publish.RUNNER_DOCKERFILE: "invalid"},
        ):
            with self.assertRaises(ValueError):
                publish.runner_input_key(invalid, "b" * 40)

    def test_runner_preflight_cannot_create_packages_or_check_business_packages(self):
        report = {}

        def exists(service, token, fork, visibility, *, result):
            self.assertEqual((service, visibility), (publish.RUNNER, "public"))
            result["packageCheck"] = {"state": "unavailable"}
            return False

        with (
            patch.object(publish, "package_exists", side_effect=exists) as metadata,
            patch.object(publish, "run") as docker,
            self.assertRaises(ValueError),
        ):
            publish.check_packages(
                "test-token", FORK, "public", result=report, services=(publish.RUNNER,)
            )
        self.assertEqual(metadata.call_count, 1)
        docker.assert_not_called()
        self.assertFalse(report["packagePolicyVerified"])
        self.assertEqual(set(report["packages"]), {publish.RUNNER})

    def test_bootstrap_selection_only_reads_the_runner_package(self):
        package = {
            "visibility": "private",
            "owner": {"login": FORK.owner},
            "repository": {"full_name": FORK.repository},
        }
        with (
            patch.dict("os.environ", {"GITHUB_ACTIONS": "false"}),
            patch.object(bootstrap, "check_identity"),
            patch.object(bootstrap, "metadata", return_value=package) as metadata,
            patch.object(bootstrap, "docker") as docker,
            redirect_stdout(io.StringIO()),
        ):
            bootstrap.prepare(FORK, "test-token", services=(publish.RUNNER,))
        self.assertEqual(
            {call.args[1] for call in metadata.call_args_list}, {publish.RUNNER}
        )
        docker.assert_not_called()

    def test_lookup_rejects_missing_or_changed_execution_release_label(self):
        uri = FORK.image(publish.RUNNER)
        manifest = subprocess.CompletedProcess(
            [], 0, json.dumps({"digest": DIGEST}), ""
        )
        for actual in (None, "b" * 64, "a" * 64):
            labels = {
                "ai.govbiz.input-key": "e" * 64,
                "org.opencontainers.image.source": FORK.source_url,
            }
            if actual:
                labels["ai.govbiz.execution-release-sha256"] = actual
            config = {
                "os": "linux",
                "architecture": "amd64",
                "config": {"Labels": labels},
            }
            with (
                patch.object(publish.subprocess, "run", return_value=manifest),
                patch.object(
                    publish,
                    "run",
                    return_value=subprocess.CompletedProcess([], 0, json.dumps(config)),
                ),
            ):
                if actual == "a" * 64:
                    self.assertEqual(
                        publish.lookup(
                            uri,
                            "src-test",
                            "e" * 64,
                            {},
                            FORK,
                            expected_labels={
                                "ai.govbiz.execution-release-sha256": "a" * 64
                            },
                        ),
                        DIGEST,
                    )
                else:
                    with self.assertRaises(ValueError):
                        publish.lookup(
                            uri,
                            "src-test",
                            "e" * 64,
                            {},
                            FORK,
                            expected_labels={
                                "ai.govbiz.execution-release-sha256": "a" * 64
                            },
                        )


class RunnerPublishTests(unittest.TestCase):
    service = publish.RUNNER
    paths = publish.RUNNER_PATHS
    dockerfile = publish.RUNNER_DOCKERFILE

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.files = {}
        for name in self.paths:
            # These two source inputs are trees; all others are blobs.
            target = (
                name + "/fixture.py"
                if name
                in (
                    "backend/ai-service/app",
                    "evaluation/support-program-evidence",
                    "frontend/web",
                    "frontend/packages/shared",
                )
                else name
            )
            raw = (
                '{"schema_version": 1}\n'
                if name == publish.RUNNER_RELEASE
                else "tracked input\n"
            )
            self.files[target] = raw
        if self.service == publish.WEB:
            self.files[publish.WEB_DOCKERFILE] = "tracked Dockerfile\n"
        self.files["infrastructure/release/policy.py"] = "tracked policy\n"
        # Even a tracked unrelated file must not enter the runner build context.
        self.files["work/unrelated.txt"] = "not a build input\n"
        for name, raw in self.files.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw.encode("utf-8"))
        self.git("init")
        self.git("-c", "core.autocrlf=false", "add", ".")
        self.git(
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            "fixture",
        )
        self.sha = self.git("rev-parse", "HEAD")
        (self.root / ".env").write_text("PRIVATE=not-for-build\n")
        source_dir = (
            "backend/ai-service/app"
            if self.service == publish.RUNNER
            else "frontend/web"
        )
        (self.root / source_dir / "untracked.py").write_text("not-for-build\n")
        dirty = (
            publish.RUNNER_RELEASE
            if self.service == publish.RUNNER
            else publish.WEB_DOCKERFILE
        )
        (self.root / dirty).write_text("dirty manifest must not be used\n")
        self.output = self.root / "receipt.json"
        self.commands = []
        self.outcome = {}
        self.fail_build = False
        self.fail_push = False
        self.expected_release = hashlib.sha256(
            self.files.get(publish.RUNNER_RELEASE, "").encode()
        ).hexdigest()
        self.labels = (
            {"ai.govbiz.execution-release-sha256": self.expected_release}
            if self.service == publish.RUNNER
            else {"ai.govbiz.web-mode": "portfolio"}
        )

    def git(self, *args):
        return REAL_RUN(
            ["git", *args], cwd=self.root, check=True, capture_output=True, text=True
        ).stdout.strip()

    def command(self, *args, **kwargs):
        self.commands.append(args)
        if args[0] == "git":
            return REAL_RUN(args, check=True, text=True, **kwargs)
        if args[:2] == ("docker", "build"):
            context = Path(args[-1])
            expected = set(self.files) - {
                "infrastructure/release/policy.py",
                "work/unrelated.txt",
            }
            self.assertEqual(
                {
                    path.relative_to(context).as_posix()
                    for path in context.rglob("*")
                    if path.is_file()
                },
                expected,
            )
            for name in expected:
                self.assertEqual(
                    (context / name).read_text(encoding="utf-8"), self.files[name]
                )
            self.assertEqual(
                Path(args[args.index("--file") + 1]),
                context / self.dockerfile,
            )
            for name, value in self.labels.items():
                self.assertIn(name + "=" + value, args)
            if self.service == publish.WEB:
                self.assertEqual(
                    args[args.index("--build-arg") + 1], "WEB_MODE=portfolio"
                )
            if self.fail_build:
                raise subprocess.CalledProcessError(1, args)
        if args[:2] == ("docker", "push") and self.fail_push:
            raise subprocess.CalledProcessError(1, args)
        return subprocess.CompletedProcess(args, 0, "")

    def publish(self, *, ci=True, packages=True, reuse=False):
        with ExitStack() as stack:
            stack.enter_context(patch.object(publish, "ROOT", self.root))
            stack.enter_context(patch.object(publish, "git", side_effect=self.git))
            stack.enter_context(
                patch.object(
                    publish,
                    "eligible",
                    **(
                        {"return_value": ci}
                        if isinstance(ci, bool)
                        else {"side_effect": ci}
                    ),
                )
            )
            stack.enter_context(
                patch.object(
                    publish,
                    "package_exists",
                    **(
                        {"return_value": packages}
                        if isinstance(packages, bool)
                        else {"side_effect": packages}
                    ),
                )
            )
            lookup = stack.enter_context(
                patch.object(
                    publish,
                    "lookup",
                    **(
                        {"return_value": DIGEST}
                        if reuse
                        else {"side_effect": [None, DIGEST]}
                    ),
                )
            )
            stack.enter_context(patch.object(publish, "run", side_effect=self.command))
            # subprocess.check_output must still read the actual Git blob.
            stack.enter_context(
                patch.object(
                    publish.subprocess,
                    "run",
                    side_effect=lambda args, **kw: (
                        subprocess.CompletedProcess(args, 0, b"")
                        if args[:2] == ["docker", "logout"]
                        else REAL_RUN(args, **kw)
                    ),
                )
            )
            stack.enter_context(redirect_stdout(io.StringIO()))
            publish.publish(
                self.service,
                self.sha,
                self.output,
                "fixture",
                "test-token",
                FORK,
                "public",
                result=self.outcome,
            )
            self.assertTrue(
                all(
                    call.kwargs["expected_labels"] == self.labels
                    for call in lookup.call_args_list
                )
            )
        return json.loads(self.output.read_text())

    def test_real_archive_excludes_dirty_untracked_and_unrelated_files(self):
        receipt = self.publish()
        self.assertEqual(
            receipt["schemaVersion"], 3 if self.service == publish.RUNNER else 4
        )
        self.assertNotIn("sourceTree", receipt)
        if self.service == publish.RUNNER:
            self.assertEqual(receipt["executionReleaseSha256"], self.expected_release)
        else:
            self.assertEqual(receipt["webMode"], "portfolio")
            self.assertNotIn("executionReleaseSha256", receipt)
        self.assertEqual(
            receipt["sourceInputs"],
            {path: self.git("rev-parse", f"{self.sha}:{path}") for path in self.paths},
        )
        self.assertEqual(
            receipt["inputKey"],
            publish.workspace_input_key(
                self.service, receipt["sourceInputs"], receipt["publisherTree"]
            ),
        )
        self.assertEqual(receipt["verifiedRevision"], self.sha)
        self.assertEqual(receipt["repository"], FORK.image(self.service))
        self.assertEqual(receipt["visibility"], "public")
        self.assertEqual(self.outcome["upload"], "confirmed")
        self.assertTrue(self.outcome["receiptWritten"])

    def test_reuse_has_no_archive_build_or_upload(self):
        self.publish(reuse=True)
        self.assertEqual([args[:2] for args in self.commands], [("docker", "login")])
        self.assertTrue(self.outcome["reused"])
        self.assertEqual(self.outcome["upload"], "not_attempted")

    def test_ci_failure_blocks_before_any_registry_login(self):
        with self.assertRaises(ValueError):
            self.publish(ci=False)
        self.assertEqual(self.commands, [])
        self.assertFalse(self.output.exists())

    def test_missing_package_blocks_before_any_registry_login(self):
        with self.assertRaises(ValueError):
            self.publish(packages=False)
        self.assertEqual(self.commands, [])
        self.assertFalse(self.output.exists())

    def test_ci_change_during_build_blocks_upload(self):
        with self.assertRaises(ValueError):
            self.publish(ci=[True, False])
        self.assertNotIn(("docker", "push"), [args[:2] for args in self.commands])
        self.assertFalse(self.output.exists())

    def test_changed_package_after_push_does_not_produce_receipt(self):
        with self.assertRaises(ValueError):
            self.publish(packages=[True, True, ValueError("policy changed")])
        self.assertEqual(self.outcome["upload"], "confirmed")
        self.assertFalse(self.outcome["receiptWritten"])
        self.assertFalse(self.output.exists())

    def test_failed_build_or_push_does_not_produce_receipt(self):
        for failure in ("build", "push"):
            self.commands = []
            self.fail_build, self.fail_push = failure == "build", failure == "push"
            with (
                self.subTest(failure=failure),
                self.assertRaises(subprocess.CalledProcessError),
            ):
                self.publish()
            self.assertFalse(self.output.exists())
            self.assertFalse(self.outcome["receiptWritten"])
            if failure == "build":
                self.assertNotIn(
                    ("docker", "push"), [args[:2] for args in self.commands]
                )


class WebPublishTests(RunnerPublishTests):
    """Exercise the same archive, reuse and failure contracts for the web context."""

    service = publish.WEB
    paths = publish.WEB_PATHS
    dockerfile = publish.WEB_DOCKERFILE


if __name__ == "__main__":
    unittest.main()
