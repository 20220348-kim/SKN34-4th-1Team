"""Offline Argo completion, live resource drift and replica-zero verification."""

import copy
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

import evaluation_dormant_status as dormant
from repository import Fork
from test_evaluation_chart import bundle

release = dormant.release


class DormantStatusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.values = bundle()
        for name, value in cls.values.items():
            value["replicas"] = 0
            value["storage"]["existingClaim"] = (
                "prefect" if name == "prefect" else "results"
            )
        cls.rendered = release.render_bundle(cls.values)
        root = Path(__file__).resolve().parents[3]
        cls.files = {
            path.relative_to(root).as_posix(): path.read_bytes()
            for path in (root / release.CHART).rglob("*")
            if path.is_file()
        }

    def setUp(self):
        self.fork = Fork("fixture/project")
        self.settings = {
            "mode": "gitops",
            "repository": self.fork.repository,
            "branch": self.fork.branch,
            "cluster": "fixture",
        }
        self.storage = {
            "namespace_uid": "namespace-uid",
            "node": "fixture-control-plane",
            "identity_verified": True,
            "data_reverified": False,
        }
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.report_path = Path(temporary.name) / "report.json"
        self.report = {
            "cross_store_business_links_verified": True,
            "archive_sha256": "d" * 64,
        }
        self.report_path.write_text(json.dumps(self.report), encoding="utf-8")
        self.plan = {
            "sourceSha": "a" * 40,
            "resources": release.argo_plan(self.fork, "a" * 40, self.values),
            "renderedSha256": {
                name: release.digest(release.encoded(rows))
                for name, rows in self.rendered.items()
            },
        }
        self.plan["resourcesSha256"] = release.digest(
            release.encoded(self.plan["resources"])
        )
        self.bound = {
            **self.plan,
            "retainedStorage": self.storage,
            "restoreReportSha256": release.digest(self.report_path.read_bytes()),
        }
        resources = release.registration_resources(self.bound)
        self.project, *self.apps = copy.deepcopy(resources)
        self.project["metadata"]["uid"] = "project-uid"
        for app in self.apps:
            app["metadata"]["uid"] = app["metadata"]["name"] + "-uid"
            source = app["spec"]["source"]
            component = source["helm"]["releaseName"]
            app["status"] = {
                "health": {"status": "Healthy"},
                "sync": {
                    "status": "Synced",
                    "revision": self.plan["sourceSha"],
                    "comparedTo": {
                        "source": copy.deepcopy(source),
                        "destination": app["spec"]["destination"],
                    },
                },
                "operationState": {
                    "phase": "Succeeded",
                    "finishedAt": "2026-10-09T00:00:00Z",
                    "syncResult": {
                        "revision": self.plan["sourceSha"],
                        "source": copy.deepcopy(source),
                    },
                },
                "resources": [
                    {
                        "group": row["apiVersion"].split("/")[0]
                        if "/" in row["apiVersion"]
                        else "",
                        "kind": row["kind"],
                        "namespace": release.NAMESPACE,
                        "name": component,
                        "status": "Synced",
                    }
                    for row in self.rendered[component]
                ],
            }
        self.live = []
        for component, rows in copy.deepcopy(self.rendered).items():
            for row in rows:
                group = (
                    row["apiVersion"].split("/")[0] if "/" in row["apiVersion"] else ""
                )
                row["metadata"].update(uid=f"{component}-{row['kind']}-uid")
                row["metadata"].setdefault("annotations", {})[
                    "argocd.argoproj.io/tracking-id"
                ] = (
                    f"{release.PROJECT}-{component}:{group}/{row['kind']}:"
                    f"{release.NAMESPACE}/{component}"
                )
                if row["kind"] == "Deployment":
                    row["metadata"]["generation"] = 1
                    row["status"] = {"observedGeneration": 1}
                elif row["kind"] == "Service":
                    row["spec"].update(
                        clusterIP="10.96.1.1",
                        clusterIPs=["10.96.1.1"],
                        ipFamilies=["IPv4"],
                    )
                self.live.append(row)
        self.live.append(
            {
                "apiVersion": "networking.k8s.io/v1",
                "kind": "NetworkPolicy",
                "metadata": {
                    "name": "deny-all",
                    "namespace": release.NAMESPACE,
                    "uid": "deny-uid",
                },
                "spec": {"podSelector": {}, "policyTypes": ["Ingress", "Egress"]},
            }
        )
        self.commands = []
        self.enterContext(
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
        self.inspector = self.enterContext(
            patch.object(
                release.pvc_restore,
                "inspect_retained_storage",
                side_effect=lambda *a: copy.deepcopy(self.storage),
            )
        )
        self.planner = self.enterContext(
            patch.object(
                release, "plan", side_effect=lambda *a, **k: copy.deepcopy(self.plan)
            )
        )
        self.enterContext(
            patch.object(release, "tracked_files", return_value=self.files)
        )
        self.enterContext(
            patch.object(release.pvc_restore, "run", side_effect=self.run_command)
        )

    def run_command(self, args, **kwargs):
        self.commands.append(args)
        self.assertIn("get", args)
        self.assertNotIn("secret", " ".join(args))
        self.assertNotIn("value", kwargs)
        kind = args[args.index("get") + 1]
        if kind == "appproject":
            return copy.deepcopy(self.project)
        if kind == "applications.argoproj.io":
            return {"items": copy.deepcopy(self.apps)}
        self.assertTrue(kind.startswith("deployments,services,networkpolicies,pods,"))
        return {"items": copy.deepcopy(self.live)}

    def verify(self):
        return dormant.verify(
            "root",
            self.fork,
            state="state",
            restore_report=self.report_path,
            langfuse_url="http://172.20.0.2:3000",
        )

    def observe(self):
        return dormant.observe(
            ["kubectl"],
            ["kubectl", "-n", "argocd"],
            self.bound,
            self.report,
            self.rendered,
        )

    def deployment(self, name="evaluation-runner"):
        return next(
            row
            for row in self.live
            if row["kind"] == "Deployment" and row["metadata"]["name"] == name
        )

    def test_success_reads_twice_and_does_not_claim_runtime_activation_or_data_validation(
        self,
    ):
        result = self.verify()
        self.assertEqual(result["status"], "DORMANT_SYNC_VERIFIED")
        self.assertTrue(result["syncCompleted"])
        self.assertTrue(result["podsAbsent"])
        for flag in (
            "runtimeVerified",
            "activationAuthorized",
            "networkPolicyEnforcementVerified",
            "storageDataReverified",
            "sourceQuiescenceVerified",
            "clusterChanged",
        ):
            self.assertIs(result[flag], False)
        self.assertEqual(self.planner.call_count, 2)
        self.assertEqual(self.inspector.call_count, 3)
        self.assertEqual(len(self.commands), 6)
        self.assertNotIn("LANGFUSE_SECRET_KEY", json.dumps(result))
        self.assertNotIn('spec"', json.dumps(result))

    def test_api_defaults_and_equivalent_quantities_do_not_look_like_drift(self):
        for row in self.live:
            if row["kind"] != "Deployment":
                continue
            template = row["spec"]["template"]
            template["metadata"]["creationTimestamp"] = None
            pod = template["spec"]
            pod.update(
                dnsPolicy="ClusterFirst",
                restartPolicy="Always",
                schedulerName="default-scheduler",
            )
            for container in pod["containers"] + pod.get("initContainers", []):
                container.update(
                    terminationMessagePath="/dev/termination-log",
                    terminationMessagePolicy="File",
                )
                for env in container.get("env", []):
                    if env.get("value") == "":
                        env.pop("value")
                for port in container.get("ports", []):
                    port["protocol"] = "TCP"
                for mount in container.get("volumeMounts", []):
                    if mount.get("readOnly") is False:
                        mount.pop("readOnly")
                for resources in container["resources"].values():
                    for key, value in resources.items():
                        if isinstance(value, str) and value.endswith("Mi"):
                            resources[key] = str(int(value[:-2]) * 1024 * 1024)
                for key in ("startupProbe", "readinessProbe"):
                    if key in container:
                        container[key].setdefault("successThreshold", 1)
                        container[key].setdefault("failureThreshold", 3)
                        if "httpGet" in container[key]:
                            container[key]["httpGet"]["scheme"] = "HTTP"
            for volume in pod["volumes"]:
                if volume.get("persistentVolumeClaim", {}).get("readOnly") is False:
                    volume["persistentVolumeClaim"].pop("readOnly")
        self.observe()

    def test_stale_incomplete_or_conflicting_argo_evidence_blocks(self):
        original = copy.deepcopy(self.apps)
        for mutation in (
            lambda a: a.update(operation={"sync": {}}),
            lambda a: a["status"]["sync"].update(status="OutOfSync"),
            lambda a: a["status"]["sync"].update(revision="b" * 40),
            lambda a: a["status"]["sync"].pop("comparedTo"),
            lambda a: a["status"]["health"].update(status="Progressing"),
            lambda a: a["status"]["operationState"].update(phase="Running"),
            lambda a: a["status"]["operationState"].pop("finishedAt"),
            lambda a: a["status"]["operationState"]["syncResult"].update(
                revision="b" * 40
            ),
            lambda a: a["status"].update(conditions=[{"message": "private error"}]),
            lambda a: a["status"]["resources"].pop(),
            lambda a: a["status"]["resources"].append(
                copy.deepcopy(a["status"]["resources"][0])
            ),
            lambda a: a["status"]["resources"][0].update(requiresPruning=True),
            lambda a: a["spec"]["syncPolicy"]["automated"].update(enabled=True),
            lambda a: a["metadata"]["annotations"].clear(),
        ):
            self.apps = copy.deepcopy(original)
            mutation(self.apps[0])
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                self.observe()

    def test_live_deployment_drift_is_rejected_despite_synced_argo_status(self):
        original = copy.deepcopy(self.live)
        for mutation in (
            lambda d: d["spec"].update(replicas=1),
            lambda d: d["status"].update(replicas=1),
            lambda d: d["status"].update(terminatingReplicas=1),
            lambda d: d["status"].update(observedGeneration=0),
            lambda d: d["spec"]["template"]["spec"].update(hostNetwork=True),
            lambda d: d["spec"]["template"]["spec"]["containers"].append(
                {"name": "extra"}
            ),
            lambda d: d["spec"]["template"]["spec"]["containers"][0].update(
                image="unverified"
            ),
            lambda d: d["spec"]["template"]["spec"]["containers"][0].update(
                envFrom=[{"secretRef": {"name": "private"}}]
            ),
            lambda d: d["spec"]["template"]["spec"]["containers"][0]["env"].append(
                {"name": "OPENAI_API_KEY", "value": "private"}
            ),
            lambda d: d["spec"]["template"]["spec"]["volumes"][0].update(
                hostPath={"path": "/private"}
            ),
            lambda d: d["metadata"]["annotations"].clear(),
        ):
            self.live = copy.deepcopy(original)
            mutation(self.deployment())
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                self.observe()

    def test_extra_workloads_and_missing_resources_block(self):
        original = copy.deepcopy(self.live)
        for kind in (
            "Pod",
            "Job",
            "CronJob",
            "DaemonSet",
            "StatefulSet",
            "HorizontalPodAutoscaler",
            "Service",
            "NetworkPolicy",
        ):
            self.live = copy.deepcopy(original) + [
                {"kind": kind, "metadata": {"name": "extra"}}
            ]
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                self.observe()
        self.live = original[:-1]  # Retained deny-all must still exist.
        with self.assertRaises(ValueError):
            self.observe()

    def test_service_and_network_policy_changes_block(self):
        original = copy.deepcopy(self.live)
        for kind, change in (
            ("Service", {"type": "NodePort"}),
            ("Service", {"externalIPs": ["192.0.2.1"]}),
            ("Service", {"clusterIP": "None"}),
            ("NetworkPolicy", {"ingress": [{}]}),
        ):
            self.live = copy.deepcopy(original)
            next(row for row in self.live if row["kind"] == kind)["spec"].update(change)
            with self.subTest(kind=kind, change=change), self.assertRaises(ValueError):
                self.observe()

    def test_only_owned_observed_zero_replicasets_are_accepted(self):
        deployment = self.deployment()
        rs = {
            "kind": "ReplicaSet",
            "metadata": {
                "name": "runner-rs",
                "namespace": release.NAMESPACE,
                "uid": "rs-uid",
                "generation": 1,
                "ownerReferences": [
                    {
                        "kind": "Deployment",
                        "name": "evaluation-runner",
                        "uid": deployment["metadata"]["uid"],
                        "controller": True,
                    }
                ],
            },
            "spec": {"replicas": 0},
            "status": {"observedGeneration": 1},
        }
        self.live.append(rs)
        self.observe()
        for mutation in (
            lambda r: r["spec"].update(replicas=1),
            lambda r: r["status"].update(readyReplicas=1),
            lambda r: r["status"].clear(),
            lambda r: r["metadata"]["ownerReferences"][0].update(uid="foreign"),
        ):
            self.live[-1] = copy.deepcopy(rs)
            mutation(self.live[-1])
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                self.observe()

    def test_changed_ci_or_identity_during_verification_cannot_return_success(self):
        for defect in ("ci", "uid", "report", "settings", "storage"):
            original_live = copy.deepcopy(self.live)
            original_settings = copy.deepcopy(self.settings)

            def recheck(*args, defect=defect, **kwargs):
                if self.planner.call_count == 2:
                    if defect == "ci":
                        raise ValueError("private CI failure")
                    if defect == "uid":
                        self.deployment()["metadata"]["uid"] = "replacement"
                    elif defect == "report":
                        self.report_path.write_text("{}", encoding="utf-8")
                    elif defect == "settings":
                        self.settings["cluster"] = "changed"
                    elif defect == "storage":
                        self.storage["namespace_uid"] = "changed"
                return copy.deepcopy(self.plan)

            self.planner.reset_mock(side_effect=True)
            self.planner.side_effect = recheck
            with self.subTest(defect=defect), self.assertRaises(ValueError):
                self.verify()
            self.live = original_live
            self.settings.clear()
            self.settings.update(original_settings)
            self.storage["namespace_uid"] = "namespace-uid"
            self.report_path.write_text(json.dumps(self.report), encoding="utf-8")

    def test_foreign_application_and_wrong_render_hash_block(self):
        self.apps.append(
            {
                "metadata": {"name": "foreign", "namespace": "other"},
                "spec": {"destination": {"namespace": release.NAMESPACE}},
            }
        )
        with self.assertRaises(ValueError):
            self.observe()
        self.apps.pop()
        self.plan["renderedSha256"]["prefect"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "rendered chart"):
            self.verify()
        self.assertEqual(self.planner.call_count, 1)

    def test_cli_failure_never_exports_private_resource_content(self):
        output = io.StringIO()
        with (
            patch.object(
                sys,
                "argv",
                [
                    "evaluation_dormant_status.py",
                    "--state-dir",
                    "state",
                    "--restore-report",
                    "restore.json",
                    "--langfuse-url",
                    "http://172.20.0.2:3000",
                ],
            ),
            patch.object(release, "from_origin", return_value=self.fork),
            patch.object(
                dormant, "verify", side_effect=ValueError("private secret and URL")
            ),
            redirect_stdout(output),
        ):
            self.assertEqual(dormant.main(), 1)
        result = json.loads(output.getvalue())
        self.assertEqual(result["status"], "BLOCKED")
        self.assertIsNone(result["syncCompleted"])
        self.assertFalse(result["clusterChanged"])
        self.assertNotIn("private", output.getvalue())


if __name__ == "__main__":
    unittest.main()
