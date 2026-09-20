import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("build_msa_images", Path(__file__).with_name("build-msa-images.py"))
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
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE.subprocess, "run") as run:
            for tag in ("latest", "other-project", "msa-../bad", "msa-;echo"):
                with self.subTest(tag=tag), self.assertRaises(SystemExit):
                    self.invoke(tag, Path(directory) / "images.json")
            run.assert_not_called()

    def test_existing_output_and_repository_output_rejected(self):
        with patch.object(MODULE.subprocess, "run") as run:
            for output in (Path(__file__), MODULE.ROOT / "unsafe-new-image-report.json"):
                with self.assertRaises(SystemExit):
                    self.invoke("msa-test-001", output)
            run.assert_not_called()

    def test_existing_image_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE.subprocess, "run",
                return_value=subprocess.CompletedProcess([], 0)) as run:
            with self.assertRaises(SystemExit):
                self.invoke("msa-test-001", Path(directory) / "images.json")
            self.assertEqual(run.call_count, 1)
            self.assertEqual(run.call_args.args[0][:3], ["docker", "image", "inspect"])


if __name__ == "__main__":
    unittest.main()
