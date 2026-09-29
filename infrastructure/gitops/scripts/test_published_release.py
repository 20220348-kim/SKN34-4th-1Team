"""Published GHCR initialization without a deployment branch, PR or cluster access."""

import copy
import io
import json
import shutil
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import deployment as deploy
import deployment_candidate as bundle
import fork_cluster as cluster
from test_deployment import FORK, SourceFixture
from test_sync_images import FORK as FIXTURE_FORK
from test_sync_images import SHA, ci_results, run


class PublishedReleaseTests(SourceFixture):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # The publication must work after both deployment workflows are removed.
        source = {
            name: value
            for name, value in cls.source.items()
            if name != bundle.CHECK_WORKFLOW
        }
        cls.sha = deploy.commit_tree(cls.root, source, cls.sha)
        bundle.git_bytes(cls.root, "update-ref", "HEAD", cls.sha)
        cls.receipts = cls.receipts_for(cls.sha)
        cls.trees = [
            {
                "path": path,
                "type": "tree",
                "sha": bundle.git_bytes(cls.root, "rev-parse", cls.sha + ":" + path)
                .decode()
                .strip(),
            }
            for path in [
                "infrastructure/release",
                *("backend/" + s for s in bundle.SERVICES),
            ]
        ]

    def setUp(self):
        self.publisher = run() | {
            "id": 900,
            "run_attempt": 1,
            "head_sha": self.sha,
            "head_repository": {"full_name": FORK.repository},
            "repository": {"id": 456, "full_name": FORK.repository},
        }
        self.current_sha = self.sha
        self.ci_state = ["success"]
        self.ci_attempt = 1
        self.calls = []
        self.make_artifacts(self.receipts)

    def make_artifacts(self, receipts):
        self.artifacts = []
        self.payloads = {}
        for index, receipt in enumerate(receipts):
            stream = io.BytesIO()
            with zipfile.ZipFile(stream, "w") as archive:
                archive.writestr(receipt["service"] + ".json", json.dumps(receipt))
            payload = stream.getvalue()
            artifact_id = 1000 + index
            self.payloads[artifact_id] = payload
            self.artifacts.append(
                {
                    "id": artifact_id,
                    "name": "msa-image-" + receipt["service"],
                    "expired": False,
                    "size_in_bytes": len(payload),
                    "digest": "sha256:" + bundle.digest(payload),
                    "workflow_run": {
                        "id": 900,
                        "head_sha": self.sha,
                        "head_branch": "main",
                        "head_repository_id": 456,
                        "repository_id": 456,
                    },
                }
            )

    def get(self, path, binary=False):
        self.calls.append(path)
        if path.startswith(
            f"repos/{FORK.repository}/actions/workflows/msa-images.yml/runs?"
        ):
            return {"workflow_runs": [copy.deepcopy(self.publisher)]}
        if path.startswith(f"repos/{FORK.repository}/actions/runs/900/artifacts?"):
            return {"artifacts": copy.deepcopy(self.artifacts)}
        if path.startswith(f"repos/{FORK.repository}/actions/artifacts/"):
            self.assertTrue(binary)
            return self.payloads[int(path.split("/artifacts/")[1].split("/")[0])]
        if path == f"repos/{FORK.repository}/git/ref/heads/main":
            return {"object": {"sha": self.current_sha}}
        if path == f"repos/{FORK.repository}/git/trees/{self.sha}?recursive=1":
            return {"tree": self.trees, "truncated": False}
        response = ci_results(self.ci_state)(path)
        response = json.loads(
            json.dumps(response)
            .replace(SHA, self.sha)
            .replace(FIXTURE_FORK.repository, FORK.repository)
        )
        for item in response.get("workflow_runs", [response]):
            if "run_attempt" in item:
                item["run_attempt"] = self.ci_attempt
        return response

    @unittest.skipUnless(
        shutil.which("helm"), "Pinned Helm required for real rendering"
    )
    def test_real_source_gate_receipts_and_helm_without_checkout_or_branch_changes(
        self,
    ):
        dirty = self.root / "untracked-settings.yaml"
        dirty.write_text("env: {OPENAI_ALLOW_LIVE_CALLS: 'true'}\n")
        before = bundle.git_bytes(self.root, "status", "--porcelain")
        record, files, revision = deploy.verified_release(self.root, FORK, get=self.get)
        self.assertEqual(revision, self.sha)
        self.assertEqual(record["verifiedRevision"], self.sha)
        self.assertEqual(record["visibility"], "public")
        for service in bundle.SERVICES:
            resources = json.loads(files[bundle.PREFIX + f"rendered/{service}.json"])
            workload = next(item for item in resources if item["kind"] == "Deployment")
            pod = workload["spec"]["template"]["spec"]
            self.assertEqual(pod["containers"][0]["image"], record["images"][service])
            self.assertFalse(pod.get("imagePullSecrets"))
            jobs = [item for item in resources if item["kind"] == "Job"]
            self.assertEqual(len(jobs), int(service == "ops-service"))
            for job in jobs:
                self.assertEqual(
                    job["spec"]["template"]["spec"]["containers"][0]["image"],
                    record["images"][service],
                )
        self.assertNotIn(bundle.ARGO, files)
        self.assertNotIn(bundle.CHECK_WORKFLOW, files)
        self.assertNotIn(bundle.MANIFEST, files)
        self.assertEqual(bundle.git_bytes(self.root, "status", "--porcelain"), before)
        self.assertEqual(
            bundle.git_bytes(self.root, "rev-parse", "HEAD").decode().strip(), self.sha
        )
        self.assertFalse(
            any(
                "deploy" in path or "/pulls" in path or "/rules/" in path
                for path in self.calls
            )
        )
        dirty.unlink()

    def test_private_receipts_preserve_pull_secret(self):
        receipts = [receipt | {"visibility": "private"} for receipt in self.receipts]
        self.make_artifacts(receipts)
        with self.mocked_renderer():
            record, files, _ = deploy.verified_release(self.root, FORK, get=self.get)
        self.assertEqual(record["visibility"], "private")
        for service in bundle.SERVICES:
            values = bundle.yaml.safe_load(
                files[bundle.PREFIX + f"environments/fork/{service}.yaml"]
            )
            self.assertEqual(values["imagePullSecrets"], [{"name": "ghcr-pull"}])

    def test_incomplete_publication_or_invalid_attempt_never_reaches_rendering(self):
        for change in (
            {"status": "in_progress"},
            {"conclusion": "failure"},
            {"run_attempt": None},
            {"run_attempt": True},
            {"run_attempt": 0},
        ):
            with self.subTest(change=change), patch.object(bundle, "render") as render:
                original = self.publisher
                self.publisher = original | change
                with self.assertRaises(ValueError):
                    deploy.verified_release(self.root, FORK, get=self.get)
                self.publisher = original
                render.assert_not_called()

    def test_failed_missing_or_skipped_ci_never_downloads_receipts_or_renders(self):
        for state in ("failure", "missing", "skipped"):
            self.ci_state[0] = state
            self.calls.clear()
            with self.subTest(state=state), patch.object(bundle, "render") as render:
                with self.assertRaisesRegex(ValueError, "Deployment source blocked"):
                    deploy.verified_release(self.root, FORK, get=self.get)
                render.assert_not_called()
                self.assertFalse(any(path.endswith("/zip") for path in self.calls))

    def test_bad_receipt_archive_is_not_accepted_as_a_complete_release(self):
        self.payloads[1000] += b"tampered"
        with patch.object(bundle, "render") as render:
            with self.assertRaisesRegex(ValueError, "checksum/size"):
                deploy.verified_release(self.root, FORK, get=self.get)
            render.assert_not_called()

    def test_old_source_does_not_pass_even_if_its_publication_succeeded(self):
        self.current_sha = "e" * 40
        with patch.object(bundle, "render") as render:
            with self.assertRaisesRegex(ValueError, "Source advanced"):
                deploy.verified_release(self.root, FORK, get=self.get)
            render.assert_not_called()

    def test_source_ci_publisher_and_artifact_changes_during_render_are_rejected(self):
        def change_source():
            self.current_sha = "e" * 40

        def change_ci():
            self.ci_attempt = 2

        def change_publisher():
            self.publisher["run_attempt"] = 2

        def change_artifact():
            self.artifacts[0]["id"] += 10

        for change in (change_source, change_ci, change_publisher, change_artifact):
            self.setUp()

            def render(*args, change=change, **kwargs):
                change()
                return {s: b"[]\n" for s in bundle.SERVICES}

            with (
                self.subTest(change=change.__name__),
                patch.object(bundle, "render", side_effect=render),
                self.assertRaisesRegex(ValueError, "advanced|changed"),
            ):
                deploy.verified_release(self.root, FORK, get=self.get)

    def test_helm_or_policy_failure_does_not_return_partial_manifests(self):
        with (
            patch.object(
                bundle, "render", side_effect=ValueError("invalid runtime policy")
            ),
            self.assertRaisesRegex(ValueError, "invalid runtime policy"),
        ):
            deploy.verified_release(self.root, FORK, get=self.get)


