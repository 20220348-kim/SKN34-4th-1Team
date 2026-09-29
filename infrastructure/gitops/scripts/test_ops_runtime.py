"""Connection activation must preserve credentials and refuse mixed environments."""

import base64
import copy
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

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
            "metadata": {},
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


if __name__ == "__main__":
    unittest.main()
