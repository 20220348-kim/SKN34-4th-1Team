"""Shared change scope and result policy for merge checks and publication."""

import json
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote

WORKFLOW_JOBS = {
    "ci.yml": {
        "frontend": ("Web and shared",),
        "mobile": ("Mobile",),
        "core-service": ("Core API",),
        "ai-service": ("AI Service",),
        "container-integration": ("Container integration",),
    },
    "catalog-ci.yml": {
        "catalog-service": ("Catalog clean build and boundaries",),
        "catalog-integration": (
            "Catalog to Core HTTP projection with offline fixtures",
        ),
    },
    "ops-ci.yml": {
        "checks": ("Ops checks and MySQL tests",),
        "docker": ("Ops container integration",),
    },
    "infra-ci.yml": {
        "fork-identity": (
            "Fork identity (ubuntu-24.04)",
            "Fork identity (macos-15-intel)",
            "Fork identity (windows-2025)",
        ),
        "repository": ("repository",),
        "kubernetes-manifests": ("kubernetes-manifests",),
        "helm-gitops": ("helm-gitops",),
    },
    "llmops-ci.yml": {
        "integration": ("Saved capture pipeline with local servers",),
        "cancellation": ("Offline cancellation and budget recovery",),
        "kubernetes": ("Kubernetes evaluation and restore",),
    },
}
SUMMARY_NAMES = dict(
    zip(
        WORKFLOW_JOBS,
        (
            "Required CI / GovBiz",
            "Required CI / Catalog",
            "Required CI / Ops",
            "Required CI / Infra",
            "Required CI / LLMOps",
        ),
    )
)
WORKFLOWS = {
    filename: tuple(name for names in jobs.values() for name in names)
    + (SUMMARY_NAMES[filename],)
    for filename, jobs in WORKFLOW_JOBS.items()
}
SCOPE_NAMES = {name: summary.replace("Required CI", "CI scope") for name, summary in SUMMARY_NAMES.items()}


def affected_jobs(paths):
    """Keep unknown/shared inputs conservative; exclude only known independent work."""
    selected = {name: set() for name in WORKFLOW_JOBS}
    # Cheap repository/identity checks keep their stable three-OS check names.
    selected["infra-ci.yml"].update(("repository", "fork-identity"))

    def add(filename, *jobs):
        selected[filename].update(jobs or WORKFLOW_JOBS[filename])

    for path in paths:
        if (path in {"README.md", "AGENTS.md"}
                or path.startswith(("docs/", "infrastructure/gitops/docs/", "backend/ai-service/docs/"))
                and path.endswith((".md", ".png", ".jpg", ".svg"))
                or re.fullmatch(r"(?:backend/[^/]+|frontend/[^/]+|infrastructure/[^/]+|evaluation/[^/]+)/README\.md", path)):
            continue
        if path.startswith("backend/ai-service/tests/"):
            add("ci.yml", "ai-service")
        elif path.startswith("backend/ai-service/app/gov_agent/"):
            add("ci.yml", "ai-service")
            if Path(path).name not in {"agent.py", "service.py", "errors.py", "__init__.py"}:
                add("ci.yml", "container-integration")
        elif path.startswith("backend/ai-service/"):
            add("ci.yml", "container-integration")
            add("catalog-ci.yml")
            add("ops-ci.yml")
            add("llmops-ci.yml")
        elif path.startswith("backend/core-service/src/test/kotlin/"):
            add("ci.yml", "core-service")
        elif path.startswith("backend/core-service/"):
            add("ci.yml", "container-integration")
            add("catalog-ci.yml")
            add("ops-ci.yml")
            add("llmops-ci.yml")
        elif path.startswith("backend/catalog-service/"):
            add("catalog-ci.yml")
            if not path.startswith("backend/catalog-service/src/test/"):
                add("llmops-ci.yml")
        elif path.startswith("backend/ops-service/"):
            add("ops-ci.yml")
            add("llmops-ci.yml")
        elif path.startswith("frontend/web/"):
            add("ci.yml", "frontend")
            test_only = ("/__tests__/" in path or re.search(r"\.(test|spec)\.[cm]?[jt]sx?$", path))
            if not test_only:
                add("ci.yml", "container-integration")
                # Global styles/wiring also affect the actual Ops browser checks.
                if not re.match(r"frontend/web/src/presentation/features/(chat|search|pricing)/", path):
                    add("llmops-ci.yml")
        elif path.startswith("frontend/mobile/") and path != "frontend/mobile/package.json":
            add("ci.yml", "mobile")
        elif path.startswith("frontend/packages/shared/"):
            add("ci.yml", "frontend", "mobile", "container-integration")
            add("llmops-ci.yml")
        elif path.startswith("infrastructure/gitops/"):
            add("infra-ci.yml")
            add("llmops-ci.yml")
        elif path.startswith(("infrastructure/llmops/", "evaluation/support-program-evidence/")):
            add("ci.yml", "ai-service")
            add("ops-ci.yml")
            add("llmops-ci.yml")
        elif path.startswith("evaluation/support-program-search/"):
            add("ci.yml", "ai-service")
        else:
            # Includes workflow/policy changes, root lock files and unknown new inputs.
            return {name: set(jobs) for name, jobs in WORKFLOW_JOBS.items()}

    if "container-integration" in selected["ci.yml"]:
        selected["ci.yml"].update(("frontend", "core-service", "ai-service"))
    if "catalog-integration" in selected["catalog-ci.yml"]:
        selected["catalog-ci.yml"].add("catalog-service")
    if "docker" in selected["ops-ci.yml"]:
        selected["ops-ci.yml"].add("checks")
    return selected


