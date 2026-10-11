"""Publish verified local release tags and prepare automatic Argo configuration."""

import argparse
import copy
import io
import json
import os
import re
import subprocess
import tempfile
import zipfile
from pathlib import Path

import yaml
from check_evaluation import LANGFUSE_ORIGIN, render_bundle
from check_msa import policy_errors
from deployment import commit_tree, source_checks
from deployment_candidate import (
    HELM_VERSION,
    KUBE_VERSION,
    PREFIX,
    SERVICES,
    digest,
    encoded,
    git_bytes,
    tracked_files,
    write_files,
)
from publish import (
    RUNNER,
    RUNNER_PATHS,
    RUNNER_RELEASE,
    WEB,
    WEB_MODE,
    WEB_PATHS,
    input_key,
    workspace_input_key,
)
from repository import from_ci, from_origin
from sync_images import api

ROOT = Path(__file__).resolve().parents[3]
COMPONENTS = (*SERVICES, WEB, RUNNER)
WORKLOADS = (*SERVICES, WEB, RUNNER, "ops-artifacts")
TAG_PREFIX = "govbiz-local/"
WORKFLOW = ".github/workflows/local-release.yml"
SOURCE_PATHS = (
    PREFIX + "charts/govbiz-service",
    PREFIX + "charts/govbiz-evaluation",
    PREFIX + "environments/portfolio",
    PREFIX + "environments/in-cluster",
    PREFIX + "environments/evaluation",
    PREFIX + "environments/local-msa/web.yaml",
)


def release_tag(run_id, attempt):
    if any(type(value) is not int or value <= 0 for value in (run_id, attempt)):
        raise ValueError("Positive run and attempt identities are required")
    return f"{TAG_PREFIX}v1.{run_id}.{attempt}"


def validate_receipt(root, fork, sha, service, receipt):
    """Recompute provenance from Git blobs, never trust uploaded input identities."""
    publisher = (
        git_bytes(root, "rev-parse", sha + ":infrastructure/release").decode().strip()
    )
    if service in SERVICES:
        tree = (
            git_bytes(root, "rev-parse", sha + ":backend/" + service).decode().strip()
        )
        key = input_key(tree, publisher)
        source = {"schemaVersion": 2, "sourceTree": tree}
    else:
        paths = RUNNER_PATHS if service == RUNNER else WEB_PATHS
        hashes = (
            git_bytes(root, "rev-parse", *(sha + ":" + path for path in paths))
            .decode()
            .splitlines()
        )
        inputs = dict(zip(paths, hashes, strict=True))
        key = workspace_input_key(service, inputs, publisher)
        source = {
            "schemaVersion": 3 if service == RUNNER else 4,
            "sourceInputs": inputs,
            "publisherTree": publisher,
        }
        if service == RUNNER:
            source["executionReleaseSha256"] = digest(
                git_bytes(root, "show", sha + ":" + RUNNER_RELEASE)
            )
        else:
            source["webMode"] = WEB_MODE
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", str(receipt.get("digest", ""))):
        raise ValueError("An immutable image digest is required")
    expected = {
        **source,
        "service": service,
        "repository": fork.image(service),
        "digest": receipt["digest"],
        "tag": "src-" + key,
        "inputKey": key,
        "platform": "linux/amd64",
        "verifiedRevision": sha,
        "visibility": "public",
    }
    if receipt != expected:
        raise ValueError(
            "Receipt differs from the tested source, policy or public package"
        )
    return expected


