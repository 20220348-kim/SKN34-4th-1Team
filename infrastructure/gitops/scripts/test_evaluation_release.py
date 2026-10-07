"""Evaluation publication provenance and manual plans without network or a cluster."""

import contextlib
import copy
import io
import json
import sys
import unittest
import zipfile
from unittest.mock import patch

import deployment as deploy
import deployment_candidate as source
import evaluation_release as release
import fork_cluster
from check_msa import REPOSITORY_ROOT
from test_deployment import FORK, SourceFixture
from test_sync_images import FORK as CI_FORK
from test_sync_images import SHA, ci_results, run


class EvaluationReleaseTests(SourceFixture):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        files = dict(cls.source)
        for path in release.RUNNER_PATHS:
            if path in (
                "backend/ai-service/app",
                "evaluation/support-program-evidence",
            ):
                files[path + "/fixture.txt"] = b"runner tree\n"
            else:
                files[path] = b"runner blob\n"
        files[release.RUNNER_RELEASE] = b'{"fixture": "execution release"}\n'
        for directory in (release.CHART, release.VALUES):
            for path in (REPOSITORY_ROOT / directory).rglob("*"):
                if path.is_file():
                    files[path.relative_to(REPOSITORY_ROOT).as_posix()] = (
                        path.read_bytes()
                    )
        cls.sha = deploy.commit_tree(cls.root, files, cls.sha)
        source.git_bytes(cls.root, "update-ref", "HEAD", cls.sha)
        cls.receipts = cls.receipts_for(cls.sha)
        cls.inputs = {
            path: source.git_bytes(cls.root, "rev-parse", cls.sha + ":" + path)
            .decode()
            .strip()
            for path in release.RUNNER_PATHS
        }
        cls.publisher_tree = (
            source.git_bytes(cls.root, "rev-parse", cls.sha + ":infrastructure/release")
            .decode()
            .strip()
        )
        cls.trees = [
            {
                "path": path,
                "type": "tree",
                "sha": source.git_bytes(cls.root, "rev-parse", cls.sha + ":" + path)
                .decode()
                .strip(),
            }
            for path in (
                "infrastructure/release",
                *("backend/" + s for s in source.SERVICES),
            )
        ]

    def setUp(self):
        self.publisher = run() | {
            "id": 900,
            "run_attempt": 1,
            "head_sha": self.sha,
            "head_repository": {"full_name": FORK.repository},
            "repository": {"id": 456, "full_name": FORK.repository},
        }
        self.runner = self.publisher | {"id": 901, "path": release.WORKFLOW}
        self.extra_runs = []
        self.artifacts = []
        self.payloads = {}
        for index, receipt in enumerate(self.receipts):
            self.artifacts.append(
                self.pack(receipt, 1000 + index, 900, "msa-image-" + receipt["service"])
            )
        key = release.runner_input_key(self.inputs, self.publisher_tree)
        self.receipt = {
            "schemaVersion": 3,
            "service": release.RUNNER,
            "visibility": "public",
            "repository": FORK.image(release.RUNNER),
            "digest": "sha256:" + "a" * 64,
            "tag": "src-" + key,
            "platform": "linux/amd64",
            "verifiedRevision": self.sha,
            "inputKey": key,
            "sourceInputs": dict(self.inputs),
            "publisherTree": self.publisher_tree,
            "executionReleaseSha256": source.digest(
                b'{"fixture": "execution release"}\n'
            ),
        }
        self.runner_artifacts = [self.pack(self.receipt, 2000, 901, release.ARTIFACT)]
        self.total_count = 1
        self.ci_state = ["success"]
        self.ci_attempt = 1
        self.current_sha = self.sha
        self.calls = []

    def pack(self, receipt, identity, run_id, name, *, filename=None, extra=False):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr(
                filename or receipt["service"] + ".json", json.dumps(receipt)
            )
            if extra:
                archive.writestr("extra.json", "{}")
        payload = buffer.getvalue()
        self.payloads[identity] = payload
        return {
            "id": identity,
            "name": name,
            "expired": False,
            "size_in_bytes": len(payload),
            "digest": "sha256:" + source.digest(payload),
            "workflow_run": {
                "id": run_id,
                "head_sha": self.sha,
                "head_branch": "main",
                "head_repository_id": 456,
                "repository_id": 456,
            },
        }

    def get(self, path, binary=False):
        self.calls.append(path)
        if "/workflows/evaluation-images.yml/runs?" in path:
            return {"workflow_runs": copy.deepcopy([self.runner, *self.extra_runs])}
        if "/workflows/msa-images.yml/runs?" in path:
            return {"workflow_runs": [copy.deepcopy(self.publisher)]}
        if "/runs/900/artifacts?" in path:
            return {"artifacts": copy.deepcopy(self.artifacts)}
        if "/runs/901/artifacts?" in path:
            return {
                "artifacts": copy.deepcopy(self.runner_artifacts),
                "total_count": self.total_count,
            }
        if "/actions/artifacts/" in path:
            self.assertTrue(binary)
            return self.payloads[int(path.split("/artifacts/")[1].split("/")[0])]
        if path == f"repos/{FORK.repository}/git/ref/heads/main":
            return {"object": {"sha": self.current_sha}}
        if path == f"repos/{FORK.repository}/git/trees/{self.sha}?recursive=1":
            return {"tree": self.trees, "truncated": False}
        result = json.loads(
            json.dumps(ci_results(self.ci_state)(path))
            .replace(SHA, self.sha)
            .replace(CI_FORK.repository, FORK.repository)
        )
        for item in result.get("workflow_runs", [result]):
            if "run_attempt" in item:
                item["run_attempt"] = self.ci_attempt
        return result

    def checked(self):
        return release.checked_runner_receipt(
            self.root,
            FORK,
            self.sha,
            release.select_runner_release(FORK, self.get),
            self.get,
        )

    def plan(self, **kwargs):
        return release.plan(
            self.root,
            FORK,
            get=self.get,
            **(
                {
                    "node": "fixture-control-plane",
                    "prefect_claim": "restored-prefect",
                    "results_claim": "restored-results",
                    "langfuse_url": "http://langfuse-web:3000",
                }
                | kwargs
            ),
        )

    def test_receipt_matches_actual_git_inputs_and_manifest_bytes(self):
        self.assertEqual(self.checked(), self.receipt)
        altered = [
            {"schemaVersion": 2},
            {"service": "ops-service"},
            {"visibility": "private"},
            {"repository": "ghcr.io/mallory/runner"},
            {"platform": "linux/arm64"},
            {"verifiedRevision": "b" * 40},
            {"digest": "latest"},
            {"tag": "src-wrong"},
            {"inputKey": "b" * 64},
            {"publisherTree": "b" * 40},
            {"executionReleaseSha256": "b" * 64},
            {"unexpected": True},
            {"sourceInputs": {key: "b" * 40 for key in self.inputs}},
            {
                "sourceInputs": {
                    key: value
                    for key, value in self.inputs.items()
                    if key != release.RUNNER_RELEASE
                }
            },
        ]
        for change in altered:
            with self.subTest(change=change):
                self.runner_artifacts = [
                    self.pack(self.receipt | change, 2000, 901, release.ARTIFACT)
                ]
                with self.assertRaises(ValueError):
                    self.checked()

    def test_archive_checksum_path_count_and_expansion_limits(self):
        self.payloads[2000] += b"tampered"
        with self.assertRaisesRegex(ValueError, "checksum"):
            self.checked()
        for options in ({"filename": "../evaluation-runner.json"}, {"extra": True}):
            self.runner_artifacts = [
                self.pack(self.receipt, 2000, 901, release.ARTIFACT, **options)
            ]
            with self.assertRaisesRegex(ValueError, "archive contents"):
                self.checked()
        huge = self.receipt | {"extra": "x" * 8200}
        self.runner_artifacts = [self.pack(huge, 2000, 901, release.ARTIFACT)]
        with self.assertRaisesRegex(ValueError, "archive contents"):
            self.checked()

    def test_publisher_identity_and_artifact_origin_are_required(self):
        original = copy.deepcopy(self.runner)
        for change in (
            {"path": ".github/workflows/msa-images.yml"},
            {"head_branch": "topic"},
            {"event": "pull_request"},
            {"run_attempt": 0},
            {"head_repository": {"full_name": "mallory/project"}},
        ):
            self.runner = original | change
            with self.subTest(change=change), self.assertRaises(ValueError):
                release.select_runner_release(FORK, self.get)
        self.runner = original
        artifact = copy.deepcopy(self.runner_artifacts[0])
        for change in (
            {"expired": True},
            {"size_in_bytes": 20000},
            {"id": 0},
            {"name": "msa-image-evaluation-runner"},
            {"workflow_run": artifact["workflow_run"] | {"head_repository_id": 999}},
            {"workflow_run": artifact["workflow_run"] | {"head_sha": "b" * 40}},
        ):
            self.runner_artifacts = [artifact | change]
            with self.subTest(change=change), self.assertRaises(ValueError):
                release.select_runner_release(FORK, self.get)
        self.runner_artifacts = [artifact]
        self.total_count = 101
        with self.assertRaisesRegex(ValueError, "Incomplete"):
            release.select_runner_release(FORK, self.get)

    def test_newer_failed_or_pending_publication_cannot_fall_back(self):
        for changes in (
            {"conclusion": "failure"},
            {"status": "in_progress"},
            {"conclusion": "cancelled"},
        ):
            self.extra_runs = [self.runner | {"id": 902} | changes]
            self.assertIsNone(release.select_runner_release(FORK, self.get))
        self.extra_runs = []
        self.runner_artifacts = [{"name": name} for name in release.REPORTS]
        self.total_count = len(self.runner_artifacts)
        self.assertIsNone(release.select_runner_release(FORK, self.get))

    def test_real_source_ci_and_helm_plan_is_manual_dormant_and_separate(self):
        dirty = self.root / release.CHART / "templates/dirty.yaml"
        dirty.parent.mkdir(parents=True)
        dirty.write_text("not a valid chart {{", encoding="utf-8")
        self.addCleanup(dirty.unlink)
        before = source.git_bytes(self.root, "status", "--porcelain")
        with (
            patch.object(fork_cluster, "verify_pull_rights") as msa_registry,
            patch.object(release, "verify_pull_rights") as runner_registry,
        ):
            result = self.plan()
        self.assertEqual(msa_registry.call_count, 1)
        runner_registry.assert_called_once_with(
            None, None, {"images": {release.RUNNER: result["images"][release.RUNNER]}}
        )
        self.assertEqual(result["status"], "PLANNED")
        self.assertEqual(result["sourceSha"], self.sha)
        self.assertEqual(
            result["executionReleaseSha256"], self.receipt["executionReleaseSha256"]
        )
        self.assertEqual(set(result["renderedSha256"]), set(release.COMPONENTS))
        for field in (
            "clusterChanged",
            "storageRestored",
            "runtimeVerified",
            "deploymentAuthorized",
            "layersDownloaded",
            "automaticSyncEnabled",
        ):
            self.assertIs(result[field], False)
        project, *apps = result["resources"]
        self.assertEqual(project["metadata"]["name"], "govbiz-evaluation")
        self.assertEqual(project["spec"]["clusterResourceWhitelist"], [])
        self.assertEqual(
            project["spec"]["namespaceResourceWhitelist"],
            [
                {"group": "apps", "kind": "Deployment"},
                {"group": "", "kind": "Service"},
            ],
        )
        self.assertEqual(len(apps), 3)
        for name, app in zip(release.COMPONENTS, apps, strict=True):
            spec = app["spec"]
            self.assertEqual(spec["destination"]["namespace"], "govbiz-evaluation")
            self.assertEqual(spec["source"]["targetRevision"], self.sha)
            self.assertEqual(spec["source"]["path"], release.CHART)
            self.assertEqual(spec["source"]["helm"]["releaseName"], name)
            value = spec["source"]["helm"]["valuesObject"]
            self.assertEqual(value["replicas"], 0)
            self.assertEqual(value["image"], result["images"][name])
            self.assertEqual(value["imagePullSecrets"], [])
            self.assertFalse(value["allowLocalImages"])
            self.assertEqual(
                spec["syncPolicy"],
                {
                    "automated": {"enabled": False, "prune": False, "selfHeal": False},
                    "retry": {"limit": 0},
                    "syncOptions": ["FailOnSharedResource=true"],
                },
            )
            self.assertNotIn("finalizers", app["metadata"])
        self.assertEqual(source.git_bytes(self.root, "status", "--porcelain"), before)

    def test_failed_required_ci_stops_before_receipt_download(self):
        for state in ("failure", "missing", "skipped"):
            self.ci_state[0] = state
            with (
                self.subTest(state=state),
                self.assertRaisesRegex(ValueError, "source blocked"),
            ):
                self.plan()
        self.assertFalse(any("/actions/artifacts/" in path for path in self.calls))

    def test_plan_blocks_mixed_source_or_private_registry_or_invalid_storage(self):
        with patch.object(fork_cluster, "verify_pull_rights"), self.mocked_renderer():
            self.runner["head_sha"] = "e" * 40
            self.runner_artifacts[0]["workflow_run"]["head_sha"] = "e" * 40
            with self.assertRaisesRegex(ValueError, "same source SHA"):
                self.plan()
            self.runner["head_sha"] = self.sha
            self.runner_artifacts[0]["workflow_run"]["head_sha"] = self.sha
            with (
                patch.object(
                    release,
                    "verify_pull_rights",
                    side_effect=ValueError("private registry"),
                ),
                self.assertRaisesRegex(ValueError, "private registry"),
            ):
                self.plan()
            with (
                patch.object(release, "verify_pull_rights"),
                self.assertRaisesRegex(ValueError, "separate claims"),
            ):
                self.plan(prefect_claim="restored-results")

    def test_publication_and_ci_changes_during_rendering_block_the_plan(self):
        actual_render = release.render_bundle
        mutations = {
            "runner rerun": lambda: self.runner.update(run_attempt=2),
            "CI rerun": lambda: setattr(self, "ci_attempt", 2),
            "source moved": lambda: setattr(self, "current_sha", "e" * 40),
            "artifact replaced": lambda: self.runner_artifacts[0].update(
                digest="sha256:" + "e" * 64
            ),
            "MSA rerun": lambda: self.publisher.update(run_attempt=2),
        }
        for name, mutate in mutations.items():
            self.setUp()

            def render(*args, mutate=mutate, **kwargs):
                result = actual_render(*args, **kwargs)
                mutate()
                return result

            with (
                self.subTest(name=name),
                patch.object(fork_cluster, "verify_pull_rights"),
                patch.object(release, "verify_pull_rights"),
                self.mocked_renderer(),
                patch.object(release, "render_bundle", side_effect=render),
                self.assertRaises(ValueError),
            ):
                self.plan()

    def test_extra_chart_resource_is_rejected_and_errors_do_not_leak_inputs(self):
        with (
            patch.object(fork_cluster, "verify_pull_rights"),
            patch.object(release, "verify_pull_rights"),
            self.mocked_renderer(),
            patch.object(
                release,
                "render_bundle",
                return_value={
                    name: [{"kind": "PersistentVolumeClaim"}]
                    for name in release.COMPONENTS
                },
            ),
            self.assertRaisesRegex(ValueError, "resource scope"),
        ):
            self.plan()
        output = io.StringIO()
        with (
            patch.object(
                sys,
                "argv",
                [
                    "evaluation_release.py",
                    "--node",
                    "node",
                    "--prefect-claim",
                    "a",
                    "--results-claim",
                    "b",
                    "--langfuse-url",
                    "http://secret:password@host",
                ],
            ),
            patch.object(release, "from_origin", return_value=FORK),
            patch.object(
                release, "plan", side_effect=ValueError("private data secret:password")
            ),
            contextlib.redirect_stdout(output),
        ):
            self.assertEqual(release.main(), 1)
        self.assertNotIn("password", output.getvalue())
        self.assertEqual(json.loads(output.getvalue())["status"], "BLOCKED")


if __name__ == "__main__":
    unittest.main()
