"""Offline Ops sync placement, configuration guards and paired image recovery."""

import copy
import io
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import deployment_candidate
import dev
import fork_cluster
import yaml
from check_msa import policy_errors, render

CONNECTED = {
    "opsSync": {"enabled": True},
    "env": {
        "PREFECT_API_URL": "http://prefect.internal:4200/api",
        "LLMOPS_ARTIFACT_URL": "http://artifacts.internal:8010",
    },
    "secretKeys": ["DJANGO_SECRET_KEY", "DB_PASSWORD", "LLMOPS_ARTIFACT_TOKEN"],
}


def connected_render(values=None, service="ops-service"):
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "connected.yaml"
        path.write_text(yaml.safe_dump(CONNECTED if values is None else values))
        return render(service, extra=("-f", str(path)))


def pod(resources, kind="Deployment"):
    return next(item for item in resources if item["kind"] == kind)["spec"]["template"][
        "spec"
    ]


class OpsSyncChartTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.resources = connected_render()

    def test_default_keeps_disconnected_ops_single_container(self):
        objects = render("ops-service")
        self.assertEqual(len(pod(objects)["containers"]), 1)
        self.assertEqual(
            policy_errors("ops-service", objects, ops_sync_enabled=False), []
        )
        self.assertTrue(policy_errors("ops-service", objects, ops_sync_enabled=True))

    def test_worker_shares_api_db_image_and_secrets_without_entering_migration_job(
        self,
    ):
        self.assertEqual(
            policy_errors("ops-service", self.resources, ops_sync_enabled=True), []
        )
        containers = pod(self.resources)["containers"]
        self.assertEqual(
            [item["name"] for item in containers], ["ops-service", "ops-sync"]
        )
        api, worker = containers
        for key in (
            "image",
            "imagePullPolicy",
            "env",
            "securityContext",
            "resources",
            "volumeMounts",
        ):
            self.assertEqual(api[key], worker[key])
        self.assertEqual(
            worker["command"], ["python", "manage.py", "sync_evaluations", "--watch"]
        )
        self.assertFalse(
            set(worker) & {"ports", "startupProbe", "readinessProbe", "livenessProbe"}
        )
        self.assertEqual(len(pod(self.resources, "Job")["containers"]), 1)
        self.assertEqual(
            pod(self.resources, "Job")["containers"][0]["name"], "ops-migrate"
        )
        self.assertEqual([item["kind"] for item in self.resources].count("Service"), 1)
        self.assertTrue(
            policy_errors("ops-service", self.resources, ops_sync_enabled=False)
        )

    def test_private_registry_digest_and_pull_secret_apply_to_both_containers(self):
        values = copy.deepcopy(CONNECTED)
        values.update(
            localMode=False,
            imagePullSecrets=[{"name": "ghcr-pull"}],
            image={
                "repository": "ghcr.io/alice/project-ops-service",
                "digest": "sha256:" + "a" * 64,
                "tag": "",
                "pullPolicy": "IfNotPresent",
            },
        )
        objects = connected_render(values)
        self.assertEqual(
            policy_errors("ops-service", objects, ops_sync_enabled=True), []
        )
        self.assertEqual(pod(objects)["imagePullSecrets"], [{"name": "ghcr-pull"}])
        self.assertEqual(
            {item["image"] for item in pod(objects)["containers"]},
            {"ghcr.io/alice/project-ops-service@sha256:" + "a" * 64},
        )

    def test_missing_token_wrong_service_and_non_boolean_enable_are_rejected(self):
        for change, service in (
            ({"secretKeys": ["DJANGO_SECRET_KEY", "DB_PASSWORD"]}, "ops-service"),
            ({"secretName": "core-runtime"}, "ops-service"),
            ({"opsSync": {"enabled": "false"}}, "ops-service"),
            ({}, "core-service"),
        ):
            with self.subTest(change=change, service=service):
                values = copy.deepcopy(CONNECTED)
                values.update(change)
                with self.assertRaises(subprocess.CalledProcessError):
                    connected_render(values, service)

    def test_absent_placeholder_loopback_and_credential_urls_are_rejected(self):
        for key in ("PREFECT_API_URL", "LLMOPS_ARTIFACT_URL"):
            for url in (
                "",
                "http://disabled-prefect.invalid/api",
                "http://localhost:4200/api",
                "http://127.0.0.1:8010",
                "http://[::1]:8010",
                "ftp://remote/path",
                "http://user:password@remote",
                "http://remote?token=value",
                "http://remote/#fragment",
                "http://bad host/path",
            ):
                with self.subTest(key=key, url=url):
                    values = copy.deepcopy(CONNECTED)
                    values["env"][key] = url
                    with self.assertRaises(subprocess.CalledProcessError):
                        connected_render(values)

    def test_worker_drift_and_extra_containers_are_rejected_by_rendered_policy(self):
        for changes in (
            {"name": "other"},
            {"image": "different:local"},
            {"env": []},
            {"imagePullPolicy": "Always"},
            {"command": ["python", "manage.py", "shell"]},
            {"securityContext": {}},
            {"resources": {}},
            {"volumeMounts": []},
            {"readinessProbe": {"exec": {"command": ["true"]}}},
        ):
            with self.subTest(changes=changes):
                objects = copy.deepcopy(self.resources)
                pod(objects)["containers"][1].update(changes)
                self.assertTrue(policy_errors("ops-service", objects))
        objects = copy.deepcopy(self.resources)
        pod(objects)["containers"].append(copy.deepcopy(pod(objects)["containers"][1]))
        self.assertTrue(policy_errors("ops-service", objects))

    def test_policy_rechecks_connection_and_secret_after_rendering(self):
        for key, value in (
            ("PREFECT_API_URL", "http://disabled-prefect.invalid/api"),
            ("LLMOPS_ARTIFACT_URL", ""),
            ("LLMOPS_ARTIFACT_URL", "http://remote:bad"),
            ("LLMOPS_ARTIFACT_TOKEN", "inline-secret"),
        ):
            with self.subTest(key=key):
                objects = copy.deepcopy(self.resources)
                for container in pod(objects)["containers"]:
                    env = next(item for item in container["env"] if item["name"] == key)
                    env.clear()
                    env.update(name=key, value=value)
                self.assertTrue(policy_errors("ops-service", objects))


