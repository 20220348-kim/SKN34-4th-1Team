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
                "minReplicas": 2,
                "maxReplicas": 3,
                "targetCPUUtilizationPercentage": 70,
            }
        return settings

    def runtime(self, settings=None):
        rows = copy.deepcopy([r for r in self.rows if r["kind"] == "Deployment"])
        bounds = gitops.replica_bounds(settings) if settings is not None else {}
        for row in rows:
            if settings is not None:
                row["spec"]["template"]["spec"]["nodeSelector"] = gitops.node_selector(
                    settings, row["metadata"]["name"]
                )
            replicas = bounds.get(row["metadata"]["name"], (1, 1))[0]
            row["spec"]["replicas"] = replicas
            row["metadata"]["generation"] = 2
            row["status"] = {
                "observedGeneration": 2,
                "replicas": replicas,
                "readyReplicas": replicas,
                "updatedReplicas": replicas,
                "availableReplicas": replicas,
            }
        return {"cluster": "govbiz-eks.ap-southeast-2.eksctl.io", "items": rows}

    def success(self, settings=None):
        runtime = self.runtime(settings)
        app = gitops.application(runtime, settings)[1]
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
                        pod["nodeSelector"], {"govbiz.io/workload-pool": "observability"}
                    )
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
                pool = (
                    "observability"
                    if row["metadata"]["name"] in ("evaluation-runner", "ops-artifacts")
                    else "application"
                )
                self.assertEqual(
                    row["spec"]["template"]["spec"]["nodeSelector"],
                    {"govbiz.io/http-pool": "shared"}
                    if http else {"govbiz.io/workload-pool": pool},
                )
            if row["kind"] == "Deployment":
                if row["metadata"]["name"] in ("core-service", "ai-service"):
                    self.assertNotIn("replicas", row["spec"])
                    self.assertEqual(row["spec"]["strategy"], {
                        "type": "RollingUpdate",
                        "rollingUpdate": {"maxSurge": 0, "maxUnavailable": 1},
                    })
                    pod = row["spec"]["template"]["spec"]
                    self.assertNotIn("topologySpreadConstraints", pod)
                    self.assertEqual(pod["affinity"], {
                        "podAntiAffinity": {
                            "requiredDuringSchedulingIgnoredDuringExecution": [{
                                "labelSelector": row["spec"]["selector"],
                                "namespaces": ["govbiz-msa"],
                                "topologyKey": "kubernetes.io/hostname",
                            }],
                        },
                    })
                else:
                    self.assertEqual(row["spec"]["replicas"], 1)
                    self.assertNotIn("podAntiAffinity", row["spec"]["template"]["spec"].get("affinity", {}))
            if row["kind"] == "HorizontalPodAutoscaler":
                self.assertEqual(row["spec"]["minReplicas"], 2)
                self.assertEqual(row["spec"]["maxReplicas"], 3)
            if row["kind"] == "Job":
                self.assertNotIn("affinity", row["spec"]["template"]["spec"])

    def test_http_disruption_budgets_allow_node_removal_without_losing_every_replica(self):
        path = ROOT / "infrastructure/eks/autoscaling/pdb.yaml"
        rows = list(yaml.safe_load_all(path.read_text()))
        for name in ("core-service", "ai-service"):
            matching = [
                row for row in rows
                if row["spec"]["selector"]["matchLabels"].get("app.kubernetes.io/name") == name
            ]
            self.assertEqual(len(matching), 1)
            self.assertEqual(matching[0]["metadata"]["namespace"], "govbiz-msa")
            self.assertEqual(matching[0]["spec"], {
                "minAvailable": 1,
                "selector": {"matchLabels": {
                    "app.kubernetes.io/name": name,
                    "app.kubernetes.io/instance": name,
                }},
            })

    def test_distributed_release_rejects_a_single_replica_minimum(self):
        for name in ("core-service", "ai-service"):
            settings = self.scaling_settings()
            settings["services"][name]["autoscaling"]["minReplicas"] = 1
            files = dict(self.source_files)
            files["infrastructure/eks/gitops-values.yaml"] = yaml.safe_dump(settings).encode()
            sha = commit_tree(self.root, files)
            with self.subTest(service=name), self.assertRaisesRegex(ValueError, "at least two"):
                gitops.bundle(self.root, receipt(sha), TAG)

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
        app, record, deployments = self.success(settings)
        self.assertTrue(gitops.synced(app, record, deployments, settings))
        for name in ("core-service", "ai-service"):
            for replicas in (1, 3):
                changed = copy.deepcopy(deployments)
                changed[name]["spec"]["replicas"] = replicas
                for key in ("replicas", "readyReplicas", "updatedReplicas", "availableReplicas"):
                    changed[name]["status"][key] = replicas
                with self.subTest(service=name, replicas=replicas):
                    self.assertEqual(gitops.synced(app, record, changed, settings), replicas == 3)
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
        core = next(r for r in runtime["items"] if r["metadata"]["name"] == "core-service")
        core_env = core["spec"]["template"]["spec"]["containers"][0]["env"]
        core_env[:] = [item for item in core_env if item["name"] != gitops.DOCUMENT_JOBS_FLAG]
        core_env.extend([
            {"name": gitops.DOCUMENT_JOBS_FLAG, "value": "false"},
            {"name": "PRIVATE_CORE_TOKEN", "valueFrom": {"secretKeyRef": {"name": "core-runtime", "key": "token"}}},
        ])
        ops = next(r for r in runtime["items"] if r["metadata"]["name"] == "ops-service")
        for c in ops["spec"]["template"]["spec"]["containers"]:
            c["env"].append({"name": "SAFE_RUNTIME_MARKER", "value": "preserved"})
        project, app = gitops.application(runtime)
        self.assertIn({"name": gitops.DOCUMENT_JOBS_FLAG, "value": "false"}, core_env)
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
                    if row["metadata"]["name"] == "core-service":
                        environment = row["spec"]["template"]["spec"]["containers"][0]["env"]
                        self.assertEqual(
                            [item for item in environment if item["name"] == gitops.DOCUMENT_JOBS_FLAG],
                            [{"name": gitops.DOCUMENT_JOBS_FLAG, "value": "true"}],
                        )
                        self.assertIn(core_env[-1], environment)

    def disabled_document_jobs_application(self):
        app, _, _ = self.success()
        app["metadata"]["resourceVersion"] = "42"
        patches = app["spec"]["source"]["kustomize"]["patches"]
        core = next(p for p in patches if p["target"]["name"] == "core-service")
        operations = json.loads(core["patch"])
        environment = next(op["value"] for op in operations if op["path"].endswith("/env"))
        next(item for item in environment if item["name"] == gitops.DOCUMENT_JOBS_FLAG)["value"] = "false"
        core["patch"] = json.dumps(operations)
        return app

    def test_document_jobs_recovery_changes_only_the_flag_and_requires_the_exported_version(self):
        app = self.disabled_document_jobs_application()
        before = copy.deepcopy(app)
        patch = gitops.document_jobs_patch(app)
        self.assertEqual(app, before)
        self.assertEqual(patch["metadata"], {"resourceVersion": "42"})
        self.assertEqual(set(patch["spec"]), {"source"})
        self.assertEqual(set(patch["spec"]["source"]), {"kustomize"})
        updated = copy.deepcopy(app)
        updated["spec"]["source"]["kustomize"] = patch["spec"]["source"]["kustomize"]
        gitops.check_application(updated)
        for original, changed in zip(
            before["spec"]["source"]["kustomize"]["patches"],
            updated["spec"]["source"]["kustomize"]["patches"],
            strict=True,
        ):
            self.assertEqual(original["target"], changed["target"])
            original_ops, changed_ops = json.loads(original["patch"]), json.loads(changed["patch"])
            if original["target"]["name"] == "core-service":
                for operations in (original_ops, changed_ops):
                    for op in operations:
                        if op["path"].endswith("/env"):
                            op["value"] = [item for item in op["value"] if item["name"] != gitops.DOCUMENT_JOBS_FLAG]
            self.assertEqual(original_ops, changed_ops)
        for mutation in (
            lambda a: a["metadata"].pop("resourceVersion"),
            lambda a: a.update(operation={"sync": {}}),
            lambda a: a["status"]["operationState"].update(phase="Running"),
            lambda a: a["spec"]["source"].update(repoURL="https://github.com/other/project.git"),
        ):
            wrong = copy.deepcopy(app)
            mutation(wrong)
            with self.assertRaises(ValueError):
                gitops.document_jobs_patch(wrong)

    def test_disabled_preserved_document_jobs_cannot_authorize_a_release(self):
        app = self.disabled_document_jobs_application()
        with self.assertRaisesRegex(ValueError, "Enable document jobs"):
            gitops.check_application(app)

    def test_live_disabled_document_jobs_block_preflight_and_success(self):
        app, record, deployments = self.success()
        environment = deployments["core-service"]["spec"]["template"]["spec"]["containers"][0]["env"]
        next(item for item in environment if item["name"] == gitops.DOCUMENT_JOBS_FLAG)["value"] = "false"
        self.assertFalse(gitops.synced(app, record, deployments))
        with (
            patch.object(gitops, "connect"),
            patch.object(gitops, "kube", side_effect=lambda ns, *args: app if ns == "argocd" else deployments[args[1]]),
            patch.object(gitops.subprocess, "run") as run,
        ):
            with self.assertRaisesRegex(ValueError, "document jobs to be enabled"):
                gitops.preflight()
            run.assert_not_called()

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
        app, _, deployments = self.success(settings)
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


