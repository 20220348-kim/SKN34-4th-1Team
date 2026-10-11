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
from pathlib import Path
from urllib.parse import quote

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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command", choices=("gate", "check", "publish", "rollout", "web-source")
    )
    parser.add_argument("--sha")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.command == "gate":
        select()
    elif args.command == "check":
        check(args.sha)
    elif args.command == "publish":
        publish(args.sha, args.output)
    elif args.command == "rollout":
        rollout(args.sha, args.output)
    else:
        web_source(args.sha, args.output)


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
