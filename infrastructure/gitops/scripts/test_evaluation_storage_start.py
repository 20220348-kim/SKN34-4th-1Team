"""Published storage-only start, atomic admission and uncertain partial requests."""

import copy
import io
import json
import sys
import tempfile
import unittest
from contextlib import nullcontext, redirect_stdout
from pathlib import Path
from unittest.mock import patch

import evaluation_storage_start as start
from repository import Fork
from test_evaluation_chart import bundle

release = start.release


class StorageStartTests(unittest.TestCase):
    real_transition = staticmethod(start.transition)

    @classmethod
    def setUpClass(cls):
        cls.fork = Fork("fixture/project")
        values = bundle()
        for name, value in values.items():
            value["replicas"] = 0
            value["storage"]["existingClaim"] = (
                "prefect" if name == "prefect" else "results"
            )
        resources = release.argo_plan(cls.fork, "a" * 40, values)
        cls.base_plan = {
            "sourceSha": "a" * 40,
            "resources": resources,
            "resourcesSha256": release.digest(release.encoded(resources)),
            "images": {name: value["image"] for name, value in values.items()},
        }
        cls.dormant_render = release.render_bundle(values)
        cls.base_plan["renderedSha256"] = {
            name: release.digest(release.encoded(rows))
            for name, rows in cls.dormant_render.items()
        }
        cls.storage = {"namespace_uid": "storage-uid", "node": "fixture-control-plane"}
        cls.report = {
            "cross_store_business_links_verified": True,
            "archive_sha256": "d" * 64,
        }
        cls.report_bytes = release.encoded(cls.report)
        cls.report_sha = release.digest(cls.report_bytes)
        cls.bound = {
            **cls.base_plan,
            "retainedStorage": cls.storage,
            "restoreReportSha256": cls.report_sha,
        }
        root = Path(__file__).resolve().parents[3]
        cls.files = {
            path.relative_to(root).as_posix(): path.read_bytes()
            for path in (root / release.CHART).rglob("*")
            if path.is_file()
        }
        with patch.object(release, "tracked_files", return_value=cls.files):
            cls.transition = start.transition(root, cls.bound, "helm")

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.report_path = Path(temporary.name) / "restore.json"
        self.report_path.write_bytes(self.report_bytes)
        initial, _, _, policies, _ = copy.deepcopy(self.transition)
        self.project, *apps = initial
        self.project["metadata"].update(uid="project-uid", resourceVersion="1")
        self.apps = {}
        observed = {}
        for app in apps:
            name = app["metadata"]["name"]
            source = copy.deepcopy(app["spec"]["source"])
            app["metadata"].update(uid=name + "-uid", resourceVersion="1")
            app["status"] = {
                "sync": {
                    "status": "Synced",
                    "revision": "a" * 40,
                    "comparedTo": {
                        "source": source,
                        "destination": app["spec"]["destination"],
                    },
                },
                "health": {"status": "Healthy"},
                "operationState": {
                    "phase": "Succeeded",
                    "finishedAt": "initial-time",
                    "syncResult": {"revision": "a" * 40, "source": source},
                },
            }
            self.apps[name] = app
            observed[name] = {
                "uid": name + "-uid",
                "specSha256": release.digest(release.encoded(app["spec"])),
                "finishedAt": "initial-time",
            }
        self.runner = {
            "metadata": {"uid": "runner-uid", "generation": 1},
            "spec": {"replicas": 0},
            "status": {"observedGeneration": 1},
        }
        self.pods = []
        self.connections = [
            {
                "kind": "NetworkPolicy",
                "metadata": {"name": "deny-all", "uid": "policy-uid"},
                "spec": {"podSelector": {}, "policyTypes": ["Ingress", "Egress"]},
            }
        ]
        self.evidence = {
            "sourceSha": "a" * 40,
            "restoreReportSha256": self.report_sha,
            "syncCompleted": True,
            "podsAbsent": True,
            "sourceQuiescenceVerified": True,
            "archiveFreshnessVerified": True,
            "preparedSecretsVerified": True,
            "storageDataReverified": True,
            "sourceHandoff": {"archiveSha256": "d" * 64},
            "observation": {
                "storage": self.storage,
                "projectUid": "project-uid",
                "applications": observed,
                "resources": {
                    "Deployment/evaluation-runner": {
                        "uid": "runner-uid",
                        "specSha256": release.digest(
                            release.encoded(self.runner["spec"])
                        ),
                    }
                },
            },
        }
        self.evidence["observation"]["resources"]["NetworkPolicy/deny-all"] = {
            "uid": "policy-uid",
            "specSha256": release.digest(release.encoded(self.connections[0]["spec"])),
        }
        self.progress = {
            "storageProbe": {},
            "networkProbeAttempted": False,
            "attempted": [],
            "acknowledged": [],
        }
        self.settings = {"mode": "gitops", "cluster": "fixture"}
        self.commands = []
        self.before_patch = self.after_patch = self.admit = None
        self.dormant = self.enterContext(
            patch.object(
                start.dormant,
                "verify",
                side_effect=lambda *a, **k: copy.deepcopy(self.evidence),
            )
        )
        self.planner = self.enterContext(
            patch.object(
                release,
                "plan",
                side_effect=lambda *a, **k: copy.deepcopy(self.base_plan),
            )
        )
        self.enterContext(
            patch.object(
                start,
                "transition",
                side_effect=lambda *a: copy.deepcopy(self.transition),
            )
        )
        self.network = self.enterContext(
            patch.object(
                start.network,
                "exercise",
                return_value={
                    "status": "ENFORCED",
                    "cleanupComplete": True,
                    "networkPolicyEnforcementVerified": True,
                    "serviceDnsVerified": True,
                    "serviceClusterIPVerified": True,
                    "chartPolicySpecSha256": policies,
                },
            )
        )
        self.handoff = self.enterContext(
            patch.object(
                start.dormant.evaluation_secrets,
                "verify_handoff",
                return_value=self.evidence["sourceHandoff"],
            )
        )
        self.loader = self.enterContext(
            patch.object(
                release.fork_cluster,
                "load_settings",
                side_effect=lambda *a: copy.deepcopy(self.settings),
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
            if kind == "appproject":
                return copy.deepcopy(self.project)
            if kind == "applications.argoproj.io":
                return {"items": copy.deepcopy(list(self.apps.values()))}
            if kind == "deployment":
                self.assertEqual(args[args.index("get") + 2], "evaluation-runner")
                return copy.deepcopy(self.runner)
            if kind == "services,networkpolicies":
                return {"items": copy.deepcopy(self.connections)}
            self.assertEqual(kind, "pods")
            return {"items": copy.deepcopy(self.pods)}
        self.assertIn("patch", args)
        self.assertIn("--patch-file=/dev/stdin", args)
        self.assertEqual(kwargs["timeout"], 30)
        name = args[args.index("patch") + 2]
        dry = "--dry-run=server" in args
        if self.before_patch:
            self.before_patch(self.apps[name], dry)
        current = copy.deepcopy(self.apps[name])
        for entry in value:
            parts = [
                part.replace("~1", "/").replace("~0", "~")
                for part in entry["path"].strip("/").split("/")
            ]
            target = current
            for part in parts[:-1]:
                target = target[part]
            if entry["op"] == "test":
                if target[parts[-1]] != entry["value"]:
                    raise ValueError("API precondition conflict")
            else:
                self.assertIn(entry["op"], ("add", "replace"))
                target[parts[-1]] = copy.deepcopy(entry["value"])
        if self.admit:
            self.admit(current, dry)
        if not dry:
            current["metadata"]["resourceVersion"] = str(
                int(current["metadata"]["resourceVersion"]) + 1
            )
            self.apps[name] = copy.deepcopy(current)
            if self.after_patch:
                self.after_patch(current)
        return current

    def request(self, activate=True):
        return start.request(
            "root",
            self.fork,
            state="state",
            restore_report=self.report_path,
            archive="archive",
            key_file="key",
            langfuse_url="http://172.20.0.2:3000",
            start=activate,
            progress=self.progress,
        )

    def writes(self):
        return [
            (args, value)
            for args, value in self.commands
            if "patch" in args and "--dry-run=server" not in args
        ]

    def test_published_transition_changes_only_two_replicas_and_binding_annotation(
        self,
    ):
        initial, started, fingerprint, policies, _ = self.transition
        self.assertEqual(initial[0], started[0])
        for before, after in zip(initial[1:], started[1:]):
            expected = copy.deepcopy(before)
            component = expected["spec"]["source"]["helm"]["releaseName"]
            if component in start.COMPONENTS:
                expected["spec"]["source"]["helm"]["valuesObject"]["replicas"] = 1
                expected["metadata"]["annotations"][start.ANNOTATION] = fingerprint
            self.assertEqual(after, expected)
        self.assertEqual(set(policies), set(start.COMPONENTS))

    def test_default_review_does_not_probe_network_or_request_any_mutation(self):
        result = self.request(False)
        self.assertEqual(result["status"], "STORAGE_START_PLANNED")
        self.assertFalse(result["clusterChanged"])
        self.assertFalse(result["syncRequested"])
        self.assertFalse(self.dormant.call_args.kwargs["verify_storage"])
        self.assertEqual(self.commands, [])
        self.network.assert_not_called()

    def test_chart_cannot_change_pod_or_add_resources_when_replicas_change(self):
        for problem in ("pod", "new-resource", "replicas"):
            rendered = copy.deepcopy(self.dormant_render)
            for name, rows in rendered.items():
                workload = next(row for row in rows if row["kind"] == "Deployment")
                workload["spec"]["replicas"] = 1 if name in start.COMPONENTS else 0
            workload = next(
                row for row in rendered["prefect"] if row["kind"] == "Deployment"
            )
            if problem == "pod":
                workload["spec"]["template"]["spec"]["hostNetwork"] = True
            elif problem == "new-resource":
                rendered["prefect"].append(
                    {"kind": "Job", "metadata": {"name": "unexpected"}}
                )
            else:
                workload["spec"]["replicas"] = 2
            with (
                self.subTest(problem=problem),
                patch.object(release, "tracked_files", return_value=self.files),
                patch.object(release, "render_bundle", return_value=rendered),
                self.assertRaisesRegex(ValueError, "rendered"),
            ):
                self.real_transition("root", self.bound, "helm")

    def test_synthetic_probe_policy_hashes_match_published_storage_policy(self):
        fixture = start.network.chart_fixture(
            "govbiz-evaluation-disposable",
            "disposable-ops",
            "disposable-observation",
            "token",
            "fixture-control-plane",
            self.base_plan["images"]["prefect"],
            "helm",
        )
        hashes = fixture[4]
        for name, digest in self.transition[3].items():
            self.assertEqual(hashes[name], digest)

    def test_start_dry_runs_both_before_patching_only_storage_apps(self):
        before = copy.deepcopy(self.apps)
        result = self.request()
        self.assertEqual(result["status"], "STORAGE_START_REQUESTED")
        self.assertTrue(result["syncRequested"])
        self.assertTrue(result["storagePolicyEnforcementVerified"])
        self.assertIsNone(result["syncCompleted"])
        for key in (
            "runtimeVerified",
            "runnerActivationRequested",
            "opsRoutingChanged",
        ):
            self.assertFalse(result[key])
        names = [release.PROJECT + "-" + name for name in start.COMPONENTS]
        self.assertEqual(self.progress["attempted"], names)
        self.assertEqual(self.progress["acknowledged"], names)
        patches = [(a, v) for a, v in self.commands if "patch" in a]
        self.assertEqual(
            ["--dry-run=server" in a for a, _ in patches], [True, True, False, False]
        )
        for args, payload in patches:
            self.assertEqual(
                [p["path"] for p in payload[:4]],
                [
                    "/metadata/uid",
                    "/metadata/resourceVersion",
                    "/spec",
                    "/metadata/annotations",
                ],
            )
            self.assertEqual([p["op"] for p in payload[:4]], ["test"] * 4)
            self.assertEqual(
                payload[-1]["value"],
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
        runner = release.PROJECT + "-evaluation-runner"
        self.assertEqual(before[runner], self.apps[runner])
        self.assertTrue(self.dormant.call_args_list[0].kwargs["verify_storage"])
        self.assertNotIn("verify_storage", self.dormant.call_args_list[1].kwargs)
        self.assertEqual(self.handoff.call_count, 4)

    def test_missing_data_or_archive_prerequisite_blocks_network_and_argo(self):
        for field in (
            "syncCompleted",
            "podsAbsent",
            "sourceQuiescenceVerified",
            "archiveFreshnessVerified",
            "preparedSecretsVerified",
            "storageDataReverified",
        ):
            with self.subTest(field=field):
                self.evidence[field] = False
                with self.assertRaises(ValueError):
                    self.request()
                self.evidence[field] = True
        self.network.assert_not_called()
        self.assertEqual(self.commands, [])

    def test_network_failure_cleanup_failure_or_other_policy_blocks_argo(self):
        original = copy.deepcopy(self.network.return_value)
        for field, value in (
            ("status", "ERROR"),
            ("cleanupComplete", False),
            ("serviceDnsVerified", False),
            ("serviceClusterIPVerified", False),
            ("networkPolicyEnforcementVerified", False),
            ("chartPolicySpecSha256", {"prefect": "wrong"}),
        ):
            self.network.return_value = {**original, field: value}
            with (
                self.subTest(field=field),
                self.assertRaisesRegex(ValueError, "policy enforcement"),
            ):
                self.request()
            self.assertEqual(self.commands, [])

    def test_dormant_evidence_change_during_probes_blocks_all_argo_calls(self):
        for key in ("sourceSha", "restoreReportSha256", "observation", "sourceHandoff"):
            changed = {**self.evidence, key: "changed"}
            self.dormant.side_effect = [copy.deepcopy(self.evidence), changed]
            with (
                self.subTest(key=key),
                self.assertRaisesRegex(ValueError, "evidence changed"),
            ):
                self.request()
            self.assertEqual(self.commands, [])

    def test_new_publication_blocks_before_admission(self):
        self.planner.side_effect = [
            copy.deepcopy(self.base_plan),
            ValueError("new main"),
        ]
        with self.assertRaises(ValueError):
            self.request()
        self.assertEqual(self.commands, [])

    def test_handoff_or_context_change_blocks_before_admission(self):
        self.handoff.return_value = {"archiveSha256": "changed"}
        with self.assertRaisesRegex(ValueError, "credentials changed"):
            self.request()
        self.assertEqual(self.commands, [])
        self.context.side_effect = ValueError("context changed")
        with self.assertRaisesRegex(ValueError, "context changed"):
            self.request()
        self.assertEqual(self.commands, [])

    def test_restore_report_change_during_network_probe_blocks_mutation(self):
        def change(*a, **k):
            self.report_path.write_bytes(b"{}")
            return self.network.return_value

        self.network.side_effect = change
        with self.assertRaises(ValueError):
            self.request()
        self.assertEqual(self.writes(), [])

    def test_foreign_application_or_replaced_project_blocks_mutation(self):
        self.apps["foreign"] = {
            "metadata": {"name": "foreign", "namespace": "argocd"},
            "spec": {"project": release.PROJECT},
        }
        with self.assertRaisesRegex(ValueError, "another Argo owner"):
            self.request()
        del self.apps["foreign"]
        self.project["metadata"]["uid"] = "replacement"
        with self.assertRaisesRegex(ValueError, "project ownership"):
            self.request()
        self.assertEqual(self.writes(), [])

    def test_started_runner_drift_or_pod_blocks_before_storage_writes(self):
        original = copy.deepcopy(self.runner)
        for mutate in (
            lambda r: r["spec"].update(replicas=1),
            lambda r: r["spec"].update(replicas=False),
            lambda r: r["spec"].update(template={"unexpected": True}),
            lambda r: r["metadata"].update(uid="replacement"),
            lambda r: r["metadata"].update(deletionTimestamp="now"),
            lambda r: r["status"].update(observedGeneration=2),
            lambda r: r["status"].update(updatedReplicas=1),
        ):
            self.runner = copy.deepcopy(original)
            mutate(self.runner)
            with (
                self.subTest(mutation=mutate),
                self.assertRaisesRegex(ValueError, "no longer dormant"),
            ):
                self.request()
        self.runner = original
        self.pods = [{"metadata": {"name": "unexpected-runner"}}]
        with self.assertRaisesRegex(ValueError, "Pod is present"):
            self.request()
        self.assertEqual(self.writes(), [])

    def test_unrequested_argo_state_change_blocks_mutation(self):
        name = release.PROJECT + "-prefect"
        original = copy.deepcopy(self.apps[name])
        for mutate in (
            lambda a: a.update(operation={"sync": {"revision": "foreign"}}),
            lambda a: a["status"]["sync"].update(status="OutOfSync"),
            lambda a: a["status"]["operationState"].update(finishedAt="new-time"),
            lambda a: a["status"].update(conditions=[{"type": "ComparisonError"}]),
        ):
            self.apps[name] = copy.deepcopy(original)
            mutate(self.apps[name])
            with self.subTest(mutation=mutate), self.assertRaises(ValueError):
                self.request()
        self.assertEqual(self.writes(), [])

    def test_added_or_broadened_network_policy_blocks_mutation(self):
        original = copy.deepcopy(self.connections)
        self.connections.append(
            {
                "kind": "NetworkPolicy",
                "metadata": {"name": "allow-all", "uid": "foreign"},
                "spec": {"podSelector": {}, "ingress": [{}]},
            }
        )
        with self.assertRaisesRegex(ValueError, "network policy changed"):
            self.request()
        self.connections = original
        self.connections[0]["spec"]["ingress"] = [{}]
        with self.assertRaisesRegex(ValueError, "network policy changed"):
            self.request()
        self.assertEqual(self.writes(), [])

    def test_admission_cannot_change_image_replicas_or_operation(self):
        for mutate in (
            lambda a: a["spec"]["source"]["helm"]["valuesObject"].update(replicas=2),
            lambda a: a["spec"]["source"].update(targetRevision="b" * 40),
            lambda a: a["operation"]["sync"].update(prune=True),
            lambda a: a["operation"].update(retry={"limit": 1}),
            lambda a: a["metadata"]["annotations"].pop(start.ANNOTATION),
        ):
            self.admit = lambda row, dry, mutate=mutate: mutate(row)
            with self.subTest(mutation=mutate), self.assertRaises(ValueError):
                self.request()
        self.assertEqual(self.writes(), [])

    def test_resource_version_race_is_not_overwritten_or_retried(self):
        def race(row, dry):
            if not dry:
                row["metadata"]["resourceVersion"] = "9"

        self.before_patch = race
        with self.assertRaisesRegex(ValueError, "precondition"):
            self.request()
        self.assertEqual(len(self.writes()), 1)
        self.assertEqual(len(self.progress["attempted"]), 1)
        self.assertEqual(self.progress["acknowledged"], [])

    def test_response_loss_preserves_possible_start_without_retry_or_rollback(self):
        def lose(row):
            raise TimeoutError("private endpoint")

        self.after_patch = lose
        with self.assertRaises(TimeoutError):
            self.request()
        self.assertEqual(len(self.writes()), 1)
        self.assertEqual(len(self.progress["attempted"]), 1)
        self.assertEqual(self.progress["acknowledged"], [])
        app = self.apps[release.PROJECT + "-prefect"]
        self.assertEqual(app["spec"]["source"]["helm"]["valuesObject"]["replicas"], 1)

    def test_failed_first_sync_stops_second_request_without_rollback(self):
        def fail(row):
            self.apps[row["metadata"]["name"]]["status"]["operationState"]["phase"] = (
                "Failed"
            )

        self.after_patch = fail
        with self.assertRaisesRegex(ValueError, "failed or interrupted"):
            self.request()
        self.assertEqual(len(self.writes()), 1)
        self.assertEqual(len(self.progress["acknowledged"]), 1)

    def test_new_main_after_first_request_preserves_partial_progress(self):
        def advance(row):
            self.planner.side_effect = ValueError("main advanced")

        self.after_patch = advance
        with self.assertRaisesRegex(ValueError, "main advanced"):
            self.request()
        self.assertEqual(len(self.writes()), 1)
        self.assertEqual(len(self.progress["acknowledged"]), 1)
        self.assertFalse(any("delete" in a or "scale" in a for a, _ in self.commands))


class StorageStartCliTests(unittest.TestCase):
    def test_sanitized_failure_distinguishes_attempted_and_acknowledged_requests(self):
        for phase in (
            "none",
            "storage-attempted",
            "storage-created",
            "network",
            "attempted",
            "acknowledged",
        ):

            def fail(*a, phase=phase, **kwargs):
                progress = kwargs["progress"]
                if phase.startswith("storage-"):
                    progress["storageProbe"]["creationAttempted"] = True
                    progress["storageProbe"]["created"] = phase == "storage-created"
                elif phase == "network":
                    progress["networkProbeAttempted"] = True
                elif phase in ("attempted", "acknowledged"):
                    progress["attempted"].append("prefect")
                    if phase == "acknowledged":
                        progress["acknowledged"].append("prefect")
                raise TimeoutError("PRIVATE_SQL PRIVATE_PASSWORD private-endpoint")

            output = io.StringIO()
            with (
                self.subTest(phase=phase),
                patch.object(start.os, "name", "posix"),
                patch.object(start, "request", side_effect=fail),
                patch.object(release, "from_origin"),
                patch.object(
                    release.fork_cluster, "locked", return_value=nullcontext()
                ),
                patch.object(
                    sys,
                    "argv",
                    [
                        "evaluation_storage_start.py",
                        "--state-dir",
                        "state",
                        "--restore-report",
                        "report",
                        "--archive",
                        "archive",
                        "--key-file",
                        "key",
                        "--langfuse-url",
                        "http://private",
                        "--request-start",
                    ],
                ),
                redirect_stdout(output),
            ):
                self.assertEqual(start.main(), 1)
            result = json.loads(output.getvalue())
            self.assertEqual(result["status"], "BLOCKED")
            self.assertEqual(result["errorType"], "TimeoutError")
            self.assertNotIn("PRIVATE", output.getvalue())
            self.assertNotIn("private", output.getvalue())
            self.assertFalse(result["runtimeVerified"])
            self.assertIs(
                result["clusterChanged"],
                False
                if phase == "none"
                else True
                if phase in ("storage-created", "acknowledged")
                else None,
            )
            self.assertIs(
                result["syncRequested"],
                True
                if phase == "acknowledged"
                else None
                if phase == "attempted"
                else False,
            )


if __name__ == "__main__":
    unittest.main()
