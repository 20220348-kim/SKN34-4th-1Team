"""Observe storage rollout without accepting stale Argo, foreign Pods or bad endpoints."""

import copy
import io
import json
import sys
import unittest
from contextlib import nullcontext, redirect_stderr, redirect_stdout
from unittest.mock import patch

import evaluation_storage_start as start
import test_evaluation_dormant_status as fixtures

dormant = start.dormant
release = start.release


class StorageRolloutTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixtures.DormantStatusTests.setUpClass.__func__(cls)

    def setUp(self):
        # Reuse the real published chart and dormant Argo/resource fixture.
        fixtures.DormantStatusTests.setUp(self)
        _, self.started, self.fingerprint, _, self.active_render = start.transition(
            "root", self.bound, "helm"
        )
        for app, expected in zip(self.apps, self.started[1:]):
            app["spec"] = copy.deepcopy(expected["spec"])
            app["metadata"]["annotations"] = copy.deepcopy(
                expected["metadata"]["annotations"]
            )
            source = app["spec"]["source"]
            app["status"]["sync"]["comparedTo"]["source"] = copy.deepcopy(source)
            app["status"]["operationState"]["syncResult"]["source"] = copy.deepcopy(
                source
            )
        self.slices = []
        for index, name in enumerate(start.COMPONENTS):
            deploy = self.resource("Deployment", name)
            deploy["spec"]["replicas"] = 1
            deploy["status"].update(
                replicas=1, readyReplicas=1, availableReplicas=1, updatedReplicas=1
            )
            template = copy.deepcopy(deploy["spec"]["template"])
            template["metadata"]["labels"]["pod-template-hash"] = "fixture"
            selector = copy.deepcopy(deploy["spec"]["selector"])
            selector["matchLabels"]["pod-template-hash"] = "fixture"
            rs = {
                "apiVersion": "apps/v1",
                "kind": "ReplicaSet",
                "metadata": {
                    "name": name + "-rs",
                    "uid": name + "-rs-uid",
                    "namespace": release.NAMESPACE,
                    "generation": 1,
                    "ownerReferences": [
                        {
                            "kind": "Deployment",
                            "apiVersion": "apps/v1",
                            "name": name,
                            "uid": deploy["metadata"]["uid"],
                            "controller": True,
                        }
                    ],
                },
                "spec": {"replicas": 1, "template": template, "selector": selector},
                "status": {
                    "observedGeneration": 1,
                    "replicas": 1,
                    "readyReplicas": 1,
                    "availableReplicas": 1,
                    "fullyLabeledReplicas": 1,
                },
            }
            pod_spec = copy.deepcopy(template["spec"])
            pod_spec.update(
                nodeName=self.storage["node"],
                serviceAccountName="default",
                serviceAccount="default",
                enableServiceLinks=True,
                priority=0,
                preemptionPolicy="PreemptLowerPriority",
                tolerations=[
                    {
                        "key": "node.kubernetes.io/" + key,
                        "operator": "Exists",
                        "effect": "NoExecute",
                        "tolerationSeconds": 300,
                    }
                    for key in ("not-ready", "unreachable")
                ],
            )
            pod = {
                "apiVersion": "v1",
                "kind": "Pod",
                "metadata": {
                    "name": name + "-pod",
                    "uid": name + "-pod-uid",
                    "namespace": release.NAMESPACE,
                    "labels": copy.deepcopy(template["metadata"]["labels"]),
                    "ownerReferences": [
                        {
                            "kind": "ReplicaSet",
                            "apiVersion": "apps/v1",
                            "name": rs["metadata"]["name"],
                            "uid": rs["metadata"]["uid"],
                            "controller": True,
                        }
                    ],
                },
                "spec": pod_spec,
                "status": {
                    "phase": "Running",
                    "conditions": [{"type": "Ready", "status": "True"}],
                    "podIPs": [{"ip": f"10.244.0.{index + 2}"}],
                },
            }
            for field, status_field in (
                ("containers", "containerStatuses"),
                ("initContainers", "initContainerStatuses"),
            ):
                pod["status"][status_field] = [
                    {
                        "name": row["name"],
                        "imageID": row["image"],
                        "containerID": f"containerd://{name}-{row['name']}",
                        "restartCount": 0,
                        "ready": True,
                        "state": {"running": {"startedAt": "now"}}
                        if field == "containers"
                        else {"terminated": {"exitCode": 0}},
                    }
                    for row in pod_spec.get(field, [])
                ]
            service = self.resource("Service", name)
            self.slices.append(
                {
                    "apiVersion": "discovery.k8s.io/v1",
                    "kind": "EndpointSlice",
                    "metadata": {
                        "name": name + "-slice",
                        "uid": name + "-slice-uid",
                        "namespace": release.NAMESPACE,
                        "labels": {"kubernetes.io/service-name": name},
                        "ownerReferences": [
                            {
                                "kind": "Service",
                                "apiVersion": "v1",
                                "name": name,
                                "uid": service["metadata"]["uid"],
                                "controller": True,
                            }
                        ],
                    },
                    "addressType": "IPv4",
                    "ports": [
                        {
                            "name": "http",
                            "protocol": "TCP",
                            "port": 4200 if name == "prefect" else 8010,
                        }
                    ],
                    "endpoints": [
                        {
                            "addresses": [pod["status"]["podIPs"][0]["ip"]],
                            "conditions": {"ready": True},
                            "targetRef": {
                                "kind": "Pod",
                                "namespace": release.NAMESPACE,
                                "name": pod["metadata"]["name"],
                                "uid": pod["metadata"]["uid"],
                            },
                        }
                    ],
                }
            )
            self.live += [rs, pod]
        self.handoff = self.enterContext(
            patch.object(
                dormant.evaluation_secrets,
                "verify_handoff",
                return_value={"archiveSha256": self.report["archive_sha256"]},
            )
        )

    def resource(self, kind, name):
        return next(
            row
            for row in self.live
            if row["kind"] == kind and row["metadata"]["name"] == name
        )

    def run_command(self, args, **kwargs):
        self.assertIn("get", args)
        if args[args.index("get") + 1] == "endpointslices.discovery.k8s.io":
            self.commands.append(args)
            return {"items": copy.deepcopy(self.slices)}
        return fixtures.DormantStatusTests.run_command(self, args, **kwargs)

    def observe(self):
        return dormant.observe(
            ["kubectl"],
            ["kubectl", "-n", "argocd"],
            self.bound,
            self.report,
            self.active_render,
            started_resources=self.started,
        )

    def verify(self):
        return start.verify_started(
            "root",
            self.fork,
            state="state",
            restore_report=self.report_path,
            archive="archive",
            key_file="key",
            langfuse_url="http://172.20.0.2:3000",
        )

    def test_success_observes_twice_with_no_mutation_or_traffic_claim(self):
        result = self.verify()
        self.assertEqual(result["status"], "STORAGE_ROLLOUT_VERIFIED")
        for field in (
            "syncCompleted",
            "storagePodsReady",
            "serviceEndpointsVerified",
            "runnerStopped",
            "sourceQuiescenceVerified",
        ):
            self.assertTrue(result[field])
        for field in (
            "clusterChanged",
            "syncRequested",
            "runtimeVerified",
            "httpTrafficVerified",
            "networkPolicyEnforcementVerified",
            "storageDataReverified",
            "runnerActivationRequested",
            "opsRoutingChanged",
        ):
            self.assertFalse(result[field])
        self.assertEqual(self.planner.call_count, 2)
        self.assertEqual(self.handoff.call_count, 2)
        self.assertEqual(len(self.commands), 8)
        self.assertTrue(all("get" in command for command in self.commands))
        self.assertEqual(
            set(result["observation"]["storageWorkloads"]["pods"]),
            set(start.COMPONENTS),
        )
        self.assertNotIn('"spec":', json.dumps(result))

    def test_dormant_mode_still_rejects_started_declarations(self):
        with self.assertRaises(ValueError):
            dormant.observe(
                ["kubectl"],
                ["kubectl", "-n", "argocd"],
                self.bound,
                self.report,
                self.rendered,
            )

    def test_missing_start_binding_pending_or_stale_argo_completion_blocks(self):
        original = copy.deepcopy(self.apps)
        for mutate in (
            lambda a: a["metadata"]["annotations"].pop(start.ANNOTATION),
            lambda a: a.update(
                operation={"sync": {"revision": self.plan["sourceSha"]}}
            ),
            lambda a: a["status"]["operationState"].update(phase="Running"),
            lambda a: a["status"]["sync"].update(status="OutOfSync"),
            lambda a: a["status"]["operationState"]["syncResult"].update(
                revision="b" * 40
            ),
            lambda a: a["status"]["operationState"]["syncResult"]["source"]["helm"][
                "valuesObject"
            ].update(replicas=0),
        ):
            self.apps = copy.deepcopy(original)
            app = next(
                a
                for a in self.apps
                if a["spec"]["source"]["helm"]["releaseName"] == "prefect"
            )
            mutate(app)
            with self.subTest(mutation=mutate), self.assertRaises(ValueError):
                self.observe()

    def test_incomplete_rollout_or_started_runner_is_rejected(self):
        original = copy.deepcopy(self.live)
        for name, section, field, value in (
            ("prefect", "status", "readyReplicas", 0),
            ("prefect", "status", "observedGeneration", 0),
            ("prefect", "status", "terminatingReplicas", 1),
            ("evaluation-runner", "spec", "replicas", 1),
        ):
            self.live = copy.deepcopy(original)
            self.resource("Deployment", name)[section][field] = value
            with self.subTest(name=name, field=field), self.assertRaises(ValueError):
                self.observe()

    def test_wrong_replicaset_owner_or_template_cannot_supply_a_ready_pod(self):
        original = copy.deepcopy(self.live)
        for mutate in (
            lambda r: r["metadata"]["ownerReferences"][0].update(uid="foreign"),
            lambda r: r["spec"]["template"]["spec"].update(hostNetwork=True),
            lambda r: r["spec"]["selector"]["matchLabels"].update(unexpected="peer"),
            lambda r: r["status"].update(readyReplicas=0),
        ):
            self.live = copy.deepcopy(original)
            mutate(self.resource("ReplicaSet", "prefect-rs"))
            with self.subTest(mutation=mutate), self.assertRaises(ValueError):
                self.observe()

    def test_pod_not_ready_foreign_owner_wrong_node_or_spec_drift_is_rejected(self):
        original = copy.deepcopy(self.live)
        for mutate in (
            lambda p: p["metadata"].update(deletionTimestamp="now"),
            lambda p: p["metadata"]["ownerReferences"][0].update(uid="foreign"),
            lambda p: p["spec"].update(nodeName="other-node"),
            lambda p: p["spec"].update(hostNetwork=True),
            lambda p: p["metadata"]["labels"].update(unexpected="peer"),
            lambda p: p["spec"].update(serviceAccountName="privileged"),
            lambda p: p["spec"]["containers"][0].update(
                image="foreign@sha256:" + "b" * 64
            ),
            lambda p: p["status"].update(phase="Pending"),
            lambda p: p["status"]["containerStatuses"][0].update(ready=False),
            lambda p: p["status"]["containerStatuses"][0].pop("imageID"),
            lambda p: p["status"]["initContainerStatuses"][0]["state"][
                "terminated"
            ].update(exitCode=1),
        ):
            self.live = copy.deepcopy(original)
            mutate(self.resource("Pod", "prefect-pod"))
            with self.subTest(mutation=mutate), self.assertRaises(ValueError):
                self.observe()

    def test_extra_runner_or_unrelated_pod_is_rejected(self):
        self.live.append({"kind": "Pod", "metadata": {"name": "runner"}})
        with self.assertRaisesRegex(ValueError, "two storage Pods"):
            self.observe()

    def test_wrong_endpoint_owner_target_address_port_or_readiness_is_rejected(self):
        original = copy.deepcopy(self.slices)
        for mutate in (
            lambda s: s["metadata"]["ownerReferences"][0].update(uid="foreign"),
            lambda s: s["endpoints"][0]["targetRef"].update(uid="old-pod"),
            lambda s: s["endpoints"][0].update(addresses=["10.244.1.99"]),
            lambda s: s["ports"][0].update(port=9999),
            lambda s: s["endpoints"][0]["conditions"].update(ready=False),
            lambda s: s["endpoints"][0]["conditions"].update(terminating=True),
        ):
            self.slices = copy.deepcopy(original)
            mutate(self.slices[0])
            with self.subTest(mutation=mutate), self.assertRaises(ValueError):
                self.observe()

    def test_missing_or_foreign_endpoint_slice_blocks(self):
        original = copy.deepcopy(self.slices)
        self.slices.pop()
        with self.assertRaises(ValueError):
            self.observe()
        self.slices = original
        self.slices[0]["metadata"]["labels"]["kubernetes.io/service-name"] = "foreign"
        with self.assertRaisesRegex(ValueError, "Unexpected storage EndpointSlice"):
            self.observe()

    def test_credential_change_between_observations_is_not_reported_as_success(self):
        self.handoff.side_effect = [{"archiveSha256": "a"}, {"archiveSha256": "b"}]
        with self.assertRaisesRegex(ValueError, "credentials changed"):
            self.verify()

    def test_pod_restart_during_verification_invalidates_result(self):
        def change(*a, **k):
            self.resource("Pod", "prefect-pod")["status"]["containerStatuses"][0][
                "restartCount"
            ] += 1
            return {"archiveSha256": self.report["archive_sha256"]}

        self.handoff.side_effect = change
        with self.assertRaisesRegex(ValueError, "resources changed"):
            self.verify()

    def test_new_publication_or_context_mismatch_blocks(self):
        self.planner.side_effect = [
            copy.deepcopy(self.plan),
            ValueError("main changed"),
        ]
        with self.assertRaisesRegex(ValueError, "main changed"):
            self.verify()
        self.settings["branch"] = "other"
        with self.assertRaisesRegex(ValueError, "matching GitOps cluster"):
            self.verify()


