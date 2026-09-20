"""Promote verified images and their pull policy within the same personal fork."""

import argparse
import hashlib
import io
import json
import os
import re
import subprocess
import zipfile
from urllib.parse import quote

import yaml

from promote_image import ROOT, SERVICES, UniqueLoader, updated_values, validate_receipt
from gate import eligible, valid_sha
from repository import Fork, from_ci

ENVIRONMENT = "fork"


def api(path, binary=False):
    result = subprocess.check_output(["gh", "api", path], timeout=90)
    return result if binary else json.loads(result)


def valid_run(run, sha, path, events, fork):
    return (valid_sha(sha) and run.get("head_sha") == sha and run.get("head_branch") == fork.branch
            and run.get("path") == path and run.get("event") in events
            and run.get("head_repository", {}).get("full_name") == fork.repository
            and run.get("repository", {}).get("full_name") == fork.repository
            and run.get("status") == "completed" and run.get("conclusion") == "success")


def select_release(fork, get=api, run_id=None):
    if run_id is not None:
        if type(run_id) is not int or run_id <= 0:
            raise ValueError("Invalid publisher run id")
        runs = [get(f"repos/{fork.repository}/actions/runs/{run_id}")]
    else:
        runs = get(f"repos/{fork.repository}/actions/workflows/msa-images.yml/runs"
                   f"?branch={quote(fork.branch, safe='')}&per_page=100")["workflow_runs"]
    for run in sorted(runs, key=lambda item: (item["id"], item.get("run_attempt", 1)), reverse=True):
        if run.get("status") != "completed" or run.get("conclusion") not in {"success", "skipped"}:
            return None
        if run.get("conclusion") == "skipped":
            continue
        sha = run.get("head_sha")
        if not valid_run(run, sha, ".github/workflows/msa-images.yml",
                         {"workflow_run", "workflow_dispatch"}, fork):
            raise ValueError("Unexpected publisher source")
        artifacts = get(f"repos/{fork.repository}/actions/runs/{run['id']}/artifacts?per_page=100")["artifacts"]
        if not artifacts:  # successful gate-only run
            continue
        if len(artifacts) != 4 or {a["name"] for a in artifacts} != {"msa-image-" + s for s in SERVICES}:
            raise ValueError("Publisher must provide exactly four image receipts")
        for artifact in artifacts:
            origin = artifact.get("workflow_run", {})
            if (artifact.get("expired") is not False or origin.get("id") != run["id"]
                    or origin.get("head_sha") != sha or origin.get("head_branch") != fork.branch
                    or origin.get("repository_id") != run["repository"]["id"]
                    or origin.get("head_repository_id") != run["repository"]["id"]
                    or not 0 < artifact.get("size_in_bytes", 0) < 16384):
                raise ValueError("Invalid/expired/cross-repository artifact")
        return run, artifacts
    return None


def decode_receipt(payload, artifact, sha, fork):
    if len(payload) > 16384 or "sha256:" + hashlib.sha256(payload).hexdigest() != artifact.get("digest"):
        raise ValueError("Artifact archive checksum/size mismatch")
    service = artifact["name"].removeprefix("msa-image-")
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        members = archive.infolist()
        if len(members) != 1 or members[0].filename != service + ".json" or members[0].file_size > 4096:
            raise ValueError("Unexpected receipt archive contents")
        receipt = json.loads(archive.read(members[0]))
    validate_receipt(receipt, fork)
    if receipt["service"] != service or receipt["verifiedRevision"] != sha:
        raise ValueError("Receipt source/service mismatch")
    return receipt


def checked_receipts(sha, release, fork, get=api):
    _, artifacts = release
    tree = get(f"repos/{fork.repository}/git/trees/{sha}?recursive=1")
    if tree.get("truncated"):
        raise ValueError("Cannot verify complete source tree")
    identities = {item["path"]: item["sha"] for item in tree["tree"] if item["type"] == "tree"}
    release_tree = identities["infrastructure/release"]
    receipts = []
    for artifact in artifacts:
        payload = get(f"repos/{fork.repository}/actions/artifacts/{artifact['id']}/zip", binary=True)
        receipt = decode_receipt(payload, artifact, sha, fork)
        service_tree = identities["backend/" + receipt["service"]]
        key = hashlib.sha256(f"v1\nlinux/amd64\n{service_tree}\n{release_tree}\n".encode()).hexdigest()
        if receipt["sourceTree"] != service_tree or receipt["inputKey"] != key:
            raise ValueError("Receipt tracked-input identity mismatch")
        receipts.append(receipt)
    return receipts


