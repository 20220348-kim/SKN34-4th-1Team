import copy
from pathlib import Path
import tempfile
import unittest

import yaml

from promote_image import UniqueLoader, promote, updated_values, validate_receipt


def receipt():
    return {"schemaVersion": 1, "service": "ai-service", "platform": "linux/amd64",
            "repository": "ghcr.io/govbiz-team/govbiz-ai-service",
            "digest": "sha256:" + "a" * 64, "tag": "src-" + "b" * 64,
            "inputKey": "b" * 64, "verifiedRevision": "c" * 40, "sourceTree": "d" * 40}


def values():
    return {"serviceName": "ai-service", "localMode": False,
            "image": {"repository": receipt()["repository"], "digest": "sha256:" + "e" * 64,
                      "tag": "", "pullPolicy": "IfNotPresent"},
            "env": {"ASSISTANT_AI_ENABLED": "true"}, "secretName": "ai-runtime",
            "secretKeys": ["DOCUMENT_INTERNAL_TOKEN"]}


class ImagePromotionTests(unittest.TestCase):
    def test_only_digest_changes_and_input_is_untouched(self):
        original = values()
        updated = updated_values(original, receipt(), original["image"]["digest"])
        self.assertEqual(original, values())
        self.assertEqual(updated["image"]["digest"], receipt()["digest"])
        updated["image"]["digest"] = original["image"]["digest"]
        self.assertEqual(updated, original)

    def test_rejects_extra_fields_and_untrusted_identifiers(self):
        for change in ({"secret": "bad"}, {"schemaVersion": True}, {"service": "../../bad"},
                       {"repository": "evil.example/govbiz/ai-service"}, {"digest": "latest"},
                       {"tag": "src-wrong"}, {"verifiedRevision": "develop"}, {"platform": "linux/arm64"}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_receipt({**receipt(), **change})

    def test_rejects_wrong_service_local_mode_or_stale_digest(self):
        for change in ({"serviceName": "core-service"}, {"localMode": True}, {"localMode": "false"}):
            with self.assertRaises(ValueError):
                updated_values({**values(), **change}, receipt(), values()["image"]["digest"])
        with self.assertRaises(ValueError):
            updated_values(values(), receipt(), "sha256:" + "f" * 64)

    def test_rejects_registry_change_mutable_tags_and_never_pull(self):
        for changes in ({"repository": "another/registry"}, {"tag": "latest"}, {"pullPolicy": "Never"}):
            current = values()
            current["image"].update(changes)
            with self.assertRaises(ValueError):
                updated_values(current, receipt(), current["image"]["digest"])

    def test_preview_does_not_write_and_apply_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            path = root / "environments/staging/ai-service.yaml"
            path.parent.mkdir(parents=True)
            original = yaml.safe_dump(values())
            path.write_text(original)
            rel = path.relative_to(root)
            diff = promote(root, rel, receipt(), values()["image"]["digest"])
            self.assertIn("+  digest: " + receipt()["digest"], diff)
            self.assertEqual(path.read_text(), original)
            promote(root, rel, receipt(), values()["image"]["digest"], write=True)
            self.assertEqual(yaml.safe_load(path.read_text())["image"]["digest"], receipt()["digest"])
            self.assertEqual(promote(root, rel, receipt(), receipt()["digest"], write=True), "")

    def test_no_local_values_creation_traversal_or_symlink_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            for target in ("environments/local-msa/ai-service.yaml", "environments/prod/ai-service.yaml",
                           "environments/../ai-service.yaml", "/tmp/ai-service.yaml", "README.md"):
                with self.assertRaises(ValueError):
                    promote(root, target, receipt(), "", True)
            (root / "environments/prod").mkdir(parents=True)
            (root / "real.yaml").write_text(yaml.safe_dump(values()))
            (root / "environments/prod/ai-service.yaml").symlink_to(root / "real.yaml")
            with self.assertRaises(ValueError):
                promote(root, "environments/prod/ai-service.yaml", receipt(), values()["image"]["digest"], True)

    def test_duplicate_yaml_keys_are_rejected(self):
        with self.assertRaises(ValueError):
            yaml.load("localMode: true\nlocalMode: false\n", Loader=UniqueLoader)


if __name__ == "__main__":
    unittest.main()
