"""Prepare reviewable deployment PRs; never write the source or deployment ref."""

import argparse
import json
import os
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import quote
from urllib.request import urlopen

from check_msa import REPOSITORY_ROOT
from deployment_candidate import (
    SCHEMA,
    CHECK_WORKFLOW,
    DEPLOYMENT_BRANCH,
    MANIFEST,
    PREFIX,
    build,
    directory_files,
    encoded,
    git_bytes,
    manifest_of,
    tracked_files,
    verify,
    write_files,
)
from gate import WORKFLOWS, api, blocked_reason, valid_sha
from repository import from_ci, from_origin
from sync_images import checked_receipts, select_release, valid_run

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
            "Require PR review, required checks, and deletion/force-push protection"
        )
    reviews = [
        item.get("parameters", {})
        for item in rules
        if item.get("type") == "pull_request"
    ]
    if not any(
        type(item.get("required_approving_review_count")) is int
        and item["required_approving_review_count"] >= 1
        and item.get("dismiss_stale_reviews_on_push") is True
        and item.get("require_last_push_approval") is True
        and item.get("required_review_thread_resolution") is True
        for item in reviews
    ):
        errors.append("Require approval of the latest push and dismiss stale reviews")
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
        raise ValueError("Create a new candidate with the required Ops migration contract")
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


def mutation(path, data):
    return json.loads(
        subprocess.check_output(
            ["gh", "api", path, "--method", "POST", "--input", "-"],
            input=json.dumps(data).encode(),
            timeout=90,
        )
    )


def propose(root, fork, files, suffix, helm="helm", get=api, *, result=None):
    manifest = admit(root, fork, files, helm, get)
    if not suffix or not all(
        part.isdecimal() and int(part) > 0 for part in suffix.split("-")
    ):
        raise ValueError("Use the trusted Actions run ID and attempt")
    branch = CANDIDATE_PREFIX + manifest["sourceSha"] + "-" + suffix
    ensure_revision(root, manifest["baseSha"])
    revision = commit_tree(root, files, manifest["baseSha"])
    # Validate again after commit construction; never push to main or deploy/fork.
    admit(root, fork, tracked_files(root, revision), helm, get)
    subprocess.run(
        ["gh", "auth", "setup-git"], check=True, capture_output=True, timeout=30
    )
    git_bytes(root, "push", "origin", revision + ":refs/heads/" + branch)
    if head(fork, branch, get) != revision:
        raise ValueError("Candidate push was not confirmed")
    body = (
        "## 배포 후보\n\n"
        f"- 소스: `{manifest['sourceSha']}`\n- 후보: `{manifest['candidateHash']}`\n"
        f"- 기존 배포: `{manifest['baseSha']}`\n- 이미지 발행: {manifest['publisherRunId']}\n\n"
        "Chart·values·이미지 receipt·Argo 선언·렌더링 결과 전체를 검토합니다.\n"
        "`govbiz/deployment-candidate` 통과와 최신 변경에 대한 리뷰 승인 후 수동 병합합니다.\n"
        "PR 생성은 배포 완료가 아닙니다. 이전 배포 상태와의 호환성을 확인하세요.\n"
    )
    pr = mutation(
        f"repos/{fork.repository}/pulls",
        {
            "base": DEPLOYMENT_BRANCH,
            "head": branch,
            "title": "배포: 검증된 전체 배포 후보 " + manifest["sourceSha"][:7],
            "body": body,
        },
    )
    if result is None:
        result = {}
    result.update(
        {
            "candidate_created": True,
            "candidate_sha": revision,
            "candidate_branch": branch,
            "candidate_pr": str(pr["number"]),
            "source_sha": manifest["sourceSha"],
            "reason": "candidate_check_not_dispatched",
            "check_dispatched": False,
        }
    )
    # A GITHUB_TOKEN-created PR does not start PR workflows. Run only the trusted
    # source-branch policy, which posts its result to this exact candidate SHA.
    subprocess.run(
        [
            "gh",
            "workflow",
            "run",
            "deployment-ci.yml",
            "--repo",
            fork.repository,
            "--ref",
            fork.branch,
            "-f",
            "candidate_sha=" + revision,
            "-f",
            "pr_number=" + str(pr["number"]),
        ],
        check=True,
        capture_output=True,
        timeout=60,
    )
    result.update(check_dispatched=True, reason="candidate_ready_for_review")
    return result


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


def event_run(fork):
    event = json.loads(
        Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8")
    )
    if os.environ["GITHUB_EVENT_NAME"] == "workflow_run":
        run = event.get("workflow_run", {})
        if not valid_run(
            run,
            run.get("head_sha"),
            ".github/workflows/msa-images.yml",
            {"workflow_dispatch", "workflow_run"},
            fork,
        ):
            raise ValueError("Untrusted publisher event")
        return run["id"]
    if (
        os.environ["GITHUB_EVENT_NAME"] != "workflow_dispatch"
        or os.environ["GITHUB_REF"] != "refs/heads/" + fork.branch
    ):
        raise ValueError(
            "Only the source default branch can prepare deployment candidates"
        )
    return None


