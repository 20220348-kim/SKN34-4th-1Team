"""Update existing EKS application Deployments; never provision or restore data."""

import copy
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "release"))
import gate
from repository import Fork

SOURCE = "ilil1/SKN34-4th-1Team"
TARGETS = (
    ("govbiz-msa", "ai-service", {"ai-service": "ai-service"}),
    ("govbiz-msa", "catalog-service", {"catalog-service": "catalog-service"}),
    ("govbiz-msa", "core-service", {"core-service": "core-service"}),
    (
        "govbiz-msa",
        "ops-service",
        {"ops-service": "ops-service", "ops-sync": "ops-service"},
    ),
    ("govbiz-evaluation", "ops-artifacts", {"ops-artifacts": "ops-service"}),
    (
        "govbiz-evaluation",
        "evaluation-runner",
        {"evaluation-runner": "evaluation-runner"},
    ),
)
COMPONENTS = {component for _, _, mapping in TARGETS for component in mapping.values()}


def require(ok, message):
    if not ok:
        raise ValueError(message)


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def kube(namespace, *args, payload=None):
    result = run(
        "kubectl",
        "--request-timeout=30s",
        "-n",
        namespace,
        *args,
        input=json.dumps(payload) if payload is not None else None,
        capture_output=True,
    )
    return result.stdout


def validate(record, env=os.environ):
    require(
        record.get("schema") == 1 and record.get("repository") == SOURCE,
        "Untrusted release source",
    )
    require(
        re.fullmatch(r"[a-f0-9]{40}", record.get("sourceSha", "")),
        "Invalid release SHA",
    )
    for key, name in (
        ("account", "AWS_ACCOUNT_ID"),
        ("region", "AWS_REGION"),
        ("cluster", "EKS_CLUSTER_NAME"),
    ):
        require(
            record.get(key) == env.get(name) and bool(record.get(key)),
            "Release target mismatch: " + key,
        )
    require(
        re.fullmatch(r"[0-9]{12}", record["account"])
        and record["region"] == "ap-southeast-2",
        "Invalid AWS target",
    )
    require(
        re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}", record["cluster"]),
        "Invalid cluster",
    )
    require(
        set(record.get("images", {})) == COMPONENTS, "Incomplete application images"
    )
    for component, image in record["images"].items():
        prefix = f"{record['account']}.dkr.ecr.{record['region']}.amazonaws.com/govbiz-demo/{component}@sha256:"
        require(
            isinstance(image, str)
            and image.startswith(prefix)
            and re.fullmatch(r"[a-f0-9]{64}", image[len(prefix) :]),
            "Only the expected ECR digest is allowed",
        )


def current(sha):
    result = run(
        "git",
        "ls-remote",
        "--exit-code",
        "https://github.com/" + SOURCE + ".git",
        "refs/heads/main",
        capture_output=True,
    )
    require(
        result.stdout.split()[0] == sha, "Main advanced; old release must not continue"
    )


def check_ci(sha):
    # The selected repository is public. Keep tokens out of CodeBuild and fail
    # closed on GitHub API errors/rate limits instead of skipping CI.
    def get(path):
        request = Request(
            "https://api.github.com/" + path,
            headers={
                "Accept": "application/vnd.github+json",
                "User-Agent": "govbiz-eks-release",
            },
        )
        with urlopen(request, timeout=30) as response:
            return json.load(response)

    reason = gate.ci_blocked_reason(sha, Fork(SOURCE, "main"), get)
    require(reason is None, "CI changed before rollout: " + str(reason))
    current(sha)


def image_patch(deployment, mapping, record):
    containers = deployment["spec"]["template"]["spec"]["containers"]
    names = {c["name"] for c in containers}
    require(set(mapping) <= names, "Expected application containers are missing")
    # Do not change env, replicas, probes, resources, data mounts or init images.
    return {
        "spec": {
            "template": {
                "metadata": {
                    "annotations": {"govbiz.io/source-sha": record["sourceSha"]}
                },
                "spec": {
                    "containers": [
                        {
                            "name": name,
                            "image": record["images"][component],
                            "imagePullPolicy": "IfNotPresent",
                        }
                        for name, component in mapping.items()
                    ]
                },
            }
        }
    }


