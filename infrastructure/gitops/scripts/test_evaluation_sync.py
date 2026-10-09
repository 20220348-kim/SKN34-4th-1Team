"""First Argo sync requests: admission, optimistic concurrency and partial failures."""

import copy
import io
import json
import os
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

import evaluation_release as release
from repository import Fork
from test_evaluation_chart import bundle


class EvaluationSyncTests(unittest.TestCase):
    def setUp(self):
        self.fork = Fork("fixture/project")
        values = bundle()
        for value in values.values():
            value["replicas"] = 0
        resources = release.argo_plan(self.fork, "a" * 40, values)
        self.plan = {
            "sourceSha": "a" * 40,
            "resources": resources,
            "resourcesSha256": release.digest(release.encoded(resources)),
            "retainedStorage": {
                "namespace_uid": "storage-uid",
                "node": "fixture-control-plane",
            },
            "restoreReportSha256": "b" * 64,
            "retainedStorageIdentityVerified": True,
            "clusterChanged": False,
            "deploymentAuthorized": False,
        }
        self.objects = {}
        for index, row in enumerate(release.registration_resources(self.plan)):
            row["metadata"].update(uid=f"uid-{index}", resourceVersion="1")
            self.objects[(row["kind"], row["metadata"]["name"])] = row
        self.progress = {"attempted": [], "acknowledged": []}
        self.settings = {"mode": "gitops", "stateId": "fixture"}
        self.commands = []
        self.targets = []
        self.before_patch = None
        self.after_patch = None
        self.admit = None
        self.planner = self.enterContext(
            patch.object(
                release,
                "plan_from_restore",
                side_effect=lambda *a, **k: copy.deepcopy(self.plan),
            )
        )
        self.publication = self.enterContext(
            patch.object(
                release,
                "plan",
                side_effect=lambda *a, **k: {
                    **{
                        key: copy.deepcopy(value)
                        for key, value in self.plan.items()
                        if key not in {"retainedStorage", "restoreReportSha256"}
                    },
                    "retainedStorageIdentityVerified": False,
                },
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
            patch.object(release.pvc_restore, "run", side_effect=self.command)
        )

    def command(self, args, *, value=None, **kwargs):
        self.commands.append((args, copy.deepcopy(value)))
        if "get" in args:
            kind = args[args.index("get") + 1]
            if kind == "applications.argoproj.io":
                return {
                    "items": copy.deepcopy(
                        [v for (k, _), v in self.objects.items() if k == "Application"]
                    )
                }
            if kind == "deployments,services,networkpolicies":
                return {"items": copy.deepcopy(self.targets)}
            key = (
                "Application" if kind == "application" else "AppProject",
                args[args.index("get") + 2],
            )
            return copy.deepcopy(self.objects.get(key))
        self.assertIn("patch", args)
        self.assertIn("--patch-file=/dev/stdin", args)
        self.assertEqual(kwargs["timeout"], 30)
        dry = "--dry-run=server" in args
        name = args[args.index("patch") + 2]
        key = ("Application", name)
        if self.before_patch:
            self.before_patch(self.objects[key], dry)
        current = copy.deepcopy(self.objects[key])
        # Emulate the API's atomic JSON Patch tests, not a blind merge patch.
        for entry in value[:-1]:
            observed = current
            for part in entry["path"].strip("/").split("/"):
                observed = observed[part]
            if observed != entry["value"]:
                raise ValueError("API precondition conflict")
        self.assertEqual(value[-1]["path"], "/operation")
        current["operation"] = copy.deepcopy(value[-1]["value"])
        if self.admit:
            self.admit(current, dry)
        if not dry:
            current["metadata"]["resourceVersion"] = str(
                int(current["metadata"]["resourceVersion"]) + 1
            )
            self.objects[key] = copy.deepcopy(current)
            if self.after_patch:
                self.after_patch(current)
        return current

    def request(self):
        return release.request_dormant_sync(
            "root",
            self.fork,
            state="state",
            restore_report="restore.json",
            progress=self.progress,
            langfuse_url="http://172.20.0.2:3000",
        )

    def writes(self):
        return [
            (a, v)
            for a, v in self.commands
            if "patch" in a and "--dry-run=server" not in a
        ]

    def test_three_requests_keep_exact_sources_zero_replicas_and_no_prune_or_force(
        self,
    ):
        before = copy.deepcopy(self.objects)
        result = self.request()
        self.assertEqual(result["status"], "DORMANT_SYNC_REQUESTED")
        self.assertIsNone(result["syncCompleted"])
        self.assertIsNone(result["runtimeStarted"])
        self.assertFalse(result["runtimeVerified"])
        self.assertFalse(result["activationRequested"])
        self.assertFalse(result["deploymentAuthorized"])
        self.assertTrue(result["retainedStorageIdentityVerified"])
        self.assertEqual(len(self.writes()), 3)
        self.assertEqual(len(self.progress["acknowledged"]), 3)
        self.assertEqual(self.planner.call_count, 2)
        self.publication.assert_called_once()
        for args, payload in self.writes():
            self.assertEqual(
                [p["op"] for p in payload], ["test", "test", "test", "add"]
            )
            operation = payload[-1]["value"]
            self.assertEqual(
                operation,
                {
                    "sync": {
                        "revision": "a" * 40,
                        "prune": False,
                        "syncStrategy": {"apply": {"force": False}},
                        "syncOptions": ["FailOnSharedResource=true"],
                    },
                    "retry": {"limit": 0},
                },
            )
            self.assertNotIn("a" * 40, args)
        for key in before:
            self.assertEqual(before[key]["spec"], self.objects[key]["spec"])
        self.assertTrue(all("get" in a or "patch" in a for a, _ in self.commands))

    def test_missing_or_foreign_registration_blocks_all_requests(self):
        original = copy.deepcopy(self.objects)
        for kind, name in original:
            self.objects = copy.deepcopy(original)
            self.objects.pop((kind, name))
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.request()
            self.assertEqual(self.writes(), [])
        self.objects = copy.deepcopy(original)
        self.objects[("Application", "foreign")] = {
            "metadata": {"name": "foreign", "namespace": "elsewhere"},
            "spec": {"destination": {"namespace": release.NAMESPACE}},
        }
        with self.assertRaisesRegex(ValueError, "another Argo owner"):
            self.request()
        self.assertEqual(self.writes(), [])

    def test_changed_spec_ownership_history_or_existing_operation_cannot_sync(self):
        key = ("Application", release.PROJECT + "-prefect")
        original = copy.deepcopy(self.objects)
        for mutate in (
            lambda r: r["spec"]["source"]["helm"]["valuesObject"].update(replicas=1),
            lambda r: r["spec"]["source"].update(targetRevision="b" * 40),
            lambda r: r["spec"]["syncPolicy"]["automated"].update(enabled=True),
            lambda r: r["metadata"].pop("annotations"),
            lambda r: r["metadata"].pop("resourceVersion"),
            lambda r: r["metadata"].update(finalizers=["cascade"]),
            lambda r: r.update(operation={"sync": {}}),
            lambda r: r.update(status={"history": [{"id": 0}]}),
            lambda r: r.update(status={"operationState": {"phase": "Failed"}}),
        ):
            self.objects = copy.deepcopy(original)
            mutate(self.objects[key])
            with self.subTest(mutation=mutate), self.assertRaises(ValueError):
                self.request()
            self.assertEqual(self.writes(), [])

    def test_existing_targets_are_not_adopted(self):
        for kind in ("Deployment", "Service", "NetworkPolicy"):
            self.targets = [{"kind": kind, "metadata": {"name": "prefect"}}]
            with (
                self.subTest(kind=kind),
                self.assertRaisesRegex(ValueError, "no adoption"),
            ):
                self.request()
            self.assertEqual(self.writes(), [])

    def test_server_admission_cannot_broaden_operation_or_activate_workloads(self):
        for mutate in (
            lambda r: r["operation"]["sync"].update(prune=True),
            lambda r: r["operation"].update(retry={"limit": 1}),
            lambda r: r["spec"]["source"]["helm"]["valuesObject"].update(replicas=1),
        ):
            self.admit = lambda row, dry, mutate=mutate: mutate(row)
            with self.subTest(mutation=mutate), self.assertRaises(ValueError):
                self.request()
            self.assertEqual(self.writes(), [])

    def test_ci_or_storage_changes_during_preflight_block_controller_actions(self):
        self.planner.side_effect = [copy.deepcopy(self.plan), ValueError("CI changed")]
        with self.assertRaises(ValueError):
            self.request()
        self.assertEqual(self.writes(), [])

    def test_resource_version_race_is_not_overwritten_or_retried(self):
        def race(row, dry):
            if not dry:
                row["metadata"]["resourceVersion"] = "9"
                row["operation"] = {"sync": {"revision": "foreign"}}

        self.before_patch = race
        with self.assertRaisesRegex(ValueError, "precondition"):
            self.request()
        self.assertEqual(len(self.writes()), 1)
        self.assertEqual(len(self.progress["attempted"]), 1)
        self.assertEqual(self.progress["acknowledged"], [])

    def test_project_replacement_after_first_request_stops_the_remaining_requests(self):
        def replace_project(row):
            self.objects[("AppProject", release.PROJECT)]["metadata"]["uid"] = (
                "replaced"
            )

        self.after_patch = replace_project
        with self.assertRaisesRegex(ValueError, "identity changed"):
            self.request()
        self.assertEqual(len(self.progress["acknowledged"]), 1)
        self.assertEqual(len(self.writes()), 1)

    def test_response_loss_does_not_retry_an_operation_that_may_have_started(self):
        def lose_response(row):
            raise TimeoutError("private endpoint")

        self.after_patch = lose_response
        with self.assertRaises(TimeoutError):
            self.request()
        self.assertEqual(len(self.progress["attempted"]), 1)
        self.assertEqual(self.progress["acknowledged"], [])
        self.after_patch = None
        with self.assertRaises(ValueError):
            self.request()
        self.assertEqual(len(self.writes()), 1)

    def test_new_publication_after_requests_does_not_report_success_or_rollback(self):
        self.publication.side_effect = ValueError("Source advanced")
        with self.assertRaises(ValueError):
            self.request()
        self.assertEqual(len(self.writes()), 3)
        self.assertEqual(len(self.progress["acknowledged"]), 3)
        self.assertFalse(any("delete" in a for a, _ in self.commands))

    def test_publication_only_recheck_still_rejects_changed_source(self):
        self.publication.side_effect = None
        self.publication.return_value = {
            "sourceSha": "c" * 40,
            "retainedStorageIdentityVerified": False,
        }
        with self.assertRaisesRegex(ValueError, "plan changed after request"):
            self.request()
        self.assertEqual(len(self.progress["acknowledged"]), 3)

    @unittest.skipUnless(os.name == "posix", "Sync CLI uses WSL/Linux stdin")
    def test_cli_requires_explicit_action_and_reports_uncertain_sync_without_private_error(
        self,
    ):
        args = [
            "evaluation_release.py",
            "--request-dormant-sync",
            "--langfuse-url",
            "http://172.20.0.2:3000",
        ]
        for extra in ([], ["--register-argo"]):
            with (
                patch.object(sys, "argv", args + extra),
                redirect_stderr(io.StringIO()),
                self.assertRaises(SystemExit),
            ):
                release.main()

        def fail(*a, progress, **kw):
            progress["attempted"].append(
                {"name": release.PROJECT + "-prefect", "uid": "fixture"}
            )
            raise TimeoutError("private-token")

        output = io.StringIO()
        with (
            patch.object(
                sys,
                "argv",
                args + ["--state-dir", "state", "--restore-report", "r.json"],
            ),
            patch.object(release, "from_origin", return_value=self.fork),
            patch.object(release, "request_dormant_sync", side_effect=fail),
            redirect_stdout(output),
        ):
            self.assertEqual(release.main(), 1)
        result = json.loads(output.getvalue())
        self.assertIsNone(result["syncRequested"])
        self.assertIsNone(result["clusterChanged"])
        self.assertIsNone(result["syncCompleted"])
        self.assertFalse(result["activationRequested"])
        self.assertNotIn("private-token", output.getvalue())


if __name__ == "__main__":
    unittest.main()
