"""Fail-closed release gate for an opted-in personal fork's default branch."""

import argparse
import json
import os
import re
import subprocess
from pathlib import Path
from urllib.parse import quote

from ci_policy import WORKFLOWS
from repository import from_ci, validate_branch

# Merge protection and publication share the mandatory names, including summaries.
# This is the submission/merge authority, never a registry publication owner.
UPSTREAM = "SKNETWORKS-FAMILY-AICAMP/SKN34-4th-1Team"
PROMOTION_PATHS = {"infrastructure/gitops/environments/fork/" + name for name in (
    "core-service.yaml", "catalog-service.yaml", "ai-service.yaml", "ops-service.yaml", "release.json")}


def api(path):
    return json.loads(subprocess.check_output(
        ["gh", "api", path], text=True, timeout=90, stderr=subprocess.PIPE))


def valid_sha(sha):
    return isinstance(sha, str) and re.fullmatch(r"[0-9a-f]{40}", sha) is not None


def candidate(event_name, event, ref, sha, fork):
    if event.get("repository", {}).get("full_name") != fork.repository:
        return None
    if event_name == "workflow_dispatch":
        return sha if ref == "refs/heads/" + fork.branch and valid_sha(sha) else None
    if event_name != "workflow_run":
        return None
    run = event.get("workflow_run", {})
    if (run.get("event") != "push" or run.get("head_branch") != fork.branch
            or run.get("head_repository", {}).get("full_name") != fork.repository
            or run.get("conclusion") != "success" or run.get("status") != "completed"):
        return None
    # workflow_run's own metadata identifies the default-branch SHA when it
    # starts. Do not issue ancestor receipts under a newer run-head identity.
    return sha if valid_sha(sha) and run.get("head_sha") == sha else None


def current_source(sha, fork, get=api):
    """A bot's digest-only commit does not invalidate its tested source ancestor."""
    if not valid_sha(sha):
        raise ValueError("A full source SHA is required")
    head = get(f"repos/{fork.repository}/git/ref/heads/{quote(fork.branch, safe='')}")["object"]["sha"]
    if not valid_sha(head):
        raise ValueError("Invalid branch SHA")
    if head == sha:
        return True
    comparison = get(f"repos/{fork.repository}/compare/{sha}...{head}")
    files = comparison.get("files", [])
    # GitHub caps comparison files at 300. A result restricted to five known
    # paths cannot conceal an omitted file; require a complete commit list too.
    return (comparison.get("status") == "ahead" and bool(files)
            and comparison.get("total_commits") == len(comparison.get("commits", []))
            and 0 < len(files) <= len(PROMOTION_PATHS)
            and all(item.get("filename") in PROMOTION_PATHS
                    and item.get("status") in {"added", "modified"} for item in files))


def upstream_merged(sha, fork, get=api, *, ancestor_only=False):
    """Keep a merged candidate usable while upstream receives later commits.

    Publication separately requires a current fork candidate and its own push CI.
    A fork-only commit may differ from the latest upstream only in private digest
    selections; unmerged application or publication policy changes stay blocked.
    Explicit older deployments use ancestor_only to require the exact SHA in
    upstream, even when its newer commits are absent from the personal repository.
    """
    if not valid_sha(sha):
        raise ValueError("Invalid candidate SHA")
    metadata = get(f"repos/{UPSTREAM}")
    if metadata.get("full_name") != UPSTREAM:
        raise ValueError("Unexpected upstream repository identity")
    branch = validate_branch(metadata.get("default_branch"))
    head = get(f"repos/{UPSTREAM}/git/ref/heads/{quote(branch, safe='')}")["object"]["sha"]
    if not valid_sha(head):
        raise ValueError("Invalid upstream SHA")
    if head == sha:
        return True
    # Compare exact merged ancestors in their authoritative repository. The fork
    # may be an independent copy and not contain upstream's newly merged HEAD.
    repository = UPSTREAM if ancestor_only else fork.repository
    comparison = get(f"repos/{repository}/compare/{head}...{sha}")
    if comparison.get("status") == "behind":
        # Comparing upstream HEAD ... candidate has no candidate-only commits or
        # files when this exact candidate is already in upstream's history.
        # Do not infer ancestry merely from an empty/truncated file list.
        return (comparison.get("base_commit", {}).get("sha") == head
                and comparison.get("merge_base_commit", {}).get("sha") == sha
                and type(comparison.get("ahead_by")) is int
                and comparison["ahead_by"] == 0
                and type(comparison.get("behind_by")) is int
                and comparison["behind_by"] > 0
                and type(comparison.get("total_commits")) is int
                and comparison["total_commits"] == 0
                and comparison.get("commits") == []
                and comparison.get("files") == [])
    if ancestor_only:
        return False
    files = comparison.get("files")
    count = comparison.get("total_commits")
    return (comparison.get("status") == "ahead"
            and comparison.get("merge_base_commit", {}).get("sha") == head
            and type(count) is int and count > 0
            and count == len(comparison.get("commits", []))
            and isinstance(files, list) and len(files) <= len(PROMOTION_PATHS)
            and all(item.get("filename") in PROMOTION_PATHS
                    and item.get("status") in {"added", "modified"} for item in files))


