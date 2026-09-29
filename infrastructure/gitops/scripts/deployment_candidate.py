"""Build and verify the complete, offline-rendered input to one fork deployment."""

import hashlib
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "release"))

from check_msa import CHART_PATH, NAMESPACE, SERVICES, policy_errors
from check_portfolio import free_runtime_errors
from gate import valid_sha
from promote_image import UniqueLoader, validate_receipt
from sync_images import prepare, validate_record

SCHEMA = "govbiz-deployment-v2"
DEPLOYMENT_BRANCH = "deploy/fork"
CHECK_WORKFLOW = ".github/workflows/deployment-ci.yml"
MANIFEST = "infrastructure/gitops/deployment.json"
ARGO = "infrastructure/gitops/argocd/fork/applications.yaml"
HELM_VERSION = "v4.3.0"
KUBE_VERSION = "1.36.4"
PREFIX = "infrastructure/gitops/"
SOURCE_PATHS = (
    CHART_PATH,
    PREFIX + "environments/portfolio",
    PREFIX + "environments/fork",
    CHECK_WORKFLOW,
)


def encoded(value):
    return (
        json.dumps(value, sort_keys=True, ensure_ascii=False, indent=2) + "\n"
    ).encode()


def digest(payload):
    return hashlib.sha256(payload).hexdigest()


def git_bytes(root, *args, data=None):
    return subprocess.check_output(
        ["git", "-C", str(root), *args], input=data, timeout=60
    )


def tracked_files(root, revision, paths=()):
    if not valid_sha(revision):
        raise ValueError("A full Git revision is required")
    entries = git_bytes(root, "ls-tree", "-r", "-z", revision, "--", *paths).split(
        b"\0"
    )
    result = {}
    for entry in filter(None, entries):
        metadata, raw_path = entry.split(b"\t", 1)
        mode, kind, blob = metadata.split()
        path = raw_path.decode("utf-8")
        if (
            mode != b"100644"
            or kind != b"blob"
            or "\\" in path
            or any(part in {"", ".", ".."} for part in path.split("/"))
        ):
            raise ValueError("Deployment inputs must be regular tracked files")
        size = int(git_bytes(root, "cat-file", "-s", blob.decode()))
        if size > 1024 * 1024:
            raise ValueError("Deployment input exceeds 1 MiB")
        result[path] = git_bytes(root, "cat-file", "blob", blob.decode())
        if len(result) > 100 or sum(map(len, result.values())) > 4 * 1024 * 1024:
            raise ValueError("Deployment snapshot exceeds its bounded file budget")
    return result


def write_files(root, files):
    root = Path(root)
    for name, payload in files.items():
        path = root / name
        if (
            not path.resolve().is_relative_to(root.resolve())
            or path.resolve() != path.absolute()
        ):
            raise ValueError(
                "Deployment file escapes its directory or contains a symlink"
            )
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)


def directory_files(root):
    root = Path(root)
    result = {}
    for path in root.rglob("*"):
        if path.is_symlink():
            raise ValueError("Deployment snapshots must not contain symlinks")
        if path.is_file():
            if path.stat().st_size > 1024 * 1024 or len(result) >= 100:
                raise ValueError("Deployment input exceeds its file budget")
            result[path.relative_to(root).as_posix()] = path.read_bytes()
    if sum(map(len, result.values())) > 4 * 1024 * 1024:
        raise ValueError("Deployment input exceeds its total budget")
    return result


def argo_resources(fork, *, ops_migration=True):
    if fork.branch == DEPLOYMENT_BRANCH:
        raise ValueError("Source and deployment branches must be distinct")
    destination = {"server": "https://kubernetes.default.svc", "namespace": NAMESPACE}
    project = {
        "apiVersion": "argoproj.io/v1alpha1",
        "kind": "AppProject",
        "metadata": {"name": "govbiz-fork", "namespace": "argocd"},
        "spec": {
            "sourceRepos": [fork.url],
            "destinations": [destination],
            "clusterResourceWhitelist": [],
            "namespaceResourceWhitelist": [
                {"group": "apps", "kind": "Deployment"},
                {"group": "", "kind": "Service"},
            ],
        },
    }
    if ops_migration:
        project["spec"]["namespaceResourceWhitelist"].append(
            {"group": "batch", "kind": "Job"}
        )
    apps = [
        {
            "apiVersion": "argoproj.io/v1alpha1",
            "kind": "Application",
            "metadata": {"name": "govbiz-fork-" + service, "namespace": "argocd"},
            "spec": {
                "project": "govbiz-fork",
                "source": {
                    "repoURL": fork.url,
                    "targetRevision": DEPLOYMENT_BRANCH,
                    "path": CHART_PATH,
                    "helm": {
                        "releaseName": service,
                        "kubeVersion": KUBE_VERSION,
                        "valueFiles": [f"../../environments/fork/{service}.yaml"],
                    },
                },
                "destination": destination,
                "syncPolicy": {
                    "automated": {"enabled": True, "prune": False, "selfHeal": True},
                    "syncOptions": ["FailOnSharedResource=true"],
                    "retry": {
                        "limit": 5,
                        "backoff": {
                            "duration": "10s",
                            "factor": 2,
                            "maxDuration": "3m",
                        },
                    },
                },
            },
        }
        for service in SERVICES
    ]
    if ops_migration:
        apps[-1]["spec"]["syncPolicy"]["retry"]["limit"] = 0
    return [project, *apps]