def api(path):
    return json.loads(subprocess.check_output(
        ["gh", "api", path], text=True, timeout=60, stderr=subprocess.PIPE))


def changed_paths(comparison, base, head):
    """GitHub returns at most 300 files; never accept a possibly truncated diff."""
    files = comparison.get("files")
    if (comparison.get("status") not in {"ahead", "identical"}
            or comparison.get("base_commit", {}).get("sha") != base
            or comparison.get("merge_base_commit", {}).get("sha") != base
            or not isinstance(files, list) or len(files) >= 300
            or (comparison.get("status") == "identical") != (base == head)):
        raise ValueError("comparison_unproven_or_truncated")
    paths = []
    for item in files:
        if not isinstance(item, dict) or item.get("status") not in {"added", "removed", "modified", "renamed", "copied", "changed"}:
            raise ValueError("unknown_change")
        names = [item.get("filename")]
        if item["status"] == "renamed":
            names.append(item.get("previous_filename"))
        if any(not isinstance(name, str) or not name or name.startswith("/") or ".." in name.split("/") for name in names):
            raise ValueError("invalid_change_path")
        paths.extend(names)
    return paths


def plan(filename, repository, branch, sha, run_id, get=api, *, default_branch=None, force=False):
    """Compare with the last successful ancestor, never just the latest push's before."""
    full = {"selected": list(WORKFLOW_JOBS[filename]), "baseline": None, "reason": "no_verified_baseline"}
    if force:
        return {**full, "reason": "manual_full_run"}
    try:
        if not re.fullmatch(r"[0-9a-f]{40}", sha) or type(run_id) is not int or run_id <= 0:
            raise ValueError("invalid_run_identity")
        for source_branch in dict.fromkeys((branch, default_branch or branch)):
            response = get(f"repos/{repository}/actions/workflows/{filename}/runs"
                           f"?branch={quote(source_branch, safe='')}&event=push&per_page=100")
            runs = response["workflow_runs"]
            if not isinstance(runs, list):
                raise ValueError("invalid_run_history")
            for run in sorted(runs, key=lambda row: row["id"], reverse=True):
                if run["id"] >= run_id:
                    continue
                base = run.get("head_sha", "")
                if (not re.fullmatch(r"[0-9a-f]{40}", base)
                        or run.get("event") != "push" or run.get("head_branch") != source_branch
                        or run.get("path") != f".github/workflows/{filename}"
                        or run.get("head_repository", {}).get("full_name") != repository):
                    raise ValueError("untrusted_baseline")
                comparison = get(f"repos/{repository}/compare/{base}...{sha}")
                # A different branch can have successes outside this candidate's history.
                if comparison.get("status") in {"behind", "diverged"}:
                    continue
                paths = changed_paths(comparison, base, sha)
                if run.get("status") != "completed" or run.get("conclusion") != "success":
                    return {**full, "reason": "previous_run_not_successful"}
                jobs_response = get(f"repos/{repository}/actions/runs/{run['id']}/jobs?filter=latest&per_page=100")
                if not successful_baseline(filename, run, jobs_response):
                    return {**full, "reason": "baseline_jobs_unproven"}
                confirmed = get(f"repos/{repository}/actions/runs/{run['id']}")
                if any(confirmed.get(field) != run.get(field) for field in (
                        "id", "run_attempt", "head_sha", "head_branch", "event", "status", "conclusion", "path")):
                    return {**full, "reason": "baseline_run_changed"}
                selected = affected_jobs(paths)[filename]
                return {"selected": [name for name in WORKFLOW_JOBS[filename] if name in selected],
                        "baseline": base, "reason": "cumulative_changes"}
        return full
    except (KeyError, TypeError, ValueError, AttributeError, OSError, subprocess.SubprocessError):
        # An API/permission problem can cost time, but cannot remove a required test.
        return {**full, "reason": "scope_unavailable_full_run"}


