"""A running Pod or matching tag alone must not become deployment proof."""

import copy
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import cluster_status as status


def node():
    return {
        "metadata": {"name": "owned-control-plane"},
        "spec": {},
        "status": {
            "conditions": [
                {"type": name, "status": value}
                for name, value in (
                    ("Ready", "True"),
                    ("MemoryPressure", "False"),
                    ("DiskPressure", "False"),
                    ("PIDPressure", "False"),
                )
            ]
        },
    }


def claim():
    return {
        "kind": "PersistentVolumeClaim",
        "metadata": {"name": "data"},
        "spec": {"volumeName": "pv-data"},
        "status": {"phase": "Bound"},
    }


class InfrastructureStatusTests(unittest.TestCase):
    def test_missing_unknown_and_unhealthy_node_conditions_fail(self):
        self.assertTrue(status.node_status(node())["healthy"])
        for condition in ("Ready", "MemoryPressure", "DiskPressure", "PIDPressure"):
            for value in (None, "Unknown", "False" if condition == "Ready" else "True"):
                item = node()
                item["status"]["conditions"] = [
                    c for c in item["status"]["conditions"] if c["type"] != condition
                ]
                if value is not None:
                    item["status"]["conditions"].append({"type": condition, "status": value})
                with self.subTest(condition=condition, value=value):
                    self.assertFalse(status.node_status(item)["healthy"])
        item = node()
        item["spec"]["unschedulable"] = True
        self.assertFalse(status.node_status(item)["healthy"])
        item = node()
        item["status"]["conditions"].append({"type": "NetworkUnavailable", "status": "True"})
        self.assertFalse(status.node_status(item)["healthy"])

    def test_virtual_state_disk_does_not_hide_full_checkout_drive(self):
        with patch.object(
            status.shutil,
            "disk_usage",
            side_effect=[SimpleNamespace(free=255 * 1024**2), SimpleNamespace(free=100 * 1024**3)],
        ):
            result = status.local_filesystems(Path("state"))
        self.assertEqual([item["ok"] for item in result], [False, True])
        self.assertEqual(result[0]["issue"], "LOW_FREE_SPACE")
        with patch.object(status.shutil, "disk_usage", side_effect=OSError("PRIVATE")):
            result = status.local_filesystems(Path("state"))
        self.assertTrue(all(item["free_bytes"] is None and not item["ok"] for item in result))
        self.assertNotIn("PRIVATE", json.dumps(result))


def workload(name="core-service"):
    labels = {"app.kubernetes.io/name": name, "app.kubernetes.io/instance": name}
    container = {"name": name, "image": "govbiz-" + name + ":known"}
    deployment = {
        "kind": "Deployment",
        "metadata": {"name": name, "generation": 2},
        "spec": {
            "replicas": 1,
            "selector": {"matchLabels": labels},
            "strategy": {"type": "Recreate"},
            "template": {"spec": {"containers": [container]}},
        },
        "status": {"observedGeneration": 2, "updatedReplicas": 1, "availableReplicas": 1},
    }
    pod = {
        "kind": "Pod",
        "metadata": {"name": name + "-pod", "uid": name + "-uid", "labels": labels},
        "spec": {"containers": [copy.deepcopy(container)]},
        "status": {
            "phase": "Running",
            "conditions": [{"type": "Ready", "status": "True"}],
            "containerStatuses": [
                {
                    "name": name,
                    "ready": True,
                    "restartCount": 2,
                    "imageID": "containerd://sha256:" + "a" * 64,
                }
            ],
        },
    }
    return deployment, pod, container["image"]