def render(root, helm="helm", *, require_ops_migration=True):
    version = subprocess.check_output(
        [helm, "version", "--template", "{{.Version}}"], text=True, timeout=30
    ).strip()
    if version != HELM_VERSION:
        raise ValueError("Use pinned Helm " + HELM_VERSION)
    chart = yaml.load(
        (root / "charts/govbiz-service/Chart.yaml").read_text(encoding="utf-8"),
        Loader=UniqueLoader,
    )
    if chart.get("dependencies"):
        raise ValueError(
            "Deployment chart dependencies must not fetch untracked inputs"
        )
    result = {}
    for service in SERVICES:
        values_path = root / f"environments/fork/{service}.yaml"
        values = yaml.load(values_path.read_text(encoding="utf-8"), Loader=UniqueLoader)
        problems = free_runtime_errors(service, values)
        subprocess.run(
            [
                helm,
                "lint",
                str(root / "charts/govbiz-service"),
                "--strict",
                "-f",
                str(values_path),
            ],
            check=True,
            capture_output=True,
            timeout=30,
        )
        output = subprocess.check_output(
            [
                helm,
                "template",
                service,
                str(root / "charts/govbiz-service"),
                "-n",
                NAMESPACE,
                "--kube-version",
                KUBE_VERSION,
                "-f",
                str(values_path),
            ],
            text=True,
            encoding="utf-8",
            timeout=30,
        )
        objects = [
            item
            for item in yaml.load_all(output, Loader=UniqueLoader)
            if item is not None
        ]
        problems.extend(
            policy_errors(
                service,
                objects,
                require_ops_migration=require_ops_migration,
                ops_sync_enabled=values.get("opsSync", {}).get("enabled", False),
            )
        )
        if problems:
            raise ValueError("\n".join(problems))
        deployment = next(item for item in objects if item["kind"] == "Deployment")
        container = deployment["spec"]["template"]["spec"]["containers"][0]
        if (
            container["image"]
            != values["image"]["repository"] + "@" + values["image"]["digest"]
        ):
            raise ValueError("Rendered image differs from the verified receipt")
        env = {item["name"]: item.get("value") for item in container["env"]}
        problems = free_runtime_errors(service, {"env": env})
        if len(env) != len(container["env"]):
            problems.append("Duplicate rendered environment variables are forbidden")
        if any(
            re.search(
                r"(PASSWORD|SECRET|TOKEN|API_KEY|SERVICE_KEY|PRIVATE_KEY)$",
                key,
                re.IGNORECASE,
            )
            and value is not None
            for key, value in env.items()
        ):
            problems.append("Rendered credentials must use Secret references")
        if problems:
            raise ValueError("\n".join(problems))
        result[service] = encoded(objects)
    return result


def release_files(
    root,
    fork,
    source_sha,
    publisher_id,
    receipts,
    helm="helm",
    *,
    require_ops_migration=True,
):
    """Render verified images using only the published commit's tracked inputs."""
    if not valid_sha(source_sha) or type(publisher_id) is not int or publisher_id <= 0:
        raise ValueError("Invalid published source or publisher identity")
    source = tracked_files(root, source_sha, SOURCE_PATHS)
    if len(receipts) != 4 or {item["service"] for item in receipts} != set(SERVICES):
        raise ValueError("Four image receipts are required")
    for receipt in receipts:
        validate_receipt(receipt, fork)
        service = receipt["service"]
        service_tree = (
            git_bytes(root, "rev-parse", f"{source_sha}:backend/{service}")
            .decode()
            .strip()
        )
        release_tree = (
            git_bytes(root, "rev-parse", f"{source_sha}:infrastructure/release")
            .decode()
            .strip()
        )
        key = digest(f"v1\nlinux/amd64\n{service_tree}\n{release_tree}\n".encode())
        if (
            receipt["verifiedRevision"] != source_sha
            or receipt["sourceTree"] != service_tree
            or receipt["inputKey"] != key
        ):
            raise ValueError("Receipt does not match the exact tracked source")
    record = {
        "repository": fork.repository,
        "branch": fork.branch,
        "verifiedRevision": source_sha,
        "visibility": receipts[0].get("visibility", "private"),
        "runId": publisher_id,
        "runUrl": f"https://github.com/{fork.repository}/actions/runs/{publisher_id}",
        "images": {r["service"]: r["repository"] + "@" + r["digest"] for r in receipts},
    }
    validate_record(record, fork)
    with tempfile.TemporaryDirectory(prefix="govbiz-candidate-") as directory:
        checkout = Path(directory).resolve()
        write_files(checkout, source)
        gitops = checkout / PREFIX
        changes = prepare(gitops, receipts, fork)
        for path, (_, value) in changes.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(value, encoding="utf-8", newline="\n")
        marker = gitops / "environments/fork/release.json"
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_bytes(encoded(record))
        rendered = render(gitops, helm, require_ops_migration=require_ops_migration)
        files = {
            name: value
            for name, value in source.items()
            if name.startswith(CHART_PATH + "/")
        }
        for service in SERVICES:
            name = PREFIX + f"environments/fork/{service}.yaml"
            # Canonical bytes avoid Windows CRLF changing the reviewed bundle.
            files[name] = yaml.safe_dump(
                yaml.load(
                    (checkout / name).read_text(encoding="utf-8"), Loader=UniqueLoader
                ),
                sort_keys=True,
                allow_unicode=True,
            ).encode()
            receipt = next(item for item in receipts if item["service"] == service)
            files[PREFIX + f"receipts/{service}.json"] = encoded(receipt)
            files[PREFIX + f"rendered/{service}.json"] = rendered[service]
        files[PREFIX + "environments/fork/release.json"] = encoded(record)
    return files