def migration_job(deployment, image, sha):
    pod = copy.deepcopy(deployment["spec"]["template"]["spec"])
    container = next(c for c in pod["containers"] if c["name"] == "ops-service")
    for key in (
        "args",
        "ports",
        "livenessProbe",
        "readinessProbe",
        "startupProbe",
        "lifecycle",
    ):
        container.pop(key, None)
    container.update(
        name="ops-migrate",
        image=image,
        imagePullPolicy="IfNotPresent",
        command=["python", "manage.py", "migrate_deployment", "--no-color"],
    )
    pod.update(
        containers=[container],
        restartPolicy="Never",
        automountServiceAccountToken=False,
    )
    for key in ("initContainers", "affinity", "nodeName"):
        pod.pop(key, None)
    mounts = {v["name"] for v in container.get("volumeMounts", [])}
    pod["volumes"] = [v for v in pod.get("volumes", []) if v["name"] in mounts]
    require(
        not any("persistentVolumeClaim" in v for v in pod["volumes"]),
        "Migration must not mount data PVCs",
    )
    return {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {"name": "ops-migrate-" + sha[:16], "namespace": "govbiz-msa"},
        "spec": {
            "backoffLimit": 0,
            "activeDeadlineSeconds": 300,
            "ttlSecondsAfterFinished": 86400,
            "template": {
                "metadata": {
                    "labels": {"app.kubernetes.io/name": "ops-service-migrate"}
                },
                "spec": pod,
            },
        },
    }


# Reuse the existing serialized, audited admission changes. Do not bypass its
# version checks or call providers. An in-flight run blocks a deployment.
PAUSE = """
import json, uuid
from apps.evaluations.admission import status, change_admission
from apps.evaluations.models import EvaluationRun
s = status()
changed = s['accepting']
if changed:
    s = change_admission(accepting=False, expected_version=s['version'], request_id=uuid.uuid4(),
                        actor='eks-release', reason='Automatic deployment ' + RELEASE_SHA)
busy = EvaluationRun.objects.filter(status__in=['REQUESTED','QUEUED','RUNNING','CANCELLING']).exists()
if busy and changed:
    change_admission(accepting=True, expected_version=s['version'], request_id=uuid.uuid4(),
                     actor='eks-release', reason='Deployment deferred: active evaluations')
print(json.dumps({'changed': changed, 'version': s['version'], 'busy': busy}))
"""
RESUME = """
import uuid
from apps.evaluations.admission import change_admission
change_admission(accepting=True, expected_version=PAUSE_VERSION, request_id=uuid.uuid4(),
                 actor='eks-release', reason='Automatic deployment completed ' + RELEASE_SHA)
"""


def ops_command(code):
    return kube(
        "govbiz-msa",
        "exec",
        "deployment/ops-service",
        "-c",
        "ops-service",
        "--",
        "python",
        "manage.py",
        "shell",
        "--verbosity",
        "0",
        "--command",
        code,
    )


