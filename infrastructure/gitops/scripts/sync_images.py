"""Historical GovBiz-Team promotion algorithm; CLI locked after repo integration.

Read only GitHub-generated receipts from the fixed publisher. No source code from
the app repository is executed, no private registry credential or cross-repo PAT.
The workflow validates the rendered configuration before its normal Git push.
"""
import argparse
import hashlib
import io
import json
import re
import subprocess
import zipfile
from pathlib import Path

import yaml

from promote_image import ROOT, SERVICES, UniqueLoader, updated_values, validate_receipt

APP = "GovBiz-Team/GovBiz"
ENVIRONMENT = "portfolio"
WORKFLOWS = ("ci.yml", "catalog-ci.yml", "ops-ci.yml")


def api(path, binary=False):
    result = subprocess.check_output(["gh", "api", path], timeout=90)
    return result if binary else json.loads(result)


def source_sha(get=api):
    sha = get(f"repos/{APP}/git/ref/heads/develop")["object"]["sha"]
    if not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise ValueError("Invalid source SHA")
    return sha


def tested(sha, get=api):
    if source_sha(get) != sha:
        return False
    for filename in WORKFLOWS:
        runs = get(f"repos/{APP}/actions/workflows/{filename}/runs?head_sha={sha}&event=push&branch=develop&per_page=100")["workflow_runs"]
        if not runs:
            return False
        run = max(runs, key=lambda item: (item["id"], item.get("run_attempt", 1)))
        if not valid_run(run, sha, f".github/workflows/{filename}", {"push"}):
            return False
    return True


def valid_run(run, sha, path, events):
    return (run.get("head_sha") == sha and run.get("head_branch") == "develop"
            and run.get("path") == path and run.get("event") in events
            and run.get("head_repository", {}).get("full_name") == APP
            and run.get("status") == "completed" and run.get("conclusion") == "success")


def select_release(sha, get=api):
    runs = get(f"repos/{APP}/actions/workflows/msa-images.yml/runs?head_sha={sha}&branch=develop&per_page=100")["workflow_runs"]
    for run in sorted(runs, key=lambda item: item["id"], reverse=True):
        # Never hide a recent failure or in-progress attempt with an old success.
        if run.get("status") != "completed" or run.get("conclusion") not in {"success", "skipped"}:
            return None
        if run.get("conclusion") == "skipped":
            continue
        if not valid_run(run, sha, ".github/workflows/msa-images.yml", {"workflow_run", "workflow_dispatch"}):
            raise ValueError("Unexpected publisher source")
        artifacts = get(f"repos/{APP}/actions/runs/{run['id']}/artifacts?per_page=100")["artifacts"]
        if not artifacts:  # successful gate-only run; nothing was published
            continue
        if len(artifacts) != 4 or {a["name"] for a in artifacts} != {"msa-image-" + s for s in SERVICES}:
            raise ValueError("Publisher must provide exactly four image receipts")
        for artifact in artifacts:
            origin = artifact.get("workflow_run", {})
            if (artifact.get("expired") is not False or origin.get("id") != run["id"]
                    or origin.get("head_sha") != sha or origin.get("head_branch") != "develop"
                    or origin.get("repository_id") != run["repository"]["id"]
                    or origin.get("head_repository_id") != run["repository"]["id"]
                    or not 0 < artifact.get("size_in_bytes", 0) < 16384):
                raise ValueError("Invalid/expired/cross-repository artifact")
        return run, artifacts
    return None


def decode_receipt(payload, artifact, sha):
    if len(payload) > 16384 or "sha256:" + hashlib.sha256(payload).hexdigest() != artifact.get("digest"):
        raise ValueError("Artifact archive checksum/size mismatch")
    service = artifact["name"].removeprefix("msa-image-")
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        members = archive.infolist()
        if len(members) != 1 or members[0].filename != service + ".json" or members[0].file_size > 4096:
            raise ValueError("Unexpected receipt archive contents")
        receipt = json.loads(archive.read(members[0]))
    validate_receipt(receipt)
    if receipt["service"] != service or receipt["verifiedRevision"] != sha:
        raise ValueError("Receipt source/service mismatch")
    return receipt


