"""Prepare private, pinned Argo inputs for an existing runtime; never apply them."""

import argparse
import json
import os
import re
import stat
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import deployment
import gitops_runtime as runtime
import yaml
from check_msa import policy_errors
from deployment_candidate import (
    HELM_VERSION,
    KUBE_VERSION,
    PREFIX,
    SERVICES,
    digest,
    encoded,
)
from repository import from_origin

# These differences can be represented by the captured env/Secret refs and sync
# container. They remain deployment blockers in the report, not exemptions.
PRESERVABLE_BLOCKERS = {
    "local_integration_profile",
    "connected_or_unverified_ops",
    "ops_container_layout_differs",
    "ops_environment_differs",
    "service_environment_differs",
}


def build_plan(fork, publication, observed, values, helm="helm"):
    """Compile only the verified source chart and values captured by preflight."""
    record, files, sha = publication
    review = observed.get("preservationReview", {})
    if (
        observed.get("status") not in {"BLOCKED", "NO_LOCAL_OVERRIDES"}
        or not isinstance(observed.get("blockers"), list)
        or not set(observed["blockers"]) <= PRESERVABLE_BLOCKERS
        or review.get("connectionRecordConflict") is not False
        or review.get("helmPreservation", {}).get("status")
        != "MATCHES_INSPECTED_FIELDS"
        or set(values) != set(SERVICES)
    ):
        raise ValueError("Runtime preservation is incomplete")
    plan = deployment.gitops_plan(fork, record, files, sha)
    _, chart = runtime.published_defaults(files)
    version = subprocess.check_output(
        [helm, "version", "--template", "{{.Version}}"],
        text=True,
        timeout=30,
        stderr=subprocess.PIPE,
    ).strip()
    if version != HELM_VERSION:
        raise ValueError("Pinned Helm is required")
    rendered = {}
    with tempfile.TemporaryDirectory(prefix="govbiz-transition-") as directory:
        root = Path(directory)
        for name, payload in chart.items():
            path = root / "chart" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(payload)
        for service, application in zip(SERVICES, plan["resources"][1:], strict=True):
            original = yaml.safe_load(
                files[PREFIX + f"environments/fork/{service}.yaml"]
            )
            preserved = yaml.safe_load(values[service])
            # Only the narrowly captured configuration may override publication.
            # In particular the image, migration, storage and security stay fixed.
            allowed = {"env", "secretKeys", "opsSync"}
            if {k: v for k, v in original.items() if k not in allowed} != {
                k: v for k, v in preserved.items() if k not in allowed
            } or not {"env", "secretKeys"} <= preserved.keys():
                raise ValueError("Preserved values changed the publication contract")
            path = root / (service + ".yaml")
            path.write_bytes(values[service])
            payload = subprocess.check_output(
                [
                    helm,
                    "template",
                    service,
                    str(root / "chart"),
                    "--namespace",
                    runtime.cluster.NAMESPACE,
                    "--kube-version",
                    KUBE_VERSION,
                    "--values",
                    str(path),
                ],
                timeout=30,
                stderr=subprocess.PIPE,
            )
            objects = [item for item in yaml.safe_load_all(payload) if item is not None]
            # This checks structure, same-image migration and Secret boundaries.
            # Existing personal integrations are not the shared bootstrap policy.
            if policy_errors(
                service,
                objects,
                require_ops_migration=True,
                ops_sync_enabled=preserved.get("opsSync", {}).get("enabled", False),
            ):
                raise ValueError("Preserved resources failed the transition policy")
            for item in objects:
                if item["kind"] not in {"Deployment", "Job"}:
                    continue
                containers = item["spec"]["template"]["spec"]["containers"]
                if any(
                    container["image"] != record["images"][service]
                    for container in containers
                ):
                    raise ValueError("Preserved resources changed the published image")
                expected_env = runtime.environment_rows(
                    runtime.values_reference(values[service])[1]
                )
                if any(
                    container.get("envFrom")
                    or runtime.environment_rows(container.get("env", []))
                    != expected_env
                    for container in containers
                ):
                    raise ValueError(
                        "Preserved resources changed the captured environment"
                    )
            application["spec"]["source"]["helm"]["valuesObject"] = preserved
            rendered[service] = objects
    plan.update(
        schema="msa-gitops-transition-v1",
        status="PREPARED_NOT_APPLIED",
        generatedAt=datetime.now(timezone.utc).isoformat(),
        repository=fork.repository,
        sourceSha=sha,
        publisherRunId=record["runId"],
        stateId=observed["stateId"],
        images=record["images"],
        resourcesSha256=digest(encoded(plan["resources"])),
        renderedSha256={
            name: digest(encoded(items)) for name, items in rendered.items()
        },
        rendered=rendered,
        runtimePreflight=observed,
        publishedReferenceVerified=True,
        sharedBootstrapPolicyVerified=False,
        configurationValuesIncluded=True,
        secretValuesRead=False,
        servicesChanged=False,
        databaseChanged=False,
        pendingChecks=[
            "fresh_publication_and_runtime_verification",
            "backup_and_restore",
            "ops_migration_and_writer_coordination",
            "secrets_and_external_connections",
            "manual_argo_handoff",
            "application_smoke_and_rollback",
        ],
    )
    return plan