def deploy(record):
    validate(record)
    sha = record["sourceSha"]
    current(sha)
    check_ci(sha)
    identity = json.loads(
        run(
            "aws", "sts", "get-caller-identity", "--output", "json", capture_output=True
        ).stdout
    )
    require(identity["Account"] == record["account"], "Unexpected AWS identity")
    run(
        "aws",
        "eks",
        "update-kubeconfig",
        "--name",
        record["cluster"],
        "--region",
        record["region"],
        "--kubeconfig",
        os.environ["KUBECONFIG"],
        capture_output=True,
    )
    deployments = {}
    for namespace, name, mapping in TARGETS:
        obj = json.loads(kube(namespace, "get", "deployment", name, "-o", "json"))
        require(
            obj["spec"].get("replicas", 1) == 1,
            "Existing deployment is stopped; inspect before releasing: " + name,
        )
        image_patch(obj, mapping, record)
        deployments[name] = obj
    annotations = deployments["ops-service"].get("metadata", {}).get("annotations", {})
    require(
        not annotations.get("govbiz.io/release-in-progress"),
        "A prior release did not finish; inspect writers and admission before clearing its marker",
    )
    # Duplicate workflow_run events must not pause admission or migrate again.
    if all(
        obj["spec"]["template"]
        .get("metadata", {})
        .get("annotations", {})
        .get("govbiz.io/source-sha")
        == sha
        and all(
            next(
                c["image"]
                for c in obj["spec"]["template"]["spec"]["containers"]
                if c["name"] == name
            )
            == record["images"][component]
            for name, component in mapping.items()
        )
        for (_, target, mapping) in TARGETS
        for obj in [deployments[target]]
    ):
        require(
            annotations.get("govbiz.io/release-complete") == sha,
            "Images match but release completion is not confirmed",
        )
        for ns, name, _ in TARGETS:
            kube(ns, "rollout", "status", "deployment/" + name, "--timeout=300s")
        print("Already deployed and ready: " + sha)
        return
    job = migration_job(
        deployments["ops-service"], record["images"]["ops-service"], sha
    )
    current(sha)
    pause = json.loads(
        ops_command("RELEASE_SHA=" + repr(sha) + "\n" + PAUSE).strip().splitlines()[-1]
    )
    require(
        not pause["busy"],
        "Active evaluations: deployment deferred without cancelling runs",
    )
    # Failure leaves admission closed and stopped writers stopped for inspection.
    print("ADMISSION_PAUSE=" + json.dumps(pause), flush=True)
    kube(
        "govbiz-msa",
        "patch",
        "deployment",
        "ops-service",
        "--type=merge",
        "--patch",
        json.dumps(
            {"metadata": {"annotations": {"govbiz.io/release-in-progress": sha}}}
        ),
    )
    for namespace, name in (
        ("govbiz-evaluation", "evaluation-runner"),
        ("govbiz-msa", "ops-service"),
    ):
        kube(namespace, "scale", "deployment/" + name, "--replicas=0")
        kube(namespace, "rollout", "status", "deployment/" + name, "--timeout=300s")
    existing = kube(
        "govbiz-msa",
        "get",
        "job",
        job["metadata"]["name"],
        "--ignore-not-found",
        "-o",
        "json",
    )
    if existing.strip():
        previous = json.loads(existing)
        require(
            previous["spec"]["template"]["spec"]["containers"][0]["image"]
            == record["images"]["ops-service"],
            "Migration job image mismatch",
        )
    else:
        kube("govbiz-msa", "create", "-f", "-", payload=job)
    kube(
        "govbiz-msa",
        "wait",
        "--for=condition=complete",
        "job/" + job["metadata"]["name"],
        "--timeout=330s",
    )
    for namespace, name, mapping in TARGETS:
        current(sha)
        kube(
            namespace,
            "patch",
            "deployment",
            name,
            "--type=strategic",
            "--patch",
            json.dumps(image_patch(deployments[name], mapping, record)),
        )
        if name in {"ops-service", "evaluation-runner"}:
            kube(namespace, "scale", "deployment/" + name, "--replicas=1")
        kube(namespace, "rollout", "status", "deployment/" + name, "--timeout=300s")
    if pause["changed"]:
        ops_command(
            "RELEASE_SHA="
            + repr(sha)
            + "\nPAUSE_VERSION="
            + str(int(pause["version"]))
            + "\n"
            + RESUME
        )
    kube(
        "govbiz-msa",
        "patch",
        "deployment",
        "ops-service",
        "--type=merge",
        "--patch",
        json.dumps(
            {
                "metadata": {
                    "annotations": {
                        "govbiz.io/release-in-progress": None,
                        "govbiz.io/release-complete": sha,
                    }
                }
            }
        ),
    )
    print("EKS rollout complete: " + sha)


if __name__ == "__main__":
    try:
        deploy(json.loads(Path("release.json").read_text()))
    except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
        print(
            str(error)
            if isinstance(error, ValueError)
            else "Deployment failed; inspect CodeBuild and Kubernetes events. Admission may remain paused.",
            file=sys.stderr,
        )
        sys.exit(1)