def receipts_for_run(root, fork, sha, run_id, attempt, get=api):
    run = get(f"repos/{fork.repository}/actions/runs/{run_id}")
    if (
        run.get("id") != run_id
        or run.get("run_attempt") != attempt
        or run.get("path") != WORKFLOW
        or run.get("head_sha") != sha
        or run.get("head_branch") != fork.branch
        or run.get("event") not in {"workflow_run", "workflow_dispatch"}
        or run.get("repository", {}).get("full_name") != fork.repository
        or run.get("head_repository", {}).get("full_name") != fork.repository
    ):
        raise ValueError("Untrusted local publisher run")
    response = get(
        f"repos/{fork.repository}/actions/runs/{run_id}/artifacts?per_page=100"
    )
    artifacts = response["artifacts"]
    names = {f"local-receipt-{attempt}-{name}" for name in COMPONENTS}
    selected = [item for item in artifacts if item.get("name") in names]
    if (
        response.get("total_count") != len(artifacts)
        or len(selected) != len(names)
        or {a["name"] for a in selected} != names
    ):
        raise ValueError("All six current-attempt receipts are required")
    receipts = {}
    for artifact in selected:
        origin = artifact.get("workflow_run", {})
        if (
            artifact.get("expired") is not False
            or origin.get("id") != run_id
            or origin.get("head_sha") != sha
            or origin.get("head_branch") != fork.branch
            or origin.get("repository_id") != run["repository"]["id"]
            or origin.get("head_repository_id") != run["repository"]["id"]
            or not 0 < artifact.get("size_in_bytes", 0) < 16384
        ):
            raise ValueError("Invalid receipt origin, expiry or size")
        payload = get(
            f"repos/{fork.repository}/actions/artifacts/{artifact['id']}/zip",
            binary=True,
        )
        if len(payload) != artifact["size_in_bytes"] or "sha256:" + digest(
            payload
        ) != artifact.get("digest"):
            raise ValueError("Receipt archive checksum mismatch")
        service = artifact["name"].removeprefix(f"local-receipt-{attempt}-")
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            entries = archive.infolist()
            if (
                len(entries) != 1
                or entries[0].filename != service + ".json"
                or entries[0].file_size > 8192
            ):
                raise ValueError("Unexpected receipt archive contents")
            receipts[service] = validate_receipt(
                root, fork, sha, service, json.loads(archive.read(entries[0]))
            )
    return receipts


def merge(base, override):
    result = copy.deepcopy(base)
    for key, value in override.items():
        result[key] = (
            merge(result[key], value)
            if isinstance(value, dict) and isinstance(result.get(key), dict)
            else value
        )
    return result


def deployment_hooks(migration, tag):
    hooks = []
    for phase, hook in (("prepare", "PreSync"), ("resume", "PostSync")):
        job = copy.deepcopy(migration)
        job["metadata"]["name"] = "ops-service-release-" + phase
        job["metadata"]["annotations"]["argocd.argoproj.io/hook"] = hook
        job["spec"]["activeDeadlineSeconds"] = 600
        if phase == "resume":
            # Evaluation ingress permits Ops. Without an instance label this is not an HTTP endpoint.
            job["spec"]["template"]["metadata"]["labels"] = {
                "app.kubernetes.io/name": "ops-service"
            }
        job["spec"]["template"]["spec"]["containers"][0]["command"] = [
            "python",
            "manage.py",
            "local_release",
            phase,
            "--release",
            tag,
        ]
        hooks.append(job)
    return hooks


