"""Fail-closed release gate for an opted-in personal fork's default branch."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import quote

from repository import from_ci, validate_branch

WORKFLOWS = ("ci.yml", "catalog-ci.yml", "ops-ci.yml", "infra-ci.yml")
# This is the submission/merge authority, never a registry publication owner.
UPSTREAM = "SKNETWORKS-FAMILY-AICAMP/SKN34-4th-1Team"
PROMOTION_PATHS = {"infrastructure/gitops/environments/fork/" + name for name in (
    "core-service.yaml", "catalog-service.yaml", "ai-service.yaml", "ops-service.yaml", "release.json")}


def api(path):
    return json.loads(subprocess.check_output(["gh", "api", path], text=True))


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


def upstream_merged(sha, fork, get=api):
    """Publish only the latest merged upstream content after the fork is synced.

    A fork-only merge SHA is allowed because its private digest selections differ
    from upstream. Every other tracked file must equal upstream, including this
    publication policy; unmerged local development can never become a release.
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
    # Both commits belong to the same GitHub fork network. A missing base,
    # failed comparison or API permission error propagates; never assume merged.
    comparison = get(f"repos/{fork.repository}/compare/{head}...{sha}")
    files = comparison.get("files")
    count = comparison.get("total_commits")
    return (comparison.get("status") == "ahead"
            and comparison.get("merge_base_commit", {}).get("sha") == head
            and type(count) is int and count > 0
            and count == len(comparison.get("commits", []))
            and isinstance(files, list) and len(files) <= len(PROMOTION_PATHS)
            and all(item.get("filename") in PROMOTION_PATHS
                    and item.get("status") in {"added", "modified"} for item in files))


def eligible(sha, fork, get=api):
    if not current_source(sha, fork, get) or not upstream_merged(sha, fork, get):
        return False
    for filename in WORKFLOWS:
        response = get(f"repos/{fork.repository}/actions/workflows/{filename}/runs"
                       f"?head_sha={sha}&branch={quote(fork.branch, safe='')}&event=push&per_page=100")
        runs = response.get("workflow_runs", [])
        if not runs:
            return False
        run = max(runs, key=lambda item: (item["id"], item.get("run_attempt", 1)))
        if (run.get("head_sha") != sha or run.get("head_branch") != fork.branch
                or run.get("event") != "push" or run.get("status") != "completed"
                or run.get("conclusion") != "success"
                or run.get("path") != f".github/workflows/{filename}"
                or run.get("head_repository", {}).get("full_name") != fork.repository):
            return False
    return True


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
            raise SystemExit("Release blocked: sync the latest merged upstream source and pass all four CI checks")
        return
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    sha = candidate(os.environ["GITHUB_EVENT_NAME"], event,
                    os.environ["GITHUB_REF"], os.environ["GITHUB_SHA"], fork)
    ready = bool(sha and eligible(sha, fork))
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"ready={str(ready).lower()}\nsha={sha if ready else ''}\n")
    print("Release gate: eligible" if ready else "Release gate: not eligible (no images will be published)")


if __name__ == "__main__":
    main()
