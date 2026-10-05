"""Publish one service's tracked Git archive to GHCR; never deploy it."""

import argparse
import hashlib
import json
import os
import re
import subprocess
import tarfile
import tempfile
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from gate import eligible, valid_sha
from repository import from_ci

ROOT = Path(__file__).resolve().parents[2]
SERVICES = ("core-service", "catalog-service", "ai-service", "ops-service")
PLATFORM = "linux/amd64"


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def git(*args):
    return run("git", *args, cwd=ROOT, capture_output=True).stdout.strip()


def repository(service, fork):
    if service not in SERVICES:
        raise ValueError("Unknown GovBiz service")
    return fork.image(service)


def input_key(tree, publisher_tree):
    # Changing publication policy must not silently reuse an old-policy image.
    for value in (tree, publisher_tree):
        if not valid_sha(value):
            raise ValueError("Invalid Git tree identity")
    return hashlib.sha256(f"v1\n{PLATFORM}\n{tree}\n{publisher_tree}\n".encode()).hexdigest()


def package_exists(service, token, fork, visibility="private", *, result=None):
    if visibility not in ("private", "public"):
        raise ValueError("Package visibility must be private or public")
    repository(service, fork)
    # Only fixed status codes enter public logs/artifacts; never copy API payloads,
    # headers, credentials or arbitrary owner/repository names into diagnostics.
    check = {"state": "pending", "expectedVisibility": visibility}
    if result is not None:
        result["packageCheck"] = check
    request = Request(f"https://api.github.com/users/{fork.owner}/packages/container/{fork.name.lower()}-{service}",
                      headers={"Authorization": "Bearer " + token,
                               "Accept": "application/vnd.github+json",
                               "X-GitHub-Api-Version": "2022-11-28"})
    try:
        with urlopen(request, timeout=30) as response:
            package = json.load(response)
    except HTTPError as error:
        reason = {401: "authentication_failed", 403: "access_denied",
                  404: "missing_or_inaccessible", 429: "rate_limited"}.get(error.code, "http_error")
        check.update(state="unavailable", reason=reason, httpStatus=error.code)
        if error.code == 404:
            # Missing and inaccessible packages are never permission to create one.
            # GITHUB_TOKEN can make a new package inherit a public repository's visibility.
            return False
        raise RuntimeError(f"Cannot verify GitHub package ownership/access: {reason} (HTTP {error.code})") from None
    except (URLError, OSError):
        check.update(state="unavailable", reason="network_error")
        raise RuntimeError("Cannot verify GitHub package ownership/access: network_error") from None
    except (json.JSONDecodeError, UnicodeError):
        check.update(state="unavailable", reason="invalid_response")
        raise ValueError("Cannot verify GitHub package policy: invalid_response") from None
    if not isinstance(package, dict):
        check.update(state="unavailable", reason="invalid_response")
        raise ValueError("Cannot verify GitHub package policy: invalid_response")  # noqa: TRY004 - malformed API data
    checks = {}
    for name, key, expected in (("repository", "full_name", fork.repository),
                                ("owner", "login", fork.owner), ("visibility", None, visibility)):
        value = package.get(name)
        if key and isinstance(value, dict):
            value = value.get(key)
        if value is None or value == "":
            checks[name] = "missing"
        elif not isinstance(value, str) or (key and not isinstance(package.get(name), dict)):
            checks[name] = "invalid"
        elif (value.lower() if key else value) == (expected.lower() if key else expected):
            checks[name] = "matched"
        else:
            checks[name] = "mismatch"
    check["checks"] = checks
    actual_visibility = package.get("visibility")
    if isinstance(actual_visibility, str) and actual_visibility in ("private", "public", "internal"):
        check["actualVisibility"] = actual_visibility
    failed = [name + ":" + status for name, status in checks.items() if status != "matched"]
    if failed:
        check.update(state="rejected", reason="policy_mismatch")
        raise ValueError(f"Package must be {visibility}, owned by this user and linked to this exact fork; "
                         "failed checks: " + ", ".join(failed))
    check.update(state="verified", reason="policy_matched")
    return True


def lookup(uri, tag, key, docker_env, fork):
    reference = uri + ":" + tag
    result = subprocess.run(["docker", "buildx", "imagetools", "inspect", reference,
                             "--format", "{{json .Manifest}}"],
                            text=True, capture_output=True, env=docker_env)
    if result.returncode:
        # Authentication/rate-limit/network failures must never become "missing".
        if result.stderr.strip() == f"ERROR: {reference}: not found":
            return None
        raise RuntimeError("GHCR lookup failed (not an explicit manifest-not-found); check registry access")
    manifest = json.loads(result.stdout)
    digest = manifest.get("digest", "")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise ValueError("Registry did not return a valid digest")
    # GHCR tags are mutable. Reuse only an image with matching tracked inputs;
    # read its config by digest to avoid a tag change between these two reads.
    config = json.loads(run("docker", "buildx", "imagetools", "inspect", uri + "@" + digest,
                            "--format", "{{json .Image}}", capture_output=True, env=docker_env).stdout)
    if "linux/amd64" in config:
        config = config["linux/amd64"]
    labels = config.get("config", {}).get("Labels", {})
    if (config.get("os") != "linux" or config.get("architecture") != "amd64"
            or labels.get("ai.govbiz.input-key") != key
            or labels.get("org.opencontainers.image.source") != fork.url.removesuffix(".git")):
        raise ValueError("Existing image has different inputs/source/platform; refusing reuse or overwrite")
    return digest


