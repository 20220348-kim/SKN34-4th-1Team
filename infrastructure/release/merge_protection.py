"""Export or audit merge rules without changing GitHub configuration."""

import argparse
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from ci_policy import WORKFLOWS
from repository import Fork, from_origin

RULESET_NAME = "GovBiz required CI - zero review approvals"
GITHUB_ACTIONS_APP = 15368


class PolicyAccessError(ValueError):
    """Expose only a fixed reason code, never GitHub response text."""


def ruleset(branch):
    return {
        "name": RULESET_NAME,
        "target": "branch",
        "enforcement": "active",
        "bypass_actors": [],
        "conditions": {
            "ref_name": {"include": ["refs/heads/" + branch], "exclude": []}
        },
        "rules": [
            {
                "type": "pull_request",
                "parameters": {
                    "required_approving_review_count": 0,
                    "dismiss_stale_reviews_on_push": False,
                    "require_code_owner_review": False,
                    "require_last_push_approval": False,
                    "required_review_thread_resolution": False,
                },
            },
            {
                "type": "required_status_checks",
                "parameters": {
                    "strict_required_status_checks_policy": True,
                    "do_not_enforce_on_create": False,
                    "required_status_checks": [
                        {"context": name, "integration_id": GITHUB_ACTIONS_APP}
                        for names in WORKFLOWS.values()
                        for name in names
                    ],
                },
            },
        ],
    }


def api(path, *, pages=False, absent=False):
    command = [
        "gh",
        "api",
        "--method",
        "GET",
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        "X-GitHub-Api-Version: 2022-11-28",
        path,
    ]
    if pages:
        command += ["--paginate"]
    result = subprocess.run(
        command, text=True, capture_output=True, timeout=90, check=False
    )
    if result.returncode:
        try:
            status = json.loads(result.stdout).get("status")
        except (ValueError, AttributeError):
            status = None
        if absent and str(status) == "404":
            return None
        # Never print gh stderr, request headers, credential hints, or response bodies.
        reason = (
            "github_api_permission_denied"
            if str(status) in {"401", "403"}
            else "github_api_unavailable"
        )
        raise PolicyAccessError(reason)
    if pages:
        # Older gh releases emit consecutive JSON documents and lack --slurp.
        # Parse every page; partial or malformed output must never pass an audit.
        remaining = result.stdout.strip()
        if not remaining:
            raise ValueError("Incomplete GitHub list response")
        items = []
        decoder = json.JSONDecoder()
        while remaining:
            page, end = decoder.raw_decode(remaining)
            if not isinstance(page, list):
                raise TypeError("Incomplete GitHub list response")
            items.extend(page)
            remaining = remaining[end:].lstrip()
        return items
    return json.loads(result.stdout)