def blocked_reason(sha, fork, get=api, *, evidence=None):
    if not current_source(sha, fork, get):
        return "source_not_current"
    if not upstream_merged(sha, fork, get):
        return "upstream_not_merged"
    return ci_blocked_reason(sha, fork, get, evidence=evidence)


def ci_blocked_reason(sha, fork, get=api, *, evidence=None):
    """Check exact push jobs; callers separately enforce source/branch authority."""
    if not valid_sha(sha):
        raise ValueError("A full source SHA is required")
    for filename, required_jobs in WORKFLOWS.items():
        response = get(f"repos/{fork.repository}/actions/workflows/{filename}/runs"
                       f"?head_sha={sha}&branch={quote(fork.branch, safe='')}&event=push&per_page=100")
        runs = response.get("workflow_runs", [])
        if not runs:
            return "ci_run_missing:" + filename
        run = max(runs, key=lambda item: (item["id"], item.get("run_attempt", 1)))
        if (run.get("head_sha") != sha or run.get("head_branch") != fork.branch
                or run.get("event") != "push" or run.get("status") != "completed"
                or run.get("conclusion") != "success"
                or run.get("path") != f".github/workflows/{filename}"
                or run.get("head_repository", {}).get("full_name") != fork.repository
                or type(run.get("id")) is not int or run["id"] <= 0
                or type(run.get("run_attempt")) is not int or run["run_attempt"] <= 0):
            return "ci_run_not_successful_or_untrusted:" + filename
        jobs_response = get(f"repos/{fork.repository}/actions/runs/{run['id']}/jobs"
                            "?filter=latest&per_page=100")
        jobs = jobs_response.get("jobs", [])
        # Current workflows have at most seven jobs. Reject incomplete/paginated results
        # instead of treating the first page or a successful gate-only run as complete CI.
        if (not isinstance(jobs, list)
                or type(jobs_response.get("total_count")) is not int
                or jobs_response["total_count"] != len(jobs)
                or len(jobs) != len(required_jobs)
                or any(not isinstance(job, dict) for job in jobs)
                or {job.get("name") for job in jobs} != set(required_jobs)
                or any(job.get("status") != "completed" or job.get("conclusion") != "success"
                       or job.get("head_sha") != sha or job.get("run_id") != run["id"]
                       for job in jobs)):
            return "ci_jobs_not_successful_or_incomplete:" + filename
        # A rerun starting during the jobs query must not inherit the prior success.
        confirmed = get(f"repos/{fork.repository}/actions/runs/{run['id']}")
        if any(confirmed.get(field) != run.get(field) for field in (
                "id", "run_attempt", "head_sha", "head_branch", "event", "status", "conclusion", "path")):
            return "ci_run_changed:" + filename
        if evidence is not None:
            evidence.append({"workflow": filename, "runId": run["id"], "runAttempt": run["run_attempt"]})
    return None


def eligible(sha, fork, get=api):
    return blocked_reason(sha, fork, get) is None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-sha")
    args = parser.parse_args()
    fork = from_ci()
    fork.require_personal_publish()
    if os.environ.get("MSA_RELEASE_ENABLED") != "true":
        raise SystemExit("Image publication is disabled; opt in on your personal fork")
    if args.check_sha:
        if not eligible(args.check_sha, fork):
            raise SystemExit("Release blocked: pin an upstream-merged source on the fork default branch and pass all required CI workflows and jobs for that SHA")
        return
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    sha = candidate(os.environ["GITHUB_EVENT_NAME"], event,
                    os.environ["GITHUB_REF"], os.environ["GITHUB_SHA"], fork)
    reason = "gate_error"
    try:
        reason = blocked_reason(sha, fork) if sha else "event_not_eligible"
    finally:
        ready = reason is None
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
            output.write(f"ready={str(ready).lower()}\nsha={sha if ready else ''}\n")
            output.write(f"source_sha={sha or ''}\nreason={reason or 'eligible'}\n")
    print("Release gate: " + (reason or "eligible"))


if __name__ == "__main__":
    main()