class PublishedBootstrapTests(unittest.TestCase):
    def test_failed_publication_stops_before_registry_credentials_or_cluster_mutation(
        self,
    ):
        settings = cluster.initial_settings(FORK)
        args = SimpleNamespace(local_images=None, helm="helm")
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(cluster, "doctor"),
            patch("connected_runtime.load_profile", return_value=None),
            patch.object(
                cluster, "published_bundle", side_effect=ValueError("CI incomplete")
            ),
            patch.object(cluster, "approved_bundle") as retired,
            patch.object(cluster, "authenticate") as auth,
            patch.object(cluster, "apply") as apply,
            patch.object(cluster, "run") as execute,
            self.assertRaisesRegex(ValueError, "CI incomplete"),
        ):
            cluster._up(args, Path(directory), settings)
        retired.assert_not_called()
        auth.assert_not_called()
        apply.assert_not_called()
        execute.assert_not_called()

    def test_published_bundle_uses_current_publication_and_credentials_use_same_path(
        self,
    ):
        settings = cluster.initial_settings(FORK)
        record = {"verifiedRevision": SHA}
        with (
            patch.object(cluster.shutil, "which", return_value="gh"),
            patch.object(
                deploy, "verified_release", return_value=(record, {}, SHA)
            ) as verified,
            patch.object(cluster, "approved_bundle") as retired,
        ):
            self.assertEqual(cluster.checked_release(settings), record)
        verified.assert_called_once_with(cluster.REPOSITORY_ROOT, FORK, "helm")
        retired.assert_not_called()

    def test_existing_gitops_credentials_keep_their_historical_release(self):
        settings = cluster.initial_settings(FORK) | {"mode": "gitops"}
        record = {"verifiedRevision": "d" * 40}
        with (
            patch.object(
                cluster, "approved_bundle", return_value=(record, {}, SHA)
            ) as old,
            patch.object(cluster, "published_bundle") as current,
        ):
            self.assertEqual(cluster.checked_release(settings), record)
        old.assert_called_once_with(settings, "helm")
        current.assert_not_called()

    def test_success_runs_migration_before_services_and_records_the_selected_release(
        self,
    ):
        settings = cluster.initial_settings(FORK)
        args = SimpleNamespace(
            local_images=None, helm="helm", kind="kind", token_file=None
        )
        record = {
            "visibility": "public",
            "verifiedRevision": SHA,
            "runId": 900,
            "repository": FORK.repository,
            "branch": "main",
            "images": {
                s: FORK.image(s) + "@sha256:" + "d" * 64 for s in bundle.SERVICES
            },
        }
        snapshot = {}
        for service in bundle.SERVICES:
            resources = [
                {
                    "kind": "Deployment",
                    "metadata": {"name": service},
                    "spec": {
                        "template": {
                            "spec": {
                                "containers": [{"image": record["images"][service]}]
                            }
                        }
                    },
                }
            ]
            if service == "ops-service":
                resources.append(
                    {"kind": "Job", "metadata": {"name": "ops-service-migrate"}}
                )
            snapshot[bundle.PREFIX + f"rendered/{service}.json"] = json.dumps(
                resources
            ).encode()
        events = []

        def execute(command, **kwargs):
            if command[:3] == ["kind", "get", "clusters"]:
                return settings["cluster"]
            if "get" in command and "secrets" in command:
                return "\n".join(cluster.RUNTIME_SECRETS)
            if "apply" in command:
                resources = list(bundle.yaml.safe_load_all(kwargs["data"]))
                for item in resources:
                    if item and item.get("kind") == "Deployment":
                        service = item["metadata"]["name"]
                        self.assertEqual(
                            item["spec"]["template"]["spec"]["containers"][0]["image"],
                            record["images"][service],
                        )
                        events.append(service)
                    self.assertFalse(item and item.get("kind") == "Job")
            return ""

        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(cluster, "doctor"),
            patch("connected_runtime.load_profile", return_value=None),
            patch.object(
                cluster, "published_bundle", return_value=(record, snapshot, SHA)
            ),
            patch.object(cluster, "require_dev"),
            patch.object(cluster, "verify_context"),
            patch.object(cluster, "verify_pull_rights") as pull,
            patch.object(
                cluster, "elasticsearch_image", return_value="elasticsearch:fixture"
            ),
            patch.object(cluster, "apply"),
            patch.object(cluster, "run", side_effect=execute),
            patch(
                "ops_migration.run_migration",
                side_effect=lambda *args: events.append("migration"),
            ),
        ):
            state = Path(directory)
            (state / "kubeconfig").write_text("fixture")
            cluster._up(args, state, settings)
            baseline = json.loads((state / "baseline.json").read_text())
        self.assertEqual(events, ["migration", *bundle.SERVICES])
        self.assertEqual(baseline["release"], record)
        self.assertEqual(baseline["images"], record["images"])
        self.assertEqual(baseline["source"], "ghcr")
        pull.assert_called_once_with(None, None, record)

    def test_missing_github_cli_fails_before_remote_reads(self):
        with (
            patch.object(cluster.shutil, "which", return_value=None),
            patch.object(deploy, "verified_release") as remote,
            self.assertRaisesRegex(ValueError, "GitHub CLI gh is required"),
        ):
            cluster.published_bundle(cluster.initial_settings(FORK))
        remote.assert_not_called()


if __name__ == "__main__":
    unittest.main()
