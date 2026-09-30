"""Connection activation must preserve credentials and refuse mixed environments."""

import base64
import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import UUID

import fork_cluster
import ops_bridge
import ops_runtime as runtime
import yaml
from check_msa import policy_errors

SETTINGS = {
    "repository": "alice/project",
    "stateId": "a" * 32,
    "namespace": "govbiz-msa",
    "cluster": "govbiz-test",
    "mode": "dev",
}
TOKEN = "x" * 64
IMAGE = "govbiz-ops-service:test"
SECRET = {
    "metadata": {"resourceVersion": "7"},
    "data": {"DJANGO_SECRET_KEY": "ZGphbmdv", "DB_PASSWORD": "cGFzcw=="},
}


class ConnectionTests(unittest.TestCase):
    def test_connection_is_bound_and_overlay_never_contains_token(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            self.assertEqual(runtime.load_overlay(state, SETTINGS), {})
            record = runtime.connection(SETTINGS, "fixture")
            (state / runtime.PROFILE).write_text(json.dumps(record))
            overlay = runtime.load_overlay(state, SETTINGS)["ops-service"]
            self.assertEqual(overlay["env"]["CORE_API_URL"], "http://core-service:8080")
            self.assertEqual(overlay["env"]["LLMOPS_LIVE_ENABLED"], "false")
            self.assertNotIn(TOKEN, json.dumps(overlay))
            for key in ("repository", "stateId", "namespace"):
                with (
                    self.subTest(key=key),
                    self.assertRaisesRegex(ValueError, "another"),
                ):
                    runtime.load_overlay(state, {**SETTINGS, key: "other"})

    def test_published_bootstrap_rejects_active_connection_before_release_lookup(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            (state / runtime.PROFILE).write_text(
                json.dumps(runtime.connection(SETTINGS, "fixture"))
            )
            with (
                patch.object(fork_cluster, "doctor"),
                patch.object(fork_cluster, "published_bundle") as release,
                self.assertRaisesRegex(ValueError, "tracked runtime"),
            ):
                fork_cluster._up(
                    SimpleNamespace(local_images=None, helm="helm"), state, SETTINGS
                )
            release.assert_not_called()

    def test_local_bootstrap_retains_active_ops_overlay_during_render(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            (state / runtime.PROFILE).write_text(
                json.dumps(runtime.connection(SETTINGS, "fixture"))
            )
            with (
                patch.object(fork_cluster, "doctor"),
                patch.object(
                    fork_cluster, "local_images", return_value={"ops-service": IMAGE}
                ),
                patch.object(
                    fork_cluster,
                    "render_services",
                    side_effect=ValueError("stop at preflight"),
                ) as render,
                self.assertRaisesRegex(ValueError, "preflight"),
            ):
                fork_cluster._up(
                    SimpleNamespace(local_images="fixture", helm="helm"),
                    state,
                    SETTINGS,
                )
            self.assertEqual(
                render.call_args.kwargs["overlay"]["ops-service"], ops_bridge.values()
            )

    def test_only_literal_single_token_is_accepted(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / ".env"
            path.write_text("LLMOPS_ARTIFACT_TOKEN=" + TOKEN + "\n")
            path.chmod(0o600)
            self.assertEqual(runtime.read_artifact_token(path), TOKEN)
            for value in (
                "",
                "x",
                "$(printenv)",
                "`credential`",
                TOKEN + "\nLLMOPS_ARTIFACT_TOKEN=" + TOKEN,
            ):
                path.write_text("LLMOPS_ARTIFACT_TOKEN=" + value + "\n")
                with self.subTest(value=value), self.assertRaises(ValueError):
                    runtime.read_artifact_token(path)

    def test_secret_patch_is_compare_and_swap_of_artifact_key_only(self):
        with patch.object(runtime, "quiet", return_value=json.dumps(SECRET)):
            result = runtime.prepare_secret(["kubectl"], TOKEN)
        self.assertEqual(
            result,
            {
                "metadata": {"resourceVersion": "7"},
                "data": {
                    "LLMOPS_ARTIFACT_TOKEN": base64.b64encode(TOKEN.encode()).decode()
                },
            },
        )
        self.assertNotIn("DB_PASSWORD", result["data"])

    def test_identical_token_does_not_write_and_different_token_is_not_rotated(self):
        resource = copy.deepcopy(SECRET)
        resource["data"]["LLMOPS_ARTIFACT_TOKEN"] = base64.b64encode(
            TOKEN.encode()
        ).decode()
        with patch.object(runtime, "quiet", return_value=json.dumps(resource)):
            self.assertIsNone(runtime.prepare_secret([], TOKEN))
            with self.assertRaisesRegex(ValueError, "rotation"):
                runtime.prepare_secret([], "y" * 64)

    def test_partial_secret_or_argo_ownership_is_rejected(self):
        for change in (
            {"data": {"DB_PASSWORD": "secret"}},
            {"immutable": True},
            {
                "metadata": {
                    "resourceVersion": "7",
                    "annotations": {"argocd.argoproj.io/tracking-id": "other"},
                }
            },
        ):
            with (
                self.subTest(change=change),
                patch.object(
                    runtime, "quiet", return_value=json.dumps(SECRET | change)
                ),
                self.assertRaises(ValueError),
            ):
                runtime.prepare_secret([], TOKEN)

    def test_real_helm_uses_same_image_and_credentials_for_api_sync_and_migration(self):
        rendered = fork_cluster.render_services(
            "helm",
            {"ops-service": IMAGE},
            overlay={"ops-service": ops_bridge.values()},
            services=("ops-service",),
        )
        self.assertEqual(set(rendered), {"ops-service"})
        resources = list(yaml.safe_load_all(rendered["ops-service"]))
        self.assertEqual(
            policy_errors("ops-service", resources, ops_sync_enabled=True), []
        )
        workload = next(item for item in resources if item["kind"] == "Deployment")
        api, sync = workload["spec"]["template"]["spec"]["containers"]
        self.assertEqual(api["image"], IMAGE)
        self.assertEqual(api["env"], sync["env"])
        self.assertEqual(api["image"], sync["image"])


class ActivationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.state = Path(temporary.name)
        self.baseline = {"source": "local", "images": {"ops-service": IMAGE}}
        self.save_baseline()
        for name, value in (
            (runtime.BRIDGE, runtime.connection(SETTINGS, "fixture")),
            ("ops-bridge-values.json", ops_bridge.values()),
        ):
            (self.state / name).write_text(json.dumps(value))
        self.env = self.state / ".env"
        self.env.write_text("LLMOPS_ARTIFACT_TOKEN=" + TOKEN)
        self.env.chmod(0o600)
        self.workload = {
            "metadata": {"resourceVersion": "12", "uid": "owned-ops"},
            "spec": {
                "template": {
                    "spec": {
                        "containers": [
                            {
                                "name": "ops-service",
                                "image": IMAGE,
                                "imagePullPolicy": "Never",
                            }
                        ]
                    }
                }
            },
        }
        self.workload["kind"] = "Deployment"
        self.workload["spec"]["template"]["spec"]["containers"][0]["env"] = [
            {"name": name, "value": value}
            for name, value in (
                ("DB_HOST", "ops-mysql"),
                ("DB_NAME", "govbiz_ops"),
                ("DB_USER", "govbiz_ops"),
                ("DB_PORT", "3306"),
            )
        ] + [
            {
                "name": name,
                "valueFrom": {"secretKeyRef": {"name": "ops-runtime", "key": name}},
            }
            for name in ("DJANGO_SECRET_KEY", "DB_PASSWORD")
        ]
        self.events = []
        self.rendered = yaml.safe_dump_all(
            [
                {"kind": "Job", "metadata": {"name": "ops-service-migrate"}},
                copy.deepcopy(self.workload),
            ]
        )
        mocks = {
            "require_dev": {},
            "run": {"side_effect": self.execute},
            "quiet": {"side_effect": self.secret_execute},
            "render_services": {"return_value": {"ops-service": self.rendered}},
            "verify_artifact_token": {},
            "verify_release": {
                "return_value": {
                    "imageId": "sha256:" + "a" * 64,
                    "runnerId": "runner",
                    "releaseSha256": "b" * 64,
                }
            },
            "load_image": {},
            "run_migration": {
                "side_effect": lambda *args: self.events.append("migration")
            },
        }
        self.mocks = {}
        for name, options in mocks.items():
            patcher = patch.object(runtime, name, **options)
            self.mocks[name] = patcher.start()
            self.addCleanup(patcher.stop)
        patcher = patch.object(ops_bridge, "connect")
        self.connect = patcher.start()
        self.addCleanup(patcher.stop)

    def save_baseline(self):
        (self.state / "baseline.json").write_text(json.dumps(self.baseline))

    def execute(self, command, data=None, **kwargs):
        if "get" in command:
            return json.dumps(self.workload)
        if "apply" in command:
            self.events.append("apply")
            self.assertNotIn("kind: Job", data)
            self.workload = next(
                item
                for item in yaml.safe_load_all(data)
                if item["kind"] == "Deployment"
            )
        if "check_evaluation_runtime" in command:
            self.events.append("diagnostics")
        return ""

    def secret_execute(self, command, data=None):
        if "get" in command:
            return json.dumps(SECRET)
        self.events.append("secret")
        payload = json.loads(data)
        self.assertEqual(set(payload["data"]), {"LLMOPS_ARTIFACT_TOKEN"})
        self.assertNotIn(TOKEN, " ".join(map(str, command)))
        return ""

    def test_activation_orders_checks_secret_migration_apply_and_diagnostics(self):
        runtime.activate(self.state, SETTINGS, self.env)
        self.assertEqual(self.events, ["secret", "migration", "apply", "diagnostics"])
        self.assertTrue((self.state / runtime.PROFILE).exists())
        self.assertEqual(self.connect.call_count, 2)

    def test_migration_failure_does_not_apply_or_record_success(self):
        self.mocks["run_migration"].side_effect = ValueError("migration failed")
        with self.assertRaisesRegex(ValueError, "migration"):
            runtime.activate(self.state, SETTINGS, self.env)
        self.assertNotIn("apply", self.events)
        self.assertFalse((self.state / runtime.PROFILE).exists())

    def test_failed_runtime_diagnostics_does_not_record_activation_success(self):
        def execute(command, **kwargs):
            if "check_evaluation_runtime" in command:
                raise ValueError("runtime failed")
            return self.execute(command, **kwargs)

        self.mocks["run"].side_effect = execute
        with self.assertRaisesRegex(ValueError, "runtime failed"):
            runtime.activate(self.state, SETTINGS, self.env)
        self.assertIn("apply", self.events)
        self.assertFalse((self.state / runtime.PROFILE).exists())

    def test_bad_auth_or_bridge_prevents_secret_and_workload_writes(self):
        self.mocks["verify_artifact_token"].side_effect = ValueError(
            "authentication failed"
        )
        with self.assertRaisesRegex(ValueError, "authentication"):
            runtime.activate(self.state, SETTINGS, self.env)
        self.assertEqual(self.events, [])
        self.mocks["verify_artifact_token"].side_effect = None
        self.connect.side_effect = ValueError("address changed")
        with self.assertRaisesRegex(ValueError, "address"):
            runtime.activate(self.state, SETTINGS, self.env)
        self.assertEqual(self.events, [])

    def test_published_baseline_or_other_current_image_is_rejected(self):
        self.baseline["source"] = "ghcr"
        self.save_baseline()
        with self.assertRaisesRegex(ValueError, "published"):
            runtime.activate(self.state, SETTINGS, self.env)
        self.baseline["source"] = "local"
        self.save_baseline()
        self.workload["spec"]["template"]["spec"]["containers"][0]["image"] = (
            "other:image"
        )
        with self.assertRaisesRegex(ValueError, "baseline"):
            runtime.activate(self.state, SETTINGS, self.env)
        self.assertEqual(self.events, [])

    def test_existing_database_cannot_be_silently_replaced(self):
        self.workload["spec"]["template"]["spec"]["containers"][0]["env"][0][
            "value"
        ] = "another-db"
        with self.assertRaisesRegex(ValueError, "switch databases"):
            runtime.activate(self.state, SETTINGS, self.env)
        self.assertEqual(self.events, [])

    def test_tampered_values_are_not_applied(self):
        values = ops_bridge.values()
        values["env"]["DB_HOST"] = "other-db"
        (self.state / "ops-bridge-values.json").write_text(json.dumps(values))
        with self.assertRaisesRegex(ValueError, "values changed"):
            runtime.activate(self.state, SETTINGS, self.env)
        self.assertEqual(self.events, [])

    def target_image(self):
        target = "govbiz-ops-service:next"
        resources = list(yaml.safe_load_all(self.rendered))
        resources[1]["spec"]["template"]["spec"]["containers"][0]["image"] = target
        self.mocks["render_services"].return_value = {
            "ops-service": yaml.safe_dump_all(resources)
        }
        return target

    def test_explicit_upgrade_only_updates_ops_baseline_after_runtime_success(self):
        self.baseline["images"]["core-service"] = "govbiz-core-service:unchanged"
        self.baseline["metadata"] = {"preserved": True}
        self.save_baseline()
        target = self.target_image()
        runtime.activate(
            self.state, SETTINGS, self.env, ops_image=target, kind="owned-kind"
        )
        saved = json.loads((self.state / "baseline.json").read_text())
        self.assertEqual(
            saved,
            {
                **self.baseline,
                "images": {**self.baseline["images"], "ops-service": target},
            },
        )
        self.mocks["load_image"].assert_called_once_with(
            SimpleNamespace(kind="owned-kind"), SETTINGS, target, self.state
        )
        self.assertEqual(
            self.mocks["render_services"].call_args.kwargs["services"], ("ops-service",)
        )
        self.assertEqual(self.mocks["verify_release"].call_count, 2)
        self.assertEqual(self.workload["metadata"]["resourceVersion"], "12")

    def test_incompatible_runner_stops_before_loading_or_writing(self):
        self.mocks["verify_release"].side_effect = ValueError("release differs")
        with self.assertRaisesRegex(ValueError, "release differs"):
            runtime.activate(
                self.state, SETTINGS, self.env, ops_image=self.target_image()
            )
        self.mocks["load_image"].assert_not_called()
        self.assertEqual(self.events, [])
        self.assertEqual(
            json.loads((self.state / "baseline.json").read_text()), self.baseline
        )

    def test_runner_replacement_during_preflight_stops_before_credentials_and_migration(
        self,
    ):
        self.mocks["verify_release"].side_effect = [
            {"runnerId": "old"},
            {"runnerId": "new"},
        ]
        with self.assertRaisesRegex(ValueError, "changed during activation"):
            runtime.activate(
                self.state, SETTINGS, self.env, ops_image=self.target_image()
            )
        self.assertEqual(self.events, [])

    def test_workload_change_during_preflight_is_not_overwritten(self):
        count = 0

        def execute(command, **kwargs):
            nonlocal count
            if "get" in command:
                count += 1
                if count == 2:
                    changed = copy.deepcopy(self.workload)
                    changed["metadata"]["resourceVersion"] = "concurrent-change"
                    return json.dumps(changed)
            return self.execute(command, **kwargs)

        self.mocks["run"].side_effect = execute
        with self.assertRaisesRegex(ValueError, "workload or baseline changed"):
            runtime.activate(self.state, SETTINGS, self.env)
        self.assertEqual(self.events, [])

    def test_upgrade_migration_failure_preserves_baseline_and_workload(self):
        self.mocks["run_migration"].side_effect = ValueError("migration failed")
        with self.assertRaisesRegex(ValueError, "migration failed"):
            runtime.activate(
                self.state, SETTINGS, self.env, ops_image=self.target_image()
            )
        self.assertEqual(
            json.loads((self.state / "baseline.json").read_text()), self.baseline
        )
        self.assertNotIn("apply", self.events)
        self.assertFalse((self.state / runtime.PROFILE).exists())

    def test_applied_upgrade_can_be_explicitly_retried_after_diagnostics_failure(self):
        target = self.target_image()

        def execute(command, **kwargs):
            if "check_evaluation_runtime" in command:
                raise ValueError("runtime failed")
            return self.execute(command, **kwargs)

        self.mocks["run"].side_effect = execute
        with self.assertRaisesRegex(ValueError, "runtime failed"):
            runtime.activate(self.state, SETTINGS, self.env, ops_image=target)
        self.assertEqual(
            json.loads((self.state / "baseline.json").read_text()), self.baseline
        )
        self.assertFalse((self.state / runtime.PROFILE).exists())
        self.mocks["run"].side_effect = self.execute
        with self.assertRaisesRegex(ValueError, "baseline"):
            runtime.activate(self.state, SETTINGS, self.env)
        runtime.activate(self.state, SETTINGS, self.env, ops_image=target)
        self.assertEqual(
            json.loads((self.state / "baseline.json").read_text())["images"][
                "ops-service"
            ],
            target,
        )

    def test_mixed_api_sync_images_are_rejected_even_for_explicit_upgrade(self):
        target = self.target_image()
        containers = self.workload["spec"]["template"]["spec"]["containers"]
        containers.append(
            {**copy.deepcopy(containers[0]), "name": "ops-sync", "image": target}
        )
        with self.assertRaisesRegex(ValueError, "baseline"):
            runtime.activate(self.state, SETTINGS, self.env, ops_image=target)
        self.assertEqual(self.events, [])

    def test_invalid_target_tags_do_not_load_or_write(self):
        for image in (
            "other:tag",
            "govbiz-ops-service:latest",
            "ghcr.io/other/ops:tag",
        ):
            with (
                self.subTest(image=image),
                self.assertRaisesRegex(ValueError, "tagged local"),
            ):
                runtime.activate(self.state, SETTINGS, self.env, ops_image=image)
        self.mocks["load_image"].assert_not_called()
        self.assertEqual(self.events, [])


class ReleasePreflightTests(unittest.TestCase):
    def setUp(self):
        self.runner = {
            "Id": "runner-id",
            "Running": True,
            "Ports": {},
            "Labels": {
                "com.docker.compose.project": "fixture",
                "com.docker.compose.service": "evaluation-runner",
            },
        }
        self.identity = "sha256:" + "a" * 64
        self.digest = "b" * 64
        run = patch.object(runtime, "run", side_effect=["runner-id", self.identity])
        inspect = patch.object(
            ops_bridge, "inspect_container", return_value=self.runner
        )
        quiet = patch.object(
            runtime,
            "quiet",
            side_effect=[
                self.digest,
                json.dumps({"release": self.digest, "free": True}),
            ],
        )
        self.run, self.inspect, self.quiet = run.start(), inspect.start(), quiet.start()
        for patcher in (run, inspect, quiet):
            self.addCleanup(patcher.stop)

    def test_matching_free_release_uses_immutable_image_and_no_network(self):
        self.assertEqual(
            runtime.verify_release(IMAGE, "fixture"),
            {
                "imageId": self.identity,
                "runnerId": "runner-id",
                "releaseSha256": self.digest,
            },
        )
        command = self.quiet.call_args_list[0].args[0]
        self.assertIn(self.identity, command)
        self.assertIn("--network=none", command)
        self.assertIn("--read-only", command)
        self.assertIn("--pull=never", command)
        self.assertNotIn(IMAGE, command)

    def test_missing_or_multiple_runners_are_rejected(self):
        for identities in ("", "one two"):
            self.run.side_effect = None
            self.run.return_value = identities
            with (
                self.subTest(identities=identities),
                self.assertRaisesRegex(ValueError, "exactly one"),
            ):
                runtime.verify_release(IMAGE, "fixture")
        self.quiet.assert_not_called()

    def test_foreign_stopped_oneoff_or_published_runner_is_rejected(self):
        changes = (
            {"Running": False},
            {"Ports": {"8000/tcp": [{"HostPort": "8000"}]}},
            {
                "Labels": {
                    **self.runner["Labels"],
                    "com.docker.compose.project": "foreign",
                }
            },
            {"Labels": {**self.runner["Labels"], "com.docker.compose.oneoff": "true"}},
        )
        for change in changes:
            self.run.side_effect = ["runner-id"]
            self.inspect.return_value = {**self.runner, **change}
            with (
                self.subTest(change=change),
                self.assertRaisesRegex(ValueError, "ownership"),
            ):
                runtime.verify_release(IMAGE, "fixture")
        self.quiet.assert_not_called()

    def test_different_release_or_live_runner_is_rejected(self):
        for result in (
            {"release": "c" * 64, "free": True},
            {"release": self.digest, "free": False},
            {"release": self.digest},
        ):
            self.run.side_effect = ["runner-id", self.identity]
            self.quiet.side_effect = [self.digest, json.dumps(result)]
            with (
                self.subTest(result=result),
                self.assertRaisesRegex(ValueError, "releases differ"),
            ):
                runtime.verify_release(IMAGE, "fixture")


class ReadOnlyRuntimeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.state = Path(temporary.name)
        self.source = (
            self.state / "backend/ops-service/apps/evaluations/execution_release.json"
        )
        self.source.parent.mkdir(parents=True)
        self.source.write_text('{"version": 1}')
        self.digest = hashlib.sha256(self.source.read_bytes()).hexdigest()
        self.baseline = {"source": "local", "images": {"ops-service": IMAGE}}
        (self.state / "baseline.json").write_text(json.dumps(self.baseline))
        for name in (runtime.PROFILE, runtime.BRIDGE):
            (self.state / name).write_text(
                json.dumps(runtime.connection(SETTINGS, "fixture"))
            )
        self.deployment = {
            "metadata": {"uid": "deployment", "resourceVersion": "1"},
            "spec": {
                "replicas": 1,
                "selector": {"matchLabels": {"app": "ops"}},
                "template": {
                    "spec": {
                        "containers": [
                            {
                                "name": name,
                                "image": IMAGE,
                                "imagePullPolicy": "Never",
                                "env": [
                                    {"name": "LLMOPS_LIVE_ENABLED", "value": "false"}
                                ],
                            }
                            for name in ("ops-service", "ops-sync")
                        ]
                    }
                },
            },
        }
        self.pod = {
            "metadata": {
                "name": "ops-pod",
                "uid": "pod-uid",
                "ownerReferences": [
                    {
                        "kind": "ReplicaSet",
                        "name": "ops-rs",
                        "uid": "rs-uid",
                        "controller": True,
                    }
                ],
            },
            "spec": copy.deepcopy(self.deployment["spec"]["template"]["spec"]),
            "status": {
                "phase": "Running",
                "containerStatuses": [
                    {"name": name, "ready": True, "containerID": "containerd://" + name}
                    for name in ("ops-service", "ops-sync")
                ],
            },
        }
        self.replica = {
            "metadata": {
                "uid": "rs-uid",
                "ownerReferences": [
                    {"kind": "Deployment", "uid": "deployment", "controller": True}
                ],
            }
        }
        self.pods = [self.pod]
        self.latest_pod = self.pod
        self.latest_deployment = self.deployment
        self.deployment_reads = 0
        self.target_results = {
            name: {"release": self.digest, "free": True}
            for name in (
                "ops-service",
                "ops-sync",
                "evaluation-runner",
                "ops-artifacts",
            )
        }
        self.diagnostics = {
            "schema_ready": True,
            "runtime": {
                "status": "PASS",
                "storage_transport": "http",
                "result_artifact_verified": False,
            },
        }
        self.commands = []
        mocks = {
            "require_dev": {},
            "commands": {
                "return_value": (["kubectl"], ["kubectl", "-n", "fixture"], [])
            },
            "run": {"return_value": "Execution release verified"},
            "quiet": {"side_effect": self.execute},
            "evaluation_runner": {"return_value": {"Id": "runner-id"}},
            "REPOSITORY_ROOT": {"new": self.state},
        }
        self.mocks = {}
        for name, options in mocks.items():
            patcher = patch.object(runtime, name, **options)
            self.mocks[name] = patcher.start()
            self.addCleanup(patcher.stop)
        patcher = patch.object(ops_bridge, "connect")
        self.connect = patcher.start()
        self.addCleanup(patcher.stop)
        patcher = patch.object(
            ops_bridge,
            "topology",
            return_value={"containers": {"ops-artifacts": "artifact-id"}},
        )
        self.topology = patcher.start()
        self.addCleanup(patcher.stop)

    def execute(self, command, data=None):
        self.commands.append(command)
        self.assertIsNone(data)
        self.assertFalse(
            set(command) & {"apply", "patch", "create", "delete", "migrate", "run"}
        )
        if "get" in command:
            kind = command[command.index("get") + 1]
            if kind == "deployment":
                self.deployment_reads += 1
                if self.deployment_reads % 2 == 0:
                    return json.dumps(self.latest_deployment)
            return json.dumps(
                {
                    "deployment": self.deployment,
                    "pods": {"items": self.pods},
                    "pod": self.latest_pod,
                    "replicaset": self.replica,
                }[kind]
            )
        if "schema_is_ready" in command[-1]:
            return json.dumps(self.diagnostics)
        name = (
            ("evaluation-runner" if command[2] == "runner-id" else "ops-artifacts")
            if command[0] == "docker"
            else command[command.index("-c") + 1]
        )
        return json.dumps(self.target_results[name])

    def check(self, run_id=None):
        return runtime.check_runtime(self.state, SETTINGS, run_id)

    def test_matching_runtime_reads_all_components_without_mutations_or_artifact_env(
        self,
    ):
        before = {
            path: path.read_bytes() for path in self.state.rglob("*") if path.is_file()
        }
        # Kubernetes may inject a service account mount into a Pod.
        self.pod["spec"]["containers"][0]["volumeMounts"] = [
            {
                "name": "kube-api-access",
                "mountPath": "/var/run/secrets/kubernetes.io/serviceaccount",
                "readOnly": True,
            }
        ]
        result = self.check()
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(
            result["checked_components"],
            ["ops-service", "ops-sync", "evaluation-runner", "ops-artifacts"],
        )
        self.assertEqual(result["release_sha256"], self.digest)
        self.assertFalse(result["evaluation_executed"])
        self.assertFalse(result["core_admin_auth_verified"])
        self.assertEqual(
            before,
            {
                path: path.read_bytes()
                for path in self.state.rglob("*")
                if path.is_file()
            },
        )
        self.assertTrue(
            all(call.kwargs["check"] is True for call in self.connect.call_args_list)
        )
        self.assertNotIn("--write", self.mocks["run"].call_args.args[0])

    def test_existing_run_is_only_read_by_runtime_diagnostics(self):
        run_id = UUID("7f5ea1ca-6c60-4bca-a6a3-8af661a241c6")
        self.diagnostics["runtime"]["result_artifact_verified"] = True
        result = self.check(run_id)
        command = next(
            command for command in self.commands if "schema_is_ready" in command[-1]
        )
        self.assertIn("inspect_runtime('" + str(run_id) + "')", command[-1])
        self.assertTrue(result["runtime"]["result_artifact_verified"])

    def test_source_must_have_an_up_to_date_execution_manifest(self):
        self.mocks["run"].side_effect = ValueError("stale source release")
        with self.assertRaisesRegex(ValueError, "stale source"):
            self.check()
        self.assertEqual(self.commands, [])

    def test_each_outdated_component_is_rejected_without_diagnostics(self):
        for name in self.target_results:
            with self.subTest(component=name):
                self.commands.clear()
                self.target_results[name]["release"] = "0" * 64
                with self.assertRaisesRegex(ValueError, "differs.*" + name):
                    self.check()
                self.assertFalse(
                    any("schema_is_ready" in command[-1] for command in self.commands)
                )
                self.target_results[name]["release"] = self.digest

    def test_api_sync_and_runner_must_remain_free_only(self):
        for name in ("ops-service", "ops-sync", "evaluation-runner"):
            with self.subTest(component=name):
                self.target_results[name]["free"] = False
                with self.assertRaisesRegex(ValueError, "not free-only: " + name):
                    self.check()
                self.target_results[name]["free"] = True
        self.target_results["ops-artifacts"]["free"] = False
        self.assertEqual(self.check()["status"], "PASS")

    def test_unready_schema_or_failed_diagnostics_or_filesystem_transport_is_rejected(
        self,
    ):
        for change in (
            {"schema_ready": False},
            {"runtime": {"status": "FAIL", "storage_transport": "http"}},
            {"runtime": {"status": "PASS", "storage_transport": "filesystem"}},
        ):
            with self.subTest(change=change):
                original = self.diagnostics
                self.diagnostics = {**original, **change}
                with self.assertRaisesRegex(ValueError, "schema or evaluation"):
                    self.check()
                self.diagnostics = original

    def test_no_or_multiple_or_terminating_pods_are_rejected(self):
        for pods in ([], [self.pod, self.pod]):
            self.pods = pods
            with self.assertRaisesRegex(ValueError, "one stable"):
                self.check()
        self.pods = [self.pod]
        self.pod["metadata"]["deletionTimestamp"] = "now"
        with self.assertRaisesRegex(ValueError, "lifecycle"):
            self.check()

    def test_replica_owned_by_another_deployment_is_rejected(self):
        self.replica["metadata"]["ownerReferences"][0]["uid"] = "foreign"
        with self.assertRaisesRegex(ValueError, "another Deployment"):
            self.check()

    def test_old_pod_image_or_unready_sync_is_rejected(self):
        self.pod["spec"]["containers"][0]["image"] = "govbiz-ops-service:old"
        with self.assertRaisesRegex(ValueError, "not ready"):
            self.check()
        self.pod["spec"]["containers"][0]["image"] = IMAGE
        self.pod["status"]["containerStatuses"][1]["ready"] = False
        with self.assertRaisesRegex(ValueError, "not ready"):
            self.check()

    def test_baseline_mismatch_or_argo_label_is_rejected(self):
        self.deployment["spec"]["template"]["spec"]["containers"][0]["image"] = (
            "govbiz-ops-service:other"
        )
        with self.assertRaisesRegex(ValueError, "baseline"):
            self.check()
        self.deployment["spec"]["template"]["spec"]["containers"][0]["image"] = IMAGE
        self.deployment["metadata"]["labels"] = {
            "argocd.argoproj.io/instance": "owned-elsewhere"
        }
        with self.assertRaisesRegex(ValueError, "baseline"):
            self.check()

    def test_pod_replacement_or_container_restart_during_check_is_rejected(self):
        self.latest_pod = copy.deepcopy(self.pod)
        self.latest_pod["metadata"]["uid"] = "replacement"
        with self.assertRaisesRegex(ValueError, "changed during"):
            self.check()
        self.latest_pod = copy.deepcopy(self.pod)
        self.latest_pod["status"]["containerStatuses"][0]["containerID"] = "restarted"
        with self.assertRaisesRegex(ValueError, "changed during"):
            self.check()

    def test_deployment_replacement_or_pod_termination_during_check_is_rejected(self):
        self.latest_deployment = copy.deepcopy(self.deployment)
        self.latest_deployment["metadata"]["uid"] = "replacement"
        with self.assertRaisesRegex(ValueError, "changed during"):
            self.check()
        self.latest_deployment = self.deployment
        self.latest_pod = copy.deepcopy(self.pod)
        self.latest_pod["metadata"]["deletionTimestamp"] = "now"
        with self.assertRaisesRegex(ValueError, "changed during"):
            self.check()

    def test_runner_replacement_or_network_change_during_check_is_rejected(self):
        self.mocks["evaluation_runner"].side_effect = [
            {"Id": "runner-id"},
            {"Id": "replacement"},
        ]
        with self.assertRaisesRegex(ValueError, "changed during"):
            self.check()
        self.mocks["evaluation_runner"].side_effect = None
        self.topology.side_effect = [
            {"containers": {"ops-artifacts": "artifact-id"}},
            {"containers": {"ops-artifacts": "replacement"}},
        ]
        with self.assertRaisesRegex(ValueError, "changed during"):
            self.check()

    def test_other_active_project_is_rejected_before_any_resource_read(self):
        (self.state / runtime.PROFILE).write_text(
            json.dumps(runtime.connection(SETTINGS, "other"))
        )
        with self.assertRaisesRegex(ValueError, "projects differ"):
            self.check()
        self.assertEqual(self.commands, [])

    def test_check_cli_does_not_require_artifact_credentials(self):
        from contextlib import nullcontext, redirect_stdout
        from io import StringIO

        with (
            patch(
                "sys.argv",
                [
                    "ops_runtime.py",
                    "--check",
                    "--run-id",
                    "7f5ea1ca-6c60-4bca-a6a3-8af661a241c6",
                ],
            ),
            patch.object(runtime, "load_settings", return_value=SETTINGS),
            patch.object(runtime, "locked", return_value=nullcontext()),
            patch.object(
                runtime, "check_runtime", return_value={"status": "PASS"}
            ) as check,
            patch.object(runtime, "activate") as activate,
            redirect_stdout(StringIO()),
        ):
            runtime.main()
        self.assertEqual(
            check.call_args.args[2], UUID("7f5ea1ca-6c60-4bca-a6a3-8af661a241c6")
        )
        activate.assert_not_called()

    def test_check_cli_rejects_activation_inputs(self):
        from contextlib import redirect_stderr
        from io import StringIO

        for args in (
            ["--check", "--artifact-env", "secret.env"],
            ["--check", "--ops-image", IMAGE],
            [
                "--run-id",
                "7f5ea1ca-6c60-4bca-a6a3-8af661a241c6",
                "--artifact-env",
                "secret.env",
            ],
            [],
        ):
            with (
                self.subTest(args=args),
                patch("sys.argv", ["ops_runtime.py", *args]),
                self.assertRaises(SystemExit),
                redirect_stderr(StringIO()),
            ):
                runtime.main()


if __name__ == "__main__":
    unittest.main()