def successful_baseline(filename, run, response):
    if not isinstance(response, dict):
        return False
    jobs = response.get("jobs")
    if (not isinstance(jobs, list) or type(response.get("total_count")) is not int
            or response["total_count"] != len(jobs) or any(not isinstance(job, dict) for job in jobs)):
        return False
    scoped = any(job.get("name") == SCOPE_NAMES[filename] for job in jobs)
    expected = set(WORKFLOWS[filename]) | ({SCOPE_NAMES[filename]} if scoped else set())
    if len(jobs) != len(expected) or {job.get("name") for job in jobs} != expected:
        return False
    required = {SUMMARY_NAMES[filename], SCOPE_NAMES[filename]}
    return all(job.get("status") == "completed" and job.get("run_id") == run["id"]
               and job.get("head_sha") == run["head_sha"]
               and (job.get("conclusion") == "success"
                    or scoped and job.get("name") not in required and job.get("conclusion") == "skipped")
               for job in jobs)


def check_results(filename, needs):
    expected = set(WORKFLOW_JOBS[filename])
    selected = expected
    if isinstance(needs, dict) and "changes" in needs:
        changes = needs["changes"]
        if not isinstance(changes, dict) or changes.get("result") != "success":
            raise ValueError("CI change scope did not succeed")
        selected = json.loads(changes.get("outputs", {}).get("selected", "null"))
        if (not isinstance(selected, list) or any(not isinstance(name, str) for name in selected)
                or len(selected) != len(set(selected)) or not set(selected) <= expected):
            raise ValueError("Invalid CI change scope")
        selected = set(selected)
        needs = {name: job for name, job in needs.items() if name != "changes"}
    if not isinstance(needs, dict) or set(needs) != expected:
        raise ValueError("Required CI dependencies are missing or unexpected")
    failed = sorted(
        name
        for name, job in needs.items()
        if not isinstance(job, dict) or job.get("result") != ("success" if name in selected else "skipped")
    )
    if failed:
        raise ValueError("Required CI did not succeed: " + ", ".join(failed))


if __name__ == "__main__":
    try:
        if len(sys.argv) == 3 and sys.argv[1] == "--plan":
            event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8"))
            metadata = event["repository"]
            branch = event.get("pull_request", {}).get("base", {}).get("ref") or os.environ["GITHUB_REF_NAME"]
            result = plan(sys.argv[2], os.environ["GITHUB_REPOSITORY"], branch,
                          os.environ["GITHUB_SHA"], int(os.environ["GITHUB_RUN_ID"]),
                          default_branch=metadata["default_branch"],
                          force=os.environ["GITHUB_EVENT_NAME"] == "workflow_dispatch")
            with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
                output.write("selected=" + json.dumps(result["selected"]) + "\n")
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as summary:
                summary.write(f"### CI scope: {sys.argv[2]}\n\n```json\n{json.dumps(result, indent=2)}\n```\n")
            print(json.dumps(result))
        elif len(sys.argv) == 2:
            check_results(sys.argv[1], json.loads(os.environ["NEEDS_JSON"]))
            print("All selected checks succeeded; only explicitly unaffected checks were skipped.")
        else:
            raise ValueError("Specify one workflow filename or --plan <workflow>")
    except (ValueError, KeyError) as error:
        sys.exit(str(error))
