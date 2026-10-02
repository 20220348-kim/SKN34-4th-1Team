"""A running Pod or matching tag alone must not become deployment proof."""

import copy
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import cluster_status as status


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
        resources, images = [], {}
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
            with patch.object(
                status,
                "run",
                side_effect=[json.dumps({"items": resources}), "", "b" * 40, " M changed"],
            ) as run:
                result = status.snapshot(state, settings, ["kube"], ["namespaced"], ["argo"])
            self.assertEqual((state / "baseline.json").read_text(), baseline)
            self.assertEqual(list(state.iterdir()), [state / "baseline.json"])
        self.assertTrue(result["workloads_ready"] and result["baseline_matches"])
        self.assertTrue(result["checkout_dirty"])
        self.assertFalse(result["argocd"]["application_crd_present"])
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
        with patch.object(status, "run", side_effect=subprocess.TimeoutExpired("kube", 15)):
            with self.assertRaises(subprocess.TimeoutExpired):
                status.snapshot(Path("unused"), {}, ["kube"], ["namespaced"], ["argo"])


if __name__ == "__main__":
    unittest.main()
