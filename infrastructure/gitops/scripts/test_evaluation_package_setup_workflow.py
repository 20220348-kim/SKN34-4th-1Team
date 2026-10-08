"""Manual empty-package setup must not become an automatic publication path."""

import unittest
from pathlib import Path

import yaml


class SetupWorkflowTests(unittest.TestCase):
    def test_manual_exact_sha_scoped_workflow_does_not_request_a_pat(self):
        root = Path(__file__).resolve().parents[3]
        workflow = yaml.safe_load(
            (root / ".github/workflows/evaluation-package-setup.yml").read_text()
        )
        self.assertEqual(
            set(workflow.get("on", workflow.get(True))), {"workflow_dispatch"}
        )
        self.assertEqual(set(workflow["jobs"]), {"setup"})
        job = workflow["jobs"]["setup"]
        self.assertEqual(
            job["permissions"],
            {"contents": "read", "actions": "read", "packages": "write"},
        )
        self.assertEqual(job["environment"], "msa-release")
        self.assertEqual(
            job["steps"][0]["with"],
            {"ref": "${{ github.sha }}", "persist-credentials": False},
        )
        step = job["steps"][1]
        self.assertEqual(step["env"]["GH_TOKEN"], "${{ github.token }}")
        self.assertIn("bootstrap_runner_actions.py", step["run"])
        self.assertNotIn("inputs.", step["run"])
        self.assertEqual(workflow["concurrency"]["group"], "evaluation-image-candidate")
        self.assertEqual(job["steps"][2]["with"]["name"], "evaluation-package-setup")
        for condition in (
            "github.event.repository.fork",
            "github.ref",
            "default_branch",
            "MSA_PACKAGE_VISIBILITY",
            "MSA_RELEASE_ENABLED",
        ):
            self.assertIn(condition, job["if"])


if __name__ == "__main__":
    unittest.main()