class EksArgoDashboardTests(unittest.TestCase):
    def setUp(self):
        manifest = ROOT / "infrastructure/eks/argocd-dashboard.yaml"
        self.rows = list(yaml.safe_load_all(manifest.read_text(encoding="utf-8")))
        self.resources = {row["kind"]: row for row in self.rows}

    def test_installation_cannot_overwrite_core_or_application_resources(self):
        server_kinds = {
            "ServiceAccount",
            "Role",
            "RoleBinding",
            "ClusterRole",
            "ClusterRoleBinding",
            "Deployment",
            "Service",
        }
        expected = {(kind, "argocd-server") for kind in server_kinds}
        expected.add(("NetworkPolicy", "argocd-server-ingress"))
        self.assertEqual(len(self.rows), len(expected))
        self.assertEqual(
            {(row["kind"], row["metadata"]["name"]) for row in self.rows}, expected
        )
        for row in self.rows:
            if row["kind"] not in {"ClusterRole", "ClusterRoleBinding"}:
                self.assertEqual(row["metadata"]["namespace"], "argocd")
        for kind in ("RoleBinding", "ClusterRoleBinding"):
            self.assertEqual(
                self.resources[kind]["subjects"],
                [{"kind": "ServiceAccount", "name": "argocd-server", "namespace": "argocd"}],
            )

    def test_dashboard_requires_authentication_and_private_tls_access(self):
        deployment = self.resources["Deployment"]
        pod = deployment["spec"]["template"]["spec"]
        container = pod["containers"][0]
        self.assertEqual(
            container["args"],
            ["/usr/local/bin/argocd-server", "--insecure=false", "--disable-auth=false", "--rootpath=/argocd"],
        )
        self.assertEqual(pod["serviceAccountName"], "argocd-server")
        self.assertFalse(pod.get("hostNetwork"))
        self.assertTrue(all("hostPort" not in port for port in container["ports"]))
        service = self.resources["Service"]["spec"]
        self.assertEqual(service["type"], "ClusterIP")
        self.assertNotIn("externalIPs", service)
        self.assertEqual(service["ports"], [{"name": "https", "port": 8080, "protocol": "TCP", "targetPort": 8080}])
        self.assertTrue(all("nodePort" not in port for port in service["ports"]))
        policy = self.resources["NetworkPolicy"]["spec"]
        self.assertEqual(policy["podSelector"]["matchLabels"], service["selector"])
        self.assertEqual(
            service["selector"]["app.kubernetes.io/name"],
            deployment["spec"]["template"]["metadata"]["labels"]["app.kubernetes.io/name"],
        )
        self.assertEqual(policy["policyTypes"], ["Ingress"])
        self.assertEqual(policy["ingress"], [{
            "from": [{
                "namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "govbiz-msa"}},
                "podSelector": {"matchLabels": {"app.kubernetes.io/name": "api-gateway"}},
            }],
            "ports": [{"protocol": "TCP", "port": 8080}],
        }])
        self.assertNotIn("egress", policy)

    def test_server_reuses_redis_and_fits_the_existing_observability_pool(self):
        deployment = self.resources["Deployment"]["spec"]
        pod = deployment["template"]["spec"]
        self.assertEqual(deployment["replicas"], 1)
        self.assertEqual(deployment["strategy"]["rollingUpdate"]["maxSurge"], 0)
        self.assertEqual(deployment["strategy"]["rollingUpdate"]["maxUnavailable"], 1)
        self.assertEqual(pod["nodeSelector"]["govbiz.io/workload-pool"], "observability")
        self.assertEqual(len(pod["containers"]), 1)
        self.assertFalse(pod.get("initContainers"))
        container = pod["containers"][0]
        self.assertEqual(container["image"], "quay.io/argoproj/argocd:v3.5.3")
        self.assertEqual(container["resources"]["requests"], {"cpu": "50m", "memory": "128Mi"})
        self.assertEqual(container["resources"]["limits"], {"cpu": "500m", "memory": "384Mi"})
        redis = next(env for env in container["env"] if env["name"] == "REDIS_PASSWORD")
        self.assertEqual(
            redis["valueFrom"]["secretKeyRef"], {"key": "auth", "name": "argocd-redis"}
        )


if __name__ == "__main__":
    unittest.main()
