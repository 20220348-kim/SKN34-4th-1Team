"""Exercise EKS Git publication, real Helm/Kustomize rendering and exact sync gates."""

import copy
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import local_release
import yaml
from deployment import commit_tree
from deployment_candidate import git_bytes

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("eks_gitops", ROOT / "infrastructure/eks/gitops.py")
gitops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gitops)
ENV = {
    "AWS_ACCOUNT_ID": "123456789012",
    "AWS_REGION": "ap-southeast-2",
    "EKS_CLUSTER_NAME": "govbiz-eks",
}
TAG = "govbiz-eks/v1.123.1"


def receipt(sha):
    return {
        "schema": 1,
        "repository": gitops.release.SOURCE,
        "sourceSha": sha,
        "account": ENV["AWS_ACCOUNT_ID"],
        "region": ENV["AWS_REGION"],
        "cluster": ENV["EKS_CLUSTER_NAME"],
        "images": {
            name: f"123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/govbiz-demo/{name}@sha256:"
            + "a" * 64
            for name in gitops.release.COMPONENTS
        },
    }


class EksGitOpsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.directory.cleanup)
        cls.root = Path(cls.directory.name)
        git_bytes(cls.root, "init", "--quiet")
        files = {}
        for source in gitops.SOURCE_PATHS:
            path = ROOT / source
            for item in [path] if path.is_file() else path.rglob("*"):
                if item.is_file():
                    files[item.relative_to(ROOT).as_posix()] = item.read_bytes()
        cls.settings = yaml.safe_load(files["infrastructure/eks/gitops-values.yaml"])
        for value in cls.settings["services"].values():
            value.pop("autoscaling", None)
        files["infrastructure/eks/gitops-values.yaml"] = yaml.safe_dump(cls.settings).encode()
        cls.source_files = files
        cls.sha = commit_tree(cls.root, files)
        git_bytes(cls.root, "update-ref", "HEAD", cls.sha)
        cls.record = receipt(cls.sha)
        cls.files = gitops.bundle(cls.root, cls.record, TAG)
        cls.rows = [
            r
            for name, payload in cls.files.items()
            if name.endswith(".yaml") and "kustomization" not in name
            for r in yaml.safe_load_all(payload)
        ]

    def setUp(self):
        read_settings = gitops.read_settings
        mock = patch.object(
            gitops,
            "read_settings",
            side_effect=lambda root=None, sha=None: (
                copy.deepcopy(self.settings) if root is None else read_settings(root, sha)
            ),
        )
        mock.start()
        self.addCleanup(mock.stop)

    def scaling_settings(self):
        settings = copy.deepcopy(self.settings)
        for name in ("core-service", "ai-service"):
            settings["services"][name]["autoscaling"] = {
                "enabled": True,
                "minReplicas": 1,
                "maxReplicas": 3,
                "targetCPUUtilizationPercentage": 70,
            }
        return settings

    def runtime(self, settings=None):
        rows = copy.deepcopy([r for r in self.rows if r["kind"] == "Deployment"])
        for row in rows:
            if settings is not None:
                row["spec"]["template"]["spec"]["nodeSelector"] = gitops.node_selector(
                    settings, row["metadata"]["name"]
                )
            row["metadata"]["generation"] = 2
            row["status"] = {
                "observedGeneration": 2,
                "replicas": 1,
                "readyReplicas": 1,
                "updatedReplicas": 1,
                "availableReplicas": 1,
            }
        return {"cluster": "govbiz-eks.ap-southeast-2.eksctl.io", "items": rows}

    def success(self):
        runtime = self.runtime()
        app = gitops.application(runtime)[1]
        record = {**self.record, "tag": TAG, "gitopsRevision": "b" * 40}
        app["status"] = {
            "sync": {"status": "Synced", "revision": record["gitopsRevision"]},
            "health": {"status": "Healthy"},
            "operationState": {
                "phase": "Succeeded",
                "syncResult": {
                    "revision": record["gitopsRevision"],
                    "resources": [
                        {
                            "kind": "Job",
                            "name": "ops-service-release-" + phase,
                            "hookPhase": "Succeeded",
                        }
                        for phase in ("prepare", "resume")
                    ],
                },
            },
        }
        return app, record, {r["metadata"]["name"]: r for r in runtime["items"]}

    def test_rendered_release_contains_only_six_apps_and_safe_hooks(self):
        kinds = {r["kind"] for r in self.rows}
        self.assertEqual(kinds, {"Deployment", "Service", "Job", "NetworkPolicy"})
        self.assertEqual(
            {r["metadata"]["name"] for r in self.rows if r["kind"] == "Deployment"},
            set(gitops.WORKLOADS),
        )
        for row in self.rows:
            if row["kind"] in {"Deployment", "Job"}:
                pod = row["spec"]["template"]["spec"]
                self.assertNotIn("kubernetes.io/hostname", pod["nodeSelector"])
                self.assertFalse(pod["automountServiceAccountToken"])
                for c in pod["containers"]:
                    self.assertIn(c["image"], self.record["images"].values())
                if row["metadata"]["name"] in ("evaluation-runner", "ops-artifacts"):
                    self.assertEqual(
                        pod["containers"][0]["resources"]["requests"]["memory"], "256Mi"
                    )
                    rule = pod["affinity"]["podAffinity"][
                        "requiredDuringSchedulingIgnoredDuringExecution"
                    ][0]
                    self.assertEqual(rule["topologyKey"], "kubernetes.io/hostname")
                    for key, value in rule["labelSelector"]["matchLabels"].items():
                        self.assertEqual(row["spec"]["template"]["metadata"]["labels"][key], value)
            if row["kind"] == "Job":
                pod = row["spec"]["template"]["spec"]
                self.assertIn("argo_release", pod["containers"][0]["command"])
                self.assertIn(TAG, pod["containers"][0]["command"])
                self.assertFalse(any("persistentVolumeClaim" in v for v in pod["volumes"]))
                self.assertNotIn(
                    "app.kubernetes.io/instance",
                    row["spec"]["template"]["metadata"].get("labels", {}),
                )
        self.assertEqual(
            {
                r["metadata"]["annotations"]["argocd.argoproj.io/hook"]
                for r in self.rows
                if r["kind"] == "Job"
            },
            {"PreSync", "PostSync"},
        )

    def test_render_uses_tested_git_source_not_dirty_values(self):
        path = self.root / "infrastructure/eks/gitops-values.yaml"
        path.parent.mkdir(parents=True)
        path.write_text("invalid dirty configuration")
        self.assertEqual(gitops.bundle(self.root, self.record, TAG), self.files)

    def test_single_writer_deployments_follow_their_database_nodes(self):
        deployments = {
            row["metadata"]["name"]: row for row in self.rows if row["kind"] == "Deployment"
        }
        for name, database in (
            ("catalog-service", "catalog-mysql"),
            ("ops-service", "ops-mysql"),
        ):
            with self.subTest(service=name):
                row = deployments[name]
                self.assertEqual(row["spec"]["strategy"], {"type": "Recreate"})
                self.assertEqual(
                    row["spec"]["template"]["spec"]["affinity"],
                    {
                        "podAffinity": {
                            "requiredDuringSchedulingIgnoredDuringExecution": [
                                {
                                    "labelSelector": {
                                        "matchLabels": {"app.kubernetes.io/name": database}
                                    },
                                    "namespaces": ["govbiz-msa"],
                                    "topologyKey": "kubernetes.io/hostname",
                                }
                            ]
                        }
                    },
                )

    def test_database_affinity_excludes_http_and_release_hooks(self):
        for row in self.rows:
            if row["kind"] == "Job" or (
                row["kind"] == "Deployment"
                and row["metadata"]["name"] in ("core-service", "ai-service")
            ):
                with self.subTest(kind=row["kind"], name=row["metadata"]["name"]):
                    self.assertNotIn("affinity", row["spec"]["template"]["spec"])

    def test_opted_in_release_shares_only_http_placement_from_tested_source(self):
        settings = self.scaling_settings()
        files = dict(self.source_files)
        files["infrastructure/eks/gitops-values.yaml"] = yaml.safe_dump(settings).encode()
        sha = commit_tree(self.root, files)
        rendered = gitops.bundle(self.root, receipt(sha), TAG)
        rows = [
            row
            for name, contents in rendered.items()
            if name.endswith(".yaml") and "kustomization" not in name
            for row in yaml.safe_load_all(contents)
        ]
        self.assertEqual(
            {r["metadata"]["name"] for r in rows if r["kind"] == "HorizontalPodAutoscaler"},
            {"core-service", "ai-service"},
        )
        for row in rows:
            if row["kind"] in ("Deployment", "Job"):
                http = row["metadata"]["name"] in ("core-service", "ai-service")
                self.assertEqual(
                    row["spec"]["template"]["spec"]["nodeSelector"],
                    {"govbiz.io/http-pool": "shared"}
                    if http else {"govbiz.io/workload-pool": "application"},
                )
            if row["kind"] == "Deployment":
                if row["metadata"]["name"] in ("core-service", "ai-service"):
                    self.assertNotIn("replicas", row["spec"])
                else:
                    self.assertEqual(row["spec"]["replicas"], 1)

    def test_scaled_adoption_preserves_only_bounded_stateless_replica_ownership(self):
        settings = self.scaling_settings()
        runtime = self.runtime(settings)
        for row in runtime["items"]:
            if row["metadata"]["name"] == "core-service":
                row["spec"]["replicas"] = 2
        project, app = gitops.application(runtime, settings)
        gitops.check_application(app, settings)
        self.assertIn(
            {"group": "autoscaling", "kind": "HorizontalPodAutoscaler"},
            project["spec"]["namespaceResourceWhitelist"],
        )
        self.assertEqual(
            {rule["name"] for rule in app["spec"]["ignoreDifferences"]},
            {"core-service", "ai-service"},
        )
        self.assertTrue(
            all(rule["jsonPointers"] == ["/spec/replicas"] for rule in app["spec"]["ignoreDifferences"])
        )
        # The shared helper retains its strict local single-writer default.
        with self.assertRaises(ValueError):
            local_release.runtime_patches(runtime, gitops.WORKLOADS, preserve_placement=True)
        for name in ("core-service", "catalog-service", "evaluation-runner"):
            wrong = copy.deepcopy(app)
            entry = next(
                item for item in wrong["spec"]["source"]["kustomize"]["patches"]
                if item["target"]["name"] == name
            )
            operations = json.loads(entry["patch"])
            selector = next(op for op in operations if op["path"].endswith("/nodeSelector"))
            selector["value"] = (
                {"govbiz.io/workload-pool": "application"}
                if name == "core-service" else {"govbiz.io/http-pool": "shared"}
            )
            entry["patch"] = json.dumps(operations)
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "node selector"):
                gitops.check_application(wrong, settings)
        for name, replicas in (("core-service", 0), ("core-service", 4), ("ops-artifacts", 2)):
            wrong = copy.deepcopy(runtime)
            next(r for r in wrong["items"] if r["metadata"]["name"] == name)["spec"]["replicas"] = replicas
            with self.subTest(name=name, replicas=replicas), self.assertRaises(ValueError):
                gitops.application(wrong, settings)

    def test_hpa_cannot_hide_images_or_non_scalable_workloads(self):
        settings = self.scaling_settings()
        for mutate in (
            lambda a: a["spec"]["ignoreDifferences"][0].update(jsonPointers=["/spec/template"]),
            lambda a: a["spec"]["ignoreDifferences"][0].update(name="*"),
            lambda a: a["spec"]["ignoreDifferences"][0].update(managedFieldsManagers=["argocd"]),
            lambda a: a["spec"]["syncPolicy"].update(syncOptions=["FailOnSharedResource=true"]),
        ):
            app = gitops.application(self.runtime(settings), settings)[1]
            mutate(app)
            with self.assertRaisesRegex(ValueError, "sync policy"):
                gitops.check_application(app, settings)
        for name, change in (
            ("catalog-service", {"enabled": True}),
            ("ops-service", {"enabled": True}),
            ("core-service", {"enabled": True, "minReplicas": 0}),
            ("core-service", {"enabled": True, "maxReplicas": 11}),
            ("core-service", {"enabled": True, "maxReplicas": True}),
            ("core-service", {"enabled": "true"}),
        ):
            settings = self.scaling_settings()
            settings["services"][name]["autoscaling"] = change
            with self.subTest(name=name, change=change), self.assertRaises(ValueError):
                gitops.replica_bounds(settings)

    def test_sync_requires_all_scaled_replicas_ready_and_exact_images_and_source(self):
        settings = self.scaling_settings()
        app, record, deployments = self.success()
        configured = gitops.application(self.runtime(settings), settings)[1]
        app["spec"] = configured["spec"]
        core = deployments["core-service"]
        core["spec"]["replicas"] = 2
        for key in ("replicas", "readyReplicas", "updatedReplicas", "availableReplicas"):
            core["status"][key] = 2
        self.assertTrue(gitops.synced(app, record, deployments, settings))
        for mutate in (
            lambda d: d["core-service"]["spec"].update(replicas=4),
            lambda d: d["core-service"]["status"].update(readyReplicas=1),
            # A RollingUpdate surge is transient; wait rather than declaring success/failure.
            lambda d: d["core-service"]["status"].update(
                replicas=3, readyReplicas=3, updatedReplicas=3, availableReplicas=3
            ),
            lambda d: d["core-service"]["status"].update(observedGeneration=1),
            lambda d: d["core-service"]["spec"]["template"]["metadata"].update(annotations={}),
            lambda d: d["core-service"]["spec"]["template"]["spec"]["containers"][0].update(image="old"),
            lambda d: d["evaluation-runner"]["spec"].update(replicas=2),
        ):
            wrong = copy.deepcopy(deployments)
            mutate(wrong)
            self.assertFalse(gitops.synced(app, record, wrong, settings))

    def test_application_preserves_env_and_pvc_without_hiding_image_updates(self):
        runtime = self.runtime()
        ops = next(r for r in runtime["items"] if r["metadata"]["name"] == "ops-service")
        for c in ops["spec"]["template"]["spec"]["containers"]:
            c["env"].append({"name": "SAFE_RUNTIME_MARKER", "value": "preserved"})
        project, app = gitops.application(runtime)
        gitops.check_application(app)
        self.assertEqual(project["spec"]["clusterResourceWhitelist"], [])
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name, data in self.files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            path = root / "release/kustomization.yaml"
            value = yaml.safe_load(path.read_text())
            value["patches"] = app["spec"]["source"]["kustomize"]["patches"]
            path.write_text(yaml.safe_dump(value))
            output = subprocess.check_output(["kubectl", "kustomize", str(path.parent)], text=True)
            rows = list(yaml.safe_load_all(output))
            for row in rows:
                if row["kind"] == "Job":
                    self.assertIn(
                        {"name": "SAFE_RUNTIME_MARKER", "value": "preserved"},
                        row["spec"]["template"]["spec"]["containers"][0]["env"],
                    )
                if row["kind"] == "Deployment":
                    for c in row["spec"]["template"]["spec"]["containers"]:
                        self.assertIn(c["image"], self.record["images"].values())

    def test_adoption_rejects_wrong_cluster_selector_ownership_and_failed_release(self):
        for mutate in (
            lambda x: x.update(cluster="kind-govbiz"),
            lambda x: x["items"].pop(),
            lambda x: x["items"][0]["metadata"].update(
                annotations={"argocd.argoproj.io/tracking-id": "other"}
            ),
            lambda x: x["items"][0]["metadata"].update(
                annotations={"govbiz.io/release-in-progress": "old"}
            ),
            lambda x: x["items"][0]["spec"].update(selector={"matchLabels": {"other": "owner"}}),
            lambda x: x["items"][0]["spec"].update(replicas=0),
        ):
            runtime = self.runtime()
            mutate(runtime)
            with self.assertRaises(ValueError):
                gitops.application(runtime)

    def test_receipt_rejects_wrong_revision_registry_and_target(self):
        gitops.validate_record(self.record, self.sha, ENV)
        for mutate in (
            lambda r: r.update(sourceSha="c" * 40),
            lambda r: r.update(account="999999999999"),
            lambda r: r["images"].pop("evaluation-runner"),
            lambda r: r["images"].update({"core-service": "evil/image:latest"}),
        ):
            record = copy.deepcopy(self.record)
            mutate(record)
            with self.assertRaises(ValueError):
                gitops.validate_record(record, self.sha, ENV)

    def test_exact_revision_both_hooks_health_and_every_image_are_required(self):
        app, record, deployments = self.success()
        self.assertTrue(gitops.synced(app, record, deployments))
        for mutate in (
            lambda a, d: a["status"]["sync"].update(revision="c" * 40),
            lambda a, d: a["status"]["health"].update(status="Degraded"),
            lambda a, d: a["status"]["operationState"]["syncResult"]["resources"].pop(),
            lambda a, d: a.update(operation={"sync": {}}),
            lambda a, d: d["core-service"]["status"].update(observedGeneration=1),
            lambda a, d: d["ops-service"]["spec"]["template"]["spec"]["containers"][1].update(
                image="wrong"
            ),
            lambda a, d: d["ops-artifacts"]["spec"]["template"]["spec"]["initContainers"][0].update(
                image="wrong"
            ),
            lambda a, d: d["ops-artifacts"]["spec"]["template"]["spec"].pop("initContainers"),
        ):
            app, record, deployments = self.success()
            mutate(app, deployments)
            self.assertFalse(gitops.synced(app, record, deployments))
        app["status"]["operationState"]["phase"] = "Failed"
        with self.assertRaisesRegex(ValueError, "Argo sync failed"):
            gitops.synced(app, record, deployments)

    def test_override_cannot_mask_the_tested_image(self):
        app, _, _ = self.success()
        app["spec"]["source"]["kustomize"]["patches"][0]["patch"] = json.dumps(
            [{"op": "replace", "path": "/spec/template/spec/containers/0/image", "value": "old"}]
        )
        with self.assertRaisesRegex(ValueError, "must not override"):
            gitops.check_application(app)
        app, _, _ = self.success()
        app["spec"]["source"]["kustomize"]["images"] = ["old/image:latest"]
        with self.assertRaisesRegex(ValueError, "overrides"):
            gitops.check_application(app)
        app, _, _ = self.success()
        app["spec"]["syncPolicy"]["syncOptions"].append("Replace=true")
        with self.assertRaisesRegex(ValueError, "sync policy"):
            gitops.check_application(app)

    def test_eks_tags_are_immutable_and_rechecked_before_push(self):
        calls = []

        def git(root, *args):
            calls.append(args)
            return b""

        gate = Mock()
        with (
            patch.object(local_release, "git_bytes", side_effect=git),
            patch.object(local_release, "commit_tree", return_value="b" * 40),
        ):
            revision = gitops.publish_tag(
                self.root,
                gitops.Fork(gitops.release.SOURCE),
                self.sha,
                TAG,
                self.files,
                gate,
                tag_prefix=gitops.TAG_PREFIX,
            )
            self.assertEqual(revision, "b" * 40)
            gate.assert_called_once_with()
            self.assertEqual(calls[-1][-1], revision + ":refs/tags/" + TAG)
            self.assertNotIn("--force", calls[-1])
            calls.clear()
            gate.side_effect = ValueError("CI changed")
            with self.assertRaisesRegex(ValueError, "CI changed"):
                gitops.publish_tag(
                    self.root,
                    gitops.Fork(gitops.release.SOURCE),
                    self.sha,
                    TAG,
                    self.files,
                    gate,
                    tag_prefix=gitops.TAG_PREFIX,
                )
            self.assertFalse(any(c[0] == "push" for c in calls))
        with (
            patch.object(
                local_release, "git_bytes", return_value=("b" * 40 + "\trefs/tags/" + TAG).encode()
            ),
            patch.object(local_release, "tracked_files", return_value={"different": b"input"}),
            self.assertRaisesRegex(ValueError, "different contents"),
        ):
            gitops.publish_tag(
                self.root,
                gitops.Fork(gitops.release.SOURCE),
                self.sha,
                TAG,
                self.files,
                Mock(),
                tag_prefix=gitops.TAG_PREFIX,
            )

    def test_publication_rechecks_ci_and_ecr_before_writing_receipt(self):
        app, _, _ = self.success()
        env = {**ENV, "GITHUB_ACTIONS": "true", "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1"}
        for failure in (None, "ci", "ecr"):
            checks = 0

            def check(sha, *, evidence, failure=failure):
                nonlocal checks
                checks += 1
                evidence.append({"runId": 2 if failure == "ci" and checks == 2 else 1})

            def tag(root, fork, sha, name, files, recheck, *, tag_prefix):
                self.assertEqual(json.loads(files["source-checks.json"]), [{"runId": 1}])
                recheck()
                return "b" * 40

            with (
                self.subTest(failure=failure),
                tempfile.TemporaryDirectory() as temp,
                patch.dict(os.environ, env),
                patch.object(gitops, "ROOT", self.root),
                patch.object(gitops.release, "check", side_effect=check),
                patch.object(
                    gitops.release,
                    "digest",
                    return_value="sha256:" + ("c" if failure == "ecr" else "a") * 64,
                ),
                patch.object(gitops, "kube", return_value=app),
                patch.object(gitops, "bundle", return_value=dict(self.files)),
                patch.object(gitops, "publish_tag", side_effect=tag),
            ):
                path = Path(temp) / "receipt.json"
                path.write_text(json.dumps(self.record))
                if failure:
                    with self.assertRaisesRegex(
                        ValueError, "CI evidence changed|ECR receipt differs"
                    ):
                        gitops.publish(self.sha, path)
                    self.assertEqual(json.loads(path.read_text()), self.record)
                else:
                    gitops.publish(self.sha, path)
                    self.assertEqual(json.loads(path.read_text())["gitopsRevision"], "b" * 40)

    def test_preflight_refuses_legacy_codebuild_writer(self):
        app, _, _ = self.success()
        for result, ok in (
            (Mock(returncode=0, stdout="yes\n"), False),
            (Mock(returncode=1, stdout="no\n"), True),
            (Mock(returncode=1, stdout=""), False),
        ):
            with (
                patch.object(gitops, "connect"),
                patch.object(
                    gitops,
                    "kube",
                    side_effect=lambda ns, *args: (
                        app if ns == "argocd" else self.success()[2][args[1]]
                    ),
                ),
                patch.object(gitops.subprocess, "run", return_value=result),
            ):
                if ok:
                    gitops.preflight()
                else:
                    with self.assertRaises(ValueError):
                        gitops.preflight()

    def test_preflight_accepts_bounded_hpa_scaling_without_restarting_stopped_workloads(self):
        settings = self.scaling_settings()
        app, _, deployments = self.success()
        app["spec"] = gitops.application(self.runtime(settings), settings)[1]["spec"]
        core = deployments["core-service"]
        core["spec"]["replicas"] = 2
        for key in ("replicas", "readyReplicas", "updatedReplicas", "availableReplicas"):
            core["status"][key] = 2
        with (
            patch.object(gitops, "read_settings", return_value=settings),
            patch.object(gitops, "connect"),
            patch.object(
                gitops,
                "kube",
                side_effect=lambda namespace, *args: (
                    app if namespace == "argocd" else deployments[args[1]]
                ),
            ),
            patch.object(gitops.subprocess, "run", return_value=Mock(returncode=1, stdout="no\n")),
        ):
            gitops.preflight()
            core["status"]["readyReplicas"] = 1
            # HPA may still be provisioning capacity; final readiness belongs to wait().
            gitops.preflight()
            core["status"]["readyReplicas"] = 2
            core["spec"]["replicas"] = 0
            with self.assertRaisesRegex(ValueError, "stopped"):
                gitops.preflight()

    def test_timeout_and_superseded_main_do_not_report_success(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, ENV):
            _, record, _ = self.success()
            path = Path(temp) / "receipt.json"
            path.write_text(json.dumps(record))
            with (
                patch.object(gitops, "ROOT", self.root),
                patch.object(gitops, "connect"),
                patch.object(gitops.release, "check") as check,
            ):
                with self.assertRaisesRegex(ValueError, "timed out"):
                    gitops.wait(self.sha, path, timeout=0)
                check.side_effect = ValueError("Source superseded")
                with self.assertRaisesRegex(ValueError, "superseded"):
                    gitops.wait(self.sha, path)


if __name__ == "__main__":
    unittest.main()
