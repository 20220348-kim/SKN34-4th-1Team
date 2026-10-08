"""Dormant Argo creation, interrupted retries and conflict handling without a cluster."""

import copy
import io
import json
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

import evaluation_release as release
from repository import Fork
from test_evaluation_chart import bundle


class EvaluationRegistrationTests(unittest.TestCase):
    def setUp(self):
        self.fork = Fork("fixture/project")
        values = bundle()
        for value in values.values():
            value["replicas"] = 0
        resources = release.argo_plan(self.fork, "a" * 40, values)
        self.plan = {
            "schema": "evaluation-gitops-plan-v1",
            "status": "PLANNED",
            "resources": resources,
            "resourcesSha256": release.digest(release.encoded(resources)),
            "retainedStorage": {"namespace_uid": "restored-namespace-uid"},
            "restoreReportSha256": "b" * 64,
            "clusterChanged": False,
            "runtimeVerified": False,
            "deploymentAuthorized": False,
        }
        self.settings = {"mode": "gitops"}
        self.objects = {}
        self.commands = []
        self.progress = {"creationAttempts": [], "created": []}
        self.failure = None
        self.admission_mutation = None
        self.uid = 0
        self.planner = self.enterContext(
            patch.object(
                release,
                "plan_from_restore",
                side_effect=lambda *a, **k: copy.deepcopy(self.plan),
            )
        )
        self.enterContext(
            patch.object(
                release.fork_cluster, "load_settings", return_value=self.settings
            )
        )
        self.enterContext(
            patch.object(
                release.fork_cluster,
                "commands",
                return_value=(["kubectl"], [], ["kubectl", "-n", "argocd"]),
            )
        )
        self.context = self.enterContext(
            patch.object(release.fork_cluster, "verify_context")
        )
        self.enterContext(
            patch.object(release.pvc_restore, "run", side_effect=self.run_command)
        )

    def run_command(self, command, *, value=None, **options):
        self.commands.append((command, copy.deepcopy(value)))
        if "get" in command:
            if "applications.argoproj.io" in command:
                return {
                    "items": copy.deepcopy(
                        [v for k, v in self.objects.items() if k[0] == "Application"]
                    )
                }
            self.assertIn("appproject", command)
            return copy.deepcopy(self.objects.get(("AppProject", release.PROJECT)))
        self.assertIn("create", command)
        self.assertEqual(set(value), {"apiVersion", "kind", "metadata", "spec"})
        key = (value["kind"], value["metadata"]["name"])
        if "--dry-run=server" in command:
            admitted = copy.deepcopy(value)
            if self.admission_mutation:
                self.admission_mutation(admitted)
            return admitted
        self.assertNotIn(key, self.objects)
        self.uid += 1
        actual = copy.deepcopy(value)
        actual["metadata"]["uid"] = "uid-" + str(self.uid)
        self.objects[key] = actual
        if self.failure:
            self.failure(actual)
        return copy.deepcopy(actual)

    def register(self):
        return release.register_from_restore(
            "root",
            self.fork,
            state="state",
            restore_report="restore.json",
            progress=self.progress,
            langfuse_url="http://langfuse:3000",
        )

    def writes(self):
        return [
            value
            for command, value in self.commands
            if "create" in command and "--dry-run=server" not in command
        ]

    def test_creates_only_four_dormant_argo_objects_and_retries_without_writes(self):
        result = self.register()
        self.assertEqual(result["status"], "REGISTERED_NOT_SYNCED")
        self.assertTrue(result["clusterChanged"])
        self.assertEqual(len(result["registeredResources"]), 4)
        self.assertEqual(
            [row["kind"] for row in self.writes()],
            ["AppProject", "Application", "Application", "Application"],
        )
        self.assertEqual(self.planner.call_count, 3)
        for row in self.writes()[1:]:
            self.assertIs(row["spec"]["syncPolicy"]["automated"]["enabled"], False)
            self.assertEqual(
                row["spec"]["source"]["helm"]["valuesObject"]["replicas"], 0
            )
            self.assertNotIn("finalizers", row["metadata"])
        for key in (
            "syncRequested",
            "runtimeStarted",
            "runtimeVerified",
            "deploymentAuthorized",
        ):
            self.assertIs(result[key], False)
        self.commands.clear()
        self.progress = {"creationAttempts": [], "created": []}
        repeated = self.register()
        self.assertFalse(repeated["clusterChanged"])
        self.assertEqual(repeated["registeredResources"], result["registeredResources"])
        self.assertEqual(self.writes(), [])

    def test_response_loss_reports_attempt_and_resumes_created_resource(self):
        def lose_response(actual):
            raise TimeoutError("private endpoint credentials")

        self.failure = lose_response
        with self.assertRaises(TimeoutError):
            self.register()
        self.assertEqual(len(self.progress["creationAttempts"]), 1)
        self.assertEqual(self.progress["created"], [])
        retained_uid = self.objects[("AppProject", release.PROJECT)]["metadata"]["uid"]
        self.failure = None
        self.commands.clear()
        self.progress = {"creationAttempts": [], "created": []}
        self.register()
        self.assertEqual(len(self.writes()), 3)
        self.assertEqual(
            self.objects[("AppProject", release.PROJECT)]["metadata"]["uid"],
            retained_uid,
        )

    def test_collisions_or_synchronized_resources_block_before_writing(self):
        self.register()
        original = copy.deepcopy(self.objects)
        key = ("Application", release.PROJECT + "-prefect")
        mutations = (
            lambda row: row["metadata"].pop("annotations"),
            lambda row: row["metadata"].update(
                finalizers=["resources-finalizer.argocd.argoproj.io"]
            ),
            lambda row: row["metadata"].update(ownerReferences=[{"uid": "foreign"}]),
            lambda row: row["metadata"].update(deletionTimestamp="now"),
            lambda row: row["spec"]["syncPolicy"]["automated"].update(enabled=True),
            lambda row: row["spec"]["source"]["helm"]["valuesObject"].update(
                replicas=1
            ),
            lambda row: row.update(operation={"sync": {}}),
            lambda row: row.update(status={"operationState": {"phase": "Succeeded"}}),
            lambda row: row.update(status={"history": [{"id": 0}]}),
        )
        for mutate in mutations:
            self.objects = copy.deepcopy(original)
            mutate(self.objects[key])
            self.commands.clear()
            with self.subTest(mutate=mutate), self.assertRaises(ValueError):
                self.register()
            self.assertEqual(self.writes(), [])

    def test_other_application_cannot_own_evaluation_namespace_or_project(self):
        for spec in (
            {"project": release.PROJECT},
            {"destination": {"namespace": release.NAMESPACE}},
        ):
            self.objects = {
                ("Application", "foreign"): {
                    "metadata": {"name": "foreign", "namespace": "argocd"},
                    "spec": spec,
                }
            }
            with (
                self.subTest(spec=spec),
                self.assertRaisesRegex(ValueError, "another Argo owner"),
            ):
                self.register()
            self.assertEqual(self.writes(), [])

    def test_admission_changes_fail_before_creation(self):
        self.admission_mutation = lambda row: row["spec"].update(sourceRepos=["*"])
        with self.assertRaises(ValueError):
            self.register()
        self.assertEqual(self.writes(), [])

    def test_dev_mode_or_cluster_identity_error_cannot_write(self):
        self.settings["mode"] = "dev"
        with self.assertRaisesRegex(ValueError, "GitOps mode"):
            self.register()
        self.assertEqual(self.commands, [])
        self.settings["mode"] = "gitops"
        self.context.side_effect = ValueError("ownership mismatch")
        with self.assertRaises(ValueError):
            self.register()
        self.assertEqual(self.writes(), [])

    def test_new_source_ci_or_storage_failure_prevents_write_or_reports_partial_state(
        self,
    ):
        for when in (0, 1, 2):
            self.objects.clear()
            self.commands.clear()
            self.progress = {"creationAttempts": [], "created": []}
            self.planner.side_effect = [copy.deepcopy(self.plan)] * when + [
                ValueError("changed CI or retained storage")
            ]
            with self.subTest(when=when), self.assertRaises(ValueError):
                self.register()
            self.assertEqual(len(self.writes()), 4 if when == 2 else 0)
            self.assertEqual(len(self.objects), len(self.writes()))

    def test_plan_change_after_preflight_is_rejected(self):
        self.planner.side_effect = [self.plan, self.plan | {"sourceSha": "changed"}]
        with self.assertRaisesRegex(ValueError, "plan changed"):
            self.register()
        self.assertEqual(self.writes(), [])

    def test_uid_replacement_during_creation_stops_without_deleting(self):
        def replace_project(actual):
            if actual["kind"] == "Application":
                self.objects[("AppProject", release.PROJECT)]["metadata"]["uid"] = (
                    "replacement"
                )

        self.failure = replace_project
        with self.assertRaisesRegex(ValueError, "identity changed"):
            self.register()
        self.assertEqual(len(self.objects), 2)
        self.assertEqual(len(self.progress["created"]), 2)

    def test_cli_requires_retained_mode_and_preserves_uncertain_mutation_without_secrets(
        self,
    ):
        args = [
            "evaluation_release.py",
            "--register-argo",
            "--langfuse-url",
            "http://langfuse:3000",
        ]
        with (
            patch.object(sys, "argv", args),
            redirect_stderr(io.StringIO()),
            self.assertRaises(SystemExit),
        ):
            release.main()

        def fail(*a, progress, **k):
            progress["creationAttempts"].append(
                {"kind": "AppProject", "name": release.PROJECT}
            )
            raise TimeoutError("secret-token")

        output = io.StringIO()
        with (
            patch.object(
                sys,
                "argv",
                args + ["--restore-report", "r.json", "--state-dir", "state"],
            ),
            patch.object(release, "from_origin", return_value=self.fork),
            patch.object(release, "register_from_restore", side_effect=fail),
            redirect_stdout(output),
        ):
            self.assertEqual(release.main(), 1)
        payload = json.loads(output.getvalue())
        self.assertIsNone(payload["clusterChanged"])
        self.assertEqual(len(payload["registration"]["creationAttempts"]), 1)
        self.assertFalse(payload["syncRequested"])
        self.assertNotIn("secret-token", output.getvalue())


if __name__ == "__main__":
    unittest.main()