class ServiceStatusTests(unittest.TestCase):
    def test_ready_is_distinct_from_baseline_alignment(self):
        deployment, pod, image = workload()
        result = status.service_status("core-service", deployment, [pod], image)
        self.assertTrue(result["ready"] and result["baseline_matches"])
        self.assertEqual(result["pods"][0]["containers"][0]["restart_count"], 2)
        for baseline in (None, "govbiz-core-service:old"):
            result = status.service_status("core-service", deployment, [pod], baseline)
            self.assertTrue(result["ready"])
            self.assertIsNot(result["baseline_matches"], True)

    def test_stale_rollout_or_unverified_pod_never_reports_ready(self):
        changes = [
            lambda d, p: d["status"].update(observedGeneration=1),
            lambda d, p: d["status"].update(updatedReplicas=0),
            lambda d, p: d["status"].update(availableReplicas=0),
            lambda d, p: d["spec"].update(replicas=0),
            lambda d, p: p["metadata"].update(deletionTimestamp="2026-10-02T00:00:00Z"),
            lambda d, p: p["status"].update(phase="Pending"),
            lambda d, p: p["status"].update(conditions=[]),
            lambda d, p: p["status"]["containerStatuses"][0].update(ready=False),
            lambda d, p: p["status"]["containerStatuses"][0].pop("imageID"),
            lambda d, p: p["spec"]["containers"][0].update(image="govbiz-core-service:old"),
        ]
        for change in changes:
            deployment, pod, image = workload()
            change(deployment, pod)
            with self.subTest(change=change):
                result = status.service_status("core-service", deployment, [pod], image)
                self.assertFalse(result["ready"])
                self.assertIn("ROLLOUT_NOT_READY", result["issues"])

    def test_missing_deployment_or_our_pod_cannot_use_another_service(self):
        deployment, _, image = workload()
        _, other, _ = workload("ops-service")
        self.assertFalse(status.service_status("core-service", deployment, [other], image)["ready"])
        self.assertFalse(status.service_status("core-service", None, [other], image)["ready"])

    def test_sync_container_must_match_baseline_and_be_running(self):
        deployment, pod, image = workload("ops-service")
        deployment["spec"]["template"]["spec"]["containers"].append(
            {"name": "ops-sync", "image": image}
        )
        pod["spec"]["containers"].append({"name": "ops-sync", "image": image})
        self.assertFalse(status.service_status("ops-service", deployment, [pod], image)["ready"])
        pod["status"]["containerStatuses"].append(
            {"name": "ops-sync", "imageID": "sha256:" + "a" * 64, "ready": True}
        )
        self.assertTrue(status.service_status("ops-service", deployment, [pod], image)["ready"])
        deployment["spec"]["template"]["spec"]["containers"][1]["image"] = "govbiz-ops-service:old"
        self.assertFalse(
            status.service_status("ops-service", deployment, [pod], image)["baseline_matches"]
        )


class SnapshotTests(unittest.TestCase):
    def test_report_is_read_only_and_does_not_expose_environment_or_claim_source_proof(self):
        resources, images = [claim()], {}
        for name in status.SERVICES:
            deployment, pod, image = workload(name)
            deployment["spec"]["template"]["spec"]["containers"][0]["env"] = [
                {"name": "TOKEN", "value": "DO-NOT-PRINT"}
            ]
            resources.extend([deployment, pod])
            images[name] = image
        settings = {
            "repository": "alice/project",
            "namespace": "govbiz-msa",
            "cluster": "owned",
            "mode": "dev",
        }
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            baseline = json.dumps({"source": "local", "images": images, "private": "DO-NOT-PRINT"})
            (state / "baseline.json").write_text(baseline)
            with (
                patch.object(
                    status,
                    "run",
                    side_effect=[
                        json.dumps({"items": resources}),
                        json.dumps({"items": [node()]}),
                        "",
                        "b" * 40,
                        " M changed",
                    ],
                ) as run,
                patch.object(
                    status.shutil, "disk_usage", return_value=SimpleNamespace(free=2 * 1024**3)
                ),
            ):
                result = status.snapshot(state, settings, ["kube"], ["namespaced"], ["argo"])
            self.assertEqual((state / "baseline.json").read_text(), baseline)
            self.assertEqual(list(state.iterdir()), [state / "baseline.json"])
        self.assertTrue(result["workloads_ready"] and result["baseline_matches"])
        self.assertEqual(result["schema_version"], 2)
        self.assertTrue(
            result["nodes_healthy"] and result["storage_ready"] and result["local_storage_ok"]
        )
        self.assertTrue(result["checkout_dirty"])
        self.assertFalse(result["argocd"]["application_crd_present"])
        self.assertEqual(result["argocd"]["evaluation"]["status"], "NOT_INSTALLED")
        for key in ("image_source_verified", "application_paths_verified", "backup_verified"):
            self.assertIs(result[key], False)
        self.assertNotIn("DO-NOT-PRINT", json.dumps(result))
        for call in run.call_args_list:
            self.assertLessEqual(call.kwargs["timeout"], 15)
            self.assertFalse(
                set(map(str, call.args[0]))
                & {"docker", "apply", "patch", "delete", "secrets", "exec"}
            )

    def test_kubernetes_timeout_does_not_produce_success(self):
        with (
            patch.object(status, "run", side_effect=subprocess.TimeoutExpired("kube", 15)),
            self.assertRaises(subprocess.TimeoutExpired),
        ):
            status.snapshot(Path("unused"), {}, ["kube"], ["namespaced"], ["argo"])

    def test_unbound_terminating_missing_claims_or_nodes_are_not_healthy(self):
        deployment, pod, _ = workload()
        pod["spec"]["volumes"] = [{"persistentVolumeClaim": {"claimName": "data"}}]
        for phase, volume, deleting, missing in (
            ("Pending", "", False, False),
            ("Lost", "pv-data", False, False),
            ("Bound", "", False, False),
            ("Bound", "pv-data", True, False),
            ("Bound", "pv-data", False, True),
        ):
            pvc = claim()
            pvc["status"]["phase"] = phase
            pvc["spec"]["volumeName"] = volume
            if deleting:
                pvc["metadata"]["deletionTimestamp"] = "2026-10-02T00:00:00Z"
            resources = [deployment, pod] + ([] if missing else [pvc])
            with (
                tempfile.TemporaryDirectory() as directory,
                patch.object(
                    status,
                    "run",
                    side_effect=[
                        json.dumps({"items": resources}),
                        '{"items": []}',
                        "",
                        "b" * 40,
                        "",
                    ],
                ),
            ):
                result = status.snapshot(
                    Path(directory),
                    {
                        "repository": "alice/project",
                        "namespace": "govbiz-msa",
                        "cluster": "owned",
                        "mode": "dev",
                    },
                    ["kube"],
                    ["ns"],
                    ["argo"],
                )
            with self.subTest(phase=phase, deleting=deleting, missing=missing):
                self.assertFalse(result["storage_ready"])
                self.assertFalse(result["nodes_healthy"])
            self.assertEqual(result["missing_claims"], ["data"] if missing else [])


