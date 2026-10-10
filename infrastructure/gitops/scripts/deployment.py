"""Verify published images for local startup and read historical deployment snapshots."""

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import quote
from urllib.request import urlopen

import yaml
from deployment_candidate import (
    DEPLOYMENT_BRANCH,
    MANIFEST,
    PREFIX,
    SCHEMA,
    SERVICES,
    argo_resources,
    build,
    digest,
    encoded,
    git_bytes,
    manifest_of,
    release_files,
    tracked_files,
    verify,
    write_files,
)
from gate import (
    WORKFLOWS,
    api,
    blocked_reason,
    ci_blocked_reason,
    upstream_merged,
    valid_sha,
)
from repository import from_origin
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


def source_checks(fork, sha, get=api, *, pinned=False):
    current = head(fork, fork.branch, get)
    if current != sha:
        if not pinned:
            raise ValueError("Source advanced: generate a new candidate")
        # An explicitly selected publication may remain on a tested main ancestor.
        # Do not infer ancestry from an empty or truncated file comparison.
        comparison = get(f"repos/{fork.repository}/compare/{current}...{sha}")
        if not (
            valid_sha(sha)
            and comparison.get("status") == "behind"
            and comparison.get("base_commit", {}).get("sha") == current
            and comparison.get("merge_base_commit", {}).get("sha") == sha
            and type(comparison.get("ahead_by")) is int
            and comparison["ahead_by"] == 0
            and type(comparison.get("behind_by")) is int
            and comparison["behind_by"] > 0
            and comparison.get("total_commits") == 0
            and comparison.get("commits") == []
            and comparison.get("files") == []
        ):
            raise ValueError("Pinned publication is not an ancestor of the fork branch")
    checks = []
    if pinned:
        reason = (
            ci_blocked_reason(sha, fork, get, evidence=checks)
            if upstream_merged(sha, fork, get, ancestor_only=True)
            else "upstream_not_merged"
        )
    else:
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


def publication_blocker(fork, get=release_api):
    """Explain a missing publication from current source checks; never authorize it."""
    unknown = {
        "status": "UNKNOWN",
        "stage": "unknown",
        "reason": "diagnostic_unavailable",
        "advisoryOnly": True,
    }
    try:
        sha = head(fork, fork.branch, get)
        reason = blocked_reason(sha, fork, get)
        if head(fork, fork.branch, get) != sha or reason == "source_not_current":
            return {**unknown, "stage": "source", "reason": "source_changed"}
        details = {}
        if reason is None:
            stage, code = "publication", "verified_publication_missing"
        elif reason == "upstream_not_merged":
            stage, code = "upstream", "upstream_not_merged"
        else:
            code, separator, workflow = reason.partition(":")
            if (
                separator != ":"
                or workflow not in WORKFLOWS
                or code
                not in {
                    "ci_run_missing",
                    "ci_run_not_successful_or_untrusted",
                    "ci_jobs_not_successful_or_incomplete",
                    "ci_run_changed",
                }
            ):
                return unknown
            stage = "required_ci"
            details["workflow"] = workflow
        return {
            "status": "BLOCKED",
            "stage": stage,
            "reason": code,
            "observedSourceSha": sha,
            "advisoryOnly": True,
            **details,
        }
    except Exception:  # noqa: BLE001 - diagnostics must not expose API/subprocess data
        return unknown


def verified_release(
    root,
    fork,
    helm="helm",
    get=release_api,
    *,
    verify_public_manifests=False,
    run_id=None,
):
    """Resolve a tested publication without branches, PRs or checkout writes."""
    fork.require_personal_publish()
    selection = (run_id,) if run_id is not None else ()
    source_options = {"pinned": True} if selection else {}
    release = select_release(fork, get, *selection)
    if release is None:
        raise ValueError(
            "No complete verified publication; wait for source CI and image publication"
        )
    run, artifacts = release
    if type(run.get("run_attempt")) is not int or run["run_attempt"] <= 0:
        raise ValueError("Publisher attempt is missing or invalid")
    sha = run["head_sha"]
    checks = source_checks(fork, sha, get, **source_options)
    receipts = checked_receipts(sha, release, fork, get)
    ensure_revision(root, sha)
    files = release_files(root, fork, sha, run["id"], receipts, helm)
    record = json.loads(files[PREFIX + "environments/fork/release.json"])
    if verify_public_manifests:
        if record.get("visibility") != "public":
            raise ValueError(
                "Public receipts are required for anonymous manifest verification"
            )
        from fork_cluster import verify_pull_rights

        verify_pull_rights(None, None, record)
    # Recheck after registry access as well: new runs/receipts/CI must not inherit
    # the earlier verification even when the old registry digests still exist.
    confirmed = select_release(fork, get, *selection)
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
    if source_checks(fork, sha, get, **source_options) != checks:
        raise ValueError("Required CI evidence changed during validation; retry")
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