def publish(service, sha, output, actor, token, fork, visibility="private", *, result=None):
    result = {} if result is None else result
    result.update(state="failed", upload="not_attempted", reused=False, receiptWritten=False)
    fork.require_personal_publish()
    uri = repository(service, fork)
    if not valid_sha(sha) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9\[\]-]*", actor) or not token:
        raise ValueError("Full source SHA, GitHub actor and temporary package token are required")
    if output.exists() or not output.parent.is_dir():
        raise ValueError("Receipt must be a new file in an existing directory")
    if git("rev-parse", "HEAD") != sha or not eligible(sha, fork):
        raise ValueError("Checkout must be the successfully tested default-branch source")
    if not package_exists(service, token, fork, visibility, result=result):
        raise ValueError(f"A pre-created {visibility} package linked to this exact fork is required; "
                         "automatic package creation is disabled and no image was uploaded")
    tree = git("rev-parse", f"{sha}:backend/{service}")
    key = input_key(tree, git("rev-parse", f"{sha}:infrastructure/release"))
    tag = "src-" + key
    with tempfile.TemporaryDirectory(prefix="govbiz-release-") as directory:
        temporary = Path(directory)
        # Never alter the user's existing Docker login or print token values.
        docker_env = {**os.environ, "DOCKER_CONFIG": str(temporary / "docker")}
        try:
            run("docker", "login", "--username", actor, "--password-stdin", "ghcr.io",
                input=token, capture_output=True, env=docker_env)
            digest = lookup(uri, tag, key, docker_env, fork)
            result["reused"] = digest is not None
            if digest is None:
                archive = temporary / "source.tar"
                run("git", "archive", "--format=tar", "--output", str(archive), sha,
                    f"backend/{service}", cwd=ROOT)
                with tarfile.open(archive) as source:
                    source.extractall(temporary / "source", filter="data")
                reference = uri + ":" + tag
                run("docker", "build", "--platform", PLATFORM, "--label",
                    "org.opencontainers.image.revision=" + sha, "--label",
                    "org.opencontainers.image.source=" + fork.url.removesuffix(".git"), "--label",
                    "ai.govbiz.input-key=" + key, "--tag", reference,
                    str(temporary / "source/backend" / service), env=docker_env)
                if not eligible(sha, fork):
                    raise ValueError("Source superseded or checks changed during build; refusing upload")
                if not package_exists(service, token, fork, visibility, result=result):
                    raise ValueError("Package disappeared or became inaccessible during build; "
                                     "refusing upload instead of creating a new package")
                result["upload"] = "attempted"
                run("docker", "push", reference, env=docker_env)
                result["upload"] = "confirmed"
                # Recheck after upload as well; an unverified image gets no receipt.
                if not package_exists(service, token, fork, visibility, result=result):
                    raise RuntimeError("Published package visibility/ownership could not be verified")
                digest = lookup(uri, tag, key, docker_env, fork)
                if digest is None:
                    raise RuntimeError("Pushed image was not found in GHCR")
            elif not package_exists(service, token, fork, visibility, result=result):
                raise ValueError("Reused package visibility/ownership could not be verified")
        finally:
            subprocess.run(["docker", "logout", "ghcr.io"], capture_output=True, env=docker_env)
    if not eligible(sha, fork):
        raise ValueError("Source superseded before receipt; uploaded images are not deployment approval")
    receipt = {"schemaVersion": 2, "visibility": visibility, "service": service, "repository": uri, "digest": digest,
               "tag": tag, "platform": PLATFORM, "verifiedRevision": sha, "sourceTree": tree,
               "inputKey": key}
    with output.open("x") as file:
        json.dump(receipt, file, indent=2)
        file.write("\n")
    result.update(state="reused" if result["reused"] else "published", receiptWritten=True)
    print(f"Verified candidate: {uri}@{digest} (not deployed)")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--service", choices=SERVICES, required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    if args.report and args.report.resolve() == args.output.resolve():
        parser.error("Report and image receipt must use different paths")
    result = {"stage": "publication-service", "sourceSha": args.sha if valid_sha(args.sha) else None,
              "service": args.service, "state": "failed", "upload": "not_attempted",
              "reused": False, "receiptWritten": False, "clusterVerified": False}
    try:
        if os.environ.get("MSA_RELEASE_ENABLED") != "true":
            raise ValueError("Image publication is disabled")
        fork = from_ci().require_personal_publish()
        result["repository"] = fork.repository
        publish(args.service, args.sha, args.output, os.environ["GITHUB_ACTOR"], os.environ["GH_TOKEN"], fork,
                os.environ.get("MSA_PACKAGE_VISIBILITY", "private"), result=result)
    except Exception as exc:
        result["errorType"] = type(exc).__name__
        raise
    finally:
        if args.report:
            from outcome import write_report
            write_report(args.report, result)


if __name__ == "__main__":
    main()
