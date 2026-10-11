"""Change-scope boundaries and failure preservation without network or model calls."""

import copy
import json
import subprocess
import unittest
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit

import ci_policy as policy

REPOSITORY = "alice/project"
BASE, PREVIOUS, HEAD = "a" * 40, "b" * 40, "c" * 40
CURRENT_RUN = 100


def run_record(filename="ci.yml", run_id=20, sha=BASE, **changes):
    return {
        "id": run_id,
        "run_attempt": 1,
        "head_sha": sha,
        "head_branch": "feature",
        "event": "push",
        "path": ".github/workflows/" + filename,
        "head_repository": {"full_name": REPOSITORY},
        "status": "completed",
        "conclusion": "success",
        **changes,
    }


def comparison(base=BASE, head=HEAD, files=()):
    return {
        "status": "identical" if base == head else "ahead",
        "base_commit": {"sha": base},
        "merge_base_commit": {"sha": base},
        "head_commit": {"sha": head},
        "files": [
            {"filename": item, "status": "modified"} if isinstance(item, str) else item
            for item in files
        ],
    }


def job_response(run, *, scoped=False):
    filename = run["path"].removeprefix(".github/workflows/")
    names = [*policy.WORKFLOWS[filename]]
    if scoped:
        names.append(policy.SCOPE_NAMES[filename])
    jobs = [
        {
            "name": name,
            "run_id": run["id"],
            "head_sha": run["head_sha"],
            "status": "completed",
            "conclusion": "success",
        }
        for name in names
    ]
    return {"total_count": len(jobs), "jobs": jobs}


def fixture_api(runs, comparisons, jobs=None):
    """Return explicit GitHub response fixtures and the paths requested by the policy."""
    calls = []
    records = {run["id"]: run for rows in runs.values() for run in rows}

    def get(path):
        calls.append(path)
        if "/actions/workflows/" in path:
            branch = parse_qs(urlsplit(path).query)["branch"][0]
            return {"workflow_runs": copy.deepcopy(runs.get(branch, []))}
        if "/compare/" in path:
            base, head = path.split("/compare/")[1].split("...")
            assert head == HEAD, path
            return copy.deepcopy(comparisons[base])
        run_id = int(path.split("/actions/runs/")[1].split("/")[0])
        if "/jobs?" in path:
            return copy.deepcopy((jobs or {}).get(run_id, job_response(records[run_id])))
        return copy.deepcopy(records[run_id])

    return get, calls


