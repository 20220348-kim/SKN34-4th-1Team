"""Prepare or revalidate private Argo inputs for an existing runtime; never apply."""

import argparse
import json
import math
import os
import re
import stat
import subprocess
import tempfile
from contextlib import ExitStack, contextmanager
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
MAX_PLAN_BYTES = 16 * 1024 * 1024


class TransitionFailure(ValueError):
    """Carry a fixed failure stage without exposing external error text."""

    def __init__(self, stage, *, changed_sections=()):
        super().__init__("Transition failed at " + stage)
        self.stage = stage
        self.changed_sections = changed_sections


@contextmanager
def transition_stage(stage):
    try:
        yield
    except TransitionFailure:
        raise
    except Exception as error:
        raise TransitionFailure(stage) from error


def changed_sections(saved, fresh):
    """Compare all fields but report only fixed section names, never input keys."""
    groups = {
        "publication": {"repository", "sourceSha", "publisherRunId", "images"},
        "runtime": {"stateId", "runtimePreflight"},
        "argo_resources": {"resources", "resourcesSha256"},
        "rendered_resources": {"rendered", "renderedSha256"},
        "safety_contract": {
            "schema",
            "status",
            "automaticSyncEnabled",
            "existingRuntimeVerified",
            "deploymentAuthorized",
            "publishedReferenceVerified",
            "sharedBootstrapPolicyVerified",
            "configurationValuesIncluded",
            "secretValuesRead",
            "servicesChanged",
            "databaseChanged",
            "pendingChecks",
        },
    }
    known = set().union(*groups.values(), {"generatedAt"})
    groups["other_fields"] = (saved.keys() | fresh.keys()) - known
    return [
        name
        for name, keys in groups.items()
        if encoded({key: saved[key] for key in keys if key in saved})
        != encoded({key: fresh[key] for key in keys if key in fresh})
    ]


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


def plan_directory(state, name):
    """Resolve a named child of owned local state, never an arbitrary input path."""
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
    return state.resolve() / name


def output_path(state, name):
    """Use a new private child of owned state, never a tracked deployment file."""
    output = plan_directory(state, name)
    if output.exists() or output.is_symlink():
        raise ValueError("Transition output already exists; use a new name")
    return output


def file_identity(info):
    return (
        info.st_dev,
        info.st_ino,
        info.st_uid,
        info.st_mode,
        info.st_nlink,
        info.st_size,
        info.st_mtime_ns,
        info.st_ctime_ns,
    )


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate transition JSON key")
        result[key] = value
    return result


def reject_constant(value):
    raise ValueError("Non-finite transition JSON value")


def finite_float(value):
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("Non-finite transition JSON value")
    return result


def read_plan(state, name):
    """Read a bounded private regular file without following links or opening FIFOs."""
    directory = plan_directory(state, name)
    with ExitStack() as stack:
        folder = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        stack.callback(os.close, folder)
        directory_info = os.fstat(folder)
        if directory_info.st_uid != os.getuid() or directory_info.st_mode & 0o077:
            raise ValueError("Transition directory must be private and owned")
        info = os.stat("transition.json", dir_fd=folder, follow_symlinks=False)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid()
            or info.st_mode & 0o077
            or info.st_nlink != 1
            or not 0 < info.st_size <= MAX_PLAN_BYTES
        ):
            raise ValueError(
                "Transition file must be a bounded private owned regular file"
            )
        fd = os.open(
            "transition.json",
            os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
            dir_fd=folder,
        )
        with os.fdopen(fd, "rb") as stream:
            if file_identity(os.fstat(stream.fileno())) != file_identity(info):
                raise ValueError("Transition file changed while opening")
            payload = stream.read(MAX_PLAN_BYTES + 1)
            if len(payload) != info.st_size or file_identity(
                os.fstat(stream.fileno())
            ) != file_identity(info):
                raise ValueError("Transition file changed while reading")
        if file_identity(
            os.stat("transition.json", dir_fd=folder, follow_symlinks=False)
        ) != file_identity(info):
            raise ValueError("Transition file changed while reading")
    value = json.loads(
        payload.decode("utf-8"),
        object_pairs_hook=unique_object,
        parse_constant=reject_constant,
        parse_float=finite_float,
    )
    return value, (
        directory_info.st_dev,
        directory_info.st_ino,
        file_identity(info),
        digest(payload),
    )


