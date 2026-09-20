"""The submitted snapshot must not reuse the former personal deployment identity."""

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

from check_msa import ROOT, REPOSITORY_ROOT, argo_errors
from check_portfolio import errors


class MigrationGuards(unittest.TestCase):
    def test_checkout_root_is_above_nested_gitops(self):
        self.assertEqual(REPOSITORY_ROOT / "infrastructure/gitops", ROOT)

    def test_promotion_clis_refuse_without_reading_receipts_or_accessing_github(self):
        commands = (
            ["sync_images.py", "--write"],
            ["sync_images.py", "--verify-record"],
            ["promote_image.py", "--receipt", "/does-not-exist/receipt.json",
             "--values", "environments/portfolio/ai-service.yaml", "--expected-digest", "", "--write"],
        )
        for script, *arguments in commands:
            with self.subTest(script=script, arguments=arguments):
                result = subprocess.run(
                    [sys.executable, "-B", str(ROOT / "scripts" / script), *arguments],
                    capture_output=True, text=True, timeout=10,
                )
                self.assertEqual(result.returncode, 2)
                self.assertIn("Image promotion is disabled", result.stderr)

    def test_previous_repo_and_chart_path_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shutil.copytree(ROOT / "argocd/local", root / "argocd/local")
            path = root / "argocd/local/applications.yaml"
            applications = list(yaml.safe_load_all(path.read_text()))
            applications[0]["spec"]["source"].update(
                repoURL="https://github.com/GovBiz-Team/GovBiz-infra.git",
                targetRevision="develop", path="charts/govbiz-service",
            )
            path.write_text(yaml.safe_dump_all(applications))
            self.assertIn("Application source mismatch", argo_errors(root))

    @unittest.skipUnless(shutil.which("helm"), "Helm required for rendered policy test")
    def test_auto_sync_cannot_be_enabled_by_accident(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for relative in ("charts", "argocd/portfolio", "environments/portfolio"):
                shutil.copytree(ROOT / relative, root / relative)
            path = root / "argocd/portfolio/applications.yaml"
            applications = list(yaml.safe_load_all(path.read_text()))
            applications[0]["spec"]["syncPolicy"]["automated"]["enabled"] = True
            path.write_text(yaml.safe_dump_all(applications))
            self.assertIn("Unexpected portfolio Argo source/sync policy", errors(root))


if __name__ == "__main__":
    unittest.main()
