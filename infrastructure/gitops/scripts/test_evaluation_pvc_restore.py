"""Real SQLite/file restore checks and bounded Kubernetes orchestration guards."""

import base64
import copy
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

import evaluation_pvc_probe as probe
import evaluation_pvc_restore as restore
import yaml
from smoke_evaluation_pvc import fixture


@unittest.skipUnless(os.name == "posix", "PVC ownership checks require Linux")
class FileTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.stores, self.expected = fixture(self.source)
        self.target = self.root / "target"
        for kind in self.stores:
            (self.target / kind).mkdir(parents=True)
        # Exercise real chown/chmod as the current unprivileged test identity.
        # The required kind smoke separately proves the fixed production 10001.
        for name, value in (("UID", os.getuid()), ("GID", os.getgid())):
            patcher = patch.object(probe, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_committed_wal_completed_links_and_reports_survive_new_process(self):
        before = copy.deepcopy(self.stores)
        # Run the exact bundled helper in two independent Python processes. Only
        # the fixture root and test UID/GID differ from its fixed Pod entry point.
        script = (
            "import json,sys,os; from pathlib import Path; v=json.load(sys.stdin); "
            "n={'__name__':'pvc_probe'}; exec(v.pop('program'),n); "
            "n['UID']=os.getuid(); n['GID']=os.getgid(); "
            "print(json.dumps(n[v['action']](v['input'],v['expected'],Path(sys.argv[1]))))"
        )

        def child(action, value):
            return json.loads(
                subprocess.run(
                    [sys.executable, "-B", "-c", script, str(self.target)],
                    input=json.dumps(
                        {
                            "program": restore.helper_program(),
                            "action": action,
                            "input": value,
                            "expected": self.expected,
                        }
                    ),
                    text=True,
                    capture_output=True,
                    check=True,
                    timeout=15,
                ).stdout
            )

        evidence = child("restore", self.stores)
        result = child("verify", evidence)
        self.assertEqual(result["matched_completed_evaluations"], 1)
        self.assertTrue(result["runtime_writable"])
        self.assertTrue(result["sqlite_integrity"])
        self.assertEqual(self.stores, before)
        self.assertTrue(evidence["prefect"]["archive"]["permissions_verified"])
        self.assertEqual(evidence["prefect"]["archive"]["matched_executions"], 1)
        self.assertNotIn(next(iter(self.expected)), json.dumps(result))
        self.assertFalse(list(self.target.rglob(".govbiz-pvc-write-probe")))

    def test_existing_second_target_is_rejected_before_first_store_write(self):
        keep = self.target / "results" / "keep"
        keep.write_text("preserve")
        with self.assertRaisesRegex(ValueError, "empty"):
            probe.restore(self.stores, self.expected, self.target)
        self.assertEqual(list((self.target / "prefect").iterdir()), [])
        self.assertEqual(keep.read_text(), "preserve")

    def test_sqlite_inspection_connections_are_closed_before_permission_mapping(self):
        connections = []
        connect = sqlite3.connect

        def opened(*args, **kwargs):
            connection = connect(*args, **kwargs)
            connections.append(connection)
            return connection

        with patch.object(sqlite3, "connect", side_effect=opened):
            probe.probe.check_prefect(self.source / "prefect", self.expected)
            probe.probe.sqlite_digest(self.source / "prefect")
        self.assertEqual(len(connections), 2)
        for connection in connections:
            with self.assertRaises(sqlite3.ProgrammingError):
                connection.execute("SELECT 1")

    def test_corrupt_content_path_and_wrong_report_cannot_pass(self):
        for defect in ("digest", "path", "report", "sqlite"):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as folder:
                target = Path(folder)
                for kind in self.stores:
                    (target / kind).mkdir()
                stores, expected = (
                    copy.deepcopy(self.stores),
                    copy.deepcopy(self.expected),
                )
                if defect == "digest":
                    stores["prefect"]["prefect.db"]["sha256"] = "0" * 64
                elif defect == "path":
                    stores["prefect"]["../escape"] = stores["prefect"]["prefect.db"]
                elif defect == "report":
                    expected[next(iter(expected))]["report_sha256"] = "0" * 64
                else:
                    # Without removing WAL, its committed pages may correctly
                    # recover the deliberately corrupted main database file.
                    stores["prefect"].pop("prefect.db-wal", None)
                    stores["prefect"].pop("prefect.db-shm", None)
                    row = stores["prefect"]["prefect.db"]
                    raw = b"not a database"
                    row.update(
                        data=base64.b64encode(raw).decode(),
                        size=len(raw),
                        sha256=hashlib.sha256(raw).hexdigest(),
                    )
                with self.assertRaises((ValueError, sqlite3.DatabaseError)):
                    probe.restore(stores, expected, target)

    def test_content_permission_and_runtime_identity_changes_fail(self):
        evidence = probe.restore(self.stores, self.expected, self.target)
        report = next((self.target / "results").rglob("report.html"))
        for defect in ("identity", "mode", "bytes"):
            with self.subTest(defect=defect):
                if defect == "identity":
                    with (
                        patch.object(probe, "UID", os.getuid() + 1),
                        self.assertRaises(ValueError),
                    ):
                        probe.verify(evidence, self.expected, self.target)
                else:
                    raw = report.read_bytes()
                    if defect == "mode":
                        report.chmod(0o777)
                    else:
                        report.write_bytes(raw + b"changed")
                    with self.assertRaises(ValueError):
                        probe.verify(evidence, self.expected, self.target)
                    report.write_bytes(raw)
                    report.chmod(0o640)


class KubernetesTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.fail = None
        with tempfile.TemporaryDirectory() as folder:
            self.stores, self.expected = fixture(Path(folder))
        self.namespace = None
        self.token = None
        self.storage_name = None
        self.policy = None
        self.pods = {}
        self.pv_reads = 0
        for owner, name, function in (
            (restore, "run", self.fake_run),
            (restore.snapshot.storage, "run", self.command),
        ):
            patcher = patch.object(owner, name, side_effect=function)
            patcher.start()
            self.addCleanup(patcher.stop)

    def command(self, args, **kwargs):
        self.events.append((args, None))
        if self.fail == "cleanup" and "namespace" in args and "delete" in args:
            raise ValueError("cleanup failure")
        if "delete" in args and "pod" in args:
            name = args[args.index("pod") + 1]
            if self.fail == "helper_cleanup":
                raise ValueError("helper cleanup failure")
            self.pods.pop(name, None)
        return b""

    def fake_run(self, args, *, value=None, timeout=60):
        self.events.append((args, value))
        if "get" in args and "namespace" in args and "--ignore-not-found" in args:
            return (
                {"metadata": {"name": restore.MIGRATION_NAMESPACE}}
                if self.fail == "collision"
                else None
            )
        if "storageclass" in args and "standard" in args:
            return {
                "provisioner": "foreign"
                if self.fail == "class"
                else "rancher.io/local-path",
                "volumeBindingMode": "WaitForFirstConsumer",
                "reclaimPolicy": "Delete",
            }
        if "create" in args:
            if value["kind"] == "StorageClass" and self.fail == "class_collision":
                raise ValueError("existing storage class")
            if value["kind"] == "Namespace":
                if self.fail == "collision":
                    raise ValueError("already exists")
                self.namespace = value["metadata"]["name"]
                self.token = value["metadata"]["labels"][restore.LABEL]
            if value["kind"] == "StorageClass":
                self.storage_name = value["metadata"]["name"]
                self.policy = value["reclaimPolicy"]
            result = {
                **value,
                "metadata": {
                    **value["metadata"],
                    "uid": "uid-" + value["metadata"]["name"],
                },
            }
            if value["kind"] == "Pod":
                self.pods[value["metadata"]["name"]] = result
            return result
        if "get" in args:
            if "node" in args:
                return {
                    "metadata": {
                        "name": "fixture-control-plane",
                        "labels": {"kubernetes.io/hostname": "fixture-control-plane"},
                    },
                    "status": {"conditions": [{"type": "Ready", "status": "True"}]},
                }
            if any("pods," in part for part in args):
                return {"items": list(self.pods.values())}
            if "pods" in args:
                return {"items": list(self.pods.values())}
            if "pod" in args:
                return self.pods[args[args.index("pod") + 1]]
            if "namespace" in args or "storageclass" in args:
                name = self.storage_name if "storageclass" in args else self.namespace
                return {
                    "metadata": {
                        "name": name,
                        "uid": "foreign"
                        if self.fail == "owner"
                        or (self.fail == "class_owner" and "storageclass" in args)
                        else "uid-" + name,
                        "labels": {restore.LABEL: self.token},
                    },
                    "status": {"phase": "Active"},
                    "provisioner": "rancher.io/local-path",
                    "volumeBindingMode": "WaitForFirstConsumer",
                    "reclaimPolicy": self.policy,
                }
            if "pvc" in args:
                name = args[args.index("pvc") + 1]
                return {
                    "metadata": {
                        "name": name,
                        "namespace": self.namespace,
                        "uid": "uid-" + name,
                        "labels": {restore.LABEL: self.token},
                    },
                    "status": {"phase": "Bound"},
                    "spec": {
                        "volumeName": "pv-" + name,
                        "storageClassName": self.storage_name,
                    },
                }
            if "pv" in args:
                name = args[args.index("pv") + 1]
                kind = name.removeprefix("pv-")
                self.pv_reads += 1
                return {
                    "metadata": {
                        "name": name,
                        "uid": "replaced-pv"
                        if self.fail == "pv_changed" and self.pv_reads > 2
                        else "uid-" + name,
                        "annotations": {
                            "pv.kubernetes.io/provisioned-by": "rancher.io/local-path"
                        },
                    },
                    "status": {"phase": "Bound"},
                    "spec": {
                        "nodeAffinity": {
                            "required": {
                                "nodeSelectorTerms": [
                                    {
                                        "matchExpressions": [
                                            {
                                                "key": "kubernetes.io/hostname",
                                                "operator": "In",
                                                "values": ["fixture-control-plane"],
                                            }
                                        ]
                                    }
                                ]
                            }
                        },
                        "claimRef": {
                            "uid": "foreign" if self.fail == "pv" else "uid-" + kind,
                            "name": kind,
                            "namespace": self.namespace,
                        },
                        "persistentVolumeReclaimPolicy": "Delete"
                        if self.fail == "retention"
                        else self.policy,
                        "storageClassName": self.storage_name,
                    },
                }
        if "exec" in args:
            self.assertIn("program", value)
            compile(value["program"], "helper", "exec")
            if self.fail == "restore" and value["action"] == "restore":
                raise ValueError("private restored data")
            if value["action"] == "restore":
                return {
                    kind: {
                        "archive": {
                            "status": "VERIFIED",
                            "permissions_verified": True,
                            "tree_sha256": hashlib.sha256(
                                json.dumps(entries, sort_keys=True).encode()
                            ).hexdigest(),
                            "matched_executions": 1,
                            "sqlite_integrity": True,
                        }
                    }
                    for kind, entries in self.stores.items()
                }
            return {
                "status": "VERIFIED",
                "matched_completed_evaluations": 0 if self.fail == "proof" else 1,
                "runtime_uid": 10001,
                "runtime_gid": 10001,
                "model_api_calls": 0,
                "pod_replacement_preserved_data": True,
                "runtime_writable": True,
                "sqlite_integrity": True,
            }
        self.fail_test(args)

    def fail_test(self, args):
        self.fail = "unexpected"
        raise AssertionError(args)

    def rehearse(self):
        return restore.rehearse(
            ["kubectl", "--context", "kind-fixture"],
            "fixture-control-plane",
            self.stores,
            self.expected,
        )

    def test_new_pvcs_pod_replacement_and_runtime_privileges(self):
        result = self.rehearse()
        self.assertTrue(result["cleanup_complete"])
        self.assertFalse(result["production_storage_restored"])
        self.assertFalse(result["application_started"])
        pods = [
            value for _, value in self.events if value and value.get("kind") == "Pod"
        ]
        self.assertEqual(len(pods), 2)
        for index, item in enumerate(pods):
            spec = item["spec"]
            self.assertEqual(
                spec["securityContext"]["runAsUser"], 10001 if index else 0
            )
            self.assertFalse(spec["automountServiceAccountToken"])
            self.assertNotIn("nodeName", spec)
            self.assertNotIn("hostNetwork", spec)
            self.assertTrue(
                all("hostPath" not in v and "secret" not in v for v in spec["volumes"])
            )
            container = spec["containers"][0]
            self.assertNotIn("env", container)
            self.assertTrue(container["securityContext"]["readOnlyRootFilesystem"])
            self.assertFalse(container["securityContext"]["allowPrivilegeEscalation"])
        self.assertEqual(
            pods[1]["spec"]["containers"][0]["securityContext"]["capabilities"],
            {"drop": ["ALL"]},
        )
        deletes = [args for args, _ in self.events if "delete" in args]
        self.assertTrue(any("restore" in args and "pod" in args for args in deletes))
        self.assertTrue(
            any(self.namespace in args and "namespace" in args for args in deletes)
        )
        self.assertFalse(
            any("--force" in args or "apply" in args for args, _ in self.events)
        )
        claims = [
            value
            for _, value in self.events
            if value and value.get("kind") == "PersistentVolumeClaim"
        ]
        self.assertEqual(len(claims), 2)
        self.assertTrue(
            all(item["spec"]["storageClassName"] == self.namespace for item in claims)
        )
        self.assertTrue(
            any("storageclass" in args and self.namespace in args for args in deletes)
        )
        private = self.stores["prefect"]["prefect.db"]["data"]
        self.assertNotIn(private, json.dumps([args for args, _ in self.events]))
        self.assertNotIn(
            private,
            json.dumps([value for args, value in self.events if "create" in args]),
        )

    def test_unsafe_targets_bad_proof_and_cleanup_fail_closed(self):
        for defect in (
            "class",
            "collision",
            "class_collision",
            "pv",
            "restore",
            "proof",
            "owner",
            "class_owner",
            "cleanup",
        ):
            self.events = []
            self.fail = defect
            with self.subTest(defect=defect), self.assertRaises(ValueError):
                self.rehearse()
            deletes = [
                args
                for args, _ in self.events
                if "delete" in args and "namespace" in args
            ]
            self.assertEqual(
                bool(deletes), defect not in {"class", "collision", "owner"}
            )
            if defect in {"class", "collision", "pv"}:
                self.assertFalse(any("exec" in args for args, _ in self.events))
            if defect in {"class_collision", "class_owner"}:
                self.assertFalse(
                    any(
                        "delete" in args and "storageclass" in args
                        for args, _ in self.events
                    )
                )

    def test_bad_input_rejected_without_cluster_calls(self):
        for expected, image in (({}, None), (self.expected, "python:latest")):
            self.events = []
            with self.assertRaises(ValueError):
                restore.rehearse(
                    ["kubectl"],
                    "fixture-control-plane",
                    self.stores,
                    expected,
                    image=image,
                )
            self.assertEqual(self.events, [])

    def test_runtime_failure_still_removes_verified_claims(self):
        with (
            self.assertRaisesRegex(ValueError, "application failed"),
            restore.restored_pvcs(
                ["kubectl", "--context", "kind-fixture"],
                "fixture-control-plane",
                self.stores,
                self.expected,
            ) as (namespace, result),
        ):
            self.assertEqual(namespace, self.namespace)
            self.assertEqual(result["status"], "VERIFIED")
            self.assertFalse(
                any("namespace" in args and "delete" in args for args, _ in self.events)
            )
            self.assertTrue(
                any("verify" in args and "delete" in args for args, _ in self.events)
            )
            raise ValueError("application failed")
        self.assertTrue(
            any("namespace" in args and "delete" in args for args, _ in self.events)
        )
        self.assertTrue(
            any("storageclass" in args and "delete" in args for args, _ in self.events)
        )

    def retained(self):
        return restore.retain_for_migration(
            ["kubectl"], "fixture-control-plane", self.stores, self.expected
        )

    def test_retained_inspection_reads_current_identities_without_writes(self):
        report = self.retained()
        self.events.clear()
        observed = restore.inspect_retained(
            ["kubectl"], "fixture-control-plane", report
        )
        self.assertEqual(observed["claims"], report["claims"])
        self.assertTrue(observed["identity_verified"])
        self.assertTrue(observed["workloads_absent"])
        for field in (
            "data_reverified",
            "archive_freshness_verified",
            "source_quiescence_verified",
        ):
            self.assertIs(observed[field], False)
        self.assertTrue(
            all("get" in args and value is None for args, value in self.events)
        )

    def test_retained_inspection_rejects_stale_report_and_live_storage_changes(self):
        report = self.retained()
        for change in (
            {"scope": "disposable_kubernetes_evaluation_pvc"},
            {"status": "FAIL"},
            {"helpers_removed": False},
            {"application_started": True},
            {"node": "other-node"},
            {"namespace_uid": "replaced"},
            {"storage_class_uid": "replaced"},
            {"claims": {"prefect": report["claims"]["prefect"]}},
            {
                "claims": report["claims"]
                | {"results": report["claims"]["results"] | {"pv_uid": "replaced"}}
            },
        ):
            with self.subTest(change=change), self.assertRaises(ValueError):
                restore.inspect_retained(
                    ["kubectl"], "fixture-control-plane", report | change
                )
        mutations = [
            ("namespace", ["metadata", "deletionTimestamp"], "now"),
            ("namespace", ["status", "phase"], "Terminating"),
            ("storageclass", ["reclaimPolicy"], "Delete"),
            ("storageclass", ["provisioner"], "other"),
            ("storageclass", ["volumeBindingMode"], "Immediate"),
            ("pvc", ["metadata", "deletionTimestamp"], "now"),
            ("pvc", ["metadata", "uid"], "replacement"),
            ("pv", ["metadata", "deletionTimestamp"], "now"),
            ("pv", ["status", "phase"], "Released"),
            ("pv", ["spec", "persistentVolumeReclaimPolicy"], "Delete"),
            ("pv", ["spec", "claimRef", "uid"], "replacement"),
            ("pv", ["spec", "nodeAffinity"], {}),
            ("node", ["status", "conditions"], []),
            ("node", ["metadata", "labels", "kubernetes.io/hostname"], "other"),
        ]
        for resource, keys, value in mutations:

            def changed(args, resource=resource, keys=keys, value=value, **kwargs):
                result = self.fake_run(args, **kwargs)
                if resource in args:
                    target = result
                    for key in keys[:-1]:
                        target = target[key]
                    target[keys[-1]] = value
                return result

            self.events.clear()
            with (
                self.subTest(resource=resource, keys=keys),
                patch.object(restore, "run", side_effect=changed),
                self.assertRaises(ValueError),
            ):
                restore.inspect_retained(["kubectl"], "fixture-control-plane", report)
            self.assertTrue(
                all("get" in args and value is None for args, value in self.events)
            )
        for kind in ("Pod", "Deployment", "Job", "CronJob"):
            self.pods = {"writer": {"kind": kind}}
            with (
                self.subTest(workload=kind),
                self.assertRaisesRegex(ValueError, "workloads"),
            ):
                restore.inspect_retained(["kubectl"], "fixture-control-plane", report)

    def test_retained_restore_keeps_identified_volumes_without_starting_services(self):
        result = self.retained()
        self.assertEqual(result["status"], "RESTORED_NOT_ACTIVATED")
        self.assertEqual(result["namespace"], "govbiz-evaluation")
        self.assertNotEqual(result["storage_class"], result["namespace"])
        self.assertEqual(result["reclaim_policy"], "Retain")
        self.assertEqual(set(result["claims"]), {"prefect", "results"})
        self.assertTrue(result["helpers_removed"])
        self.assertTrue(result["resources_retained"])
        for name in (
            "application_started",
            "services_changed",
            "production_cutover",
            "archive_freshness_verified",
            "source_quiescence_verified",
        ):
            self.assertFalse(result[name])
        self.assertEqual(self.pods, {})
        self.assertEqual(self.pv_reads, 4)
        deletes = [args for args, _ in self.events if "delete" in args]
        self.assertEqual(len(deletes), 2)
        self.assertTrue(all("pod" in args for args in deletes))
        self.assertFalse(
            any(
                value and value.get("kind") in {"Deployment", "Secret", "Service"}
                for _, value in self.events
            )
        )
        self.assertNotIn(next(iter(self.expected)), json.dumps(result))

    def test_failed_retained_restore_never_deletes_storage_or_reports_success(self):
        for defect in (
            "class",
            "collision",
            "class_collision",
            "pv",
            "restore",
            "proof",
            "retention",
            "pv_changed",
            "owner",
            "class_owner",
            "helper_cleanup",
        ):
            self.events = []
            self.pods = {}
            self.pv_reads = 0
            self.fail = defect
            with self.subTest(defect=defect), self.assertRaises(ValueError):
                self.retained()
            deletes = [args for args, _ in self.events if "delete" in args]
            self.assertTrue(all("pod" in args for args in deletes))
            if defect not in {"owner", "helper_cleanup"}:
                self.assertEqual(self.pods, {})
            if defect in {"class", "collision", "class_collision", "pv", "retention"}:
                self.assertFalse(any("exec" in args for args, _ in self.events))

    def test_retained_cleanup_refuses_foreign_pods_without_deleting_them(self):
        self.retained()
        for defect in ("name", "uid", "label"):
            self.events = []
            item = {
                "metadata": {
                    "name": "verify",
                    "namespace": self.namespace,
                    "uid": "original",
                    "labels": {restore.LABEL: self.token},
                }
            }
            if defect == "name":
                item["metadata"]["name"] = "foreign"
            elif defect == "label":
                item["metadata"]["labels"] = {}
            self.pods = {item["metadata"]["name"]: item}

            def changed(args, defect=defect, **kwargs):
                value = copy.deepcopy(self.fake_run(args, **kwargs))
                if defect == "uid" and "get" in args and "pod" in args:
                    value["metadata"]["uid"] = "replaced"
                return value

            with (
                self.subTest(defect=defect),
                patch.object(restore, "run", side_effect=changed),
                self.assertRaises(ValueError),
            ):
                restore.remove_retained_helpers(
                    ["kubectl"],
                    ["kubectl", "-n", self.namespace],
                    self.namespace,
                    self.token,
                    "uid-" + self.namespace,
                )
            self.assertTrue(self.pods)
            self.assertFalse(any("delete" in args for args, _ in self.events))

    def test_caller_failure_cannot_delete_retained_storage(self):
        with (
            self.assertRaisesRegex(ValueError, "caller failed"),
            restore.restored_pvcs(
                ["kubectl"],
                "fixture-control-plane",
                self.stores,
                self.expected,
                retain=True,
            ),
        ):
            raise ValueError("caller failed")
        self.assertTrue(
            all("pod" in args for args, _ in self.events if "delete" in args)
        )


class ArchiveTests(unittest.TestCase):
    def test_actual_pvc_smoke_is_mandatory_in_required_llmops_ci(self):
        workflow = yaml.safe_load(
            (
                restore.fork_cluster.REPOSITORY_ROOT / ".github/workflows/llmops-ci.yml"
            ).read_text(encoding="utf-8")
        )
        steps = workflow["jobs"]["integration"]["steps"]
        checks = [
            step
            for step in steps
            if "scripts/smoke_evaluation_pvc.py" in step.get("run", "")
        ]
        self.assertEqual(len(checks), 1)
        self.assertNotIn("if", checks[0])
        self.assertNotIn("continue-on-error", checks[0])
        self.assertEqual(workflow["jobs"]["merge-readiness"]["needs"], ["integration"])

    def test_only_store_data_and_db_verified_links_reach_kubernetes(self):
        events = []
        payload = {
            "database": {"sql": "private SQL"},
            "runtime_keys": {"key": "private key"},
            "stores": {
                kind: {"entries": {"fixture": kind}} for kind in ("prefect", "results")
            },
        }

        @contextmanager
        def database(value):
            events.append("db-start")
            yield ["disposable-mysql"]
            events.append("db-removed")

        def rehearse(kube, node, stores, expected):
            self.assertEqual(events, ["db-start", "db-removed"])
            self.assertNotIn("private", json.dumps(stores))
            self.assertEqual(expected, {"from": "database"})
            return {"status": "VERIFIED"}

        with (
            patch.object(
                restore.fork_cluster,
                "load_settings",
                return_value={"cluster": "fixture"},
            ),
            patch.object(
                restore.fork_cluster, "commands", return_value=(["kubectl"], [], [])
            ),
            patch.object(restore.fork_cluster, "verify_context"),
            patch.object(
                restore.snapshot.database, "read_archive", return_value=b"encrypted"
            ),
            patch.object(restore.snapshot.storage, "key_bytes", return_value=b"key"),
            patch.object(
                restore.snapshot.storage, "open_payload", return_value=payload
            ),
            patch.object(restore.snapshot, "validate", side_effect=lambda value: value),
            patch.object(
                restore.snapshot.database, "restored_database", side_effect=database
            ),
            patch.object(
                restore.snapshot,
                "completed_evidence",
                return_value={"from": "database"},
            ),
            patch.object(restore, "rehearse", side_effect=rehearse) as disposable,
            patch.object(
                restore, "retain_for_migration", side_effect=rehearse
            ) as retained,
        ):
            result = restore.verify_archive("state", "archive", "key")
            retained.assert_not_called()
            disposable.assert_called_once()
            events.clear()
            retained_result = restore.verify_archive(
                "state", "archive", "key", retain=True
            )
            retained.assert_called_once()
        self.assertTrue(result["cross_store_business_links_verified"])
        self.assertTrue(retained_result["cross_store_business_links_verified"])
        self.assertEqual(
            retained_result["archive_sha256"], hashlib.sha256(b"encrypted").hexdigest()
        )

    def test_cli_failure_does_not_expose_private_subprocess_details(self):
        with (
            patch("sys.argv", ["probe", "--archive", "private", "--key-file", "key"]),
            patch.object(
                restore, "verify_archive", side_effect=ValueError("private archive SQL")
            ),
            patch("sys.stderr") as error,
            patch("builtins.print") as output,
            self.assertRaises(SystemExit) as result,
        ):
            restore.main()
        self.assertEqual(result.exception.code, 1)
        output.assert_not_called()
        self.assertNotIn("private archive SQL", str(error.write.call_args_list))

    def test_retained_cli_requires_explicit_option_and_reports_preserved_storage(self):
        with (
            patch(
                "sys.argv",
                [
                    "probe",
                    "--archive",
                    "private",
                    "--key-file",
                    "key",
                    "--retain-for-migration",
                ],
            ),
            patch.object(
                restore, "verify_archive", side_effect=ValueError("private archive SQL")
            ) as verify,
            patch.object(restore.os, "name", "posix"),
            patch("sys.stderr") as error,
            patch("builtins.print") as output,
            self.assertRaises(SystemExit) as result,
        ):
            restore.main()
        self.assertEqual(result.exception.code, 1)
        self.assertTrue(verify.call_args.kwargs["retain"])
        self.assertIn(
            "storage was not automatically deleted", str(error.write.call_args_list)
        )
        self.assertNotIn("private archive SQL", str(error.write.call_args_list))
        output.assert_not_called()


if __name__ == "__main__":
    unittest.main()