class AffectedJobsTests(unittest.TestCase):
    def test_global_web_styles_still_require_the_ops_browser_checks(self):
        for path in ("frontend/web/src/index.css", "frontend/web/src/design-tokens.css"):
            with self.subTest(path=path):
                self.assertEqual(policy.affected_jobs([path])["llmops-ci.yml"], set(policy.WORKFLOW_JOBS["llmops-ci.yml"]))

    def assert_full(self, paths):
        self.assertEqual(
            policy.affected_jobs(paths),
            {filename: set(jobs) for filename, jobs in policy.WORKFLOW_JOBS.items()},
        )

    def test_documentation_only_keeps_cheap_repository_and_identity_checks(self):
        selected = policy.affected_jobs([
            "README.md", "AGENTS.md", "docs/guide.md", "docs/screenshot.png",
            "backend/ai-service/README.md", "frontend/web/README.md",
            "backend/ai-service/docs/agent-structure.md", "infrastructure/gitops/docs/web-kubernetes.md",
            "evaluation/support-program-evidence/README.md",
        ])
        self.assertEqual(selected["infra-ci.yml"], {"repository", "fork-identity"})
        self.assertTrue(all(not jobs for name, jobs in selected.items() if name != "infra-ci.yml"))

    def test_gov_supervisor_leaf_and_web_test_do_not_schedule_llmops(self):
        selected = policy.affected_jobs([
            "backend/ai-service/app/gov_agent/agent.py",
            "backend/ai-service/tests/gov_agent/test_supervisor.py",
            "frontend/web/src/presentation/features/chat/hooks/useGovAgentChat.test.tsx",
        ])
        self.assertEqual(selected["ci.yml"], {"ai-service", "frontend"})
        for filename in ("catalog-ci.yml", "ops-ci.yml", "llmops-ci.yml"):
            self.assertEqual(selected[filename], set())

    def test_gov_contract_or_router_change_includes_consumers_and_container_prerequisites(self):
        for path in ("models.py", "router.py", "new_contract.py"):
            with self.subTest(path=path):
                selected = policy.affected_jobs(["backend/ai-service/app/gov_agent/" + path])
                self.assertEqual(
                    selected["ci.yml"],
                    {"ai-service", "core-service", "frontend", "container-integration"},
                )

    def test_shared_contract_changes_include_web_mobile_and_llmops(self):
        selected = policy.affected_jobs(["frontend/packages/shared/src/domain/entities/GovAgent.ts"])
        self.assertEqual(selected["ci.yml"], set(policy.WORKFLOW_JOBS["ci.yml"]))
        self.assertEqual(selected["llmops-ci.yml"], set(policy.WORKFLOW_JOBS["llmops-ci.yml"]))

    def test_root_locks_workflow_policy_and_unknown_paths_select_everything(self):
        for path in (
            "pnpm-lock.yaml", "package.json", "pnpm-workspace.yaml",
            "frontend/mobile/package.json", ".github/workflows/ci.yml",
            "infrastructure/release/ci_policy.py", "new-service/entrypoint.py",
        ):
            with self.subTest(path=path):
                self.assert_full([path])

    def test_backend_configuration_change_preserves_cross_service_checks(self):
        selected = policy.affected_jobs(["backend/ai-service/app/config.py"])
        self.assertEqual(
            selected["ci.yml"], {"frontend", "core-service", "ai-service", "container-integration"}
        )
        for filename in ("catalog-ci.yml", "ops-ci.yml", "llmops-ci.yml"):
            self.assertEqual(selected[filename], set(policy.WORKFLOW_JOBS[filename]))

    def test_core_kotlin_tests_are_local_but_shared_test_resources_keep_integrations(self):
        selected = policy.affected_jobs(["backend/core-service/src/test/kotlin/ai/govbiz/core/ExampleTest.kt"])
        self.assertEqual(selected["ci.yml"], {"core-service"})
        self.assertEqual(selected["llmops-ci.yml"], set())
        selected = policy.affected_jobs(["backend/core-service/src/test/resources/application-test.yml"])
        self.assertIn("container-integration", selected["ci.yml"])
        self.assertEqual(selected["llmops-ci.yml"], set(policy.WORKFLOW_JOBS["llmops-ci.yml"]))


class ChangedPathsTests(unittest.TestCase):
    def test_rename_keeps_original_path_and_removed_sources_still_select_tests(self):
        paths = policy.changed_paths(comparison(files=[
            {"filename": "docs/retired.md", "previous_filename": "backend/core-service/src/main/Main.kt", "status": "renamed"},
            {"filename": "backend/ai-service/app/gov_agent/models.py", "status": "removed"},
        ]), BASE, HEAD)
        self.assertIn("backend/core-service/src/main/Main.kt", paths)
        self.assertIn("backend/ai-service/app/gov_agent/models.py", paths)
        self.assertIn("core-service", policy.affected_jobs(paths)["ci.yml"])
        self.assertEqual(policy.affected_jobs(paths)["llmops-ci.yml"], set(policy.WORKFLOW_JOBS["llmops-ci.yml"]))

    def test_invalid_or_ambiguous_comparison_is_rejected(self):
        original = comparison(files=["README.md"])
        changes = [
            {"status": "diverged"}, {"status": "behind"}, {"status": "identical"},
            {"base_commit": {"sha": PREVIOUS}}, {"merge_base_commit": {"sha": PREVIOUS}},
            {"files": None}, {"files": [{"filename": "README.md", "status": "unknown"}]},
            {"files": [{"filename": "README.md", "status": "renamed"}]},
            {"files": [{"filename": "../README.md", "status": "modified"}]},
        ]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(ValueError):
                policy.changed_paths({**original, **change}, BASE, HEAD)

    def test_299_complete_files_are_accepted_but_300_are_ambiguous(self):
        files = [f"docs/{number}.md" for number in range(300)]
        self.assertEqual(len(policy.changed_paths(comparison(files=files[:299]), BASE, HEAD)), 299)
        with self.assertRaises(ValueError):
            policy.changed_paths(comparison(files=files), BASE, HEAD)


