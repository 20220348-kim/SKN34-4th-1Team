import copy
import subprocess
import sys
import unittest

from check_msa import ROOT, SERVICES
from smoke_msa import STUBS, validate_manifest
from gitops_msa import validate_revisions


class MsaSmokeSafetyTests(unittest.TestCase):
    def fixture(self):
        names = set(SERVICES) | set(STUBS) | {"elasticsearch"}
        return {"images": {n: f"govbiz-{n}:msa-test-001" for n in names},
                "imageIds": {n: "sha256:" + "a" * 64 for n in names}}

    def test_accept_complete_local_manifest(self):
        validate_manifest(self.fixture())

    def test_reject_missing_images(self):
        fixture = self.fixture()
        del fixture["images"]["catalog-service"]
        with self.assertRaises(RuntimeError):
            validate_manifest(fixture)

    def test_reject_unrelated_and_mutable_tags(self):
        for image in ("another-project:msa-test-001", "govbiz-core-service:latest", "govbiz-core-service:stable"):
            fixture = copy.deepcopy(self.fixture())
            fixture["images"]["core-service"] = image
            with self.subTest(image=image), self.assertRaises(RuntimeError):
                validate_manifest(fixture)

    def test_require_image_ids(self):
        fixture = self.fixture()
        fixture["imageIds"]["core-service"] = "fake"
        with self.assertRaises(RuntimeError):
            validate_manifest(fixture)

    def test_gitops_requires_two_distinct_full_revisions(self):
        validate_revisions(["a" * 40, "b" * 40])
        for revisions in (["develop", "main"], ["a" * 40, "a" * 40], ["a" * 40]):
            with self.assertRaises(ValueError):
                validate_revisions(revisions)

    def test_interactive_gitops_refuses_unattended_execution_before_docker(self):
        result = subprocess.run([sys.executable, "-B", str(ROOT / "scripts/smoke_msa.py"),
                                 "--images", "/unused-image-file", "--report", "/unused-report-file",
                                 "--gitops-interactive"], stdin=subprocess.DEVNULL,
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 2)
        self.assertIn("requires a terminal", result.stderr)


if __name__ == "__main__":
    unittest.main()
