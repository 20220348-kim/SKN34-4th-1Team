"""Ensure adding/skipping a CI job cannot silently weaken the merge summaries."""

import sys
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "infrastructure/release"))
from ci_policy import SUMMARY_NAMES, WORKFLOW_JOBS, WORKFLOWS


class WorkflowPolicyTests(unittest.TestCase):
    def test_required_ci_cancels_only_the_same_workflow_and_ref(self):
        groups = set()
        for filename in WORKFLOWS:
            workflow = yaml.load(
                (ROOT / ".github/workflows" / filename).read_text(),
                Loader=yaml.BaseLoader,
            )
            with self.subTest(filename=filename):
                concurrency = workflow["concurrency"]
                self.assertEqual(
                    concurrency,
                    {
                        "group": "${{ github.workflow }}-${{ github.ref }}",
                        "cancel-in-progress": "true",
                    },
                )
                # Different branches, PR refs and workflows must never collide.
                for ref in (
                    "refs/heads/main",
                    "refs/heads/skn-test",
                    "refs/pull/1/merge",
                    "refs/pull/2/merge",
                ):
                    group = (
                        concurrency["group"]
                        .replace("${{ github.workflow }}", workflow["name"])
                        .replace("${{ github.ref }}", ref)
                        .lower()
                    )
                    self.assertNotIn(group, groups)
                    groups.add(group)

    def test_publication_and_package_setup_are_not_interrupted_by_new_ci(self):
        expected = {
            "msa-images.yml": "msa-image-candidates",
            "evaluation-images.yml": "evaluation-image-candidate",
            "evaluation-package-setup.yml": "evaluation-image-candidate",
        }
        for filename, group in expected.items():
            workflow = yaml.load(
                (ROOT / ".github/workflows" / filename).read_text(),
                Loader=yaml.BaseLoader,
            )
            with self.subTest(filename=filename):
                self.assertEqual(
                    workflow["concurrency"],
                    {"group": group, "cancel-in-progress": "false"},
                )

    def test_runner_publication_reuses_exact_ci_gate_without_changing_business_matrix(
        self,
    ):
        workflows = {
            name: yaml.load(
                (ROOT / ".github/workflows" / name).read_text(), Loader=yaml.BaseLoader
            )
            for name in ("msa-images.yml", "evaluation-images.yml")
        }
        business, runner = workflows.values()
        self.assertEqual(runner["on"], business["on"])
        self.assertEqual(runner["jobs"]["gate"], business["jobs"]["gate"])
        self.assertNotEqual(
            runner["concurrency"]["group"], business["concurrency"]["group"]
        )
        self.assertEqual(
            len(business["jobs"]["publish"]["strategy"]["matrix"]["service"]), 4
        )
        publication = runner["jobs"]["publish"]
        self.assertNotIn("strategy", publication)
        self.assertEqual(publication["needs"], business["jobs"]["publish"]["needs"])
        self.assertEqual(publication["if"], business["jobs"]["publish"]["if"])
        self.assertEqual(
            publication["permissions"], business["jobs"]["publish"]["permissions"]
        )
        self.assertEqual(
            publication["steps"][0], business["jobs"]["publish"]["steps"][0]
        )
        self.assertTrue(
            any(
                'gate.py --check-sha "$SOURCE_SHA"' in step.get("run", "")
                for step in publication["steps"]
            )
        )
        self.assertTrue(
            any(
                'publish.py --service evaluation-runner --sha "$SOURCE_SHA"'
                in step.get("run", "")
                for step in publication["steps"]
            )
        )
        preflight = runner["jobs"]["package-preflight"]
        self.assertEqual(
            preflight["permissions"], {"contents": "read", "packages": "read"}
        )
        self.assertEqual(preflight["if"], runner["jobs"]["gate"]["if"])
        self.assertIn(
            "--check-packages --service evaluation-runner", preflight["steps"][1]["run"]
        )
        self.assertEqual(preflight["steps"][0], runner["jobs"]["gate"]["steps"][0])
        self.assertEqual(
            runner["jobs"]["outcome"]["needs"], ["gate", "package-preflight", "publish"]
        )
        for job in runner["jobs"].values():
            self.assertNotIn("continue-on-error", job)
            for step in job["steps"]:
                self.assertNotIn("continue-on-error", step)
                if step.get("uses", "").startswith("actions/upload-artifact@"):
                    self.assertTrue(step["with"]["name"].startswith("evaluation-"))

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
