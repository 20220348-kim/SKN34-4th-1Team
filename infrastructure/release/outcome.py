"""Record publication/promotion facts without granting deployment approval."""

import argparse
import json
import os
from pathlib import Path

from gate import valid_sha
from repository import SERVICES, from_ci

# Informational artifacts are never receipts or authorization evidence.
PUBLICATION_REPORTS = {"msa-publication-result"} | {
    "msa-publication-" + s for s in SERVICES
}


def write_report(path, report):
    report = {**report, "schema": "msa-release-outcome-v1"}
    for field, key in (
        ("runId", "GITHUB_RUN_ID"),
        ("runAttempt", "GITHUB_RUN_ATTEMPT"),
    ):
        if os.environ.get(key):
            report.setdefault(field, int(os.environ[key]))
    payload = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    path.write_text(payload, encoding="utf-8")
    print(payload, end="")
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as summary:
            summary.write("### Release outcome\n\n```json\n" + payload + "```\n\n")
            summary.write(
                "This record does not confirm Argo CD sync or cluster readiness.\n"
            )
    return report


def workflow_report(stage, needs, event, env):
    fork = from_ci(env)
    trigger = (
        event.get("workflow_run", {}).get("head_sha")
        if env.get("GITHUB_EVENT_NAME") == "workflow_run"
        else env.get("GITHUB_SHA")
    )
    job = needs.get("gate" if stage == "publication" else "promote", {})
    outputs = job.get("outputs", {})
    source = outputs.get("source_sha")
    report = {
        "stage": stage,
        "repository": fork.repository,
        "branch": fork.branch,
        "runId": int(env["GITHUB_RUN_ID"]),
        "runAttempt": int(env["GITHUB_RUN_ATTEMPT"]),
        "triggerSha": trigger if valid_sha(trigger) else None,
        "sourceSha": source if valid_sha(source) else None,
        "clusterVerified": False,
    }
    metadata = event.get("repository", {})
    personal = (
        metadata.get("full_name") == fork.repository
        and metadata.get("fork") is True
        and metadata.get("owner", {}).get("type") == "User"
        and fork.owner.lower() != "sknetworks-family-aicamp"
    )
    enabled = (
        env.get(
            "MSA_RELEASE_ENABLED" if stage == "publication" else "MSA_PROMOTION_ENABLED"
        )
        == "true"
    )
    result = job.get("result", "unknown")
    if not personal:
        reason = "not_personal_fork"
    elif not enabled:
        reason = "disabled"
    else:
        reason = outputs.get("reason") or "job_" + result
    if stage == "publication":
        published = needs.get("publish", {}).get("result", "unknown")
        ready = (
            result == "success" and outputs.get("ready") == "true" and valid_sha(source)
        )
        verified = bool(personal and enabled and ready and published == "success")
        state = "blocked"
        if verified:
            state, reason = "verified", "verified_receipts"
        elif published in {"failure", "cancelled", "unknown"}:
            state = published
            if ready:
                reason = "publication_" + published
        elif published == "success" and personal and enabled:
            state, reason = "unverified", "missing_gate_evidence"
        report.update(
            gateResult=result,
            publicationResult=published,
            imagesVerified=verified,
            state=state,
            reason=reason,
        )
        # Matrix failures may occur after some pushes; upload/reuse facts live in
        # each service report and must not be inferred from the aggregate result.
    else:
        pushed = outputs.get("pushed") == "true"
        attempted = outputs.get("push_attempted") == "true"
        revision = outputs.get("revision")
        confirmed = (
            personal
            and enabled
            and pushed
            and valid_sha(source)
            and valid_sha(revision)
        )
        if result in {"failure", "cancelled"}:
            failed = next(
                (
                    name
                    for name in ("selection", "validation", "commit")
                    if outputs.get(name + "_result") in {"failure", "cancelled"}
                ),
                None,
            )
            reason = (failed + "_" + result) if failed else "job_" + result
        if attempted and not confirmed:
            reason = "push_unconfirmed"
        state = "blocked" if result in {"success", "skipped"} else result
        if confirmed:
            state, reason = "pushed", "push_confirmed"
        elif (
            personal
            and enabled
            and valid_sha(source)
            and valid_sha(revision)
            and result == "success"
            and outputs.get("unchanged") == "true"
        ):
            state, reason = "unchanged", "no_changes"
        elif reason == "prepared":
            reason = "promotion_not_confirmed"
        report.update(
            jobResult=result,
            state=state,
            reason=reason,
            pushed=True if confirmed else None if attempted else False,
            revision=revision if valid_sha(revision) else None,
            publisherRunId=outputs.get("publisher_run_id") or None,
        )
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", choices=("publication", "promotion"), required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    event = json.loads(
        Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8")
    )
    report = workflow_report(
        args.stage, json.loads(os.environ["RELEASE_NEEDS"]), event, os.environ
    )
    write_report(args.output, report)


if __name__ == "__main__":
    main()
