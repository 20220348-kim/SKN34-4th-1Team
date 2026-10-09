"""Bounded read-only PVC probe lifecycle, admission drift and cleanup failures."""

import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import evaluation_retained_data as data
from smoke_evaluation_pvc import fixture


class RetainedDataTests(unittest.TestCase):
    def setUp(self):
        with tempfile.TemporaryDirectory() as directory:
            self.stores, _ = fixture(Path(directory))
        self.storage = {"namespace_uid": "namespace-uid"}
        self.report = {"claims": "bound by inspector"}
        self.image = "registry.example/helper@sha256:" + "a" * 64
        self.progress, self.events = {}, []
        self.pod = None
        self.defect = None
        self.proof = {
            "status": "VERIFIED",
            "archive_content_matched": True,
            "sqlite_integrity": True,
            "prefect_logical_data_matched": True,
            "runtime_permissions_verified": True,
            "retained_data_unchanged": True,
            "runtime_uid": 10001,
            "runtime_gid": 10001,
            "model_api_calls": 0,
        }
        self.inspector = self.enterContext(
            patch.object(
                data.pvc, "inspect_retained_storage", return_value=self.storage
            )
        )
        self.enterContext(patch.object(data.pvc, "run", side_effect=self.command))
        self.enterContext(
            patch.object(data.pvc.snapshot.storage, "run", side_effect=self.wait)
        )

    def command(self, args, *, value=None, **kwargs):
        self.events.append((args, copy.deepcopy(value)))
        if "create" in args:
            self.pod = copy.deepcopy(value)
            self.pod["metadata"]["uid"] = "pod-uid"
            self.pod["spec"]["nodeName"] = "node"
            if self.defect == "response_loss":
                raise TimeoutError("private create response")
            return copy.deepcopy(self.pod)
        if "get" in args:
            if "pods" in args:
                return {"items": [copy.deepcopy(self.pod)] if self.pod else []}
            return copy.deepcopy(self.pod)
        if "delete" in args:
            self.assertIn("--raw", args)
            self.assertTrue(
                args[args.index("--raw") + 1].startswith(
                    "/api/v1/namespaces/govbiz-evaluation/pods/data-recheck-"
                )
            )
            self.assertEqual(value["preconditions"], {"uid": "pod-uid"})
            if self.defect == "cleanup":
                raise TimeoutError("private cleanup response")
            self.pod = None
            return {"status": "Success"}
        self.assertIn("exec", args)
        self.assertEqual(value["action"], "recheck")
        self.assertEqual(value["stores"], self.stores)
        if self.defect == "probe":
            raise ValueError("private file error")
        return copy.deepcopy(self.proof)

    def wait(self, args, **kwargs):
        self.events.append((args, None))
        if "--for=condition=Ready" in args:
            if self.defect == "readiness":
                raise TimeoutError("private Pod event")
            if self.defect == "replacement":
                self.pod["metadata"]["uid"] = "foreign"
            if self.defect == "admission":
                self.pod["spec"]["volumes"][0]["persistentVolumeClaim"]["readOnly"] = (
                    False
                )
            if self.defect == "labels":
                self.pod["metadata"]["labels"]["app.kubernetes.io/name"] = (
                    "evaluation-runner"
                )
            if self.defect == "environment":
                self.pod["spec"]["containers"][0]["envFrom"] = [
                    {"secretRef": {"name": "foreign"}}
                ]
        return b""

    def recheck(self):
        return data.recheck(
            ["kubectl"], "node", self.report, self.stores, self.image, self.progress
        )

    def test_nonroot_readonly_probe_sends_data_only_via_stdin_and_removes_only_its_pod(
        self,
    ):
        result = self.recheck()
        self.assertTrue(result["cleanup_complete"])
        self.assertTrue(self.progress["cleanupComplete"])
        created = next(value for args, value in self.events if "create" in args)
        spec = created["spec"]
        self.assertEqual(spec["securityContext"]["runAsUser"], 10001)
        self.assertFalse(spec["automountServiceAccountToken"])
        for volume in spec["volumes"]:
            if "persistentVolumeClaim" in volume:
                self.assertTrue(volume["persistentVolumeClaim"]["readOnly"])
        for mount in spec["containers"][0]["volumeMounts"]:
            if mount["name"] != "tmp":
                self.assertTrue(mount["readOnly"])
        args = json.dumps([a for a, _ in self.events])
        raw = next(
            row["data"]
            for row in self.stores["results"].values()
            if row["kind"] == "file"
        )
        self.assertNotIn(raw, args)
        self.assertNotIn(raw, json.dumps(result))
        self.assertIsNone(self.pod)

    def test_failure_and_ambiguous_create_still_clean_up_without_success(self):
        for defect in (
            "response_loss",
            "readiness",
            "probe",
            "admission",
            "labels",
            "environment",
        ):
            self.defect = defect
            with (
                self.subTest(defect=defect),
                self.assertRaises((ValueError, TimeoutError)),
            ):
                self.recheck()
            self.assertIsNone(self.pod)
            self.assertTrue(self.progress["cleanupComplete"])
            self.events.clear()

    def test_foreign_pod_or_failed_cleanup_is_not_reported_as_success(self):
        for defect in ("replacement", "cleanup"):
            self.pod = None
            self.events.clear()
            self.defect = defect
            with (
                self.subTest(defect=defect),
                self.assertRaises((ValueError, TimeoutError)),
            ):
                self.recheck()
            self.assertFalse(self.progress["cleanupComplete"])
            if defect == "replacement":
                self.assertFalse(any("delete" in args for args, _ in self.events))

    def test_existing_pod_or_mutable_image_blocks_before_create(self):
        self.pod = {"metadata": {"name": "existing"}}
        with self.assertRaises(ValueError):
            self.recheck()
        self.pod = None
        self.image = "registry.example/helper:latest"
        with self.assertRaises(ValueError):
            self.recheck()
        self.assertFalse(any("create" in args for args, _ in self.events))

    def test_incomplete_or_wrongly_typed_proof_cannot_succeed(self):
        original = copy.deepcopy(self.proof)
        for key, value in (
            ("model_api_calls", False),
            ("sqlite_integrity", 1),
            ("runtime_uid", 0),
            ("status", "FAILED"),
        ):
            self.proof = {**original, key: value}
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.recheck()
            self.assertTrue(self.progress["cleanupComplete"])

    def test_storage_replacement_after_create_preserves_retained_resources(self):
        self.inspector.side_effect = [
            self.storage,
            {"namespace_uid": "new"},
            {"namespace_uid": "new"},
        ]
        with self.assertRaises(ValueError):
            self.recheck()
        self.assertFalse(any("delete" in args for args, _ in self.events))
        self.assertFalse(self.progress["cleanupComplete"])


if __name__ == "__main__":
    unittest.main()