def audit(fork, get=api):
    prefix = "repos/" + fork.repository
    metadata = get(prefix)
    if metadata.get("full_name", "").lower() != fork.repository.lower():
        raise ValueError("Repository identity could not be verified")
    # Some APIs conceal bypass details from non-admins. A missing field is not [];
    # a concealed 404 must not be treated as the absence of protection.
    if metadata.get("permissions", {}).get("admin") is not True:
        raise ValueError(
            "Repository administration visibility is needed to audit bypass rules"
        )
    branch = quote(fork.branch, safe="")
    effective = get(f"{prefix}/rules/branches/{branch}?per_page=100", pages=True)
    classic = get(f"{prefix}/branches/{branch}/protection", absent=True)
    sources = {}
    for rule in effective:
        identity = rule.get("ruleset_id")
        if type(identity) is not int or identity <= 0:
            raise ValueError("Effective rule source is missing")
        if identity not in sources:
            source = get(f"{prefix}/rulesets/{identity}?includes_parents=true")
            if (
                source.get("id") != identity
                or source.get("enforcement") != "active"
                or not isinstance(source.get("bypass_actors"), list)
            ):
                raise ValueError("Active ruleset or bypass visibility is incomplete")
            sources[identity] = source

    expected = ruleset(fork.branch)
    candidates = [
        source for source in sources.values() if source.get("name") == RULESET_NAME
    ]
    problems = []
    if len(candidates) != 1:
        problems.append("dedicated_active_ruleset_missing_or_ambiguous")
    else:
        actual = candidates[0]
        if (
            actual.get("target") != "branch"
            or actual.get("conditions") != expected["conditions"]
        ):
            problems.append("branch_scope_differs")
        for wanted in expected["rules"]:
            matches = [
                r for r in actual.get("rules", []) if r.get("type") == wanted["type"]
            ]
            if len(matches) != 1:
                problems.append("missing_or_ambiguous_rule:" + wanted["type"])
                continue
            params = matches[0].get("parameters", {})
            if wanted["type"] == "required_status_checks":
                checks = params.get("required_status_checks", [])
                if (
                    params.get("strict_required_status_checks_policy") is not True
                    or params.get("do_not_enforce_on_create", False) is not False
                    or not isinstance(checks, list)
                    or any(
                        item not in checks
                        for item in wanted["parameters"]["required_status_checks"]
                    )
                ):
                    problems.append("required_checks_missing_unbound_or_not_strict")
            elif any(
                params.get(key) != value for key, value in wanted["parameters"].items()
            ):
                problems.append("pull_request_policy_differs")

    # Other repository/organization rules still apply; never silently relax them.
    for rule in effective:
        if rule.get("type") == "pull_request":
            params = rule.get("parameters", {})
            if (
                params.get("required_approving_review_count") != 0
                or params.get("require_code_owner_review") is not False
                or params.get("require_last_push_approval") is not False
            ):
                problems.append("another_rule_requires_review_approval")
    for identity, source in sources.items():
        if source["bypass_actors"]:
            problems.append(f"ruleset_has_bypass:{identity}")
    if classic is not None:
        reviews = classic.get("required_pull_request_reviews")
        if reviews and (
            reviews.get("required_approving_review_count", 0) != 0
            or reviews.get("require_code_owner_reviews")
            or reviews.get("require_last_push_approval")
        ):
            problems.append("classic_protection_requires_review_approval")
        if classic.get("enforce_admins", {}).get("enabled") is not True:
            problems.append("classic_protection_allows_admin_bypass")
        if reviews and any(reviews.get("bypass_pull_request_allowances", {}).values()):
            problems.append("classic_protection_has_pull_request_bypass")

    # Reject a policy edited while its effective rules and bypass details were read.
    if get(f"{prefix}/rules/branches/{branch}?per_page=100", pages=True) != effective:
        raise ValueError("Effective branch rules changed during inspection")
    if get(f"{prefix}/branches/{branch}/protection", absent=True) != classic:
        raise ValueError("Classic branch protection changed during inspection")
    for identity, source in sources.items():
        if get(f"{prefix}/rulesets/{identity}?includes_parents=true") != source:
            raise ValueError("Ruleset changed during inspection")

    # An administrator can edit rules, even when they cannot bypass a merge rule.
    return {
        "status": "FAIL" if problems else "PASS",
        "scope": "merge_rule_configuration",
        "repository": fork.repository,
        "branch": fork.branch,
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "problems": sorted(set(problems)),
        "required_check_count": sum(map(len, WORKFLOWS.values())),
        "bypass_rulesets": [
            {"id": identity, "actors": source["bypass_actors"]}
            for identity, source in sorted(sources.items())
        ],
        "classic_protection_present": classic is not None,
        "administrator_can_edit_rules": True,
        "merge_behavior_verified": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("ruleset", "check"))
    parser.add_argument("--repository", help="GitHub owner/name; defaults to origin")
    parser.add_argument("--branch", default="main")
    args = parser.parse_args()
    try:
        fork = (
            Fork(args.repository, args.branch)
            if args.repository
            else from_origin(Path(__file__).resolve().parents[2], args.branch)
        )
        result = ruleset(fork.branch) if args.command == "ruleset" else audit(fork)
    except (
        ValueError,
        KeyError,
        TypeError,
        AttributeError,
        OSError,
        subprocess.SubprocessError,
    ) as error:
        print(
            json.dumps(
                {
                    "status": "UNKNOWN",
                    "scope": "merge_rule_configuration",
                    "reason": str(error)
                    if isinstance(error, PolicyAccessError)
                    else "API access, identity or complete policy evidence unavailable",
                }
            )
        )
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if result.get("status") == "FAIL" else 0


if __name__ == "__main__":
    raise SystemExit(main())
