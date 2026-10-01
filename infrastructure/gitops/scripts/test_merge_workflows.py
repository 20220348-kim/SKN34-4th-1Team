"""Ensure adding/skipping a CI job cannot silently weaken the merge summaries."""

import sys
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "infrastructure/release"))
from ci_policy import SUMMARY_NAMES, WORKFLOW_JOBS, WORKFLOWS


class WorkflowPolicyTests(unittest.TestCase):
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