class OpsSyncBootstrapTests(unittest.TestCase):
    def test_local_image_preflight_accepts_explicit_connected_overlay(self):
        images = {
            service: "govbiz-" + service + ":fixture"
            for service in fork_cluster.SERVICES
        }
        rendered = fork_cluster.render_services(
            "helm", images, overlay={"ops-service": CONNECTED}
        )
        objects = list(yaml.safe_load_all(rendered["ops-service"]))
        self.assertEqual(
            policy_errors("ops-service", objects, ops_sync_enabled=True), []
        )
        self.assertEqual(
            {item["image"] for item in pod(objects)["containers"]},
            {"govbiz-ops-service:fixture"},
        )

    def test_published_render_requires_the_worker_selected_by_source_values(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shutil.copytree(
                fork_cluster.ROOT / "charts/govbiz-service",
                root / "charts/govbiz-service",
            )
            target = root / "environments/fork"
            target.mkdir(parents=True)
            for service in fork_cluster.SERVICES:
                values = yaml.safe_load(
                    (
                        fork_cluster.ROOT / f"environments/portfolio/{service}.yaml"
                    ).read_text()
                )
                if service == "ops-service":
                    values["env"].update(CONNECTED["env"])
                    values.update(
                        {key: value for key, value in CONNECTED.items() if key != "env"}
                    )
                (target / (service + ".yaml")).write_text(yaml.safe_dump(values))
            rendered = deployment_candidate.render(root)
            self.assertEqual(
                len(pod(json.loads(rendered["ops-service"]))["containers"]), 2
            )
            execute = subprocess.check_output

            def omit_worker(command, **kwargs):
                output = execute(command, **kwargs)
                if command[1:3] == ["template", "ops-service"]:
                    objects = list(yaml.safe_load_all(output))
                    pod(objects)["containers"].pop()
                    return yaml.safe_dump_all(objects)
                return output

            with (
                patch(
                    "deployment_candidate.subprocess.check_output",
                    side_effect=omit_worker,
                ),
                self.assertRaisesRegex(ValueError, "Ops sync container does not match"),
            ):
                deployment_candidate.render(root)


class OpsSyncDevTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.state = Path(directory.name)
        self.settings = {
            "repository": "alice/project",
            "cluster": "govbiz-fixture",
            "namespace": "govbiz-msa",
            "mode": "dev",
            "platform": "linux/amd64",
        }
        self.original = "ghcr.io/alice/ops@sha256:" + "1" * 64
        self.containers = [
            {"name": name, "image": self.original, "imagePullPolicy": "IfNotPresent",
             "env": [{"name": "PREFECT_API_URL", "value": "http://disabled-prefect.invalid/api"}]}
            for name in ("ops-service", "ops-sync")
        ]
        self.calls = []
        self.fail_rollouts = 0
        self.metadata = {}
        for patcher in (
            patch("dev.run", side_effect=self.execute),
            patch("dev.require_dev"),
            patch("dev.load_settings", return_value=self.settings),
            patch("dev.snapshot", return_value="fingerprint"),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def execute(self, command, **kwargs):
        command = [str(item) for item in command]
        self.calls.append(command)
        if command[:2] == ["docker", "version"]:
            return "linux/amd64"
        if command[0] in {"docker", "kind"}:
            return ""
        if "get" in command:
            return json.dumps(
                {
                    "metadata": self.metadata,
                    "spec": {"template": {"spec": {"containers": self.containers}}},
                }
            )
        if "set" in command:
            values = dict(
                item.split("=", 1)
                for item in command[command.index("deployment/ops-service") + 1 :]
            )
            self.assertEqual(set(values), {"ops-service", "ops-sync"})
            self.assertEqual(len(set(values.values())), 1)
            for container in self.containers:
                container["image"] = values[container["name"]]
            return ""
        if "rollout" in command:
            if self.fail_rollouts:
                self.fail_rollouts -= 1
                raise subprocess.CalledProcessError(1, command)
            return ""
        raise AssertionError(command)

    def sync(self):
        return dev.sync_service(self.state, self.state, self.settings, "ops-service")

    def test_connected_runtime_cannot_build_or_restore_through_watcher(self):
        self.sync()
        before = (self.state / "dev-images.json").read_text()
        self.containers[0]["env"][0]["value"] = "http://ops-compose-prefect:4200/api"
        self.calls.clear()
        with self.assertRaisesRegex(ValueError, "ops_runtime.py"):
            self.sync()  # Even the unchanged-source shortcut must not bypass this guard.
        with self.assertRaisesRegex(ValueError, "ops_runtime.py"):
            dev.restore(self.state, self.settings, ("ops-service",))
        self.assertEqual((self.state / "dev-images.json").read_text(), before)
        self.assertFalse(any("build" in call or "set" in call for call in self.calls))

    def test_activation_record_blocks_even_if_prefect_appears_disabled(self):
        (self.state / "ops-activation.json").write_text("{}")
        with self.assertRaisesRegex(ValueError, "ops_runtime.py"):
            self.sync()
        self.assertFalse(any("build" in call or "set" in call for call in self.calls))
        self.assertFalse((self.state / "dev-images.json").exists())

    def test_connection_enabled_during_build_stops_before_image_change_or_ledger(self):
        def activated(state):
            self.containers[1]["env"][0]["value"] = "http://ops-compose-prefect:4200/api"
            return self.settings

        with patch("dev.load_settings", side_effect=activated), self.assertRaisesRegex(ValueError, "ops_runtime.py"):
            self.sync()
        self.assertFalse(any("set" in call for call in self.calls))
        self.assertEqual({item["image"] for item in self.containers}, {self.original})
        self.assertFalse((self.state / "dev-images.json").exists())

    def test_watch_all_rejects_connected_ops_before_updating_other_services(self):
        self.containers[0]["env"][0]["value"] = "http://ops-compose-prefect:4200/api"
        with patch("dev.sync_service") as sync, self.assertRaisesRegex(ValueError, "ops_runtime.py"):
            dev.watch(self.state, self.state, self.settings, ("core-service", "ops-service"))
        sync.assert_not_called()

    def test_once_all_rejects_connected_ops_before_updating_other_services(self):
        self.containers[0]["env"][0]["value"] = "http://ops-compose-prefect:4200/api"
        with (
            patch("sys.argv", ["dev.py", "--once", "--state-dir", str(self.state)]),
            patch("dev.sys.platform", "linux"),
            patch("sys.stderr", new_callable=io.StringIO) as output,
            patch("dev.sync_service") as sync,
        ):
            self.assertEqual(dev.main(), 1)
        self.assertIn("ops_runtime.py", output.getvalue())
        sync.assert_not_called()

    def test_update_and_restore_change_both_images_in_one_mutation(self):
        self.assertTrue(self.sync())
        self.assertEqual(len([call for call in self.calls if "set" in call]), 1)
        self.assertNotEqual(self.containers[0]["image"], self.original)
        self.assertFalse(self.sync())
        dev.restore(self.state, self.settings, ("ops-service",))
        self.assertEqual(len([call for call in self.calls if "set" in call]), 2)
        self.assertEqual({item["image"] for item in self.containers}, {self.original})
        self.assertFalse((self.state / "dev-images.json").exists())

    def test_failed_rollout_restores_both_images_and_reports_failure(self):
        self.fail_rollouts = 1
        with self.assertRaises(subprocess.CalledProcessError):
            self.sync()
        self.assertEqual(len([call for call in self.calls if "set" in call]), 2)
        self.assertEqual({item["image"] for item in self.containers}, {self.original})
        self.assertEqual(dev.read_ledger(self.state, self.settings)["images"], {})

    def test_mismatched_worker_image_prevents_build_or_restore(self):
        self.sync()
        self.containers[1]["image"] = "changed-outside-watcher:local"
        self.calls.clear()
        with self.assertRaisesRegex(ValueError, "images differ"):
            self.sync()
        with self.assertRaisesRegex(ValueError, "images differ"):
            dev.restore(self.state, self.settings, ("ops-service",))
        self.assertFalse(any("build" in call or "set" in call for call in self.calls))
        self.assertTrue((self.state / "dev-images.json").is_file())

    def test_unknown_container_pull_policy_or_argo_tracking_prevents_mutation(self):
        for changes in ({"name": "other"}, {"imagePullPolicy": "Always"}):
            original = copy.deepcopy(self.containers)
            self.containers[1].update(changes)
            with self.assertRaises(ValueError):
                self.sync()
            self.containers = original
        self.metadata = {"annotations": {"argocd.argoproj.io/tracking-id": "owned"}}
        with self.assertRaisesRegex(ValueError, "Argo CD tracks"):
            self.sync()
        self.assertFalse(any("build" in call or "set" in call for call in self.calls))


if __name__ == "__main__":
    unittest.main()
