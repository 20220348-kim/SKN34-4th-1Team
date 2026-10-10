"""Kubernetes PVC capture reuses the existing encrypted Ops archive contract."""

import base64
import copy
import hashlib
import json
import unittest
from unittest.mock import patch

import evaluation_snapshot as evaluation
import ops_runtime_keys as keys
import ops_state_snapshot as snapshot

IMAGE = "prefecthq/prefect@sha256:" + "a" * 64
SETTINGS = {"mode": "gitops", "repository": "alice/project"}


def resources():
    rows = {
        ("namespace", evaluation.NAMESPACE): {"metadata": {"uid": "ns"}},
        ("pods", "-o"): {"items": []},
        ("statefulsets,daemonsets,jobs,cronjobs,hpa", "-o"): {"items": []},
    }
    deployments = []
    for name in evaluation.COMPONENTS:
        container = {"name": name, "image": IMAGE, "env": []}
        spec = {"containers": [container]}
        if name != "ops-artifacts":
            kind, path = ("prefect", "/data") if name == "prefect" else ("results", "/results")
            container["volumeMounts"] = [{"name": "data", "mountPath": path}]
            if name == "prefect":
                container["env"] = [
                    {"name": "PREFECT_HOME", "value": "/tmp/prefect"},
                    {
                        "name": "PREFECT_SERVER_DATABASE_CONNECTION_URL",
                        "value": "sqlite+aiosqlite:////data/prefect.db",
                    },
                ]
            spec["volumes"] = [{"name": "data", "persistentVolumeClaim": {"claimName": kind}}]
            rows["pvc", kind] = {
                "metadata": {"uid": kind},
                "status": {"phase": "Bound"},
                "spec": {"volumeName": "pv-" + kind},
            }
            rows["pv", "pv-" + kind] = {
                "metadata": {"name": "pv-" + kind, "uid": "pv-" + kind},
                "spec": {
                    "persistentVolumeReclaimPolicy": "Retain",
                    "claimRef": {"uid": kind, "name": kind, "namespace": evaluation.NAMESPACE},
                },
            }
        deployments.append(
            {
                "metadata": {
                    "name": name,
                    "uid": name,
                    "generation": 2,
                    "annotations": {
                        "argocd.argoproj.io/tracking-id": f"govbiz-evaluation-{name}:apps/Deployment:{evaluation.NAMESPACE}/{name}"
                    },
                },
                "spec": {"replicas": 0, "template": {"spec": spec}},
                "status": {"observedGeneration": 2},
            }
        )
        rows["application", "govbiz-evaluation-" + name] = {
            "metadata": {"uid": "app-" + name},
            "spec": {
                "project": evaluation.NAMESPACE,
                "destination": {
                    "server": "https://kubernetes.default.svc",
                    "namespace": evaluation.NAMESPACE,
                },
                "source": {
                    "repoURL": "https://github.com/alice/project.git",
                    "targetRevision": "b" * 40,
                    "path": "infrastructure/gitops/charts/govbiz-evaluation",
                    "helm": {"valuesObject": {"image": IMAGE}},
                },
                "syncPolicy": {"automated": {"enabled": False, "prune": False, "selfHeal": False}},
            },
            "status": {"operationState": {"phase": "Succeeded"}},
        }
    rows["deployments", "-o"] = {"items": deployments}
    return rows


class EvaluationSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.rows = resources()
        self.read = self.enterContext(
            patch.object(evaluation.database, "read_json", side_effect=self.resource)
        )

    def resource(self, args):
        index = args.index("get")
        return self.rows[tuple(args[index + 1 : index + 3])]

    def observe(self):
        return evaluation.observe(["kubectl"], SETTINGS)

    def test_frozen_source_records_pvc_and_argo_identity_without_data_or_secrets(self):
        result = self.observe()
        self.assertEqual(result["stores"]["results"]["claim_uid"], "results")
        self.assertEqual(result["deployments"]["prefect"]["image"], IMAGE)
        self.assertFalse(any("secret" in call.args[0] for call in self.read.call_args_list))
        original = result
        self.rows["pvc", "results"]["metadata"]["uid"] = "replacement"
        with self.assertRaises(ValueError):
            self.observe()
        self.rows["pv", "pv-results"]["spec"]["claimRef"]["uid"] = "replacement"
        self.assertNotEqual(original, self.observe())

    def test_active_writers_auto_sync_and_indirect_sqlite_fail_before_read(self):
        original = copy.deepcopy(self.rows)
        for change in (
            "pod",
            "replica",
            "autosync",
            "envFrom",
            "database",
            "reclaim",
            "unobserved",
        ):
            self.rows = copy.deepcopy(original)
            writer = self.rows["deployments", "-o"]["items"][0]
            container = writer["spec"]["template"]["spec"]["containers"][0]
            if change == "pod":
                self.rows["pods", "-o"]["items"] = [{}]
            if change == "replica":
                writer["spec"]["replicas"] = 1
            if change == "unobserved":
                writer["status"]["observedGeneration"] = 1
            if change == "autosync":
                self.rows["application", "govbiz-evaluation-prefect"]["spec"]["syncPolicy"][
                    "automated"
                ]["enabled"] = True
            if change == "envFrom":
                container["envFrom"] = [{"secretRef": {"name": "other"}}]
            if change == "database":
                container["env"].append(
                    {
                        "name": "PREFECT_API_DATABASE_CONNECTION_URL",
                        "valueFrom": {"secretKeyRef": {"name": "other", "key": "url"}},
                    }
                )
            if change == "reclaim":
                self.rows["pv", "pv-results"]["spec"]["persistentVolumeReclaimPolicy"] = "Delete"
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.observe()

    def test_collection_reads_only_source_and_requires_uid_scoped_cleanup(self):
        source = self.observe()
        entries = {
            ".": {
                "kind": "directory",
                "mode": 0o755,
                "uid": 10001,
                "gid": 10001,
                "mtime_ns": 1,
                "size": 0,
            },
            "report": {
                "kind": "file",
                "mode": 0o600,
                "uid": 10001,
                "gid": 10001,
                "mtime_ns": 1,
                "size": 1,
                "data": "YQ==",
                "sha256": hashlib.sha256(b"a").hexdigest(),
            },
        }
        manifests, deletes = [], []

        def run(args, **kwargs):
            if "create" in args:
                item = json.loads(kwargs["data"])
                manifests.append(item)
                return json.dumps({"metadata": {"uid": item["kind"]}}).encode()
            if "exec" in args:
                return json.dumps(entries).encode()
            if "delete" in args:
                deletes.append(json.loads(kwargs["data"])["preconditions"])
            return b"{}"

        with patch.object(evaluation.database.storage, "run", side_effect=run):
            self.assertEqual(evaluation.collect(["kubectl"], source, "results", "helper"), entries)
        policy, pod = manifests
        self.assertEqual(policy["spec"]["egress"], [])
        self.assertFalse(pod["spec"]["automountServiceAccountToken"])
        self.assertNotIn("fsGroup", pod["spec"]["securityContext"])
        self.assertTrue(pod["spec"]["volumes"][0]["persistentVolumeClaim"]["readOnly"])
        self.assertTrue(pod["spec"]["containers"][0]["volumeMounts"][0]["readOnly"])
        self.assertEqual(deletes, [{"uid": "Pod"}, {"uid": "NetworkPolicy"}])

        def fail_cleanup(args, **kwargs):
            if "delete" in args:
                raise ValueError("cleanup failed")
            return run(args, **kwargs)

        with (
            patch.object(evaluation.database.storage, "run", side_effect=fail_cleanup),
            self.assertRaises(ValueError),
        ):
            evaluation.collect(["kubectl"], source, "results", "helper")

    def test_token_capture_uses_kubernetes_consumers_and_rejects_rotation(self):
        source = {"namespace": "govbiz-msa", "evaluation": self.observe()}
        for key, name, secret, env_name in (
            ("artifact", "ops-artifacts", "llmops-artifacts", "LLMOPS_ARTIFACT_TOKEN"),
            ("budget", "evaluation-runner", "llmops-runner", "LLMOPS_BUDGET_TOKEN"),
        ):
            deployment = next(
                row
                for row in self.rows["deployments", "-o"]["items"]
                if row["metadata"]["name"] == name
            )
            container = deployment["spec"]["template"]["spec"]["containers"][0]
            container["env"] = [
                {"name": env_name, "valueFrom": {"secretKeyRef": {"name": secret, "key": env_name}}}
            ]
            source["evaluation"]["deployments"][name]["spec_sha256"] = evaluation.fingerprint(
                deployment["spec"]
            )
            self.rows["deployment", name] = deployment
            self.rows["secret", secret] = {
                "type": "Opaque",
                "metadata": {
                    "name": secret,
                    "namespace": evaluation.NAMESPACE,
                    "uid": secret,
                    "resourceVersion": "1",
                },
                "data": {env_name: base64.b64encode((key + "x" * 40).encode()).decode()},
            }

        def read(args):
            return [{"Id": "image"}] if args[0] == "docker" else self.resource(args)

        with patch.object(evaluation.database, "read_json", side_effect=read):
            values, versions = keys.evaluation_tokens(
                ["kubectl", "-n", "govbiz-msa"], source, {"image"}
            )
            self.assertEqual(values["budget"], "budget" + "x" * 40)
            self.assertEqual(versions["llmops-runner"]["version"], "1")
            self.rows["deployment", "evaluation-runner"]["spec"]["replicas"] = 1
            with self.assertRaises(ValueError):
                keys.evaluation_tokens(["kubectl", "-n", "govbiz-msa"], source, {"image"})

    def test_archive_capture_dispatches_pvc_without_touching_compose(self):
        before = {"evaluation": self.observe()}
        with (
            patch.object(snapshot.database, "commands", return_value=(["kubectl"], [], [])),
            patch.object(evaluation, "collect", return_value={"fixture": True}) as collect,
            patch.object(snapshot, "volume_helper") as compose,
        ):
            self.assertEqual(
                snapshot.collect_source("state", SETTINGS, before, "results", {}), {"fixture": True}
            )
            collect.assert_called_once_with(
                ["kubectl"], before["evaluation"], "results", snapshot.HELPER
            )
            compose.assert_not_called()


if __name__ == "__main__":
    unittest.main()