def write_plan(output, plan):
    """Publish a complete private file exclusively; never replace existing output."""
    serialized = encoded(plan)
    if len(serialized) > MAX_PLAN_BYTES:
        raise ValueError("Transition file exceeds its size limit")
    output.mkdir(mode=0o700)
    created = []
    try:
        for name, payload in (
            (".gitignore", b"*\n"),
            ("transition.json", serialized),
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


def current_plan(root, fork, state, helm="helm"):
    """Rebuild from current publication and observed settings, not stored evidence."""
    with transition_stage("publication_verification"):
        publication = deployment.verified_release(
            root, fork, helm, verify_public_manifests=True
        )
    values = {}
    with transition_stage("runtime_preservation"):
        observed = runtime.preflight(
            state,
            fork,
            helm,
            review_preservation=True,
            published_files=publication[1],
            prepared_values=values,
        )
    with transition_stage("plan_rendering"):
        plan = build_plan(fork, publication, observed, values, helm)
    with transition_stage("publication_revalidation"):
        if (
            deployment.verified_release(root, fork, helm, verify_public_manifests=True)
            != publication
        ):
            raise ValueError("Publisher or image receipts changed during preparation")
    return plan


def public_report(plan, name):
    """Keep private values and rendered objects out of stdout in both commands."""
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


def prepare(root, fork, state, name, helm="helm"):
    with transition_stage("output_path_check"):
        output = output_path(state, name)
    plan = current_plan(root, fork, state, helm)
    # The private file is an observation, not a reusable deployment approval.
    # Applying it will require fresh source/runtime and migration/backup checks.
    with transition_stage("plan_write"):
        write_plan(output, plan)
    return public_report(plan, name)


def verify_saved(root, fork, state, name, helm="helm"):
    with transition_stage("saved_plan_read"):
        saved, identity = read_plan(state, name)
    with transition_stage("saved_plan_identity"):
        settings = runtime.cluster.load_settings(state)
        if (
            not isinstance(saved, dict)
            or saved.get("schema") != "msa-gitops-transition-v1"
            or saved.get("status") != "PREPARED_NOT_APPLIED"
            or saved.get("repository") != fork.repository
            or settings["repository"].lower() != fork.repository.lower()
            or saved.get("stateId") != settings["stateId"]
            or not deployment.valid_sha(saved.get("sourceSha"))
            or type(saved.get("publisherRunId")) is not int
            or saved["publisherRunId"] <= 0
            or not isinstance(saved.get("generatedAt"), str)
            or datetime.fromisoformat(saved["generatedAt"]).utcoffset() is None
        ):
            raise ValueError("Stored transition identity is invalid")
    fresh = current_plan(root, fork, state, helm)
    # Recomputed file hashes alone cannot establish trust: compare every field
    # against new verified inputs. Canonical JSON preserves bool/int distinctions.
    with transition_stage("plan_comparison"):
        changes = changed_sections(saved, fresh)
        if changes:
            raise TransitionFailure("plan_comparison", changed_sections=changes)
    with transition_stage("state_revalidation"):
        if runtime.cluster.load_settings(state) != settings:
            raise ValueError("Local state changed during verification")
    with transition_stage("saved_plan_revalidation"):
        if read_plan(state, name)[1] != identity:
            raise ValueError("Transition file changed during verification")
    return public_report(fresh, name) | {
        "status": "REVALIDATED_NOT_APPLIED",
        "savedPlanMatched": True,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument(
        "--output-name",
        required=True,
        help="Named gitops-transition-... child of state",
    )
    parser.add_argument(
        "--verify",
        action="store_true",
        help="Revalidate an existing file without rewriting or applying it",
    )
    parser.add_argument("--branch")
    parser.add_argument("--helm", default="helm")
    args = parser.parse_args()
    fork = None
    try:
        root = Path(__file__).resolve().parents[3]
        with transition_stage("repository_identity"):
            fork = from_origin(root, branch=args.branch).require_personal_publish()
        action = verify_saved if args.verify else prepare
        report = action(root, fork, args.state_dir, args.output_name, args.helm)
    except Exception as error:  # noqa: BLE001 - external output may contain local values
        cause = (
            error.__cause__ or error if isinstance(error, TransitionFailure) else error
        )
        report = {
            "schema": "msa-gitops-transition-v1",
            "status": "BLOCKED",
            "reason": "transition_verification_failed"
            if args.verify
            else "transition_preparation_failed",
            "errorType": type(cause).__name__,
            "configurationValuesIncluded": False,
            "deploymentAuthorized": False,
            "servicesChanged": False,
            "databaseChanged": False,
        }
        if isinstance(error, TransitionFailure):
            report["failureStage"] = error.stage
            if error.changed_sections:
                report["changedSections"] = error.changed_sections
        if isinstance(cause, subprocess.TimeoutExpired):
            report["failureKind"] = "external_command_timeout"
        elif isinstance(cause, subprocess.CalledProcessError):
            report["failureKind"] = "external_command_failed"
        if isinstance(
            cause, (subprocess.TimeoutExpired, subprocess.CalledProcessError)
        ):
            tool = (
                Path(cause.cmd[0]).name.lower().removesuffix(".exe")
                if isinstance(cause.cmd, (tuple, list))
                and cause.cmd
                and isinstance(cause.cmd[0], str)
                else "unknown"
            )
            report["externalTool"] = (
                tool if tool in {"gh", "git", "helm", "kubectl"} else "unknown"
            )
        if fork is not None and str(cause).startswith(
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