class PlanTests(unittest.TestCase):
    def assert_full(self, result, filename="ci.yml"):
        self.assertEqual(result["selected"], list(policy.WORKFLOW_JOBS[filename]))
        self.assertIsNone(result["baseline"])

    def plan(self, get, *, filename="ci.yml", **kwargs):
        return policy.plan(filename, REPOSITORY, "feature", HEAD, CURRENT_RUN, get, **kwargs)

    def test_compares_entire_range_from_verified_success_not_only_last_commit(self):
        run = run_record()
        get, calls = fixture_api({"feature": [run]}, {BASE: comparison(files=[
            "backend/core-service/src/main/Main.kt", "docs/follow-up.md",
        ])})
        result = self.plan(get)
        self.assertEqual(result["baseline"], BASE)
        self.assertEqual(result["reason"], "cumulative_changes")
        self.assertIn("core-service", result["selected"])
        self.assertIn(f"repos/{REPOSITORY}/compare/{BASE}...{HEAD}", calls)
        self.assertFalse(any(f"{PREVIOUS}...{HEAD}" in path for path in calls))

    def test_latest_unsuccessful_ancestor_forces_full_even_when_only_docs_changed(self):
        for status, conclusion in (
            ("completed", "failure"), ("completed", "cancelled"),
            ("completed", "skipped"), ("queued", None), ("in_progress", None),
        ):
            with self.subTest(status=status, conclusion=conclusion):
                latest = run_record(run_id=30, sha=PREVIOUS, status=status, conclusion=conclusion)
                get, calls = fixture_api({"feature": [run_record(), latest]}, {
                    BASE: comparison(files=["README.md"]),
                    PREVIOUS: comparison(base=PREVIOUS, files=["README.md"]),
                })
                result = self.plan(get)
                self.assert_full(result)
                self.assertEqual(result["reason"], "previous_run_not_successful")
                self.assertFalse(any(f"{BASE}...{HEAD}" in path for path in calls))

    def test_no_baseline_and_manual_dispatch_select_all(self):
        get, calls = fixture_api({}, {})
        self.assert_full(self.plan(get))
        calls.clear()
        manual = self.plan(get, force=True)
        self.assert_full(manual)
        self.assertEqual(manual["reason"], "manual_full_run")
        self.assertEqual(calls, [])

    def test_new_branch_can_use_verified_default_branch_ancestor(self):
        run = run_record(head_branch="main")
        get, _ = fixture_api({"main": [run]}, {BASE: comparison(files=["README.md"])})
        result = self.plan(get, default_branch="main")
        self.assertEqual(result["selected"], [])
        self.assertEqual(result["baseline"], BASE)

    def test_unrelated_success_is_not_a_baseline(self):
        run = run_record(head_branch="main")
        get, _ = fixture_api({"main": [run]}, {BASE: {**comparison(), "status": "diverged"}})
        self.assert_full(self.plan(get, default_branch="main"))

    def test_current_or_future_run_cannot_validate_itself(self):
        for run_id in (CURRENT_RUN, CURRENT_RUN + 1):
            get, calls = fixture_api({"feature": [run_record(run_id=run_id)]}, {})
            self.assert_full(self.plan(get))
            self.assertFalse(any("/compare/" in path for path in calls))

    def test_baseline_rerun_during_job_lookup_cannot_reuse_prior_success(self):
        run = run_record()
        endpoint = f"repos/{REPOSITORY}/actions/runs/{run['id']}"
        for change in (
            {"run_attempt": 2}, {"status": "queued", "conclusion": None},
            {"conclusion": "failure"}, {"head_sha": PREVIOUS},
        ):
            with self.subTest(change=change):
                original_get, calls = fixture_api(
                    {"feature": [run]}, {BASE: comparison(files=["README.md"])}
                )

                def get(path):
                    value = original_get(path)
                    return {**value, **change} if path == endpoint else value

                result = self.plan(get)
                self.assert_full(result)
                self.assertEqual(result["reason"], "baseline_run_changed")
                self.assertLess(calls.index(endpoint + "/jobs?filter=latest&per_page=100"), calls.index(endpoint))

    def test_truncated_or_unproven_diff_forces_full(self):
        for value in (
            comparison(files=[f"docs/{n}.md" for n in range(300)]),
            {**comparison(files=["README.md"]), "merge_base_commit": {"sha": PREVIOUS}},
        ):
            get, _ = fixture_api({"feature": [run_record()]}, {BASE: value})
            self.assert_full(self.plan(get))

    def test_incomplete_untrusted_or_failed_baseline_jobs_force_full(self):
        run = run_record()
        original = job_response(run)
        variants = [
            {**original, "total_count": len(original["jobs"]) + 1},
            {"total_count": len(original["jobs"]) - 1, "jobs": original["jobs"][:-1]},
        ]
        for fields in (
            {"head_sha": PREVIOUS}, {"run_id": 1}, {"conclusion": "failure"},
            {"conclusion": "cancelled"}, {"conclusion": "skipped"},
            {"status": "in_progress"}, {"name": "unknown"},
        ):
            altered = copy.deepcopy(original)
            altered["jobs"][0].update(fields)
            variants.append(altered)
        for response in variants:
            with self.subTest(response=response):
                get, _ = fixture_api({"feature": [run]}, {BASE: comparison(files=["README.md"])}, {run["id"]: response})
                self.assert_full(self.plan(get))

    def test_pre_split_llmops_success_cannot_omit_new_required_suites(self):
        filename = "llmops-ci.yml"
        run = run_record(filename)
        response = job_response(run, scoped=True)
        old_names = {"Saved capture pipeline with local servers", policy.SUMMARY_NAMES[filename], policy.SCOPE_NAMES[filename]}
        response["jobs"] = [job for job in response["jobs"] if job["name"] in old_names]
        response["total_count"] = len(response["jobs"])
        get, _ = fixture_api({"feature": [run]}, {BASE: comparison(files=["README.md"])}, {run["id"]: response})
        result = self.plan(get, filename=filename)
        self.assert_full(result, filename)
        self.assertEqual(result["reason"], "baseline_jobs_unproven")

    def test_successful_scoped_baseline_requires_both_planner_and_summary(self):
        run = run_record()
        response = job_response(run, scoped=True)
        required = {policy.SCOPE_NAMES["ci.yml"], policy.SUMMARY_NAMES["ci.yml"]}
        for job in response["jobs"]:
            if job["name"] not in required:
                job["conclusion"] = "skipped"
        self.assertTrue(policy.successful_baseline("ci.yml", run, response))
        get, _ = fixture_api({"feature": [run]}, {BASE: comparison(files=["README.md"])}, {run["id"]: response})
        self.assertEqual(self.plan(get)["selected"], [])
        for name in required:
            for status in ("failure", "cancelled", "skipped", None):
                with self.subTest(name=name, status=status):
                    altered = copy.deepcopy(response)
                    next(job for job in altered["jobs"] if job["name"] == name)["conclusion"] = status
                    self.assertFalse(policy.successful_baseline("ci.yml", run, altered))

    def test_baseline_identity_must_match_workflow_branch_repository_and_event(self):
        for change in (
            {"head_repository": {"full_name": "other/project"}},
            {"head_branch": "another-branch"}, {"event": "pull_request"},
            {"path": ".github/workflows/unknown.yml"}, {"head_sha": "main"},
        ):
            with self.subTest(change=change):
                get, _ = fixture_api({"feature": [run_record(**change)]}, {})
                self.assert_full(self.plan(get))

    def test_malformed_comparison_metadata_forces_full(self):
        for value in (None, [], {**comparison(), "base_commit": None}, {**comparison(), "merge_base_commit": None}):
            with self.subTest(value=value):
                get, _ = fixture_api({"feature": [run_record()]}, {BASE: value})
                self.assert_full(self.plan(get))

    def test_transport_and_malformed_api_failures_never_remove_tests(self):
        errors = (
            subprocess.CalledProcessError(1, "gh"),
            subprocess.TimeoutExpired("gh", 60),
            HTTPError("https://api.invalid", 403, "private", {}, None),
            URLError("private"), OSError("private"),
        )
        for error in errors:
            def unavailable(_):
                raise error
            with self.subTest(error=type(error).__name__):
                self.assert_full(self.plan(unavailable))
        for response in (None, [], {"total_count": 1, "jobs": [None]}):
            with self.subTest(response=response):
                run = run_record()
                get, _ = fixture_api({"feature": [run]}, {BASE: comparison(files=["README.md"])}, {run["id"]: response})
                self.assert_full(self.plan(get))


