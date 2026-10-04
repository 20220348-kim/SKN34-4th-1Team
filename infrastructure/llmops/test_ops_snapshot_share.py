"""Portable history integrity boundaries without Docker or paid calls."""

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import ops_snapshot as snapshot
import ops_snapshot_share as share
from test_ops_snapshot import example_files


class PortableCopyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.key = self.root / "key"
        snapshot.exclusive(self.key, b"a" * 64 + b"\n")
        self.archive = self.root / "original.enc"
        self.ops = {"id": "sha256:" + "b" * 64, "platform": "linux/amd64"}
        self.mysql = {"id": "sha256:" + "c" * 64, "platform": "linux/amd64"}
        snapshot.exclusive(
            self.archive,
            snapshot.seal(
                {
                    "version": 1,
                    "files": example_files(),
                    "sql": "original SQL",
                    "sql_sha256": hashlib.sha256(b"original SQL").hexdigest(),
                    "mysql_image": self.mysql["id"],
                },
                snapshot.key_bytes(self.key),
            ),
        )
        self.package = self.root / "package"

    def package_fixture(self):
        def save(args, **kwargs):
            self.assertEqual(args[:3], ["docker", "image", "save"])
            self.assertNotIn(str(self.key), args)
            Path(args[args.index("--output") + 1]).write_bytes(b"synthetic Docker image archive")

        with (
            patch.object(share, "image_info", side_effect=[self.ops, self.mysql]),
            patch.object(snapshot, "require_local_image"),
            patch.object(snapshot, "run", side_effect=save),
        ):
            share.pack(self.archive, self.key, "new-ops-image", self.package)

    def test_package_preserves_encrypted_history_and_excludes_key(self):
        self.package_fixture()
        self.assertEqual(
            set(p.name for p in self.package.iterdir()),
            {
                "snapshot.enc",
                "images.tar",
                "package.enc",
            },
        )
        self.assertEqual((self.package / "snapshot.enc").read_bytes(), self.archive.read_bytes())
        manifest = share.verify_package(self.package, self.key)
        self.assertEqual(manifest["images"], {"ops": self.ops, "mysql": self.mysql})

    def test_corrupt_image_or_history_fails_before_loading_or_restoring(self):
        self.package_fixture()
        for name in ("images.tar", "snapshot.enc"):
            path = self.package / name
            original = path.read_bytes()
            path.write_bytes(original + b"tampered")
            with (
                patch.object(snapshot, "run") as command,
                patch.object(snapshot, "restore") as restore,
                self.assertRaisesRegex(ValueError, "integrity"),
            ):
                share.restore_local(self.package, self.key, self.root / "restored")
            command.assert_not_called()
            restore.assert_not_called()
            path.write_bytes(original)

    def test_package_wrong_key_and_symlink_refused(self):
        self.package_fixture()
        wrong = self.root / "wrong"
        snapshot.exclusive(wrong, b"f" * 64)
        with patch.object(snapshot, "run") as command, self.assertRaises(ValueError):
            share.restore_local(self.package, wrong, self.root / "restored")
        command.assert_not_called()
        (self.package / "images.tar").unlink()
        (self.package / "images.tar").symlink_to(self.archive)
        with self.assertRaises(OSError):
            share.verify_package(self.package, self.key)

    def test_restore_uses_pinned_runtime_and_explicit_local_ports(self):
        self.package_fixture()
        with (
            patch.object(snapshot, "run") as command,
            patch.object(share, "image_info", side_effect=[self.mysql, self.ops]),
            patch.object(snapshot, "restore", return_value={"status": "RESTORED"}) as restore,
        ):
            # Manifest JSON is sorted when encrypted, so mysql precedes ops.
            result = share.restore_local(
                self.package, self.key, self.root / "restored", 18080, 18002
            )
        self.assertEqual(command.call_count, 1)
        self.assertEqual(result["core_proxy_target"], "http://127.0.0.1:18080")
        self.assertEqual(
            restore.call_args.kwargs,
            {
                "local_ops_image": self.ops["id"],
                "core_port": 18080,
                "api_port": 18002,
            },
        )

    def test_invalid_ports_fail_before_loading_images(self):
        for core, ops in ((8080, 8080), (80, 18002), (8080, 65536)):
            with patch.object(snapshot, "run") as command, self.assertRaises(ValueError):
                share.restore_local(self.package, self.key, self.root / "restored", core, ops)
            command.assert_not_called()

    def test_existing_package_is_not_overwritten(self):
        self.package_fixture()
        before = (self.package / "package.enc").read_bytes()
        with (
            patch.object(share, "image_info", side_effect=[self.ops, self.mysql]),
            patch.object(snapshot, "run") as command,
            self.assertRaisesRegex(ValueError, "NEW"),
        ):
            share.pack(self.archive, self.key, "image", self.package)
        command.assert_not_called()
        self.assertEqual((self.package / "package.enc").read_bytes(), before)

    def test_old_runtime_is_rejected_before_publishing_a_package(self):
        with (
            patch.object(share, "image_info", side_effect=[self.ops, self.mysql]),
            patch.object(snapshot, "require_local_image", side_effect=ValueError("old runtime")),
            patch.object(snapshot, "run") as command,
            self.assertRaisesRegex(ValueError, "old runtime"),
        ):
            share.pack(self.archive, self.key, "old-image", self.package)
        self.assertFalse(self.package.exists())
        command.assert_not_called()

    def test_restore_cannot_rebind_existing_local_copy_to_another_core(self):
        target = self.root / "restored"
        target.mkdir()
        state = {
            "sha256": hashlib.sha256(self.archive.read_bytes()).hexdigest(),
            "complete": True,
            "local": {"ops_image": self.ops["id"], "core_port": 8080, "api_port": 18002},
        }
        marker = target / "snapshot-state.json"
        marker.write_text(json.dumps(state))
        with (
            patch.object(snapshot, "run") as command,
            self.assertRaisesRegex(ValueError, "changed"),
        ):
            snapshot.restore(
                self.archive, self.key, target, local_ops_image=self.ops["id"], core_port=18080
            )
        command.assert_not_called()
        self.assertEqual(json.loads(marker.read_text()), state)


if __name__ == "__main__":
    unittest.main()
