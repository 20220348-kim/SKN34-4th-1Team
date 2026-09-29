"""Verify published images for local startup and read historical deployment snapshots."""

import json
import os
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import quote
from urllib.request import urlopen

from deployment_candidate import (
    DEPLOYMENT_BRANCH,
    MANIFEST,
    PREFIX,
    SCHEMA,
    build,
    encoded,
    git_bytes,
    manifest_of,
    release_files,
    tracked_files,
    verify,
    write_files,
)
from gate import WORKFLOWS, api, blocked_reason, valid_sha
from sync_images import api as release_api
from sync_images import checked_receipts, select_release

CHECK_NAME = "govbiz/deployment-candidate"
CANDIDATE_PREFIX = "candidates/fork/"


def head(fork, branch, get=api):
    sha = get(f"repos/{fork.repository}/git/ref/heads/{quote(branch, safe='')}")[
        "object"
    ]["sha"]
    if not valid_sha(sha):
        raise ValueError("Invalid remote branch revision")
    return sha


def ensure_revision(root, revision):
    if not valid_sha(revision):
        raise ValueError("Invalid revision")
    exists = subprocess.run(
        ["git", "-C", str(root), "cat-file", "-e", revision + "^{commit}"],
        capture_output=True,
        check=False,
        timeout=30,
    )
    if exists.returncode:
        git_bytes(root, "fetch", "--no-tags", "origin", revision)


def rule_errors(rules, required):
    types = {item.get("type") for item in rules}
    errors = []
    if (
        not {"deletion", "non_fast_forward", "pull_request", "required_status_checks"}
        <= types
    ):
        errors.append(
            "Require PRs, required checks, and deletion/force-push protection"
        )
    reviews = [
        item.get("parameters", {})
        for item in rules
        if item.get("type") == "pull_request"
    ]
    if not any(
        type(item.get("required_approving_review_count")) is int
        and item["required_approving_review_count"] >= 0
        and item.get("required_review_thread_resolution") is True
        for item in reviews
    ):
        errors.append(
            "Require a valid PR policy and resolved conversations; review approvals are optional"
        )
    checks = [
        item.get("parameters", {})
        for item in rules
        if item.get("type") == "required_status_checks"
    ]
    names = {
        check.get("context")
        for item in checks
        for check in item.get("required_status_checks", [])
    }
    if not required <= names or not any(
        item.get("strict_required_status_checks_policy") is True for item in checks
    ):
        errors.append(
            "Required checks are incomplete or the up-to-date branch policy is missing"
        )
    return errors


def require_rules(fork, get=api):
    for branch, required in (
        (fork.branch, {name for jobs in WORKFLOWS.values() for name in jobs}),
        (DEPLOYMENT_BRANCH, {CHECK_NAME}),
    ):
        rules = []
        for page in range(1, 11):
            batch = get(
                f"repos/{fork.repository}/rules/branches/{quote(branch, safe='')}?per_page=100&page={page}"
            )
            if not isinstance(batch, list):
                raise TypeError("Cannot inspect active branch rules")
            rules.extend(batch)
            if len(batch) < 100:
                break
        else:
            raise ValueError("Incomplete branch rules response")
        errors = rule_errors(rules, required)
        if errors:
            raise ValueError(branch + ": " + "; ".join(errors))


def source_checks(fork, sha, get=api):
    if head(fork, fork.branch, get) != sha:
        raise ValueError("Source advanced: generate a new candidate")
    checks = []
    reason = blocked_reason(sha, fork, get, evidence=checks)
    if reason:
        raise ValueError("Deployment source blocked: " + reason)
    return checks


def admit(root, fork, files, helm="helm", get=api):
    manifest = manifest_of(files, fork)
    if manifest["schema"] != SCHEMA:
        raise ValueError(
            "Create a new candidate with the required Ops migration contract"
        )
    if os.environ.get("GITHUB_ACTIONS") == "true":
        policy_sha = git_bytes(root, "rev-parse", "HEAD").decode().strip()
        if policy_sha != manifest["sourceSha"]:
            raise ValueError(
                "Trusted policy checkout differs from the candidate source; redispatch"
            )
    require_rules(fork, get)
    if head(fork, DEPLOYMENT_BRANCH, get) != manifest["baseSha"]:
        raise ValueError(
            "Deployment branch advanced: do not rebase or overwrite the reviewed candidate"
        )
    checks = source_checks(fork, manifest["sourceSha"], get)
    if checks != manifest["sourceChecks"]:
        raise ValueError("Required CI evidence changed after candidate creation")
    release = select_release(fork, get, manifest["publisherRunId"])
    if release is None or release[0]["head_sha"] != manifest["sourceSha"]:
        raise ValueError("Candidate publisher is not a verified release")
    receipts = checked_receipts(manifest["sourceSha"], release, fork, get)
    for receipt in receipts:
        if files[PREFIX + f"receipts/{receipt['service']}.json"] != encoded(receipt):
            raise ValueError("Candidate receipt differs from the publisher artifact")
    ensure_revision(root, manifest["sourceSha"])
    verify(root, fork, files, helm)
    if (
        head(fork, DEPLOYMENT_BRANCH, get) != manifest["baseSha"]
        or head(fork, fork.branch, get) != manifest["sourceSha"]
    ):
        raise ValueError("Source or deployment branch changed during validation")
    return manifest