class SummaryTests(unittest.TestCase):
    def needs(self, selected):
        return {
            "changes": {"result": "success", "outputs": {"selected": json.dumps(selected)}},
            **{name: {"result": "success" if name in selected else "skipped"}
               for name in policy.WORKFLOW_JOBS["ci.yml"]},
        }

    def test_only_explicitly_unselected_checks_may_be_skipped(self):
        policy.check_results("ci.yml", self.needs(["ai-service", "frontend"]))
        policy.check_results("ci.yml", self.needs([]))
        for job, state in (
            ("ai-service", "skipped"), ("ai-service", "failure"),
            ("ai-service", "cancelled"), ("ai-service", "pending"),
            ("core-service", "failure"), ("core-service", "cancelled"),
            ("core-service", "success"),
        ):
            with self.subTest(job=job, state=state), self.assertRaises(ValueError):
                needs = self.needs(["ai-service"])
                needs[job]["result"] = state
                policy.check_results("ci.yml", needs)

    def test_failed_scope_missing_job_and_unknown_selection_are_rejected(self):
        for state in ("failure", "cancelled", "skipped", None):
            with self.subTest(state=state), self.assertRaises(ValueError):
                needs = self.needs([])
                needs["changes"]["result"] = state
                policy.check_results("ci.yml", needs)
        for selected in (["unknown"], ["ai-service", "ai-service"], None, {}, [1]):
            with self.subTest(selected=selected), self.assertRaises(ValueError):
                needs = self.needs([])
                needs["changes"]["outputs"]["selected"] = json.dumps(selected)
                policy.check_results("ci.yml", needs)
        for name in policy.WORKFLOW_JOBS["ci.yml"]:
            with self.subTest(missing=name), self.assertRaises(ValueError):
                needs = self.needs([])
                del needs[name]
                policy.check_results("ci.yml", needs)

    def test_invalid_selection_json_cannot_turn_into_unaffected_success(self):
        for raw in ("", "[", "true", "\"ai-service\""):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                needs = self.needs([])
                needs["changes"]["outputs"]["selected"] = raw
                policy.check_results("ci.yml", needs)


if __name__ == "__main__":
    unittest.main()
