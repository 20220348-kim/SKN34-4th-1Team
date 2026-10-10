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
from repository import IMAGE_COMPONENTS, from_ci

ROOT = Path(__file__).resolve().parents[2]
SERVICES = ("core-service", "catalog-service", "ai-service", "ops-service")
PLATFORM = "linux/amd64"
RUNNER = "evaluation-runner"
RUNNER_DOCKERFILE = "infrastructure/llmops/Dockerfile.runner"
RUNNER_RELEASE = "backend/ops-service/apps/evaluations/execution_release.json"
WEB = "web"
WEB_DOCKERFILE = "frontend/web/Dockerfile"
WEB_PATHS = (
    "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
    "frontend/web", "frontend/packages/shared", "frontend/mobile/package.json",
    "evaluation/application-map/fixtures/synthetic-online-input-guide-v1.json",
)
# Only the portfolio build is currently exercised by the required image CI.
WEB_MODE = "portfolio"
# This image has a repository-root context. Archive only its actual COPY inputs;
# never send local .env files, work/, caches or an entire checkout to Docker.
RUNNER_PATHS = (
    RUNNER_DOCKERFILE,
    "backend/ai-service/pyproject.toml",
    "backend/ai-service/uv.lock",
    "backend/ai-service/app",
    "evaluation/support-program-evidence",
    *("backend/ops-service/apps/evaluations/" + name for name in (
        "catalog.py", "capture_catalog.json", "rag_live_plans.json", "recovery_inputs.py",
        "execution_spec.py", "execution_release.json", "quality_policy.py", "rag_replay.py",
    )),
)


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def git(*args):
    return run("git", *args, cwd=ROOT, capture_output=True).stdout.strip()


def repository(service, fork):
    if service not in IMAGE_COMPONENTS:
        raise ValueError("Unknown GovBiz service")
    return fork.image(service)


def input_key(tree, publisher_tree):
    # Changing publication policy must not silently reuse an old-policy image.
    for value in (tree, publisher_tree):
        if not valid_sha(value):
            raise ValueError("Invalid Git tree identity")
    return hashlib.sha256(f"v1\n{PLATFORM}\n{tree}\n{publisher_tree}\n".encode()).hexdigest()


def runner_input_key(inputs, publisher_tree):
    """Bind every cross-service runner input and publication policy to reuse."""
    return workspace_input_key(RUNNER, inputs, publisher_tree)


def workspace_input_key(service, inputs, publisher_tree):
    """Hash the actual workspace inputs and the tested build mode."""
    if service not in (RUNNER, WEB):
        raise ValueError("Unknown workspace image")
    paths = RUNNER_PATHS if service == RUNNER else WEB_PATHS
    if (set(inputs) != set(paths) or not valid_sha(publisher_tree)
            or any(not valid_sha(value) for value in inputs.values())):
        raise ValueError("Incomplete workspace source identities")
    payload = json.dumps(inputs, sort_keys=True, separators=(",", ":"))
    version = "evaluation-runner-v1" if service == RUNNER else f"web-{WEB_MODE}-v1"
    return hashlib.sha256(
        f"{version}\n{PLATFORM}\n{payload}\n{publisher_tree}\n".encode()
    ).hexdigest()


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


def check_packages(token, fork, visibility, *, result, services=SERVICES):
    """Read selected package policies without CI gating, Docker or receipts."""
    fork.require_personal_publish()
    if visibility not in ("private", "public") or not token:
        raise ValueError("Package preflight requires a token and private/public visibility")
    if not services or len(set(services)) != len(services) or any(s not in IMAGE_COMPONENTS for s in services):
        raise ValueError("Select known image components")
    result.update(packages={}, packagePolicyVerified=False)
    for service in services:
        item = {}
        try:
            package_exists(service, token, fork, visibility, result=item)
        except (ValueError, RuntimeError):
            # Expected API/policy failures already contain a sanitized diagnostic.
            # Unexpected failures propagate instead of pretending all checks ran.
            if "packageCheck" not in item or item["packageCheck"]["state"] == "pending":
                raise
        result["packages"][service] = item["packageCheck"]
    verified = all(item["state"] == "verified" for item in result["packages"].values())
    result.update(state="verified" if verified else "failed", packagePolicyVerified=verified)
    if not verified:
        raise ValueError("Package preflight failed; inspect the per-service package checks")