def prepare_candidate(root, fork, output, helm="helm", get=api, run_id=None):
    fork.require_personal_publish()
    release = select_release(fork, get, run_id)
    if release is None:
        return {"prepared": False, "reason": "no_complete_release", "source_sha": ""}
    run, _ = release
    sha = run["head_sha"]
    require_rules(fork, get)
    base = head(fork, DEPLOYMENT_BRANCH, get)
    checks = source_checks(fork, sha, get)
    receipts = checked_receipts(sha, release, fork, get)
    ensure_revision(root, sha)
    files = build(root, fork, sha, base, run["id"], checks, receipts, helm)
    if output.exists():
        raise ValueError("Candidate output must be a new directory")
    admit(root, fork, files, helm, get)
    output.mkdir(parents=True)
    write_files(output, files)
    return {
        "prepared": True,
        "reason": "candidate_prepared",
        "source_sha": sha,
        "publisher_run_id": run["id"],
        "candidate_hash": json.loads(files[MANIFEST])["candidateHash"],
    }


def commit_tree(root, files, base=None):
    """Use a temporary index: preserve the user's checkout, index and branch."""
    with tempfile.TemporaryDirectory(prefix="govbiz-deployment-index-") as directory:
        env = {**os.environ, "GIT_INDEX_FILE": str(Path(directory) / "index")}

        def git(*args, data=None):
            return (
                subprocess.check_output(
                    ["git", "-C", str(root), *args], input=data, env=env, timeout=60
                )
                .decode()
                .strip()
            )

        git("read-tree", "--empty")
        for path, payload in sorted(files.items()):
            blob = git("hash-object", "-w", "--stdin", data=payload)
            git("update-index", "--add", "--cacheinfo", "100644", blob, path)
        tree = git("write-tree")
        return git(
            "-c",
            "user.name=github-actions[bot]",
            "-c",
            "user.email=41898282+github-actions[bot]@users.noreply.github.com",
            "-c",
            "commit.gpgsign=false",
            "commit-tree",
            tree,
            *(["-p", base] if base else []),
            data="배포: 검증된 전체 배포 후보 생성\n".encode(),
        )


def candidate_parent(root, revision, base):
    parents = (
        git_bytes(root, "rev-list", "--parents", "-n", "1", revision).decode().split()
    )
    if parents != [revision, base]:
        raise ValueError(
            "Candidate must be one snapshot commit directly on the reviewed deployment base"
        )


def public_api(path):
    with urlopen("https://api.github.com/" + path, timeout=30) as response:
        return json.load(response)


def verified_release(root, fork, helm="helm", get=release_api):
    """Resolve a current tested publication without branches, PRs or checkout writes."""
    fork.require_personal_publish()
    release = select_release(fork, get)
    if release is None:
        raise ValueError(
            "No complete verified publication; wait for source CI and image publication"
        )
    run, artifacts = release
    if type(run.get("run_attempt")) is not int or run["run_attempt"] <= 0:
        raise ValueError("Publisher attempt is missing or invalid")
    sha = run["head_sha"]
    checks = source_checks(fork, sha, get)
    receipts = checked_receipts(sha, release, fork, get)
    ensure_revision(root, sha)
    files = release_files(root, fork, sha, run["id"], receipts, helm)
    confirmed = select_release(fork, get)
    if (
        confirmed is None
        or any(
            confirmed[0].get(key) != run.get(key)
            for key in (
                "id",
                "run_attempt",
                "head_sha",
                "head_branch",
                "event",
                "path",
                "status",
                "conclusion",
            )
        )
        or sorted((a["name"], a["id"], a["digest"]) for a in confirmed[1])
        != sorted((a["name"], a["id"], a["digest"]) for a in artifacts)
    ):
        raise ValueError("Publisher or image receipts changed during validation; retry")
    if source_checks(fork, sha, get) != checks:
        raise ValueError("Required CI evidence changed during validation; retry")
    record = json.loads(files[PREFIX + "environments/fork/release.json"])
    return record, files, sha


def approved_release(root, fork, helm="helm", get=public_api):
    """An approved old release remains usable when source main advances."""
    require_rules(fork, get)
    revision = head(fork, DEPLOYMENT_BRANCH, get)
    ensure_revision(root, revision)
    files = tracked_files(root, revision)
    manifest = manifest_of(files, fork)
    ensure_revision(root, manifest["sourceSha"])
    verify(root, fork, files, helm)
    if head(fork, DEPLOYMENT_BRANCH, get) != revision:
        raise ValueError("Deployment changed during bootstrap validation; retry")
    return (
        json.loads(files[PREFIX + "environments/fork/release.json"]),
        files,
        revision,
    )


def main():
    raise SystemExit(
        "Separate deployment branches and deployment PR automation were removed. "
        "Use the normal development PR into the source default branch. "
        "Automatic deployment is not configured; no remote changes were made."
    )


if __name__ == "__main__":
    main()
