import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "build_msa_images", Path(__file__).with_name("build-msa-images.py")
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class MsaBuildSafetyTests(unittest.TestCase):
    def invoke(self, tag, output):
        with patch("sys.argv", ["build-msa-images.py", "--tag", tag, "--output", str(output)]):
            MODULE.main()

    def test_all_nine_contexts_have_dockerfiles(self):
        self.assertEqual(len(MODULE.CONTEXTS), 9)
        for context in MODULE.CONTEXTS.values():
            self.assertTrue((MODULE.ROOT / context / "Dockerfile").is_file())

    def test_invalid_tag_rejected_before_docker(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(MODULE.subprocess, "run") as run,
            patch.object(MODULE.subprocess, "check_output") as query,
        ):
            for tag in ("latest", "other-project", "msa-../bad", "msa-;echo"):
                with self.subTest(tag=tag), self.assertRaises(SystemExit):
                    self.invoke(tag, Path(directory) / "images.json")
            run.assert_not_called()
            query.assert_not_called()

    def test_existing_output_and_repository_output_rejected(self):
        with (
            patch.object(MODULE.subprocess, "run") as run,
            patch.object(MODULE.subprocess, "check_output") as query,
        ):
            for output in (Path(__file__), MODULE.ROOT / "unsafe-new-image-report.json"):
                with self.assertRaises(SystemExit):
                    self.invoke("msa-test-001", output)
            run.assert_not_called()
            query.assert_not_called()

    def test_existing_image_is_not_overwritten(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(MODULE.subprocess, "run") as run,
            patch.object(
                MODULE.subprocess, "check_output", return_value="sha256:" + "a" * 64
            ) as query,
        ):
            with self.assertRaises(SystemExit):
                self.invoke("msa-test-001", Path(directory) / "images.json")
            run.assert_not_called()
            self.assertEqual(query.call_count, 1)
            self.assertEqual(query.call_args.args[0][:3], ["docker", "image", "ls"])

    @staticmethod
    def query(command, **kwargs):
        if command[:3] == ["docker", "image", "ls"]:
            return ""
        if command[:3] == ["git", "rev-parse", "HEAD"]:
            return "b" * 40
        if command[:2] == ["git", "status"]:
            return " M backend/ai-service/app/main.py"
        if command[:3] == ["docker", "image", "inspect"]:
            return "sha256:" + "a" * 64
        raise AssertionError("Unexpected read: " + repr(command))

    def test_docker_query_failure_never_means_image_tag_is_available(self):
        errors = (
            subprocess.CalledProcessError(1, ["docker"], output="PRIVATE", stderr="PRIVATE"),
            subprocess.TimeoutExpired(["docker"], 15, output="PRIVATE", stderr="PRIVATE"),
            FileNotFoundError("PRIVATE"),
        )
        for error in errors:
            with (
                self.subTest(error=type(error).__name__),
                tempfile.TemporaryDirectory() as directory,
            ):
                manifest = Path(directory) / "images.json"
                with (
                    patch.object(MODULE.subprocess, "check_output", side_effect=error) as query,
                    patch.object(MODULE.subprocess, "run") as build,
                    patch("sys.stderr", new_callable=io.StringIO) as output,
                    self.assertRaises(SystemExit) as stopped,
                ):
                    self.invoke("msa-test-001", manifest)
                self.assertEqual(stopped.exception.code, 1)
                self.assertNotIn("PRIVATE", output.getvalue())
                self.assertEqual(query.call_args.kwargs["timeout"], 15)
                build.assert_not_called()
                self.assertFalse(manifest.exists())

    def test_git_failure_stops_before_building(self):
        def query(command, **kwargs):
            if command[0] == "git":
                raise subprocess.TimeoutExpired(command, 15)
            return self.query(command, **kwargs)

        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(MODULE.subprocess, "check_output", side_effect=query),
            patch.object(MODULE.subprocess, "run") as build,
            self.assertRaises(SystemExit),
        ):
            self.invoke("msa-test-001", Path(directory) / "images.json")
        build.assert_not_called()

    def test_build_failure_and_timeout_do_not_write_success_manifest(self):
        for error in (
            subprocess.CalledProcessError(1, ["docker"]),
            subprocess.TimeoutExpired(["docker"], 3600),
        ):
            with tempfile.TemporaryDirectory() as directory:
                manifest = Path(directory) / "images.json"
                with (
                    patch.object(MODULE.subprocess, "check_output", side_effect=self.query),
                    patch.object(MODULE.subprocess, "run", side_effect=error) as build,
                    self.assertRaises(SystemExit),
                ):
                    self.invoke("msa-test-001", manifest)
                self.assertFalse(manifest.exists())
                self.assertEqual(build.call_count, 1)
                self.assertEqual(build.call_args.kwargs["timeout"], 3600)

    def test_invalid_or_unreadable_image_identity_prevents_manifest(self):
        for identity in ("", "not-a-digest", subprocess.TimeoutExpired(["docker"], 15)):

            def query(command, **kwargs):
                if command[:3] == ["docker", "image", "inspect"]:
                    if isinstance(identity, Exception):
                        raise identity
                    return identity
                return self.query(command, **kwargs)

            with tempfile.TemporaryDirectory() as directory:
                manifest = Path(directory) / "images.json"
                with (
                    patch.object(MODULE.subprocess, "check_output", side_effect=query),
                    patch.object(MODULE.subprocess, "run"),
                    self.assertRaises(SystemExit),
                ):
                    self.invoke("msa-test-001", manifest)
                self.assertFalse(manifest.exists())

    def test_success_records_all_identities_and_dirty_source_with_bounded_reads(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(MODULE.subprocess, "check_output", side_effect=self.query) as query,
            patch.object(MODULE.subprocess, "run") as build,
        ):
            manifest = Path(directory) / "images.json"
            self.invoke("msa-test-001", manifest)
            report = json.loads(manifest.read_text())
        self.assertEqual(set(report["images"]), set(MODULE.CONTEXTS))
        self.assertEqual(set(report["imageIds"]), set(MODULE.CONTEXTS))
        self.assertEqual(report["revision"], "b" * 40)
        self.assertTrue(report["dirty"])
        self.assertEqual(build.call_count, 9)
        for call in query.call_args_list:
            self.assertEqual(call.kwargs["timeout"], 15)
            self.assertNotIn("push", call.args[0])


if __name__ == "__main__":
    unittest.main()
