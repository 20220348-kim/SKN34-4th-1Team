"""CI-gated ECR publication and rollout on the private CodeBuild Actions runner."""

import argparse
import io
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote, urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "infrastructure/release"))
import gate
from publish import RUNNER_PATHS, WEB_PATHS
from repository import from_ci

SOURCE = "ilil1/SKN34-4th-1Team"
COMPONENTS = (
    "core-service",
    "catalog-service",
    "ai-service",
    "ops-service",
    "evaluation-runner",
)


def require(ok, message):
    if not ok:
        raise ValueError(message)


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def aws(*args):
    return json.loads(
        run(
            "aws", *args, "--output", "json", "--no-cli-pager", capture_output=True
        ).stdout
    )


def authority():
    fork = from_ci()
    require(
        fork.repository == SOURCE and fork.branch == "main",
        "Only the selected repository main can deploy",
    )
    require(os.environ.get("EKS_RELEASE_ENABLED") == "true", "EKS release is disabled")
    return fork


def check(sha, get=gate.api):
    fork = authority()
    require(gate.valid_sha(sha), "A full source SHA is required")
    head = get(f"repos/{fork.repository}/git/ref/heads/{quote(fork.branch, safe='')}")[
        "object"
    ]["sha"]
    require(head == sha, "Source superseded; deploy the latest tested main")
    reason = gate.ci_blocked_reason(sha, fork, get)
    require(reason is None, "Required CI is not ready: " + str(reason))
    require(
        get(f"repos/{fork.repository}/git/ref/heads/main")["object"]["sha"] == sha,
        "Main changed during CI verification",
    )


def select():
    fork = authority()
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    sha = gate.candidate(
        os.environ["GITHUB_EVENT_NAME"],
        event,
        os.environ["GITHUB_REF"],
        os.environ["GITHUB_SHA"],
        fork,
    )
    ready, reason = False, "event_not_eligible"
    if sha:
        try:
            check(sha)
            ready, reason = True, "eligible"
        except ValueError as error:
            reason = str(error)
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as out:
        out.write(f"ready={str(ready).lower()}\nsha={sha if ready else ''}\n")
    print(reason)


def settings():
    account, region, cluster = (
        os.environ.get(key, "")
        for key in ("AWS_ACCOUNT_ID", "AWS_REGION", "EKS_CLUSTER_NAME")
    )
    require(re.fullmatch(r"[0-9]{12}", account), "Missing AWS account ID")
    require(region == "ap-southeast-2", "This deployment is for Sydney")
    require(
        re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}", cluster),
        "Missing EKS cluster name",
    )
    require(
        aws("sts", "get-caller-identity")["Account"] == account,
        "Unexpected AWS account",
    )
    return account, region, cluster


def archive(sha, paths, destination):
    require(gate.valid_sha(sha), "Invalid archive SHA")
    data = subprocess.check_output(["git", "archive", sha, "--", *paths], cwd=ROOT)
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        tar.extractall(destination, filter="data")


def digest(repository, tag):
    response = aws(
        "ecr",
        "batch-get-image",
        "--repository-name",
        repository,
        "--image-ids",
        "imageTag=" + tag,
    )
    if response.get("images"):
        value = response["images"][0]["imageId"]["imageDigest"]
        require(re.fullmatch(r"sha256:[a-f0-9]{64}", value), "Invalid ECR digest")
        return value
    require(
        [f.get("failureCode") for f in response.get("failures", [])]
        == ["ImageNotFound"],
        "Cannot resolve the ECR image",
    )
    return None


def publish(sha, output):
    check(sha)
    account, region, cluster = settings()
    registry = f"{account}.dkr.ecr.{region}.amazonaws.com"
    require(
        run("git", "rev-parse", "HEAD", cwd=ROOT, capture_output=True).stdout.strip()
        == sha,
        "Checkout does not match the tested source",
    )
    images = {}
    with tempfile.TemporaryDirectory() as temp:
        # Keep login credentials outside the checkout and remove them on exit.
        docker_env = {**os.environ, "DOCKER_CONFIG": temp + "/docker"}
        password = run("aws", "ecr", "get-login-password", capture_output=True).stdout
        run(
            "docker",
            "login",
            "--username",
            "AWS",
            "--password-stdin",
            registry,
            input=password,
            env=docker_env,
            capture_output=True,
        )
        for service in COMPONENTS:
            check(sha)
            repository, tag = "govbiz-demo/" + service, "git-" + sha
            info = aws(
                "ecr", "describe-repositories", "--repository-names", repository
            )["repositories"][0]
            require(
                info["imageTagMutability"] == "IMMUTABLE", "ECR tags must be immutable"
            )
            value = digest(repository, tag)
            if value is None:
                source = Path(temp) / service
                source.mkdir()
                runner = service == "evaluation-runner"
                archive(
                    sha, RUNNER_PATHS if runner else ("backend/" + service,), source
                )
                context = source if runner else source / "backend" / service
                dockerfile = (
                    source / "infrastructure/llmops/Dockerfile.runner"
                    if runner
                    else context / "Dockerfile"
                )
                ref = f"{registry}/{repository}:{tag}"
                run(
                    "docker",
                    "build",
                    "--platform",
                    "linux/amd64",
                    "--file",
                    str(dockerfile),
                    "--label",
                    "org.opencontainers.image.revision=" + sha,
                    "--tag",
                    ref,
                    str(context),
                    env=docker_env,
                )
                check(sha)  # A new merge or CI rerun during the build cannot publish.
                run("docker", "push", ref, env=docker_env)
                value = digest(repository, tag)
                require(value is not None, "Published image is missing")
            images[service] = f"{registry}/{repository}@{value}"
    record = {
        "schema": 1,
        "repository": SOURCE,
        "sourceSha": sha,
        "region": region,
        "account": account,
        "cluster": cluster,
        "images": images,
    }
    output.write_text(json.dumps(record, indent=2) + "\n")