def evaluation_apps():
    from evaluation_release import argo_plan

    return [
        {
            **app,
            "status": {
                "sync": {"status": "Synced", "revision": "a" * 40},
                "health": {"status": "Healthy"},
            },
        }
        for app in argo_plan(
            SimpleNamespace(url="https://github.com/alice/project.git"),
            "a" * 40,
            {name: {"replicas": 0} for name in status.COMPONENTS},
        )
        if app["kind"] == "Application"
    ]


class EvaluationApplicationTests(unittest.TestCase):
    def test_dormant_healthy_applications_are_not_runtime_or_publication_proof(self):
        report = status.evaluation_applications(evaluation_apps(), "alice/project")
        self.assertEqual(report["status"], "OBSERVED")
        self.assertEqual(len(report["applications"]), 3)
        self.assertTrue(all(not item["issues"] for item in report["applications"]))
        for key in (
            "runtime_verified",
            "storage_verified",
            "publication_verified",
            "deployment_authorized",
        ):
            self.assertIs(report[key], False)

    def test_missing_or_partially_installed_components_remain_explicit(self):
        report = status.evaluation_applications([], "alice/project")
        self.assertEqual(report["status"], "NOT_INSTALLED")
        self.assertTrue(
            all(
                item["issues"] == ["APPLICATION_MISSING"]
                for item in report["applications"]
            )
        )
        report = status.evaluation_applications(evaluation_apps()[:1], "alice/project")
        self.assertEqual(report["status"], "ATTENTION")
        self.assertEqual(sum(item["present"] for item in report["applications"]), 1)

    def test_wrong_named_app_is_reported_even_when_routed_outside_evaluation_namespace(
        self,
    ):
        changes = (
            lambda app: app["spec"].update(project="default"),
            lambda app: app["spec"]["destination"].update(namespace="govbiz-msa"),
            lambda app: app["spec"]["destination"].update(
                server="https://other-cluster"
            ),
            lambda app: app["spec"]["source"].update(
                repoURL="https://github.com/other/project.git"
            ),
            lambda app: app["spec"]["source"].update(path="other/chart"),
            lambda app: app["spec"]["source"]["helm"].update(releaseName="other"),
            lambda app: app["spec"].update(sources=[{"repoURL": "private"}]),
        )
        for change in changes:
            apps = evaluation_apps()
            change(apps[0])
            with self.subTest(change=change):
                report = status.evaluation_applications(apps, "alice/project")
                self.assertEqual(report["status"], "ATTENTION")
                self.assertIn(
                    "APPLICATION_IDENTITY_MISMATCH", report["applications"][0]["issues"]
                )

    def test_auto_sync_stale_revision_unhealthy_and_pending_operations_need_attention(
        self,
    ):
        cases = (
            (
                lambda a: a["spec"]["syncPolicy"].update(automated={}),
                "AUTOMATIC_SYNC_CONFIGURED",
            ),
            (
                lambda a: a["spec"]["syncPolicy"]["automated"].update(enabled=True),
                "AUTOMATIC_SYNC_CONFIGURED",
            ),
            (
                lambda a: a["spec"]["syncPolicy"]["automated"].update(prune=True),
                "AUTOMATIC_SYNC_CONFIGURED",
            ),
            (
                lambda a: a["spec"]["syncPolicy"]["automated"].update(selfHeal=True),
                "AUTOMATIC_SYNC_CONFIGURED",
            ),
            (
                lambda a: a["spec"]["source"].update(targetRevision="main"),
                "REVISION_NOT_PINNED",
            ),
            (
                lambda a: a["status"]["sync"].update(revision="b" * 40),
                "SYNC_REVISION_MISMATCH",
            ),
            (
                lambda a: a["status"]["sync"].update(status="OutOfSync"),
                "APPLICATION_NOT_SYNCED",
            ),
            (
                lambda a: a["status"]["health"].update(status="Degraded"),
                "APPLICATION_NOT_HEALTHY",
            ),
            (
                lambda a: a["metadata"].update(deletionTimestamp="now"),
                "APPLICATION_TERMINATING",
            ),
            (
                lambda a: a.update(operation={"sync": {}}),
                "APPLICATION_OPERATION_ACTIVE",
            ),
            (
                lambda a: a["status"].update(operationState={"phase": "Running"}),
                "APPLICATION_OPERATION_ACTIVE",
            ),
            (
                lambda a: a["status"].update(conditions=[{"message": "PRIVATE"}]),
                "APPLICATION_CONDITIONS_PRESENT",
            ),
        )
        for change, expected in cases:
            apps = evaluation_apps()
            change(apps[0])
            with self.subTest(expected=expected, change=change):
                report = status.evaluation_applications(apps, "alice/project")
                self.assertEqual(report["status"], "ATTENTION")
                self.assertIn(expected, report["applications"][0]["issues"])
                self.assertNotIn("PRIVATE", json.dumps(report))
        apps = evaluation_apps()
        for app in apps:
            app["spec"]["syncPolicy"].pop("automated")
        self.assertEqual(
            status.evaluation_applications(apps, "alice/project")["status"], "OBSERVED"
        )

    def test_individually_synced_different_revisions_are_not_a_consistent_bundle(self):
        apps = evaluation_apps()
        apps[0]["spec"]["source"]["targetRevision"] = "b" * 40
        apps[0]["status"]["sync"]["revision"] = "b" * 40
        report = status.evaluation_applications(apps, "alice/project")
        self.assertEqual(report["status"], "ATTENTION")
        self.assertTrue(
            all(
                "COMPONENT_REVISION_MISMATCH" in item["issues"]
                for item in report["applications"]
            )
        )

    def test_unknown_status_and_revision_never_echo_private_response_values(self):
        apps = evaluation_apps()
        apps[0]["spec"]["source"]["targetRevision"] = "PRIVATE"
        apps[0]["status"] = {
            "sync": {"status": "PRIVATE", "revision": "PRIVATE"},
            "health": {"status": "PRIVATE", "message": "PRIVATE"},
        }
        report = status.evaluation_applications(apps, "alice/project")
        self.assertEqual(report["status"], "ATTENTION")
        self.assertNotIn("PRIVATE", json.dumps(report))
        self.assertEqual(report["applications"][0]["sync"], "Unknown")
        self.assertIsNone(report["applications"][0]["desired_revision"])

    def test_snapshot_keeps_msa_scope_and_reuses_one_bounded_argo_read(self):
        apps = evaluation_apps()
        for app in apps:
            app["spec"]["source"]["helm"]["valuesObject"]["secret"] = "PRIVATE"
        apps.append(
            {
                "metadata": {"name": "govbiz-core-service"},
                "spec": {"destination": {"namespace": "govbiz-msa"}},
                "status": {
                    "sync": {"status": "Synced"},
                    "health": {"status": "Healthy"},
                },
            }
        )
        apps.append(
            {
                "metadata": {"name": "unrelated-app"},
                "spec": {
                    "destination": {"namespace": "unrelated"},
                    "private": "PRIVATE",
                },
            }
        )
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(
                status,
                "run",
                side_effect=[
                    '{"items": []}',
                    '{"items": []}',
                    "applications.argoproj.io",
                    json.dumps({"items": apps}),
                    "b" * 40,
                    "",
                ],
            ) as run,
        ):
            report = status.snapshot(
                Path(directory),
                {
                    "repository": "alice/project",
                    "namespace": "govbiz-msa",
                    "cluster": "owned",
                    "mode": "gitops",
                },
                ["kube"],
                ["ns"],
                ["argo"],
            )
        self.assertEqual(
            [app["name"] for app in report["argocd"]["applications"]],
            ["govbiz-core-service"],
        )
        self.assertEqual(report["argocd"]["evaluation"]["status"], "OBSERVED")
        self.assertEqual(
            sum(
                call.args[0][:3] == ["argo", "get", "applications"]
                for call in run.call_args_list
            ),
            1,
        )
        self.assertNotIn("PRIVATE", json.dumps(report))
        self.assertNotIn("unrelated-app", json.dumps(report))
        for call in run.call_args_list:
            self.assertLessEqual(call.kwargs["timeout"], 15)
            self.assertFalse(
                set(map(str, call.args[0]))
                & {"apply", "patch", "delete", "secrets", "exec"}
            )


if __name__ == "__main__":
    unittest.main()