def bundle(root, fork, sha, tag, receipts, helm="helm"):
    """Render tested charts into one atomic Argo sync scope; no data resources."""
    if set(receipts) != set(COMPONENTS):
        raise ValueError("Incomplete local release")
    for name, receipt in receipts.items():
        validate_receipt(root, fork, sha, name, receipt)
    source = tracked_files(root, sha, SOURCE_PATHS)
    files = {}
    with tempfile.TemporaryDirectory(prefix="govbiz-local-release-") as directory:
        checkout = Path(directory).resolve()
        write_files(checkout, source)
        gitops = checkout / PREFIX

        def values(path):
            return yaml.safe_load((gitops / path).read_text())

        for name in (*SERVICES, WEB):
            value = values(
                f"environments/{'local-msa' if name == WEB else 'portfolio'}/{name}.yaml"
            )
            value = merge(value, values(f"environments/in-cluster/{name}.yaml"))
            receipt = receipts[name]
            value.update(
                image={
                    "repository": receipt["repository"],
                    "digest": receipt["digest"],
                    "tag": "",
                    "pullPolicy": "IfNotPresent",
                },
                imagePullSecrets=[],
                localMode=False,
            )
            path = checkout / "values.yaml"
            path.write_text(yaml.safe_dump(value))
            output = subprocess.check_output(
                [
                    helm,
                    "template",
                    name,
                    str(gitops / "charts/govbiz-service"),
                    "--namespace",
                    "govbiz-msa",
                    "--kube-version",
                    KUBE_VERSION,
                    "--values",
                    str(path),
                ],
                timeout=30,
                stderr=subprocess.PIPE,
            )
            resources = [row for row in yaml.safe_load_all(output) if row]
            if name in SERVICES:
                errors = policy_errors(
                    name, resources, ops_sync_enabled=name == "ops-service"
                )
                if errors:
                    raise ValueError(
                        "Local service policy failed: " + "; ".join(errors)
                    )
            if name == "ops-service":
                migration = next(row for row in resources if row["kind"] == "Job")
                resources.remove(migration)
                resources.extend(deployment_hooks(migration, tag))
            files[f"release/{name}.yaml"] = yaml.safe_dump_all(
                resources, sort_keys=False
            ).encode()
        evaluation = {
            name: values(f"environments/evaluation/{name}.yaml")
            for name in ("prefect", RUNNER, "ops-artifacts")
        }
        runner_image = receipts[RUNNER]["repository"] + "@" + receipts[RUNNER]["digest"]
        for name, value in evaluation.items():
            value["replicas"] = 1
            value["storage"]["node"] = "govbiz-local-control-plane"
        evaluation[RUNNER]["image"] = runner_image
        evaluation[RUNNER]["runner"]["langfuseUrl"] = LANGFUSE_ORIGIN
        evaluation["ops-artifacts"].update(
            image=receipts["ops-service"]["repository"]
            + "@"
            + receipts["ops-service"]["digest"],
            evidenceImage=runner_image,
        )
        rendered = render_bundle(
            evaluation,
            "govbiz-evaluation",
            helm,
            chart=gitops / "charts/govbiz-evaluation",
        )
        for name in (RUNNER, "ops-artifacts"):
            files[f"release/{name}.yaml"] = yaml.safe_dump_all(
                rendered[name], sort_keys=False
            ).encode()
    files["release/kustomization.yaml"] = yaml.safe_dump(
        {
            "apiVersion": "kustomize.config.k8s.io/v1beta1",
            "kind": "Kustomization",
            "resources": [name + ".yaml" for name in WORKLOADS],
        },
        sort_keys=False,
    ).encode()
    files["release-record.json"] = encoded(
        {
            "schema": "govbiz-local-release-v1",
            "repository": fork.repository,
            "sourceSha": sha,
            "tag": tag,
            "receipts": receipts,
            "files": {path: digest(data) for path, data in files.items()},
        }
    )
    return files


