"""Manually prepare one empty runner or web package with Actions' temporary token."""

import argparse
import json
import os
import tempfile
from pathlib import Path
from uuid import uuid4

import bootstrap_packages as local
import gate
from repository import from_ci

WORKFLOW = ".github/workflows/evaluation-package-setup.yml"
SERVICE = "evaluation-runner"


def context(env, event, token):
    fork = from_ci(env).require_personal_publish()
    service = event.get("inputs", {}).get("component", SERVICE)
    if service not in (SERVICE, "web"):
        raise ValueError("Select the evaluation-runner or web package")
    sha = gate.candidate(
        env.get("GITHUB_EVENT_NAME"),
        event,
        env.get("GITHUB_REF"),
        env.get("GITHUB_SHA"),
        fork,
    )
    if (
        env.get("GITHUB_ACTIONS") != "true"
        or env.get("GITHUB_EVENT_NAME") != "workflow_dispatch"
        or env.get("GITHUB_WORKFLOW_REF")
        != f"{fork.repository}/{WORKFLOW}@refs/heads/{fork.branch}"
        or env.get("MSA_RELEASE_ENABLED") != "true"
        or env.get("MSA_PACKAGE_VISIBILITY") != "public"
        or event.get("inputs", {}).get("confirm_package") != fork.image(service)
        or not sha
        or not token
    ):
        raise ValueError(
            "Use the explicit default-branch setup workflow for this public package"
        )
    repository, _ = local.api("repos/" + fork.repository, token)
    if (
        repository.get("full_name") != fork.repository
        or repository.get("default_branch") != fork.branch
        or repository.get("fork") is not True
        or repository.get("owner", {}).get("type") != "User"
        or repository.get("owner", {}).get("login", "").lower() != fork.owner.lower()
        or repository.get("parent", {}).get("full_name") != gate.UPSTREAM
    ):
        raise ValueError(
            "Setup requires the exact personal fork and its default branch"
        )
    return fork, sha, service


def package_visibility(package, fork):
    if not isinstance(package, dict) or package.get("visibility") not in (
        "private",
        "public",
    ):
        raise ValueError("Cannot verify the package visibility")
    visibility = package["visibility"]
    local.validate_package(package, fork, require_link=True, visibility=visibility)
    return visibility


def require_ci(sha, fork):
    if not gate.eligible(sha, fork):
        raise ValueError(
            "Exact source and required CI must succeed before package setup"
        )


def prepare(env, event, token, report):
    fork, sha, service = context(env, event, token)
    report.update(package=fork.image(service), sourceSha=sha, service=service)
    require_ci(sha, fork)
    package = local.metadata(fork, service, token)
    if package is None:
        # Explicit setup can create an empty package; the normal publisher still
        # refuses missing/inaccessible packages and never reaches this path.
        reference = fork.image(service) + ":bootstrap-" + uuid4().hex
        dockerfile = (
            local.EMPTY_DOCKERFILE
            + f'LABEL org.opencontainers.image.source="{fork.source_url}"\n'
        )
        with tempfile.TemporaryDirectory(prefix="govbiz-runner-setup-") as directory:
            docker_env = {**os.environ, "DOCKER_CONFIG": directory}
            built = False
            try:
                local.docker(
                    "login",
                    "ghcr.io",
                    "--username",
                    fork.owner,
                    "--password-stdin",
                    env=docker_env,
                    data=token,
                )
                built = True  # Also clean a partially completed local build.
                local.docker(
                    "build",
                    "--platform",
                    "linux/amd64",
                    "--network",
                    "none",
                    "--tag",
                    reference,
                    "-",
                    env=docker_env,
                    data=dockerfile,
                )
                require_ci(sha, fork)
                package = local.metadata(fork, service, token)
                if package is None:
                    report["upload"] = "attempted"
                    local.docker("push", reference, env=docker_env)
                    report["upload"] = "completed"
                    package = local.metadata(fork, service, token)
                # Never overwrite/adopt a package that appeared during the build.
                visibility = package_visibility(package, fork)
                require_ci(sha, fork)
            finally:
                try:
                    if built:
                        local.docker("image", "rm", reference, env=docker_env)
                finally:
                    local.docker("logout", "ghcr.io", env=docker_env)
    else:
        visibility = package_visibility(package, fork)
        require_ci(sha, fork)
    report.update(
        status="PUBLIC_METADATA_VERIFIED"
        if visibility == "public"
        else "AWAITING_PUBLIC_CONFIGURATION",
        actualVisibility=visibility,
        packageMetadataVerified=True,
        settingsUrl=f"https://github.com/users/{fork.owner}/packages/container/{fork.name.lower()}-{service}/settings",
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    report = {
        "schema": "evaluation-package-setup-v1",
        "status": "BLOCKED",
        "upload": "not_attempted",
        "packageMetadataVerified": False,
        "applicationImagePublished": False,
        "receiptWritten": False,
        "clusterChanged": False,
    }
    try:
        event = json.loads(
            Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8")
        )
        prepare(os.environ, event, os.environ.get("GH_TOKEN", ""), report)
    except Exception as error:  # noqa: BLE001 - never log API, Docker or token-bearing error text
        report.update(status="BLOCKED", errorType=type(error).__name__)
    payload = json.dumps(report, sort_keys=True, indent=2) + "\n"
    args.report.write_text(payload, encoding="utf-8")
    print(payload, end="")
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as stream:
            stream.write(
                "### Kubernetes package setup\n\n```json\n" + payload + "```\n\n"
            )
            stream.write(
                "This creates only an empty package. Configure Public visibility and Actions access in package settings, then run the normal gated image publisher. No application receipt or deployment is produced.\n"
            )
    return int(report["status"] == "BLOCKED")


if __name__ == "__main__":
    raise SystemExit(main())