def rollout(sha, receipt):
    # One runner builds and deploys: no mutable S3 bundle or second build job.
    check(sha)
    record = json.loads(receipt.read_text())
    require(record.get("sourceSha") == sha, "Release receipt does not match this SHA")
    sys.path.insert(0, str(ROOT / "infrastructure/eks"))
    import deploy

    deploy.deploy(record)


def web_source(sha, destination):
    check(sha)
    destination.mkdir()
    archive(sha, WEB_PATHS, destination)


def vercel_api(path, team, token, method="GET"):
    # Project-scoped requests do not require the CLI's personal /v2/user lookup.
    request = Request(
        "https://api.vercel.com" + path + "?teamId=" + quote(team, safe=""),
        data=b"{}" if method == "POST" else None,
        method=method,
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
        },
    )
    try:
        with urlopen(request, timeout=30) as response:
            body = response.read()
            return json.loads(body) if body else {}
    except HTTPError as error:
        # Response bodies may contain private project details. Do not print them.
        raise ValueError(
            f"Vercel {method} request failed (HTTP {error.code})"
        ) from None


def promote_web(sha, deployment_url):
    team = os.environ.get("VERCEL_ORG_ID", "")
    project_id = os.environ.get("VERCEL_PROJECT_ID", "")
    token = os.environ.get("VERCEL_TOKEN", "")
    require(re.fullmatch(r"team_[A-Za-z0-9]+", team), "Missing Vercel team ID")
    require(re.fullmatch(r"prj_[A-Za-z0-9]+", project_id), "Missing Vercel project ID")
    require(
        bool(token) and "\r" not in token and "\n" not in token, "Missing Vercel token"
    )
    url = urlsplit(deployment_url)
    require(
        url.scheme == "https"
        and re.fullmatch(r"[a-z0-9-]+\.vercel\.app", url.netloc)
        and url.path in ("", "/")
        and not url.query
        and not url.fragment,
        "Expected one Vercel deployment URL",
    )
    check(sha)
    deployment = vercel_api(
        "/v13/deployments/" + quote(url.netloc, safe=""), team, token
    )
    project_path = "/v9/projects/" + project_id
    project = vercel_api(project_path, team, token)
    require(
        project.get("id") == project_id and project.get("accountId") == team,
        "Vercel project does not belong to the configured team",
    )
    require(
        deployment.get("projectId") == project_id, "Vercel deployment project mismatch"
    )
    require(deployment.get("url") == url.netloc, "Vercel deployment URL mismatch")
    require(
        deployment.get("meta", {}).get("githubCommitSha") == sha,
        "Vercel deployment source SHA mismatch",
    )
    require(
        deployment.get("readyState") == "READY"
        and deployment.get("target") == "production",
        "Only a ready staged production deployment can be promoted",
    )
    deployment_id = deployment.get("id", "")
    require(
        re.fullmatch(r"dpl_[A-Za-z0-9]+", deployment_id), "Invalid Vercel deployment ID"
    )
    check(sha)  # Main or required CI may change during the Vercel reads.
    vercel_api(
        f"/v10/projects/{project_id}/promote/{deployment_id}", team, token, "POST"
    )
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        project = vercel_api(project_path, team, token)
        require(
            project.get("id") == project_id and project.get("accountId") == team,
            "Vercel promotion project mismatch",
        )
        job = project.get("lastAliasRequest") or {}
        if job.get("toDeploymentId") == deployment_id:
            require(
                job.get("jobStatus") not in ("failed", "skipped"),
                "Vercel domain promotion failed",
            )
            production = project.get("targets", {}).get("production") or {}
            if (
                job.get("jobStatus") == "succeeded"
                and production.get("id") == deployment_id
            ):
                check(sha)
                return {
                    "sourceSha": sha,
                    "projectId": project_id,
                    "deploymentId": deployment_id,
                    "url": deployment_url,
                }
        time.sleep(5)
    raise ValueError("Vercel domain promotion did not complete within 180 seconds")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command",
        choices=("gate", "check", "publish", "rollout", "web-source", "web-promote"),
    )
    parser.add_argument("--sha")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--deployment-url-file", type=Path)
    args = parser.parse_args()
    if args.command == "gate":
        select()
    elif args.command == "check":
        check(args.sha)
    elif args.command == "publish":
        publish(args.sha, args.output)
    elif args.command == "rollout":
        rollout(args.sha, args.output)
    elif args.command == "web-source":
        web_source(args.sha, args.output)
    else:
        require(
            args.deployment_url_file and args.output,
            "Deployment URL file and output are required",
        )
        record = promote_web(args.sha, args.deployment_url_file.read_text().strip())
        args.output.write_text(json.dumps(record, indent=2) + "\n")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
        # A subprocess command may contain authentication material: never dump it.
        print(
            str(error)
            if isinstance(error, ValueError)
            else "Release command failed; inspect the preceding step",
            file=sys.stderr,
        )
        sys.exit(1)