def runtime_patches(runtime):
    """Keep installed environment/Secret references and results PVC, never images."""
    deployments = [
        row
        for row in runtime["items"]
        if row.get("kind") == "Deployment"
        and row.get("metadata", {}).get("name") in WORKLOADS
    ]
    by_name = {row["metadata"]["name"]: row for row in deployments}
    if len(deployments) != len(WORKLOADS) or set(by_name) != set(WORKLOADS):
        raise ValueError("Export all seven installed application Deployments")
    patches = []
    for name in WORKLOADS:
        row = by_name[name]
        namespace = (
            "govbiz-evaluation" if name in (RUNNER, "ops-artifacts") else "govbiz-msa"
        )
        if (
            row["metadata"]["namespace"] != namespace
            or row["spec"].get("replicas") != 1
        ):
            raise ValueError("Only an installed, running local stack can be adopted")
        pod = row["spec"]["template"]["spec"]
        containers = pod["containers"]
        expected = [name, "ops-sync"] if name == "ops-service" else [name]
        if [container["name"] for container in containers] != expected:
            raise ValueError("Unexpected container layout; review before adoption")
        if name in ("ops-service", RUNNER):
            environment = {
                item["name"]: item.get("value") for item in containers[0].get("env", [])
            }
            if any(
                environment.get(flag, "false") != "false"
                for flag in (
                    "LLMOPS_LIVE_ENABLED",
                    "LLMOPS_RAG_LIVE_ENABLED",
                    "LLMOPS_SCHEDULES_ENABLED",
                )
            ):
                raise ValueError(
                    "Automatic local releases currently require the free evaluation profile"
                )
            if name == RUNNER and (
                environment.get("LLMOPS_OPS_API_URL")
                != "http://ops-service.govbiz-msa.svc.cluster.local:8000"
                or environment.get("LANGFUSE_BASE_URL") != LANGFUSE_ORIGIN
            ):
                raise ValueError(
                    "Complete the in-cluster evaluation migration before adoption"
                )
        if name == "ops-service" and containers[0].get("env", []) != containers[1].get(
            "env", []
        ):
            raise ValueError("Ops API and sync environment must agree")
        ops = []
        if name in (*SERVICES, WEB):
            for index, container in enumerate(containers):
                ops.append(
                    {
                        "op": "add",
                        "path": f"/spec/template/spec/containers/{index}/env",
                        "value": container.get("env", []),
                    }
                )
        else:
            # Do not carry runner flags/API keys across releases: its free-only contract is in Git.
            claim = next(
                volume["persistentVolumeClaim"]
                for volume in pod["volumes"]
                if volume["name"] == "data"
            )
            ops.extend(
                [
                    {
                        "op": "add",
                        "path": "/spec/template/spec/nodeSelector",
                        "value": pod["nodeSelector"],
                    },
                    {
                        "op": "replace",
                        "path": "/spec/template/spec/volumes/0/persistentVolumeClaim/claimName",
                        "value": claim["claimName"],
                    },
                ]
            )
        patches.append(
            {
                "target": {"kind": "Deployment", "name": name, "namespace": namespace},
                "patch": json.dumps(ops),
            }
        )
        if name == "ops-service":
            for phase in ("prepare", "resume"):
                patches.append(
                    {
                        "target": {
                            "kind": "Job",
                            "name": "ops-service-release-" + phase,
                            "namespace": namespace,
                        },
                        "patch": json.dumps(ops[:1]),
                    }
                )
    if (
        by_name[RUNNER]["spec"]["template"]["spec"]["nodeSelector"]
        != by_name["ops-artifacts"]["spec"]["template"]["spec"]["nodeSelector"]
    ):
        raise ValueError("Runner and artifacts must share their results node")
    claims = [
        next(
            v["persistentVolumeClaim"]["claimName"]
            for v in by_name[n]["spec"]["template"]["spec"]["volumes"]
            if v["name"] == "data"
        )
        for n in (RUNNER, "ops-artifacts")
    ]
    if claims[0] != claims[1]:
        raise ValueError("Runner and artifacts must share their results claim")
    return patches


def application(fork, runtime):
    destinations = [
        {"server": "https://kubernetes.default.svc", "namespace": n}
        for n in ("govbiz-msa", "govbiz-evaluation")
    ]
    return [
        {
            "apiVersion": "argoproj.io/v1alpha1",
            "kind": "AppProject",
            "metadata": {"name": "govbiz-local", "namespace": "argocd"},
            "spec": {
                "sourceRepos": [fork.url],
                "destinations": destinations,
                "clusterResourceWhitelist": [],
                "namespaceResourceWhitelist": [
                    {"group": group, "kind": kind}
                    for group, kind in (
                        ("apps", "Deployment"),
                        ("", "Service"),
                        ("batch", "Job"),
                        ("networking.k8s.io", "NetworkPolicy"),
                    )
                ],
            },
        },
        {
            "apiVersion": "argoproj.io/v1alpha1",
            "kind": "Application",
            "metadata": {"name": "govbiz-local", "namespace": "argocd"},
            "spec": {
                "project": "govbiz-local",
                "destination": destinations[0],
                "source": {
                    "repoURL": fork.url,
                    "path": "release",
                    "tagPrefix": TAG_PREFIX,
                    "targetRevision": ">=1.0.0 <2.0.0",
                    "kustomize": {"patches": runtime_patches(runtime)},
                },
                "syncPolicy": {
                    "automated": {"enabled": True, "prune": False, "selfHeal": False},
                    "syncOptions": ["FailOnSharedResource=true"],
                    "retry": {
                        "limit": 5,
                        "backoff": {
                            "duration": "30s",
                            "factor": 2,
                            "maxDuration": "5m",
                        },
                    },
                },
            },
        },
    ]


