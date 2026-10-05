"""Ensure adding/skipping a CI job cannot silently weaken the merge summaries."""

import sys
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "infrastructure/release"))
from ci_policy import SUMMARY_NAMES, WORKFLOW_JOBS, WORKFLOWS


class WorkflowPolicyTests(unittest.TestCase):
    def test_package_preflight_is_read_only_and_cannot_bypass_source_ci(self):
        workflow = yaml.load(
            (ROOT / ".github/workflows/msa-images.yml").read_text(),
            Loader=yaml.BaseLoader,
        )
        self.assertEqual(set(workflow["on"]), {"workflow_run", "workflow_dispatch"})
        jobs = workflow["jobs"]
        preflight = jobs["package-preflight"]
        self.assertNotIn("needs", preflight)
        self.assertEqual(preflight["if"], jobs["gate"]["if"])
        self.assertEqual(
            preflight["permissions"], {"contents": "read", "packages": "read"}
        )
        self.assertNotIn("continue-on-error", preflight)
        checkout, check, upload = preflight["steps"]
        self.assertEqual(checkout, jobs["gate"]["steps"][0])
        self.assertEqual(
            checkout["with"]["ref"], "${{ github.event.repository.default_branch }}"
        )
        self.assertEqual(checkout["with"]["persist-credentials"], "false")
        self.assertEqual(check["env"], {"GH_TOKEN": "${{ github.token }}"})
        self.assertEqual(
            check["run"],
            'python3 -B infrastructure/release/publish.py --check-packages --report "${RUNNER_TEMP}/package-preflight.json"',
        )
        self.assertNotIn("continue-on-error", check)
        self.assertEqual(upload["if"], "${{ always() }}")
        self.assertEqual(upload["with"]["name"], "msa-package-preflight")
        self.assertEqual(upload["with"]["if-no-files-found"], "error")
        publication = jobs["publish"]
        self.assertEqual(set(publication["needs"]), {"gate", "package-preflight"})
        self.assertEqual(
            publication["if"],
            "needs.gate.outputs.ready == 'true' && needs.package-preflight.result == 'success'",
        )
        self.assertEqual(
            publication["steps"][0]["with"]["ref"], "${{ needs.gate.outputs.sha }}"
        )
        self.assertTrue(
            any(
                'gate.py --check-sha "$SOURCE_SHA"' in step.get("run", "")
                for step in publication["steps"]
            )
        )
        self.assertEqual(
            set(jobs["outcome"]["needs"]), {"gate", "package-preflight", "publish"}
        )
        self.assertEqual(jobs["outcome"]["if"], "${{ always() }}")

    def test_summaries_cover_all_jobs_and_run_after_failures(self):
        for filename, expected in WORKFLOW_JOBS.items():
            with self.subTest(filename=filename):
                workflow = yaml.load(
                    (ROOT / ".github/workflows" / filename).read_text(),
                    Loader=yaml.BaseLoader,
                )
                self.assertEqual(set(workflow["on"]), {"push", "pull_request"})
                self.assertTrue(
                    all(value in (None, "", {}) for value in workflow["on"].values())
                )
                jobs = workflow["jobs"]
                self.assertEqual(set(jobs), {*expected, "merge-readiness"})
                summary = jobs["merge-readiness"]
                self.assertEqual(summary["if"], "${{ always() }}")
                self.assertEqual(summary["name"], SUMMARY_NAMES[filename])
                self.assertEqual(set(summary["needs"]), set(expected))
                self.assertNotIn("continue-on-error", summary)
                self.assertEqual(summary["defaults"]["run"]["working-directory"], ".")
                step = summary["steps"][-1]
                self.assertEqual(step["env"]["NEEDS_JSON"], "${{ toJSON(needs) }}")
                self.assertEqual(
                    step["run"],
                    f"python3 -B infrastructure/release/ci_policy.py {filename}",
                )
                self.assertNotIn("continue-on-error", step)
                names = []
                for identity in expected:
                    job = jobs[identity]
                    name = job.get("name", identity)
                    if identity == "fork-identity":
                        names.extend(
                            name.replace("${{ matrix.os }}", os)
                            for os in job["strategy"]["matrix"]["os"]
                        )
                    else:
                        names.append(name)
                    self.assertNotIn("continue-on-error", job)
                self.assertEqual(tuple(names) + (summary["name"],), WORKFLOWS[filename])


if __name__ == "__main__":
    unittest.main()
