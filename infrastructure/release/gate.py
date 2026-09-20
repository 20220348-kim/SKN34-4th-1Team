"""Fail-closed release gate: only the current, fully tested develop push is eligible."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess

REPOSITORY = "GovBiz-Team/GovBiz"
WORKFLOWS = ("ci.yml", "catalog-ci.yml", "ops-ci.yml")


def api(path):
    return json.loads(subprocess.check_output(["gh", "api", path], text=True))


def valid_sha(sha):
    return isinstance(sha, str) and re.fullmatch(r"[0-9a-f]{40}", sha) is not None


def candidate(event_name, event, ref, sha):
    if event.get("repository", {}).get("full_name") != REPOSITORY:
        return None
    if event_name == "workflow_dispatch":
        return sha if ref == "refs/heads/develop" and valid_sha(sha) else None
    if event_name != "workflow_run":
        return None
    run = event.get("workflow_run", {})
    if (run.get("event") != "push" or run.get("head_branch") != "develop"
            or run.get("head_repository", {}).get("full_name") != REPOSITORY
            or run.get("conclusion") != "success" or run.get("status") != "completed"):
        return None
    return run.get("head_sha") if valid_sha(run.get("head_sha")) else None


def eligible(sha, get=api):
    if not valid_sha(sha):
        raise ValueError("A full source SHA is required")
    if get(f"repos/{REPOSITORY}/git/ref/heads/develop")["object"]["sha"] != sha:
        return False
    for filename in WORKFLOWS:
        response = get(f"repos/{REPOSITORY}/actions/workflows/{filename}/runs"
                       f"?head_sha={sha}&branch=develop&event=push&per_page=100")
        runs = response.get("workflow_runs", [])
        if not runs:
            return False
        # A newer failed/pending attempt must not be hidden by an older success.
        run = max(runs, key=lambda item: (item["id"], item.get("run_attempt", 1)))
        if (run.get("head_sha") != sha or run.get("head_branch") != "develop"
                or run.get("event") != "push" or run.get("status") != "completed"
                or run.get("conclusion") != "success"
                or run.get("path") != f".github/workflows/{filename}"
                or run.get("head_repository", {}).get("full_name") != REPOSITORY):
            return False
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-sha")
    args = parser.parse_args()
    if args.check_sha:
        if not eligible(args.check_sha):
            raise SystemExit("Release blocked: source is superseded or checks are not all successful")
        return
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    sha = candidate(os.environ["GITHUB_EVENT_NAME"], event,
                    os.environ["GITHUB_REF"], os.environ["GITHUB_SHA"])
    ready = bool(sha and eligible(sha))
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"ready={str(ready).lower()}\nsha={sha if ready else ''}\n")
    print("Release gate: eligible" if ready else "Release gate: not eligible (no images will be published)")


if __name__ == "__main__":
    main()