def gitops_plan(fork, record, files, sha):
    """Describe manual Argo inputs from an already verified public publication."""
    if (
        not valid_sha(sha)
        or record.get("verifiedRevision") != sha
        or record.get("repository") != fork.repository
        or record.get("branch") != fork.branch
        or record.get("visibility") != "public"
    ):
        raise ValueError("GitOps plan requires the matching public publication")
    resources = argo_resources(fork)
    rendered_hashes = {}
    for service, application in zip(SERVICES, resources[1:], strict=True):
        values = yaml.safe_load(files[PREFIX + f"environments/fork/{service}.yaml"])
        if values["image"]["repository"] + "@" + values["image"]["digest"] != record[
            "images"
        ][service] or values.get("imagePullSecrets"):
            raise ValueError("GitOps values differ from the public image receipt")
        source = application["spec"]["source"]
        source["targetRevision"] = sha
        # Published values are generated from receipts and may not exist at sha.
        # Supplying the entire verified values object avoids stale Git value files.
        source["helm"].pop("valueFiles")
        source["helm"]["valuesObject"] = values
        application["spec"]["syncPolicy"]["automated"] = {
            "enabled": False,
            "prune": False,
            "selfHeal": False,
        }
        application["spec"]["syncPolicy"]["retry"]["limit"] = 0
        rendered_hashes[service] = digest(files[PREFIX + f"rendered/{service}.json"])
    return {
        "status": "PLANNED",
        "resources": resources,
        "resourcesSha256": digest(encoded(resources)),
        "renderedSha256": rendered_hashes,
        "automaticSyncEnabled": False,
        "existingRuntimeVerified": False,
        "deploymentAuthorized": False,
    }


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in {
        "verify-public",
        "plan-gitops",
        "review-published-runtime",
        "--help",
        "-h",
    }:
        raise SystemExit(
            "Separate deployment branches and deployment PR automation were removed. "
            "Use verify-public, plan-gitops or review-published-runtime for read-only preparation. "
            "Automatic deployment is not configured; no remote changes were made."
        )
    parser = argparse.ArgumentParser(
        description="Verify public images or plan pinned Argo inputs; never apply to a cluster."
    )
    parser.add_argument(
        "action", choices=("verify-public", "plan-gitops", "review-published-runtime")
    )
    parser.add_argument("--branch", help="Origin's default branch when omitted")
    parser.add_argument("--helm", default="helm", help="Pinned Helm executable")
    parser.add_argument(
        "--state-dir",
        type=Path,
        help="Owned local state for plan-gitops or review-published-runtime",
    )
    parser.add_argument(
        "--review-preservation",
        action="store_true",
        help="With --state-dir, render existing environment/sync settings temporarily; never apply or export values",
    )
    args = parser.parse_args()
    published_review = args.action == "review-published-runtime"
    if args.state_dir is not None and args.action == "verify-public":
        parser.error("--state-dir is not supported by verify-public")
    if published_review and args.state_dir is None:
        parser.error("review-published-runtime requires --state-dir")
    if args.review_preservation and (
        args.state_dir is None or args.action != "plan-gitops"
    ):
        parser.error("--review-preservation requires plan-gitops --state-dir")
    report = {
        "schema": {
            "verify-public": "msa-publication-check-v1",
            "plan-gitops": "msa-gitops-plan-v1",
            "review-published-runtime": "msa-published-runtime-review-v1",
        }[args.action],
        "status": "BLOCKED",
        "clusterVerified": False,
        "layersDownloaded": False,
    }
    fork = None
    try:
        root = Path(__file__).resolve().parents[3]
        fork = from_origin(root, branch=args.branch).require_personal_publish()
        report.update(repository=fork.repository, branch=fork.branch)
        if published_review:
            report.update(
                referenceScope="verified_publication",
                publishedReferenceVerified=False,
                deploymentAuthorized=False,
            )
            publication = verified_release(
                root, fork, args.helm, verify_public_manifests=True
            )
            record, files, sha = publication
        if args.state_dir is not None:
            from gitops_runtime import SCOPE, preflight

            report["runtimePreflight"] = {
                "status": "UNKNOWN",
                "scope": SCOPE,
            }
            options = {"review_preservation": True} if args.review_preservation else {}
            if published_review:
                options = {"review_preservation": True, "published_files": files}
            observed = preflight(args.state_dir, fork, args.helm, **options)
            if published_review:
                if (
                    verified_release(
                        root, fork, args.helm, verify_public_manifests=True
                    )
                    != publication
                ):
                    raise ValueError(
                        "Publisher or image receipts changed during runtime review"
                    )
                report.update(
                    sourceSha=sha,
                    publisherRunId=record["runId"],
                    publishedReferenceVerified=True,
                )
            report["runtimePreflight"] = observed
            if report["runtimePreflight"]["status"] != "NO_LOCAL_OVERRIDES":
                raise ValueError("Local runtime requires an explicit transition")
        if not published_review:
            record, files, sha = verified_release(
                root, fork, args.helm, verify_public_manifests=True
            )
        plan = {}
        if args.action == "plan-gitops":
            plan = gitops_plan(fork, record, files, sha)
        elif published_review:
            plan = {"status": "REVIEWED", "existingRuntimeVerified": False}
        report.update(
            status="PASS",
            sourceSha=sha,
            publisherRunId=record["runId"],
            visibility=record["visibility"],
            images=record["images"],
            receiptsVerified=True,
            helmPolicyVerified=True,
            registryManifestsVerified=True,
        )
        report.update(plan)
    except Exception as error:  # noqa: BLE001 - do not print registry bearer or subprocess details
        reasons = {
            "Local runtime requires an explicit transition": "runtime_transition_required",
            "No complete verified publication": "publication_not_available",
            "Source advanced": "source_not_current",
            "Deployment source blocked": "required_source_checks_not_verified",
            "Public receipts are required": "public_receipts_required",
            "Publisher or image receipts changed": "publication_changed",
            "Required CI evidence changed": "ci_evidence_changed",
        }
        reason = next(
            (code for prefix, code in reasons.items() if str(error).startswith(prefix)),
            "verification_failed",
        )
        report.update(reason=reason, errorType=type(error).__name__)
        if fork is not None and reason in {
            "publication_not_available",
            "source_not_current",
            "required_source_checks_not_verified",
        }:
            report["publicationBlocker"] = publication_blocker(fork)
        print(json.dumps(report, sort_keys=True))
        return 1
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