def write_outputs(values):
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
            output.writelines(
                f"{key}={str(value).lower() if isinstance(value, bool) else value}\n"
                for key, value in values.items()
            )
    print(json.dumps(values))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "propose", "check", "bootstrap"))
    parser.add_argument("--directory", type=Path)
    parser.add_argument("--helm", default="helm")
    args = parser.parse_args()
    fork = (
        from_ci()
        if os.environ.get("GITHUB_REPOSITORY")
        else from_origin(REPOSITORY_ROOT)
    )
    fork.require_personal_publish()
    if args.action == "bootstrap":
        # Create a local commit only, for administrator review before protection setup.
        revision = git_bytes(REPOSITORY_ROOT, "rev-parse", "HEAD").decode().strip()
        policy = tracked_files(REPOSITORY_ROOT, revision, (CHECK_WORKFLOW,))
        if set(policy) != {CHECK_WORKFLOW}:
            raise ValueError(
                "Commit the deployment validation workflow before bootstrap"
            )
        commit = commit_tree(REPOSITORY_ROOT, {})
        print("Bootstrap commit (no remote writes): " + commit)
        print(
            "After review: git push origin "
            + commit
            + ":refs/heads/"
            + DEPLOYMENT_BRANCH
        )
        return
    if args.action in {"prepare", "propose"}:
        if os.environ.get("MSA_PROMOTION_ENABLED") != "true" or args.directory is None:
            raise ValueError(
                "Explicit promotion opt-in and candidate directory are required"
            )
        run_id = event_run(fork)
        decision = {"prepared": False, "reason": "candidate_error", "source_sha": ""}
        try:
            if args.action == "prepare":
                decision = prepare_candidate(
                    REPOSITORY_ROOT, fork, args.directory, args.helm, run_id=run_id
                )
            else:
                decision = propose(
                    REPOSITORY_ROOT,
                    fork,
                    directory_files(args.directory),
                    os.environ["GITHUB_RUN_ID"]
                    + "-"
                    + os.environ["GITHUB_RUN_ATTEMPT"],
                    args.helm,
                    result=decision,
                )
        finally:
            write_outputs(decision)
        return
    event = json.loads(
        Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8")
    )
    if (
        os.environ["GITHUB_EVENT_NAME"] != "workflow_dispatch"
        or os.environ["GITHUB_REF"] != "refs/heads/" + fork.branch
    ):
        raise ValueError(
            "Deployment checks must run the trusted source-branch workflow"
        )
    revision = event.get("inputs", {}).get("candidate_sha")
    number = event.get("inputs", {}).get("pr_number", "")
    if not valid_sha(revision) or not number.isdecimal() or int(number) <= 0:
        raise ValueError("A full candidate SHA and PR number are required")
    pr = api(f"repos/{fork.repository}/pulls/{int(number)}")
    if (
        pr["state"] != "open"
        or pr["base"]["ref"] != DEPLOYMENT_BRANCH
        or pr["base"]["repo"]["full_name"] != fork.repository
        or pr["head"]["repo"]["full_name"] != fork.repository
        or not pr["head"]["ref"].startswith(CANDIDATE_PREFIX)
        or pr["head"]["sha"] != revision
    ):
        raise ValueError("PR identity or candidate revision changed")
    status_path = f"repos/{fork.repository}/statuses/{revision}"
    status = {
        "context": CHECK_NAME,
        "target_url": f"https://github.com/{fork.repository}/actions/runs/{os.environ['GITHUB_RUN_ID']}",
    }
    mutation(
        status_path,
        status
        | {
            "state": "pending",
            "description": "Validating exact source, receipts and deployment snapshot",
        },
    )
    try:
        ensure_revision(REPOSITORY_ROOT, revision)
        manifest = admit(
            REPOSITORY_ROOT, fork, tracked_files(REPOSITORY_ROOT, revision), args.helm
        )
        candidate_parent(REPOSITORY_ROOT, revision, manifest["baseSha"])
        current = api(f"repos/{fork.repository}/pulls/{int(number)}")
        if current["state"] != "open" or current["head"]["sha"] != revision:
            raise ValueError("PR changed during validation")
    except Exception:
        mutation(
            status_path,
            status
            | {
                "state": "failure",
                "description": "Candidate validation failed; inspect the workflow log",
            },
        )
        raise
    mutation(
        status_path,
        status
        | {
            "state": "success",
            "description": "Exact candidate validated; review and manual merge still required",
        },
    )
    print(
        "PASS: exact candidate "
        + manifest["candidateHash"]
        + " at "
        + revision
        + "; not deployed"
    )


if __name__ == "__main__":
    main()