class StorageRolloutCliTests(unittest.TestCase):
    def arguments(self):
        return [
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
            "--verify-started",
        ]

    def test_read_mode_cannot_request_start_and_dispatches_only_verification(self):
        output = io.StringIO()
        with (
            patch.object(sys, "argv", self.arguments()),
            patch.object(start.os, "name", "posix"),
            patch.object(release, "from_origin"),
            patch.object(release.fork_cluster, "locked", return_value=nullcontext()),
            patch.object(
                start,
                "verify_started",
                return_value={"status": "STORAGE_ROLLOUT_VERIFIED"},
            ) as verify,
            patch.object(start, "request") as request,
            redirect_stdout(output),
        ):
            self.assertEqual(start.main(), 0)
        verify.assert_called_once()
        request.assert_not_called()
        with (
            patch.object(sys, "argv", self.arguments() + ["--request-start"]),
            redirect_stderr(io.StringIO()),
            self.assertRaises(SystemExit),
        ):
            start.main()

    def test_read_failure_is_sanitized_and_reports_no_mutation(self):
        output = io.StringIO()
        with (
            patch.object(sys, "argv", self.arguments()),
            patch.object(start.os, "name", "posix"),
            patch.object(release, "from_origin"),
            patch.object(release.fork_cluster, "locked", return_value=nullcontext()),
            patch.object(
                start, "verify_started", side_effect=ValueError("PRIVATE credentials")
            ),
            redirect_stdout(output),
        ):
            self.assertEqual(start.main(), 1)
        result = json.loads(output.getvalue())
        self.assertEqual(result["status"], "BLOCKED")
        self.assertFalse(result["clusterChanged"])
        self.assertFalse(result["syncRequested"])
        self.assertFalse(result["runtimeVerified"])
        self.assertNotIn("PRIVATE", output.getvalue())


if __name__ == "__main__":
    unittest.main()