def publish_tag(root, fork, sha, tag, files, recheck):
    """Create an immutable tag, never a deployment branch, PR or force push."""
    ref = "refs/tags/" + tag
    if not re.fullmatch(r"govbiz-local/v1\.[1-9][0-9]*\.[1-9][0-9]*", tag):
        raise ValueError("Invalid local release tag")
    existing = git_bytes(root, "ls-remote", "--refs", fork.url, ref).decode().strip()
    if existing:
        revision, found_ref = existing.split()
        if found_ref != ref:
            raise ValueError("Unexpected remote tag")
        git_bytes(root, "fetch", "--no-tags", fork.url, revision)
        if tracked_files(root, revision) != files:
            raise ValueError("Immutable release tag already has different contents")
        recheck()
        return revision
    revision = commit_tree(root, files, base=sha)
    recheck()  # Check current source, CI and artifact evidence immediately before publication.
    git_bytes(root, "push", fork.url, revision + ":" + ref)
    return revision


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    publish = sub.add_parser("publish")
    publish.add_argument("--sha", required=True)
    publish.add_argument("--helm", default="helm")
    app = sub.add_parser("application")
    app.add_argument("--runtime", type=Path, required=True)
    app.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.action == "application":
        resources = application(
            from_origin(ROOT).require_personal_publish(),
            json.loads(args.runtime.read_text()),
        )
        # Env values may contain private configuration. Never print or publish them.
        fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as output:
            yaml.safe_dump_all(resources, output, sort_keys=False)
        print("Automatic Argo configuration prepared; cluster unchanged.")
        return
    fork = from_ci().require_personal_publish()
    if (
        os.environ.get("LOCAL_ARGO_RELEASE_ENABLED") != "true"
        or os.environ.get("GITHUB_ACTIONS") != "true"
        or git_bytes(ROOT, "rev-parse", "HEAD").decode().strip() != args.sha
    ):
        raise ValueError("Publication requires the opted-in, tested Actions checkout")
    version = subprocess.check_output(
        [args.helm, "version", "--short"], text=True
    ).strip()
    if version.split("+")[0] != HELM_VERSION:
        raise ValueError("Pinned Helm is required")
    run_id, attempt = (
        int(os.environ["GITHUB_RUN_ID"]),
        int(os.environ["GITHUB_RUN_ATTEMPT"]),
    )
    checks = source_checks(fork, args.sha)
    receipts = receipts_for_run(ROOT, fork, args.sha, run_id, attempt)
    tag = release_tag(run_id, attempt)
    files = bundle(ROOT, fork, args.sha, tag, receipts, args.helm)
    files["source-checks.json"] = encoded(checks)

    def recheck():
        if (
            source_checks(fork, args.sha) != checks
            or receipts_for_run(ROOT, fork, args.sha, run_id, attempt) != receipts
        ):
            raise ValueError("Source, CI or publication evidence changed")

    revision = publish_tag(ROOT, fork, args.sha, tag, files, recheck)
    print(
        json.dumps(
            {
                "tag": tag,
                "revision": revision,
                "sourceSha": args.sha,
                "clusterVerified": False,
            }
        )
    )


if __name__ == "__main__":
    main()
