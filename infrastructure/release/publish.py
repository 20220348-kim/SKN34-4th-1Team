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


def package_exists(service, token, fork, visibility="private"):
    if visibility not in ("private", "public"):
        raise ValueError("Package visibility must be private or public")
    repository(service, fork)
    request = Request(f"https://api.github.com/users/{fork.owner}/packages/container/{fork.name.lower()}-{service}",
                      headers={"Authorization": "Bearer " + token,
                               "Accept": "application/vnd.github+json",
                               "X-GitHub-Api-Version": "2022-11-28"})
    try:
        with urlopen(request, timeout=30) as response:
            package = json.load(response)
    except HTTPError as error:
        if error.code == 404:
            # Missing and inaccessible packages are never permission to create one.
            # GITHUB_TOKEN can make a new package inherit a public repository's visibility.
            return False
        raise RuntimeError("Cannot verify GitHub package ownership/access") from None
    if (package.get("repository", {}).get("full_name", "").lower() != fork.repository.lower()
            or package.get("owner", {}).get("login", "").lower() != fork.owner.lower()
            or package.get("visibility") != visibility):
        raise ValueError(f"Package must be {visibility}, owned by this user and linked to this exact fork")
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


def publish(service, sha, output, actor, token, fork, visibility="private"):
    fork.require_personal_publish()
    uri = repository(service, fork)
    if not valid_sha(sha) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9\[\]-]*", actor) or not token:
        raise ValueError("Full source SHA, GitHub actor and temporary package token are required")
    if output.exists() or not output.parent.is_dir():
        raise ValueError("Receipt must be a new file in an existing directory")
    if git("rev-parse", "HEAD") != sha or not eligible(sha, fork):
        raise ValueError("Checkout must be the successfully tested default-branch source")
    if not package_exists(service, token, fork, visibility):
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
                if not package_exists(service, token, fork, visibility):
                    raise ValueError("Package disappeared or became inaccessible during build; "
                                     "refusing upload instead of creating a new package")
                run("docker", "push", reference, env=docker_env)
                # Recheck after upload as well; an unverified image gets no receipt.
                if not package_exists(service, token, fork, visibility):
                    raise RuntimeError("Published package visibility/ownership could not be verified")
                digest = lookup(uri, tag, key, docker_env, fork)
                if digest is None:
                    raise RuntimeError("Pushed image was not found in GHCR")
            elif not package_exists(service, token, fork, visibility):
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
    print(f"Published candidate: {uri}@{digest} (not deployed)")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--service", choices=SERVICES, required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if os.environ.get("MSA_RELEASE_ENABLED") != "true":
        raise SystemExit("Image publication is disabled")
    fork = from_ci()
    fork.require_personal_publish()
    publish(args.service, args.sha, args.output, os.environ["GITHUB_ACTOR"], os.environ["GH_TOKEN"], fork,
            os.environ.get("MSA_PACKAGE_VISIBILITY", "private"))


if __name__ == "__main__":
    main()