def lookup(uri, tag, key, docker_env, fork, *, expected_labels=None):
    reference = uri + ":" + tag
    result = subprocess.run(["docker", "buildx", "imagetools", "inspect", reference,
                             "--format", "{{json .Manifest}}"],
                            text=True, capture_output=True, env=docker_env, check=False)
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
            or labels.get("org.opencontainers.image.source") != fork.url.removesuffix(".git")
            or any(labels.get(name) != value for name, value in (expected_labels or {}).items())):
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
    extra_labels = {}
    if service == RUNNER:
        inputs = {path: git("rev-parse", f"{sha}:{path}") for path in RUNNER_PATHS}
        publisher_tree = git("rev-parse", f"{sha}:infrastructure/release")
        key = runner_input_key(inputs, publisher_tree)
        release = subprocess.check_output(["git", "show", f"{sha}:{RUNNER_RELEASE}"], cwd=ROOT, timeout=15)
        release_hash = hashlib.sha256(release).hexdigest()
        extra_labels["ai.govbiz.execution-release-sha256"] = release_hash
        receipt_source = {"schemaVersion": 3, "sourceInputs": inputs,
                          "publisherTree": publisher_tree, "executionReleaseSha256": release_hash}
        archive_paths = RUNNER_PATHS
    elif service == WEB:
        inputs = {path: git("rev-parse", f"{sha}:{path}") for path in WEB_PATHS}
        publisher_tree = git("rev-parse", f"{sha}:infrastructure/release")
        key = workspace_input_key(WEB, inputs, publisher_tree)
        extra_labels["ai.govbiz.web-mode"] = WEB_MODE
        receipt_source = {"schemaVersion": 4, "sourceInputs": inputs,
                          "publisherTree": publisher_tree, "webMode": WEB_MODE}
        archive_paths = WEB_PATHS
    else:
        tree = git("rev-parse", f"{sha}:backend/{service}")
        key = input_key(tree, git("rev-parse", f"{sha}:infrastructure/release"))
        receipt_source = {"schemaVersion": 2, "sourceTree": tree}
        archive_paths = (f"backend/{service}",)
    lookup_options = {"expected_labels": extra_labels} if extra_labels else {}
    tag = "src-" + key
    with tempfile.TemporaryDirectory(prefix="govbiz-release-") as directory:
        temporary = Path(directory)
        # Never alter the user's existing Docker login or print token values.
        docker_env = {**os.environ, "DOCKER_CONFIG": str(temporary / "docker")}
        try:
            run("docker", "login", "--username", actor, "--password-stdin", "ghcr.io",
                input=token, capture_output=True, env=docker_env)
            digest = lookup(uri, tag, key, docker_env, fork, **lookup_options)
            result["reused"] = digest is not None
            if digest is None:
                archive = temporary / "source.tar"
                run("git", "archive", "--format=tar", "--output", str(archive), sha,
                    *archive_paths, cwd=ROOT)
                with tarfile.open(archive) as source:
                    source.extractall(temporary / "source", filter="data")
                reference = uri + ":" + tag
                context = temporary / "source"
                build_options = []
                if service in (RUNNER, WEB):
                    dockerfile = RUNNER_DOCKERFILE if service == RUNNER else WEB_DOCKERFILE
                    build_options += ["--file", str(context / dockerfile)]
                    for name, value in extra_labels.items():
                        build_options += ["--label", name + "=" + value]
                    if service == WEB:
                        build_options += ["--build-arg", "WEB_MODE=" + WEB_MODE]
                else:
                    context = context / "backend" / service
                run("docker", "build", "--platform", PLATFORM, "--label",
                    "org.opencontainers.image.revision=" + sha, "--label",
                    "org.opencontainers.image.source=" + fork.url.removesuffix(".git"), "--label",
                    "ai.govbiz.input-key=" + key, "--tag", reference,
                    *build_options, str(context), env=docker_env)
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
                digest = lookup(uri, tag, key, docker_env, fork, **lookup_options)
                if digest is None:
                    raise RuntimeError("Pushed image was not found in GHCR")
            elif not package_exists(service, token, fork, visibility, result=result):
                raise ValueError("Reused package visibility/ownership could not be verified")
        finally:
            subprocess.run(["docker", "logout", "ghcr.io"], capture_output=True, env=docker_env, check=False)
    if not eligible(sha, fork):
        raise ValueError("Source superseded before receipt; uploaded images are not deployment approval")
    receipt = {**receipt_source, "visibility": visibility, "service": service, "repository": uri, "digest": digest,
               "tag": tag, "platform": PLATFORM, "verifiedRevision": sha,
               "inputKey": key}
    with output.open("x") as file:
        json.dump(receipt, file, indent=2)
        file.write("\n")
    result.update(state="reused" if result["reused"] else "published", receiptWritten=True)
    print(f"Verified candidate: {uri}@{digest} (not deployed)")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-packages", action="store_true", help="Read package policies only; never build or upload")
    parser.add_argument("--service", choices=IMAGE_COMPONENTS)
    parser.add_argument("--sha")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    if args.check_packages:
        if args.service not in (None, RUNNER, WEB) or args.sha or args.output or not args.report:
            parser.error("--check-packages requires --report; --service may select evaluation-runner or web")
    elif not all((args.service, args.sha, args.output)):
        parser.error("Publication requires --service, --sha and --output")
    if args.report and args.output and args.report.resolve() == args.output.resolve():
        parser.error("Report and image receipt must use different paths")
    result = {"stage": "package-preflight" if args.check_packages else "publication-service",
              "sourceSha": args.sha if valid_sha(args.sha) else None,
              "service": args.service, "state": "failed", "upload": "not_attempted",
              "reused": False, "receiptWritten": False, "clusterVerified": False}
    try:
        if os.environ.get("MSA_RELEASE_ENABLED") != "true":
            raise ValueError("Image publication is disabled")
        fork = from_ci().require_personal_publish()
        result["repository"] = fork.repository
        visibility = os.environ.get("MSA_PACKAGE_VISIBILITY", "private")
        if args.check_packages:
            check_packages(os.environ["GH_TOKEN"], fork, visibility, result=result,
                           services=(args.service,) if args.service else SERVICES)
        else:
            publish(args.service, args.sha, args.output, os.environ["GITHUB_ACTOR"], os.environ["GH_TOKEN"], fork,
                    visibility, result=result)
    except Exception as exc:
        result["errorType"] = type(exc).__name__
        raise
    finally:
        if args.report:
            from outcome import write_report
            write_report(args.report, result)


if __name__ == "__main__":
    main()
