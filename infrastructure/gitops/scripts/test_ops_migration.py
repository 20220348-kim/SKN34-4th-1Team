"""Free checks for the required Ops hook and fail-closed local execution."""

import copy
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import yaml

import fork_cluster as cluster
from check_msa import policy_errors, render
from deployment_candidate import argo_resources
from ops_migration import run_migration
from repository import Fork


class OpsMigrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.resources = render("ops-service")
        cls.job = next(item for item in cls.resources if item["kind"] == "Job")

    def test_only_ops_hook_uses_same_image_and_runtime_security(self):
        self.assertEqual(policy_errors("ops-service", self.resources), [])
        for mutate in (
            lambda job: job["spec"].update(backoffLimit=1),
            lambda job: job["spec"].update(activeDeadlineSeconds=0),
            lambda job: job["metadata"]["annotations"].update(
                {"argocd.argoproj.io/hook": "PostSync"}
            ),
            lambda job: job["metadata"]["annotations"].update(
                {"argocd.argoproj.io/hook-delete-policy": "HookFailed"}
            ),
            lambda job: job["spec"]["template"]["spec"].update(
                automountServiceAccountToken=True
            ),
            lambda job: job["spec"]["template"]["spec"]["containers"][0].update(
                image="unverified:tag"
            ),
            lambda job: job["spec"]["template"]["spec"]["containers"][0].update(
                command=["python", "manage.py", "migrate", "--fake"]
            ),
            lambda job: job["spec"]["template"]["spec"]["containers"][0].update(env=[]),
            lambda job: job["spec"]["template"]["spec"]["containers"][0].update(
                resources={}
            ),
        ):
            objects = copy.deepcopy(self.resources)
            mutate(next(item for item in objects if item["kind"] == "Job"))
            with self.subTest(mutate=mutate):
                self.assertTrue(policy_errors("ops-service", objects))
        without_job = [item for item in self.resources if item["kind"] != "Job"]
        self.assertTrue(policy_errors("ops-service", without_job))
        self.assertEqual(
            policy_errors("ops-service", without_job, require_ops_migration=False), []
        )
        self.assertTrue(
            policy_errors("core-service", render("core-service") + [self.job])
        )
        apps = argo_resources(Fork("alice/project"))
        ops = next(
            app for app in apps if app["metadata"]["name"] == "govbiz-fork-ops-service"
        )
        self.assertEqual(ops["spec"]["syncPolicy"]["retry"]["limit"], 0)

    def test_success_deletes_completed_job_but_failure_or_existing_job_is_preserved(
        self,
    ):
        kube = ["kubectl", "--context", "fixture"]
        nk = kube + ["--namespace", "govbiz-msa"]
        execute = Mock(return_value="")
        run_migration(self.job, kube, nk, execute)
        commands = [call.args[0] for call in execute.call_args_list]
        self.assertIn("create", commands[1])
        self.assertIn("--for=condition=complete", commands[2])
        self.assertIn("delete", commands[3])
        self.assertEqual(
            yaml.safe_load(execute.call_args_list[1].kwargs["data"]), self.job
        )
        for results, count in (
            (["existing"], 1),
            (["", None, RuntimeError("failed")], 3),
        ):
            execute = Mock(side_effect=results)
            with (
                self.subTest(results=results),
                self.assertRaises((ValueError, RuntimeError)),
            ):
                run_migration(self.job, kube, nk, execute)
            self.assertEqual(execute.call_count, count)
            self.assertFalse(
                any("delete" in call.args[0] for call in execute.call_args_list)
            )

    def test_failed_migration_stops_bootstrap_before_any_app_apply(self):
        settings = cluster.initial_settings(Fork("alice/project"))
        images = {
            service: "govbiz-" + service + ":fixture" for service in cluster.SERVICES
        }
        rendered = {
            service: yaml.safe_dump_all(render(service)) for service in cluster.SERVICES
        }
        args = SimpleNamespace(helm="helm", kind="kind", local_images=Path("fixture"))
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            (state / "kubeconfig").touch()

            def execute(command, **kwargs):
                if command[:3] == ["kind", "get", "clusters"]:
                    return settings["cluster"]
                if "get" in command and "secrets" in command:
                    return " ".join(cluster.RUNTIME_SECRETS)
                return ""

            with (
                patch.object(cluster, "doctor"),
                patch("connected_runtime.load_profile", return_value=None),
                patch.object(cluster, "local_images", return_value=images),
                patch.object(cluster, "render_services", return_value=rendered),
                patch.object(cluster, "require_dev"),
                patch.object(cluster, "verify_context"),
                patch.object(cluster, "load_image"),
                patch.object(cluster, "elasticsearch_image", return_value="fixture:es"),
                patch.object(cluster, "run", side_effect=execute) as run,
                patch(
                    "ops_migration.run_migration",
                    side_effect=ValueError("migration failed"),
                ),
                self.assertRaisesRegex(ValueError, "migration failed"),
            ):
                cluster._up(args, state, settings)
            for call in run.call_args_list:
                self.assertNotIn("kind: Deployment", call.kwargs.get("data", ""))
            self.assertFalse((state / "baseline.json").exists())


if __name__ == "__main__":
    unittest.main()
