"""Both Infra CI render jobs must supply the CLI required by deployment admission."""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml
from check_msa import REPOSITORY_ROOT
from deployment_candidate import HELM_VERSION


class InfraToolchainTests(unittest.TestCase):
    def setUp(self):
        self.workflow = yaml.safe_load(
            (REPOSITORY_ROOT / ".github/workflows/infra-ci.yml").read_text(
                encoding="utf-8"
            )
        )

    def test_both_render_jobs_install_and_verify_helm_before_checks(self):
        for name in ("kubernetes-manifests", "helm-gitops"):
            with self.subTest(job=name):
                steps = self.workflow["jobs"][name]["steps"]
                install = next(
                    i
                    for i, step in enumerate(steps)
                    if step.get("name")
                    == "Install pinned Helm with checksum verification"
                )
                guard = next(
                    i
                    for i, step in enumerate(steps)
                    if step.get("name") == "Verify pinned Helm version"
                )
                check = (
                    "unittest discover"
                    if name == "kubernetes-manifests"
                    else "scripts/check_msa.py"
                )
                tests = next(
                    i for i, step in enumerate(steps) if check in step.get("run", "")
                )
                self.assertLess(install, guard)
                self.assertLess(guard, tests)
                for index in (install, guard, tests):
                    self.assertNotIn("if", steps[index])
                    self.assertNotIn("continue-on-error", steps[index])
                script = steps[install]["run"]
                archive = f"helm-{HELM_VERSION}-linux-amd64.tar.gz"
                self.assertIn(f"https://get.helm.sh/{archive}", script)
                self.assertIn(f"sha256sum --check {archive}.sha256sum", script)
                self.assertLess(
                    script.index("sha256sum --check"), script.index("tar -xzf")
                )
                self.assertIn('"$tool_dir/linux-amd64" >> "$GITHUB_PATH"', script)
                self.assertIn("set -euo pipefail", script)
                subprocess.run(["bash", "-n"], input=script, text=True, check=True)

    def test_script_suite_has_one_required_full_discovery(self):
        jobs = self.workflow["jobs"]
        discoveries = [
            (name, step)
            for name, job in jobs.items()
            for step in job["steps"]
            if "unittest discover -s scripts" in step.get("run", "")
        ]
        self.assertEqual(len(discoveries), 1)
        name, step = discoveries[0]
        self.assertEqual(name, "kubernetes-manifests")
        self.assertEqual(
            step["run"], "python -B -m unittest discover -s scripts -p 'test_*.py'"
        )
        self.assertNotIn("if", step)
        self.assertNotIn("continue-on-error", step)
        self.assertIn(name, jobs["merge-readiness"]["needs"])

    def test_workflow_version_guard_rejects_wrong_cli_and_cli_failure(self):
        for job in ("kubernetes-manifests", "helm-gitops"):
            guard = next(
                step["run"]
                for step in self.workflow["jobs"][job]["steps"]
                if step.get("name") == "Verify pinned Helm version"
            )
            for version, exit_code, accepted in (
                (HELM_VERSION, 0, True),
                ("v3.19.0", 0, False),
                ("v4.3.1", 0, False),
                ("", 1, False),
                (HELM_VERSION, 1, False),
            ):
                with (
                    self.subTest(job=job, version=version),
                    tempfile.TemporaryDirectory() as directory,
                ):
                    cli = Path(directory) / "helm"
                    cli.write_text(
                        f"#!/bin/sh\nprintf '%s' '{version}'\nexit {exit_code}\n",
                        encoding="utf-8",
                    )
                    cli.chmod(0o700)
                    result = subprocess.run(
                        ["bash", "-e", "-o", "pipefail", "-c", guard],
                        env={
                            **os.environ,
                            "PATH": directory + os.pathsep + os.environ["PATH"],
                        },
                        capture_output=True,
                        check=False,
                    )
                    self.assertEqual(result.returncode == 0, accepted)


if __name__ == "__main__":
    unittest.main()
