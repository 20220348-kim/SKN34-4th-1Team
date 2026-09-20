import copy
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
import shutil
from unittest.mock import patch
import zipfile

import yaml

import sync_images as sync
from test_promote_image import FORK, receipt, values

SHA = "c" * 40


def run():
    return {"id": 123, "head_sha": SHA, "head_branch": "main", "event": "workflow_dispatch",
            "path": ".github/workflows/msa-images.yml", "head_repository": {"full_name": FORK.repository},
            "repository": {"id": 456, "full_name": FORK.repository}, "status": "completed", "conclusion": "success"}


def artifact(service="ai-service"):
    return {"id": 789, "name": "msa-image-" + service, "expired": False, "size_in_bytes": 400,
            "workflow_run": {"id": 123, "head_sha": SHA, "head_branch": "main",
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
        self.assertEqual(sync.decode_receipt(payload, metadata, SHA, FORK), receipt())
        with self.assertRaises(ValueError):
            sync.decode_receipt(payload + b"tamper", metadata, SHA, FORK)

    def test_archive_traversal_and_wrong_revision_rejected(self):
        for filename in ("../ai-service.json", "/ai-service.json", "core-service.json"):
            payload, metadata = zipped(receipt(), filename)
            with self.assertRaises(ValueError):
                sync.decode_receipt(payload, metadata, SHA, FORK)
        payload, metadata = zipped({**receipt(), "verifiedRevision": "f" * 40})
        with self.assertRaises(ValueError):
            sync.decode_receipt(payload, metadata, SHA, FORK)

    def test_run_is_fixed_repository_branch_workflow_and_event(self):
        self.assertTrue(sync.valid_run(run(), SHA, run()["path"], {"workflow_dispatch"}, FORK))
        for changes in ({"head_branch": "feature"}, {"head_repository": {"full_name": "attacker/GovBiz"}},
                        {"event": "pull_request"}, {"conclusion": "failure"}, {"path": "fake.yml"}):
            self.assertFalse(sync.valid_run({**run(), **changes}, SHA, run()["path"], {"workflow_dispatch"}, FORK))

    def test_latest_failed_publish_is_not_hidden(self):
        get = lambda _: {"workflow_runs": [{**run(), "id": 124, "conclusion": "failure"}, run()]}
        self.assertIsNone(sync.select_release(FORK, get))

    def test_requires_all_four_unexpired_same_repository_artifacts(self):
        artifacts = [artifact(s) for s in sync.SERVICES]
        def get(path):
            return {"artifacts": artifacts} if "/artifacts?" in path else {"workflow_runs": [run()]}
        self.assertEqual(sync.select_release(FORK, get)[0]["id"], 123)
        for changes in ({"expired": True}, {"workflow_run": {"id": 0}}, {"size_in_bytes": 999999}):
            original = artifacts[0]
            artifacts[0] = {**original, **changes}
            with self.assertRaises(ValueError):
                sync.select_release(FORK, get)
            artifacts[0] = original
        artifacts.pop()
        with self.assertRaises(ValueError):
            sync.select_release(FORK, get)

    def test_input_tree_identity_is_verified_without_executing_source(self):
        receipts = []
        artifacts = []
        payloads = {}
        key = hashlib.sha256(f"v1\nlinux/amd64\n{'d' * 40}\n{'e' * 40}\n".encode()).hexdigest()
        for number, service in enumerate(sync.SERVICES):
            item = {**receipt(), "service": service, "repository": FORK.image(service),
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
        self.assertEqual(sync.checked_receipts(SHA, (run(), artifacts), FORK, get), receipts)

    def test_batch_preflight_never_changes_files_on_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            path = root / "environments/portfolio"
            path.mkdir(parents=True)
            receipts = []
            for service in sync.SERVICES:
                r = {**receipt(), "service": service, "repository": FORK.image(service)}
                v = values()
                v["serviceName"] = service
                v["image"]["repository"] = r["repository"]
                (path / (service + ".yaml")).write_text(yaml.safe_dump(v))
                receipts.append(r)
            before = {p: p.read_text() for p in path.iterdir()}
            changes = sync.prepare(root, receipts, FORK)
            self.assertEqual(len(changes), 4)
            receipts[-1]["repository"] = "evil.example/image"
            with self.assertRaises(ValueError):
                sync.prepare(root, receipts, FORK)
            self.assertEqual({p: p.read_text() for p in path.iterdir()}, before)

    def test_first_verified_release_creates_only_fork_values_and_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            shutil.copytree(sync.ROOT / "environments/portfolio", root / "environments/portfolio")
            originals = {p.name: p.read_bytes() for p in (root / "environments/portfolio").iterdir()}
            receipts = [{**receipt(), "service": service, "repository": FORK.image(service)}
                        for service in sync.SERVICES]
            with patch.object(sync, "select_release", return_value=(run(), [])), \
                    patch.object(sync, "eligible", return_value=True), \
                    patch.object(sync, "checked_receipts", return_value=receipts):
                sync.synchronize(FORK, root=root, write=True)
            marker = json.loads((root / "environments/fork/release.json").read_text())
            self.assertEqual(sync.validate_record(marker, FORK), marker)
            self.assertEqual(marker["branch"], "main")
            for service in sync.SERVICES:
                item = yaml.safe_load((root / f"environments/fork/{service}.yaml").read_text())
                self.assertEqual(item["image"]["repository"], FORK.image(service))
                self.assertEqual(item["image"]["digest"], receipt()["digest"])
                self.assertEqual(item["imagePullSecrets"], [{"name": "ghcr-pull"}])
                self.assertFalse(item["localMode"])
            self.assertEqual({p.name: p.read_bytes() for p in (root / "environments/portfolio").iterdir()}, originals)
            self.assertEqual(sync.prepare(root, receipts, FORK), {})
            with self.assertRaises(ValueError):
                sync.validate_record(marker, type(FORK)("bob/Example"))

    def test_initial_invalid_receipt_cannot_create_partial_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            shutil.copytree(sync.ROOT / "environments/portfolio", root / "environments/portfolio")
            receipts = [{**receipt(), "service": service, "repository": FORK.image(service)}
                        for service in sync.SERVICES]
            receipts[-1]["repository"] = "ghcr.io/bob/example-ops-service"
            with self.assertRaises(ValueError):
                sync.prepare(root, receipts, FORK)
            self.assertFalse((root / "environments/fork").exists())

    def test_new_fork_replaces_inherited_selection_with_own_verified_images(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            shutil.copytree(sync.ROOT / "environments/portfolio", root / "environments/portfolio")
            def publish(fork):
                receipts = [{**receipt(), "service": service, "repository": fork.image(service)}
                            for service in sync.SERVICES]
                record = {**run(), "head_repository": {"full_name": fork.repository},
                          "repository": {"id": 456, "full_name": fork.repository}}
                with patch.object(sync, "select_release", return_value=(record, [])), \
                        patch.object(sync, "eligible", return_value=True), \
                        patch.object(sync, "checked_receipts", return_value=receipts):
                    sync.synchronize(fork, root=root, write=True)
            publish(FORK)
            before = {p.name: p.read_text() for p in (root / "environments/fork").iterdir()}
            bob = type(FORK)("bob/OtherProject")
            publish(bob)
            after = {p.name: p.read_text() for p in (root / "environments/fork").iterdir()}
            self.assertEqual(set(after), {s + ".yaml" for s in sync.SERVICES} | {"release.json"})
            self.assertTrue(all(before[name] != after[name] for name in after))
            self.assertNotIn("ghcr.io/alice/", "".join(after.values()))
            self.assertEqual(sync.validate_record(json.loads(after["release.json"]), bob)["repository"], bob.repository)

    def test_recheck_failure_prevents_any_write(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            shutil.copytree(sync.ROOT / "environments/portfolio", root / "environments/portfolio")
            receipts = [{**receipt(), "service": service, "repository": FORK.image(service)}
                        for service in sync.SERVICES]
            with patch.object(sync, "select_release", return_value=(run(), [])), \
                    patch.object(sync, "eligible", side_effect=[True, False]), \
                    patch.object(sync, "checked_receipts", return_value=receipts), self.assertRaises(ValueError):
                sync.synchronize(FORK, root=root, write=True)
            self.assertFalse((root / "environments/fork").exists())

    def test_changed_tracked_input_or_cross_owner_receipt_is_rejected(self):
        payload, metadata = zipped({**receipt(), "repository": "ghcr.io/bob/example-ai-service"})
        with self.assertRaises(ValueError):
            sync.decode_receipt(payload, metadata, SHA, FORK)
        payload, metadata = zipped(receipt())
        def get(path, binary=False):
            return payload if binary else {"tree": [
                {"path": "infrastructure/release", "sha": "f" * 40, "type": "tree"},
                {"path": "backend/ai-service", "sha": "d" * 40, "type": "tree"}]}
        with self.assertRaises(ValueError):
            sync.checked_receipts(SHA, (run(), [metadata]), FORK, get)


if __name__ == "__main__":
    unittest.main()