def checked_receipts(sha, release, get=api):
    _, artifacts = release
    # Git tree API returns the directory identity without trusting artifact labels.
    tree = get(f"repos/{APP}/git/trees/{sha}?recursive=1")
    if tree.get("truncated"):
        raise ValueError("Cannot verify complete source tree")
    identities = {item["path"]: item["sha"] for item in tree["tree"] if item["type"] == "tree"}
    release_tree = identities["infrastructure/release"]
    receipts = []
    for artifact in artifacts:
        payload = get(f"repos/{APP}/actions/artifacts/{artifact['id']}/zip", binary=True)
        receipt = decode_receipt(payload, artifact, sha)
        service_tree = identities["backend/" + receipt["service"]]
        key = hashlib.sha256(f"v1\nlinux/amd64\n{service_tree}\n{release_tree}\n".encode()).hexdigest()
        if receipt["sourceTree"] != service_tree or receipt["inputKey"] != key:
            raise ValueError("Receipt tracked-input identity mismatch")
        receipts.append(receipt)
    return receipts


def prepare(root, receipts):
    if len(receipts) != 4 or {r["service"] for r in receipts} != set(SERVICES):
        raise ValueError("All four verified receipts are required")
    changes = {}
    for receipt in receipts:
        path = root / f"environments/{ENVIRONMENT}/{receipt['service']}.yaml"
        if not path.is_file() or path.resolve() != path.absolute():
            raise ValueError("Only existing, non-symlink portfolio values may change")
        original = path.read_text()
        values = yaml.load(original, Loader=UniqueLoader)
        updated = updated_values(values, receipt, values["image"].get("digest", ""))
        if values != updated:
            changes[path] = (original, yaml.safe_dump(updated, sort_keys=False, allow_unicode=True))
    return changes


def synchronize(root=ROOT, write=False, get=api):
    sha = source_sha(get)
    if not tested(sha, get):
        print("No promotion: current develop has not passed all three CI workflows")
        return
    release = select_release(sha, get)
    if release is None:
        print("No promotion: current source has no complete successful image release")
        return
    run, _ = release
    marker = root / f"environments/{ENVIRONMENT}/release.json"
    if marker.is_symlink():
        raise ValueError("Release record must not be a symlink")
    if marker.exists() and json.loads(marker.read_text()).get("runId") == run["id"]:
        print("No promotion: selected release already recorded")
        return
    receipts = checked_receipts(sha, release, get)
    changes = prepare(root, receipts)
    record = {"repository": APP, "verifiedRevision": sha, "runId": run["id"],
              "runUrl": f"https://github.com/{APP}/actions/runs/{run['id']}",
              "images": {r["service"]: r["repository"] + "@" + r["digest"] for r in receipts}}
    # Recheck after downloads; never promote a superseded/failed source.
    if not tested(sha, get):
        raise ValueError("Source/CI changed while checking receipts")
    if write:
        if any(path.read_text() != original for path, (original, _) in changes.items()):
            raise ValueError("Concurrent values modification")
        for path, (_, result) in changes.items():
            path.write_text(result)
        marker.write_text(json.dumps(record, indent=2) + "\n")
    print(f"Verified release {run['id']} at {sha}; {len(changes)} image digest changes; write={write}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--verify-record", action="store_true")
    args = parser.parse_args()
    parser.error(
        "Image promotion is disabled in the unified repository. The retained receipts "
        "belong to the former GovBiz-Team publisher. Configure and test the fork's "
        "publisher, private GHCR and source identities before enabling promotion. "
        "No GitHub API call or values update was made."
    )
    if args.verify_record:
        record = json.loads((ROOT / f"environments/{ENVIRONMENT}/release.json").read_text())
        if not tested(record["verifiedRevision"]):
            raise SystemExit("Source was superseded or its CI changed before push")
    else:
        synchronize(write=args.write)


if __name__ == "__main__":
    main()
