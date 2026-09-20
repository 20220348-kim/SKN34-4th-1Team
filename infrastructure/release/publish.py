"""Publish one service's tracked Git archive to GHCR; never deploy it."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from gate import eligible, valid_sha

ROOT = Path(__file__).resolve().parents[2]
SERVICES = ("core-service", "catalog-service", "ai-service", "ops-service")
PLATFORM = "linux/amd64"
SOURCE = "https://github.com/GovBiz-Team/GovBiz"


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def git(*args):
    return run("git", *args, cwd=ROOT, capture_output=True).stdout.strip()


def repository(service):
    if service not in SERVICES:
        raise ValueError("Unknown GovBiz service")
    return "ghcr.io/govbiz-team/govbiz-" + service


def input_key(tree, publisher_tree):
    # Changing publication policy must not silently reuse an old-policy image.
    for value in (tree, publisher_tree):
        if not valid_sha(value):
            raise ValueError("Invalid Git tree identity")
    return hashlib.sha256(f"v1\n{PLATFORM}\n{tree}\n{publisher_tree}\n".encode()).hexdigest()


def package_exists(service, token):
    repository(service)
    request = Request("https://api.github.com/orgs/GovBiz-Team/packages/container/govbiz-" + service,
                      headers={"Authorization": "Bearer " + token,
                               "Accept": "application/vnd.github+json",
                               "X-GitHub-Api-Version": "2022-11-28"})
    try:
        with urlopen(request, timeout=30) as response:
            package = json.load(response)
    except HTTPError as error:
        if error.code == 404:
            # A brand-new package has no pull token/manifest yet. Only the fixed
            # own package path is eligible for creation; push still enforces ACLs.
            return False
        raise RuntimeError("Cannot verify GitHub package ownership/access") from None
    if package.get("repository", {}).get("full_name") != "GovBiz-Team/GovBiz":
        raise ValueError("Existing package must be linked to GovBiz; do not overwrite another package")
    return True


def lookup(uri, tag, key, docker_env):
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
            or labels.get("org.opencontainers.image.source") != SOURCE):
        raise ValueError("Existing image has different inputs/source/platform; refusing reuse or overwrite")
    return digest


def publish(service, sha, output, actor, token):
    uri = repository(service)
    if not valid_sha(sha) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9\[\]-]*", actor) or not token:
        raise ValueError("Full source SHA, GitHub actor and temporary package token are required")
    if output.exists() or not output.parent.is_dir():
        raise ValueError("Receipt must be a new file in an existing directory")
    if git("rev-parse", "HEAD") != sha or not eligible(sha):
        raise ValueError("Checkout must be the current, successfully tested develop SHA")
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
            digest = lookup(uri, tag, key, docker_env) if package_exists(service, token) else None
            if digest is None:
                archive = temporary / "source.tar"
                run("git", "archive", "--format=tar", "--output", str(archive), sha,
                    f"backend/{service}", cwd=ROOT)
                with tarfile.open(archive) as source:
                    source.extractall(temporary / "source", filter="data")
                reference = uri + ":" + tag
                run("docker", "build", "--platform", PLATFORM, "--label",
                    "org.opencontainers.image.revision=" + sha, "--label",
                    "org.opencontainers.image.source=" + SOURCE, "--label",
                    "ai.govbiz.input-key=" + key, "--tag", reference,
                    str(temporary / "source/backend" / service), env=docker_env)
                if not eligible(sha):
                    raise ValueError("Source superseded or checks changed during build; refusing upload")
                run("docker", "push", reference, env=docker_env)
                digest = lookup(uri, tag, key, docker_env)
                if digest is None:
                    raise RuntimeError("Pushed image was not found in GHCR")
        finally:
            subprocess.run(["docker", "logout", "ghcr.io"], capture_output=True, env=docker_env)
    if not eligible(sha):
        raise ValueError("Source superseded before receipt; uploaded images are not deployment approval")
    receipt = {"schemaVersion": 1, "service": service, "repository": uri, "digest": digest,
               "tag": tag, "platform": PLATFORM, "verifiedRevision": sha, "sourceTree": tree,
               "inputKey": key}
    with output.open("x") as file:
        json.dump(receipt, file, indent=2)
        file.write("\n")
    print(f"Published candidate: {uri}@{digest} (not deployed)")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--service", choices=SERVICES, required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if os.environ.get("MSA_RELEASE_ENABLED") != "true":
        raise SystemExit("Image publication is disabled")
    if os.environ.get("GITHUB_REPOSITORY") != "GovBiz-Team/GovBiz":
        raise SystemExit("Publication is restricted to the GovBiz repository")
    publish(args.service, args.sha, args.output, os.environ["GITHUB_ACTOR"], os.environ["GH_TOKEN"])


if __name__ == "__main__":
    main()
