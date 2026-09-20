import copy
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import yaml

import sync_images as sync
from test_promote_image import receipt, values

SHA = "c" * 40


def run():
    return {"id": 123, "head_sha": SHA, "head_branch": "develop", "event": "workflow_dispatch",
            "path": ".github/workflows/msa-images.yml", "head_repository": {"full_name": sync.APP},
            "repository": {"id": 456}, "status": "completed", "conclusion": "success"}


def artifact(service="ai-service"):
    return {"id": 789, "name": "msa-image-" + service, "expired": False, "size_in_bytes": 400,
            "workflow_run": {"id": 123, "head_sha": SHA, "head_branch": "develop",
                             "head_repository_id": 456, "repository_id": 456}}


def zipped(data, filename="ai-service.json"):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr(filename, json.dumps(data))
    payload = output.getvalue()
    metadata = artifact()
    metadata["digest"] = "sha256:" + hashlib.sha256(payload).hexdigest()
    return payload, metadata


class SyncTests(unittest.TestCase):
    def test_exact_receipt_and_archive_checksum(self):
        payload, metadata = zipped(receipt())
        self.assertEqual(sync.decode_receipt(payload, metadata, SHA), receipt())
        with self.assertRaises(ValueError):
            sync.decode_receipt(payload + b"tamper", metadata, SHA)

    def test_archive_traversal_and_wrong_revision_rejected(self):
        for filename in ("../ai-service.json", "/ai-service.json", "core-service.json"):
            payload, metadata = zipped(receipt(), filename)
            with self.assertRaises(ValueError):
                sync.decode_receipt(payload, metadata, SHA)
        payload, metadata = zipped({**receipt(), "verifiedRevision": "f" * 40})
        with self.assertRaises(ValueError):
            sync.decode_receipt(payload, metadata, SHA)

    def test_run_is_fixed_repository_branch_workflow_and_event(self):
        self.assertTrue(sync.valid_run(run(), SHA, run()["path"], {"workflow_dispatch"}))
        for changes in ({"head_branch": "feature"}, {"head_repository": {"full_name": "attacker/GovBiz"}},
                        {"event": "pull_request"}, {"conclusion": "failure"}, {"path": "fake.yml"}):
            self.assertFalse(sync.valid_run({**run(), **changes}, SHA, run()["path"], {"workflow_dispatch"}))

    def test_latest_failed_publish_is_not_hidden(self):
        get = lambda _: {"workflow_runs": [{**run(), "id": 124, "conclusion": "failure"}, run()]}
        self.assertIsNone(sync.select_release(SHA, get))

    def test_requires_all_four_unexpired_same_repository_artifacts(self):
        artifacts = [artifact(s) for s in sync.SERVICES]
        def get(path):
            return {"artifacts": artifacts} if "/artifacts?" in path else {"workflow_runs": [run()]}
        self.assertEqual(sync.select_release(SHA, get)[0]["id"], 123)
        for changes in ({"expired": True}, {"workflow_run": {"id": 0}}, {"size_in_bytes": 999999}):
            original = artifacts[0]
            artifacts[0] = {**original, **changes}
            with self.assertRaises(ValueError):
                sync.select_release(SHA, get)
            artifacts[0] = original
        artifacts.pop()
        with self.assertRaises(ValueError):
            sync.select_release(SHA, get)

    def test_input_tree_identity_is_verified_without_executing_source(self):
        receipts = []
        artifacts = []
        payloads = {}
        key = hashlib.sha256(f"v1\nlinux/amd64\n{'d' * 40}\n{'e' * 40}\n".encode()).hexdigest()
        for number, service in enumerate(sync.SERVICES):
            item = {**receipt(), "service": service, "repository": "ghcr.io/govbiz-team/govbiz-" + service,
                    "inputKey": key, "tag": "src-" + key}
            payload, meta = zipped(item, service + ".json")
            meta.update(name="msa-image-" + service, id=number)
            artifacts.append(meta)
            payloads[number] = payload
            receipts.append(item)
        def get(path, binary=False):
            if binary:
                return payloads[int(path.split("/")[-2])]
            return {"tree": [{"path": "backend/" + s, "sha": "d" * 40, "type": "tree"} for s in sync.SERVICES]
                    + [{"path": "infrastructure/release", "sha": "e" * 40, "type": "tree"}]}
        self.assertEqual(sync.checked_receipts(SHA, (run(), artifacts), get), receipts)

    def test_batch_preflight_never_changes_files_on_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            path = root / "environments/portfolio"
            path.mkdir(parents=True)
            receipts = []
            for service in sync.SERVICES:
                r = {**receipt(), "service": service, "repository": "ghcr.io/govbiz-team/govbiz-" + service}
                v = values()
                v["serviceName"] = service
                v["image"]["repository"] = r["repository"]
                (path / (service + ".yaml")).write_text(yaml.safe_dump(v))
                receipts.append(r)
            before = {p: p.read_text() for p in path.iterdir()}
            changes = sync.prepare(root, receipts)
            self.assertEqual(len(changes), 4)
            receipts[-1]["repository"] = "evil.example/image"
            with self.assertRaises(ValueError):
                sync.prepare(root, receipts)
            self.assertEqual({p: p.read_text() for p in path.iterdir()}, before)


if __name__ == "__main__":
    unittest.main()