def prepare(root, receipts, fork):
    """Preflight all four files before creating the fork environment for the first time."""
    if len(receipts) != 4 or {r["service"] for r in receipts} != set(SERVICES):
        raise ValueError("All four verified receipts are required")
    for receipt in receipts:
        validate_receipt(receipt, fork)
    if len({r.get("visibility", "private") for r in receipts}) != 1:
        raise ValueError("All four receipts must agree on package visibility")
    root = root.resolve()
    destination = root / "environments/fork"
    if destination.resolve() != destination.absolute():
        raise ValueError("Fork environment must not contain symlinks")
    marker = destination / "release.json"
    if marker.resolve() != marker.absolute():
        raise ValueError("Release record must not be a symlink")
    inherited = False
    if marker.exists():
        record = json.loads(marker.read_text())
        previous = Fork(record.get("repository"), record.get("branch"))
        validate_record(record, previous)
        inherited = previous != fork
    changes = {}
    for receipt in receipts:
        validate_receipt(receipt, fork)
        path = destination / (receipt["service"] + ".yaml")
        if path.resolve() != path.absolute() or (path.exists() and not path.is_file()):
            raise ValueError("Fork values must be plain files without symlinks")
        original = path.read_text() if path.exists() else None
        if original is None or inherited:
            # Portfolio templates contain only disabled-paid-API local runtime
            # defaults. Never retain their old registry or illustrative digest.
            template = root / "environments/portfolio" / path.name
            if template.resolve() != template.absolute() or not template.is_file():
                raise ValueError("Missing safe runtime template")
            values = yaml.load(template.read_text(), Loader=UniqueLoader)
            values["image"] = {"repository": fork.image(receipt["service"]), "digest": "",
                               "tag": "", "pullPolicy": "IfNotPresent"}
            values["imagePullSecrets"] = [{"name": "ghcr-pull"}]
            values["localMode"] = False
        else:
            values = yaml.load(original, Loader=UniqueLoader)
        updated = updated_values(values, receipt, values["image"].get("digest", ""), fork)
        if original is None or inherited or values != updated:
            changes[path] = (original, yaml.safe_dump(updated, sort_keys=False, allow_unicode=True))
    return changes


def validate_record(record, fork):
    keys = {"repository", "branch", "verifiedRevision", "runId", "runUrl", "images"}
    if (set(record) not in (keys, keys | {"visibility"})
            or record.get("visibility", "private") not in ("private", "public")
            or record["repository"] != fork.repository or record["branch"] != fork.branch
            or not valid_sha(record["verifiedRevision"])
            or type(record["runId"]) is not int or record["runId"] <= 0
            or record["runUrl"] != f"https://github.com/{fork.repository}/actions/runs/{record['runId']}"
            or not isinstance(record["images"], dict) or set(record["images"]) != set(SERVICES)):
        raise ValueError("Release record does not identify this fork and its verified publisher")
    for service, image in record["images"].items():
        if not isinstance(image, str) or not re.fullmatch(re.escape(fork.image(service)) + r"@sha256:[a-f0-9]{64}", image):
            raise ValueError("Release image does not belong to this fork")
    return record


def verify_record(root, fork, get=api):
    marker = root / "environments/fork/release.json"
    if marker.resolve() != marker.absolute():
        raise ValueError("Release record must not be a symlink")
    record = validate_record(json.loads(marker.read_text()), fork)
    sha = record["verifiedRevision"]
    if not eligible(sha, fork, get):
        raise ValueError("Source or one of its four CI results changed")
    release = select_release(fork, get, record["runId"])
    if release is None or release[0]["head_sha"] != sha:
        raise ValueError("Recorded publisher is not a successful release")
    receipts = checked_receipts(sha, release, fork, get)
    expected = {r["service"]: r["repository"] + "@" + r["digest"] for r in receipts}
    if (record["images"] != expected or prepare(root, receipts, fork)
            or any(r.get("visibility", "private") != record.get("visibility", "private") for r in receipts)):
        raise ValueError("Record/values differ from verified receipts")
    return record


def synchronize(fork, root=ROOT, write=False, get=api, run_id=None):
    fork.require_personal_publish()
    release = select_release(fork, get, run_id)
    if release is None:
        print("No promotion: no complete successful image release")
        return
    run, _ = release
    sha = run["head_sha"]
    if not eligible(sha, fork, get):
        print("No promotion: source changed or all four CI workflows have not passed")
        return
    receipts = checked_receipts(sha, release, fork, get)
    changes = prepare(root, receipts, fork)
    marker = root / "environments/fork/release.json"
    if marker.resolve() != marker.absolute():
        raise ValueError("Release record must not be a symlink")
    record = {"repository": fork.repository, "branch": fork.branch, "verifiedRevision": sha,
              "visibility": receipts[0].get("visibility", "private"),
              "runId": run["id"], "runUrl": f"https://github.com/{fork.repository}/actions/runs/{run['id']}",
              "images": {r["service"]: r["repository"] + "@" + r["digest"] for r in receipts}}
    validate_record(record, fork)
    if not eligible(sha, fork, get):
        raise ValueError("Source/CI changed while checking receipts")
    if write:
        for path, (original, _) in changes.items():
            if (path.read_text() if path.exists() else None) != original:
                raise ValueError("Concurrent values modification")
        marker.parent.mkdir(parents=True, exist_ok=True)
        for path, (_, result) in changes.items():
            path.write_text(result)
        marker.write_text(json.dumps(record, indent=2) + "\n")
    print(f"Verified release {run['id']} at {sha}; {len(changes)} image changes; write={write}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--verify-record", action="store_true")
    args = parser.parse_args()
    fork = from_ci().require_personal_publish()
    if os.environ.get("MSA_PROMOTION_ENABLED") != "true":
        raise SystemExit("Image promotion is disabled; opt in on your personal fork")
    event_name = os.environ.get("GITHUB_EVENT_NAME")
    run_id = None
    if event_name == "workflow_run":
        from pathlib import Path
        event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
        run = event.get("workflow_run", {})
        if not valid_run(run, run.get("head_sha"), ".github/workflows/msa-images.yml",
                         {"workflow_run", "workflow_dispatch"}, fork):
            raise SystemExit("Untrusted publisher event")
        run_id = run["id"]
    elif event_name != "workflow_dispatch" or os.environ.get("GITHUB_REF") != "refs/heads/" + fork.branch:
        raise SystemExit("Only default-branch manual dispatch or trusted publisher completion is allowed")
    if args.verify_record:
        verify_record(ROOT, fork)
    else:
        synchronize(fork, write=args.write, run_id=run_id)


if __name__ == "__main__":
    main()
