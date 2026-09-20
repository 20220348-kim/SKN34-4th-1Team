"""Prepare empty private GHCR packages locally; never upload application source.

This is a one-time, interactive setup tool, not the CI publisher. Repository
linking and Actions write access must then be configured in GitHub's package UI.
"""

import argparse
import getpass
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener
import uuid

from gate import UPSTREAM
from repository import SERVICES, from_origin

ROOT = Path(__file__).resolve().parents[2]
EMPTY_DOCKERFILE = (
    'FROM scratch\n'
    'LABEL ai.govbiz.bootstrap="empty-v1"\n'
    'LABEL org.opencontainers.image.description="Empty package initialization; no application source"\n'
)


class NoRedirect(HTTPRedirectHandler):
    # Never forward a user's PAT outside the fixed GitHub API endpoint.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def credential(path=None):
    if path is None:
        if not sys.stdin.isatty():
            raise ValueError("Use an interactive terminal or your mode-0600 --token-file")
        token = getpass.getpass("One-time GHCR setup PAT (hidden): ").strip()
    else:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor) as stream:
            info = os.fstat(stream.fileno())
            if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600
                    or info.st_uid != os.getuid()):
                raise ValueError("Token file must be your regular non-symlink file with mode 0600")
            token = stream.read(513).strip()
    if not re.fullmatch(r"ghp_[A-Za-z0-9]{20,255}", token):
        raise ValueError("A personal access token (classic) is required")
    return token


def api(path, token, missing_ok=False):
    request = Request("https://api.github.com/" + path, headers={
        "Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    })
    try:
        with build_opener(NoRedirect()).open(request, timeout=30) as response:
            return json.load(response), response.headers
    except HTTPError as error:
        if error.code == 404 and missing_ok:
            return None, {}
        raise ValueError(f"GitHub setup check failed (HTTP {error.code}); no permissions changed") from None
    except (URLError, TimeoutError, json.JSONDecodeError):
        raise ValueError("Cannot verify GitHub setup; do not upload or enable publication") from None


def check_identity(fork, token, create):
    fork.require_personal_publish()
    user, headers = api("user", token)
    scopes = {value.strip() for value in headers.get("X-OAuth-Scopes", "").split(",") if value.strip()}
    allowed = {"read:packages", "write:packages"}
    required = "write:packages" if create else "read:packages"
    if (not scopes or not scopes <= allowed
            or (required not in scopes and not (not create and "write:packages" in scopes))):
        raise ValueError("Use only package read/write scopes; creation needs write:packages. No repo/workflow/delete scope")
    if user.get("type") != "User" or user.get("login", "").lower() != fork.owner.lower():
        raise ValueError("PAT owner must be the same personal account as Git origin")
    metadata, _ = api("repos/" + fork.repository, token)
    if (metadata.get("full_name", "").lower() != fork.repository.lower()
            or metadata.get("owner", {}).get("type") != "User"
            or metadata.get("owner", {}).get("login", "").lower() != fork.owner.lower()
            or metadata.get("fork") is not True
            or metadata.get("parent", {}).get("full_name", "").lower() != UPSTREAM.lower()):
        raise ValueError("Origin must be your personal fork of the education repository")


def metadata(fork, service, token):
    package, _ = api(f"users/{fork.owner}/packages/container/{fork.name.lower()}-{service}",
                     token, missing_ok=True)
    return package


def validate_package(package, fork, require_link=False):
    if package is None:
        raise ValueError("Package missing or inaccessible")
    linked = (package.get("repository") or {}).get("full_name", "")
    if (package.get("visibility") != "private"
            or (package.get("owner") or {}).get("login", "").lower() != fork.owner.lower()
            or (linked and linked.lower() != fork.repository.lower())
            or (require_link and linked.lower() != fork.repository.lower())):
        raise ValueError("Package must be private, owned by you, and linked only to your exact fork")


def docker(*args, env, data=None):
    try:
        subprocess.run(["docker", *args], input=data, text=True, capture_output=True,
                       check=True, timeout=300, env=env)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        # Do not include subprocess input, raw output or token-bearing environment.
        raise ValueError(f"Docker {args[0]} failed; publication stays disabled") from None


def prepare(fork, token, create=False):
    if os.environ.get("GITHUB_ACTIONS") == "true":
        raise ValueError("Run one-time setup locally, never in GitHub Actions")
    check_identity(fork, token, create)
    packages = {service: metadata(fork, service, token) for service in SERVICES}
    # Validate all known destinations before building or uploading anything.
    for package in packages.values():
        if package is not None:
            validate_package(package, fork, require_link=not create)
        elif not create:
            raise ValueError("All four pre-created private packages are required")
    missing = [service for service, package in packages.items() if package is None]
    if missing:
        with tempfile.TemporaryDirectory(prefix="govbiz-package-login-") as temporary:
            env = {**os.environ, "DOCKER_CONFIG": temporary}
            created_tags = []
            try:
                docker("login", "ghcr.io", "--username", fork.owner, "--password-stdin", env=env, data=token)
                for service in missing:
                    # Another owner/admin action may have created the package meanwhile.
                    current = metadata(fork, service, token)
                    if current is not None:
                        validate_package(current, fork)
                        continue
                    reference = fork.image(service) + ":bootstrap-" + uuid.uuid4().hex
                    # '-' reads only this literal Dockerfile: no directory context, COPY,
                    # source/revision label, application layers, build args or credentials.
                    docker("build", "--platform", "linux/amd64", "--network", "none", "--tag",
                           reference, "-", env=env, data=EMPTY_DOCKERFILE)
                    created_tags.append(reference)
                    current = metadata(fork, service, token)
                    if current is not None:
                        validate_package(current, fork)
                        continue
                    docker("push", reference, env=env)
                    validate_package(metadata(fork, service, token), fork)
                    print(f"Verified private empty package: {fork.image(service)}")
            finally:
                for reference in created_tags:
                    try:
                        docker("image", "rm", reference, env=env)
                    except ValueError:
                        print(f"Local bootstrap tag cleanup needed: {reference}", file=sys.stderr)
                try:
                    docker("logout", "ghcr.io", env=env)
                except ValueError:
                    pass  # Isolated credential directory is still deleted on exit.
    for service in SERVICES:
        validate_package(metadata(fork, service, token), fork, require_link=not create)
        print(f"https://github.com/users/{fork.owner}/packages/container/{fork.name.lower()}-{service}/settings")
    print("Private metadata verified. This does not verify Actions write access or a deployed application.")
    print("Keep both release variables false until package UI permissions and CI access are verified.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("create", "verify"))
    parser.add_argument("--token-file", type=Path)
    args = parser.parse_args()
    try:
        fork = from_origin(ROOT)
        fork.require_personal_publish()
        if args.action == "create":
            print("Destinations: " + ", ".join(fork.image(service) for service in SERVICES))
            if not sys.stdin.isatty() or input("Create only empty bootstrap packages at these destinations? Type yes: ") != "yes":
                raise ValueError("One-time package creation was not confirmed")
        token = credential(args.token_file)
        try:
            prepare(fork, token, create=args.action == "create")
        finally:
            del token
    except (ValueError, OSError) as error:
        raise SystemExit(str(error)) from None


if __name__ == "__main__":
    main()