def output_path(state, name):
    """Use a new private child of owned state, never a tracked deployment file."""
    if not re.fullmatch(r"gitops-transition-[a-z0-9][a-z0-9-]{0,63}", name):
        raise ValueError(
            "Use a gitops-transition- name with lowercase letters and digits"
        )
    state = Path(state)
    info = state.lstat()
    if (
        os.name != "posix"
        or not stat.S_ISDIR(info.st_mode)
        or info.st_uid != os.getuid()
        or info.st_mode & 0o022
    ):
        raise ValueError("Use owned local state on a POSIX filesystem (WSL on Windows)")
    output = state.resolve() / name
    if output.exists() or output.is_symlink():
        raise ValueError("Transition output already exists; use a new name")
    return output


def write_plan(output, plan):
    """Publish a complete private file exclusively; never replace existing output."""
    output.mkdir(mode=0o700)
    created = []
    try:
        for name, payload in (
            (".gitignore", b"*\n"),
            ("transition.json", encoded(plan)),
        ):
            path = output / name
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            created.append(path)
            with os.fdopen(fd, "wb") as stream:
                stream.write(payload)
    except Exception:
        for path in reversed(created):
            path.unlink()
        output.rmdir()
        raise


def prepare(root, fork, state, name, helm="helm"):
    output = output_path(state, name)
    publication = deployment.verified_release(
        root, fork, helm, verify_public_manifests=True
    )
    values = {}
    observed = runtime.preflight(
        state,
        fork,
        helm,
        review_preservation=True,
        published_files=publication[1],
        prepared_values=values,
    )
    plan = build_plan(fork, publication, observed, values, helm)
    if (
        deployment.verified_release(root, fork, helm, verify_public_manifests=True)
        != publication
    ):
        raise ValueError("Publisher or image receipts changed during preparation")
    # The private file is an observation, not a reusable deployment approval.
    # Applying it will require fresh source/runtime and migration/backup checks.
    write_plan(output, plan)
    return {
        key: plan[key]
        for key in (
            "schema",
            "status",
            "sourceSha",
            "publisherRunId",
            "stateId",
            "automaticSyncEnabled",
            "existingRuntimeVerified",
            "deploymentAuthorized",
            "publishedReferenceVerified",
            "sharedBootstrapPolicyVerified",
            "secretValuesRead",
            "servicesChanged",
            "databaseChanged",
            "pendingChecks",
        )
    } | {"outputName": name, "configurationValuesIncluded": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument(
        "--output-name", required=True, help="New gitops-transition-... child of state"
    )
    parser.add_argument("--branch")
    parser.add_argument("--helm", default="helm")
    args = parser.parse_args()
    fork = None
    try:
        root = Path(__file__).resolve().parents[3]
        fork = from_origin(root, branch=args.branch).require_personal_publish()
        report = prepare(root, fork, args.state_dir, args.output_name, args.helm)
    except Exception as error:  # noqa: BLE001 - external output may contain local values
        report = {
            "schema": "msa-gitops-transition-v1",
            "status": "BLOCKED",
            "reason": "transition_preparation_failed",
            "errorType": type(error).__name__,
            "configurationValuesIncluded": False,
            "deploymentAuthorized": False,
            "servicesChanged": False,
            "databaseChanged": False,
        }
        if fork is not None and str(error).startswith(
            (
                "No complete verified publication",
                "Source advanced",
                "Deployment source blocked",
            )
        ):
            report["reason"] = "publication_not_verified"
            report["publicationBlocker"] = deployment.publication_blocker(fork)
        print(json.dumps(report, sort_keys=True))
        return 1
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