def build(
    root,
    fork,
    source_sha,
    base_sha,
    publisher_id,
    checks,
    receipts,
    helm="helm",
    *,
    schema=SCHEMA,
):
    """Read only Git blobs; never execute candidate scripts or copy untracked files."""
    if (
        not valid_sha(source_sha)
        or not valid_sha(base_sha)
        or type(publisher_id) is not int
        or publisher_id <= 0
        or fork.branch == DEPLOYMENT_BRANCH
    ):
        raise ValueError("Invalid source, deployment base or publisher identity")
    if schema not in {"govbiz-deployment-v1", SCHEMA}:
        raise ValueError("Unsupported deployment schema")
    if CHECK_WORKFLOW not in tracked_files(root, source_sha, (CHECK_WORKFLOW,)):
        raise ValueError("Source does not contain the deployment validation workflow")
    files = release_files(
        root,
        fork,
        source_sha,
        publisher_id,
        receipts,
        helm,
        require_ops_migration=schema == SCHEMA,
    )
    files[ARGO] = yaml.safe_dump_all(
        argo_resources(fork, ops_migration=schema == SCHEMA), sort_keys=False
    ).encode()
    manifest = {
        "schema": schema,
        "repository": fork.repository,
        "sourceBranch": fork.branch,
        "deploymentBranch": DEPLOYMENT_BRANCH,
        "sourceSha": source_sha,
        "baseSha": base_sha,
        "publisherRunId": publisher_id,
        "sourceChecks": checks,
        "helmVersion": HELM_VERSION,
        "kubeVersion": KUBE_VERSION,
        "files": {name: digest(value) for name, value in sorted(files.items())},
    }
    manifest["candidateHash"] = digest(encoded(manifest))
    files[MANIFEST] = encoded(manifest)
    return files


def manifest_of(files, fork):
    manifest = json.loads(files[MANIFEST])
    keys = {
        "schema",
        "repository",
        "sourceBranch",
        "deploymentBranch",
        "sourceSha",
        "baseSha",
        "publisherRunId",
        "sourceChecks",
        "helmVersion",
        "kubeVersion",
        "files",
        "candidateHash",
    }
    if (
        set(manifest) != keys
        or manifest["schema"] not in {"govbiz-deployment-v1", SCHEMA}
        or manifest["repository"] != fork.repository
        or manifest["sourceBranch"] != fork.branch
        or manifest["deploymentBranch"] != DEPLOYMENT_BRANCH
    ):
        raise ValueError("Candidate does not belong to this source/deployment boundary")
    unsigned = {key: value for key, value in manifest.items() if key != "candidateHash"}
    if digest(encoded(unsigned)) != manifest["candidateHash"]:
        raise ValueError("Candidate metadata changed after review")
    actual = {name: digest(value) for name, value in files.items() if name != MANIFEST}
    if actual != manifest["files"]:
        raise ValueError(
            "Candidate files changed, disappeared or gained unreviewed inputs"
        )
    return manifest


def verify(root, fork, files, helm="helm"):
    manifest = manifest_of(files, fork)
    receipts = [
        json.loads(files[PREFIX + f"receipts/{service}.json"]) for service in SERVICES
    ]
    expected = build(
        root,
        fork,
        manifest["sourceSha"],
        manifest["baseSha"],
        manifest["publisherRunId"],
        manifest["sourceChecks"],
        receipts,
        helm,
        schema=manifest["schema"],
    )
    if files != expected:
        raise ValueError(
            "Candidate differs from the source, receipts or fresh Helm rendering"
        )
    return manifest
