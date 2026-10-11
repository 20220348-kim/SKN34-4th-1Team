"""Local auto-sync: source provenance, rendering, preservation and publication guards."""

import copy
import io
import json
import shutil
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import Mock, patch

import local_release as release
import yaml
from deployment import commit_tree
from deployment_candidate import git_bytes
from repository import Fork

FORK = Fork("alice/project")
TAG = "govbiz-local/v1.123.1"


class LocalReleaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.directory.cleanup)
        cls.root = Path(cls.directory.name)
        git_bytes(cls.root, "init", "--quiet")
        files = {"infrastructure/release/policy.txt": b"fixture"}
        for source in release.SOURCE_PATHS:
            path = release.ROOT / source
            for item in [path] if path.is_file() else path.rglob("*"):
                if item.is_file():
                    files[item.relative_to(release.ROOT).as_posix()] = item.read_bytes()
        for name in release.SERVICES:
            files[f"backend/{name}/source.txt"] = name.encode()
        tree_paths = {
            "backend/ai-service/app",
            "evaluation/support-program-evidence",
            "frontend/web",
            "frontend/packages/shared",
        }
        for path in (*release.RUNNER_PATHS, *release.WEB_PATHS):
            files[path + "/fixture.txt" if path in tree_paths else path] = b"fixture"
        cls.sha = commit_tree(cls.root, files)
        git_bytes(cls.root, "update-ref", "HEAD", cls.sha)
        publisher = cls.git_identity("infrastructure/release")
        cls.receipts = {}
        for name in release.COMPONENTS:
            if name in release.SERVICES:
                tree = cls.git_identity("backend/" + name)
                key = release.input_key(tree, publisher)
                source = {"schemaVersion": 2, "sourceTree": tree}
            else:
                paths = (
                    release.RUNNER_PATHS
                    if name == release.RUNNER
                    else release.WEB_PATHS
                )
                inputs = {path: cls.git_identity(path) for path in paths}
                key = release.workspace_input_key(name, inputs, publisher)
                source = {
                    "schemaVersion": 3 if name == release.RUNNER else 4,
                    "sourceInputs": inputs,
                    "publisherTree": publisher,
                }
                if name == release.RUNNER:
                    source["executionReleaseSha256"] = release.digest(b"fixture")
                else:
                    source["webMode"] = release.WEB_MODE
            cls.receipts[name] = {
                **source,
                "service": name,
                "repository": FORK.image(name),
                "digest": "sha256:" + "a" * 64,
                "visibility": "public",
                "verifiedRevision": cls.sha,
                "inputKey": key,
                "tag": "src-" + key,
                "platform": "linux/amd64",
            }

    @classmethod
    def git_identity(cls, path):
        return git_bytes(cls.root, "rev-parse", cls.sha + ":" + path).decode().strip()

    def test_provenance_rejects_wrong_source_policy_visibility_and_workspace_inputs(
        self,
    ):
        for name, receipt in self.receipts.items():
            self.assertEqual(
                release.validate_receipt(self.root, FORK, self.sha, name, receipt),
                receipt,
            )
            for key, value in (
                ("verifiedRevision", "b" * 40),
                ("visibility", "private"),
                ("inputKey", "b" * 64),
                ("repository", "ghcr.io/other/image"),
            ):
                with self.subTest(name=name, key=key), self.assertRaises(ValueError):
                    release.validate_receipt(
                        self.root, FORK, self.sha, name, receipt | {key: value}
                    )
        for name in (release.WEB, release.RUNNER):
            with self.assertRaises(ValueError):
                release.validate_receipt(
                    self.root,
                    FORK,
                    self.sha,
                    name,
                    self.receipts[name] | {"sourceInputs": {}},
                )

    def test_archive_identity_checksum_attempt_and_completeness(self):
        artifacts, payloads = [], {}
        for index, (name, receipt) in enumerate(self.receipts.items(), 1):
            stream = io.BytesIO()
            with zipfile.ZipFile(stream, "w") as archive:
                archive.writestr(name + ".json", json.dumps(receipt))
            payloads[index] = stream.getvalue()
            artifacts.append(
                {
                    "id": index,
                    "name": "local-receipt-1-" + name,
                    "expired": False,
                    "size_in_bytes": len(payloads[index]),
                    "digest": "sha256:" + release.digest(payloads[index]),
                    "workflow_run": {
                        "id": 123,
                        "head_sha": self.sha,
                        "head_branch": "main",
                        "repository_id": 77,
                        "head_repository_id": 77,
                    },
                }
            )
        run = {
            "id": 123,
            "run_attempt": 1,
            "path": release.WORKFLOW,
            "event": "workflow_run",
            "head_sha": self.sha,
            "head_branch": "main",
            "repository": {"id": 77, "full_name": FORK.repository},
            "head_repository": {"full_name": FORK.repository},
        }

        def get(path, binary=False):
            if binary:
                return payloads[int(path.split("/")[-2])]
            return (
                {"total_count": len(artifacts), "artifacts": artifacts}
                if "/artifacts?" in path
                else run
            )

        self.assertEqual(
            release.receipts_for_run(self.root, FORK, self.sha, 123, 1, get),
            self.receipts,
        )
        for field, value in (
            ("digest", "sha256:" + "0" * 64),
            ("expired", True),
            ("name", "local-receipt-2-core-service"),
        ):
            before = copy.deepcopy(artifacts)
            artifacts[0][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                release.receipts_for_run(self.root, FORK, self.sha, 123, 1, get)
            artifacts[:] = before
        with self.assertRaises(ValueError):
            release.receipts_for_run(self.root, FORK, self.sha, 123, 2, get)

    def rendered(self):
        self.assertIsNotNone(shutil.which("helm"), "Pinned Helm is required")
        return release.bundle(self.root, FORK, self.sha, TAG, self.receipts)

    def test_real_helm_bundle_covers_all_images_and_bounds_hooks_without_data_ownership(
        self,
    ):
        files = self.rendered()
        objects = [
            row
            for name, payload in files.items()
            if name.endswith(".yaml") and "kustomization" not in name
            for row in yaml.safe_load_all(payload)
        ]
        self.assertEqual(
            {row["kind"] for row in objects},
            {"Deployment", "Service", "Job", "NetworkPolicy"},
        )
        self.assertEqual(
            {row["metadata"]["name"] for row in objects if row["kind"] == "Deployment"},
            set(release.WORKLOADS),
        )
        jobs = [row for row in objects if row["kind"] == "Job"]
        self.assertEqual(
            {j["metadata"]["annotations"]["argocd.argoproj.io/hook"] for j in jobs},
            {"PreSync", "PostSync"},
        )
        for job in jobs:
            pod = job["spec"]["template"]["spec"]
            self.assertEqual(pod["containers"][0]["command"][-2:], ["--release", TAG])
            self.assertFalse(pod["automountServiceAccountToken"])
        for row in objects:
            if row["kind"] != "Deployment":
                continue
            name = row["metadata"]["name"]
            receipt = self.receipts["ops-service" if name == "ops-artifacts" else name]
            self.assertEqual(
                row["spec"]["template"]["spec"]["containers"][0]["image"],
                receipt["repository"] + "@" + receipt["digest"],
            )
        runtime = {
            "items": copy.deepcopy(
                [row for row in objects if row["kind"] == "Deployment"]
            )
        }
        for row in runtime["items"]:
            pod = row["spec"]["template"]["spec"]
            for container in pod["containers"]:
                container["image"] = "old-runtime-image:kept-out-of-patches"
            if row["metadata"]["name"] == "core-service":
                pod["containers"][0]["env"].append(
                    {"name": "CUSTOM_LOCAL_SETTING", "value": "preserved"}
                )
            if row["metadata"]["name"] in (release.RUNNER, "ops-artifacts"):
                pod["nodeSelector"] = {"kubernetes.io/hostname": "existing-local-node"}
                pod["volumes"][0]["persistentVolumeClaim"]["claimName"] = (
                    "existing-local-results"
                )
        app = release.application(FORK, runtime)[1]
        self.assertTrue(app["spec"]["syncPolicy"]["automated"]["enabled"])
        self.assertFalse(app["spec"]["syncPolicy"]["automated"]["prune"])
        self.assertEqual(app["spec"]["source"]["tagPrefix"], release.TAG_PREFIX)
        self.assertNotIn("helm", app["spec"]["source"])
        patches = app["spec"]["source"]["kustomize"]["patches"]
        for item in patches:
            self.assertTrue(
                all(
                    "image" not in op["path"] and "command" not in op["path"]
                    for op in json.loads(item["patch"])
                )
            )
        wrong = copy.deepcopy(runtime)
        wrong["items"].pop()
        with self.assertRaises(ValueError):
            release.application(FORK, wrong)
        # Render the exact Argo Kustomize input with runtime preservation patches.
        kubectl = shutil.which("kubectl")
        self.assertIsNotNone(kubectl, "kubectl is required by Infra CI")
        with tempfile.TemporaryDirectory() as directory:
            release.write_files(Path(directory).resolve(), files)
            path = Path(directory).resolve() / "release/kustomization.yaml"
            config = yaml.safe_load(path.read_text())
            config["patches"] = patches
            path.write_text(yaml.safe_dump(config))
            output = release.subprocess.check_output(
                [kubectl, "kustomize", str(path.parent)]
            )
            actual = [row for row in yaml.safe_load_all(output) if row]
            self.assertEqual(len(actual), len(objects))
            for row in actual:
                if row["kind"] != "Deployment":
                    continue
                name = row["metadata"]["name"]
                pod = row["spec"]["template"]["spec"]
                receipt = self.receipts[
                    "ops-service" if name == "ops-artifacts" else name
                ]
                self.assertEqual(
                    pod["containers"][0]["image"],
                    receipt["repository"] + "@" + receipt["digest"],
                )
                if name == "core-service":
                    self.assertIn(
                        {"name": "CUSTOM_LOCAL_SETTING", "value": "preserved"},
                        pod["containers"][0]["env"],
                    )
                if name in (release.RUNNER, "ops-artifacts"):
                    self.assertEqual(
                        pod["volumes"][0]["persistentVolumeClaim"]["claimName"],
                        "existing-local-results",
                    )

    def test_stale_source_or_ci_prevents_tag_push(self):
        def git(root, *args):
            if args[0] == "ls-remote":
                return b""
            self.fail("Must not push after the final gate fails")

        with (
            patch.object(release, "git_bytes", side_effect=git),
            patch.object(release, "commit_tree", return_value="a" * 40),
            self.assertRaisesRegex(ValueError, "CI changed"),
        ):
            release.publish_tag(
                self.root,
                FORK,
                self.sha,
                TAG,
                {},
                Mock(side_effect=ValueError("CI changed")),
            )

    def test_existing_tag_cannot_be_overwritten(self):
        calls = []

        def git(root, *args):
            calls.append(args)
            return (
                ("b" * 40 + "\trefs/tags/" + TAG).encode()
                if args[0] == "ls-remote"
                else b""
            )

        with (
            patch.object(release, "git_bytes", side_effect=git),
            patch.object(release, "tracked_files", return_value={"wrong": b"x"}),
            self.assertRaisesRegex(ValueError, "different contents"),
        ):
            release.publish_tag(self.root, FORK, self.sha, TAG, {}, Mock())
        self.assertFalse(any(call[0] == "push" for call in calls))

    def test_workflow_gates_all_six_images_and_tag_publication(self):
        workflow = yaml.safe_load((release.ROOT / release.WORKFLOW).read_text())
        jobs = workflow["jobs"]
        self.assertIn("LOCAL_ARGO_RELEASE_ENABLED", jobs["gate"]["if"])
        self.assertEqual(
            set(jobs["images"]["strategy"]["matrix"]["service"]),
            set(release.COMPONENTS),
        )
        self.assertEqual(jobs["release"]["needs"], ["gate", "images"])
        self.assertIn("needs.images.result == 'success'", jobs["release"]["if"])
        self.assertEqual(
            jobs["release"]["permissions"], {"contents": "write", "actions": "read"}
        )
        self.assertFalse(workflow["concurrency"]["cancel-in-progress"])


if __name__ == "__main__":
    unittest.main()
