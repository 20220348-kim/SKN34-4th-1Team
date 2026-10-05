"""Activate the owned kind/Compose Ops connection using local development images."""

import argparse
import base64
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID, uuid4

import ops_bridge
import yaml
from connected_runtime import quiet
from fork_cluster import (
    REPOSITORY_ROOT,
    STATE,
    commands,
    load_image,
    load_settings,
    locked,
    render_services,
    require_dev,
    run,
    write_json,
)
from ops_migration import run_migration

PROFILE = "ops-activation.json"
BRIDGE = "ops-bridge.json"


def require_bootstrap_ops(state, containers=None):
    """Keep connected Ops upgrades on the migration/release/drain checked path."""
    profile = Path(state) / PROFILE
    connected = profile.exists() or profile.is_symlink()
    if containers is not None:
        # Missing, indirect, duplicate or image-default URLs cannot prove this is
        # the disabled bootstrap runtime. Explicit env takes precedence over envFrom.
        connected = connected or not containers or any(
            [item for item in container.get("env", []) if item.get("name") == "PREFECT_API_URL"]
            != [{"name": "PREFECT_API_URL", "value": "http://disabled-prefect.invalid/api"}]
            for container in containers
        )
    if connected:
        raise ValueError(
            "Ops is connected or its connection state is unverified; use ops_runtime.py "
            "--preflight and the explicit --ops-image upgrade path instead of up/dev.py. "
            "Do not delete activation records to bypass this check."
        )


def connection(settings, project):
    return {
        "schemaVersion": 1,
        "repository": settings["repository"],
        "stateId": settings["stateId"],
        "namespace": settings["namespace"],
        "composeProject": project,
    }


def read_connection(path, settings):
    if path.is_symlink():
        raise ValueError("Ops connection must not be a symlink")
    record = json.loads(path.read_text(encoding="utf-8"))
    project = record.get("composeProject", "")
    if (
        not isinstance(project, str)
        or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,62}", project)
        or record != connection(settings, project)
    ):
        raise ValueError(
            "Ops connection belongs to another repository, state or namespace"
        )
    return record


def upgrade_preflight(state, settings):
    require_dev(state, settings)
    record = read_connection(Path(state) / BRIDGE, settings)
    ops_bridge.connect(state, settings, record["composeProject"], check=True)
    _, nk, _ = commands(state, settings)
    # Execute the reviewed checkout's probe against the existing image/schema.
    # It only imports stable models/client code; no file is installed in the Pod.
    program = Path(__file__).with_name("ops_upgrade_probe.py").read_text()
    result = json.loads(
        quiet(
            nk
            + [
                "exec",
                "-i",
                "deployment/ops-service",
                "-c",
                "ops-service",
                "--",
                "python",
                "-",
            ],
            data=program,
        )
    )
    if (
        not isinstance(result, dict)
        or type(result.get("schemaVersion")) is not int
        or result.get("schemaVersion") != 4
        or result.get("scope") != "ops_upgrade_preflight"
        or result.get("status") not in {"PASS", "BLOCKED", "UNKNOWN"}
        or type(result.get("admission_blocked")) is not bool
        or type(result.get("admission_supported")) is not bool
        or result.get("backup_verified") is not False
        or result.get("evaluation_executed") is not False
    ):
        raise ValueError("Incomplete Ops upgrade preflight response")
    if result["status"] == "PASS":
        checks = result.get("checks", {})
        expected = {
            "unsettled_evaluations",
            "open_reservations",
            "unfinished_flows",
            "active_schedules",
            "unpaused_ops_schedules",
            "unsettled_schedule_occurrences",
            "inspected_flows",
            "open_admission",
        }
        if (
            not isinstance(checks, dict)
            or set(checks) != expected
            or any(
                type(value) is not int
                or value < 0
                or (key != "inspected_flows" and value != 0)
                for key, value in checks.items()
            )
        ):
            raise ValueError("Incomplete Ops upgrade preflight checks")
        if not result["admission_supported"] or not result["admission_blocked"]:
            raise ValueError(
                "Ops upgrade requires supported and paused admission control"
            )
        if (
            type(result.get("admission_version")) is not int
            or result["admission_version"] < 1
        ):
            raise ValueError("Incomplete Ops upgrade admission version")
    return result


def read_artifact_token(path):
    path = Path(path)
    info = path.lstat()
    if (
        not stat.S_ISREG(info.st_mode)
        or (hasattr(os, "getuid") and info.st_uid != os.getuid())
        or (os.name != "nt" and stat.S_IMODE(info.st_mode) != 0o600)
    ):
        raise ValueError("Use your regular private mode-0600 artifact env file")
    entries = []
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r"\s*LLMOPS_ARTIFACT_TOKEN=(\S+)\s*", line)
        if match:
            entries.append(match[1])
    if len(entries) != 1 or not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", entries[0]):
        raise ValueError(
            "Expected one literal LLMOPS_ARTIFACT_TOKEN in the artifact env file"
        )
    return entries[0]


def prepare_secret(nk, token):
    resource = json.loads(quiet(nk + ["get", "secret", "ops-runtime", "-o", "json"]))
    metadata = resource.get("metadata", {})
    data = resource.get("data", {})
    if (
        not metadata.get("resourceVersion")
        or resource.get("immutable")
        or any(not data.get(key) for key in ("DJANGO_SECRET_KEY", "DB_PASSWORD"))
        or any(
            key.startswith("argocd.argoproj.io/")
            for field in ("labels", "annotations")
            for key in metadata.get(field, {})
        )
    ):
        raise ValueError("Existing Ops Secret is incomplete, immutable or Argo-managed")
    encoded = base64.b64encode(token.encode()).decode()
    if data.get("LLMOPS_ARTIFACT_TOKEN") not in (None, encoded):
        raise ValueError(
            "Existing artifact token differs; explicit token rotation is required"
        )
    if data.get("LLMOPS_ARTIFACT_TOKEN") == encoded:
        return None
    # Compare-and-swap only this key; never replace or regenerate DB/Django credentials.
    return {
        "metadata": {"resourceVersion": metadata["resourceVersion"]},
        "data": {"LLMOPS_ARTIFACT_TOKEN": encoded},
    }


def verify_artifact_token(settings, project, token):
    snapshot = ops_bridge.topology(settings, project)
    program = (
        "import sys,json; from urllib.request import Request,build_opener,ProxyHandler; "
        "token=sys.stdin.read(); "
        "response=build_opener(ProxyHandler({})).open(Request("
        "'http://127.0.0.1:8010/v1/status',headers={'Authorization':'Bearer '+token}),timeout=3); "
        "assert json.load(response)=={'schema_version':1,'results_readable':True}"
    )
    quiet(
        [
            "docker",
            "exec",
            "-i",
            snapshot["containers"]["ops-artifacts"],
            "python",
            "-c",
            program,
        ],
        token,
    )


def evaluation_runner(project):
    """Select one private runner from the connected Compose project."""
    identities = run(
        [
            "docker",
            "ps",
            "--filter",
            "label=com.docker.compose.project=" + project,
            "--filter",
            "label=com.docker.compose.service=evaluation-runner",
            "--format",
            "{{.ID}}",
        ],
        capture=True,
    ).split()
    if len(identities) != 1:
        raise ValueError("Expected exactly one running Compose evaluation-runner")
    runner = ops_bridge.inspect_container(identities[0])
    labels = runner.get("Labels") or {}
    if (
        runner.get("Running") is not True
        or labels.get("com.docker.compose.project") != project
        or labels.get("com.docker.compose.service") != "evaluation-runner"
        or str(labels.get("com.docker.compose.oneoff", "false")).lower() != "false"
        or runner.get("Ports")
    ):
        raise ValueError("Evaluation runner ownership or private runtime changed")
    return runner


def verify_release(image, project):
    """Compare the selected image with the owned free runner; never emit credentials."""
    runner = evaluation_runner(project)
    identity = run(
        ["docker", "image", "inspect", image, "--format", "{{.Id}}"], capture=True
    ).strip()
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", identity):
        raise ValueError("Expected a local Ops image identity")
    digest = "import hashlib; from pathlib import Path; "
    image_hash = quiet(
        [
            "docker",
            "run",
            "--rm",
            "--pull=never",
            "--network=none",
            "--read-only",
            "--memory=128m",
            "--cpus=0.5",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges:true",
            "--entrypoint=python",
            identity,
            "-c",
            digest
            + "print(hashlib.sha256(Path('/app/apps/evaluations/execution_release.json').read_bytes()).hexdigest())",
        ]
    ).strip()
    runner_result = json.loads(
        quiet(
            [
                "docker",
                "exec",
                runner["Id"],
                "/app/backend/ai-service/.venv/bin/python",
                "-c",
                digest + "import os,json; print(json.dumps({"
                "'release':hashlib.sha256(Path('/app/backend/ops-service/apps/evaluations/execution_release.json').read_bytes()).hexdigest(),"
                "'free':os.environ.get('LLMOPS_LIVE_ENABLED','').lower()=='false' and not os.environ.get('OPENAI_API_KEY')"
                "}))",
            ]
        )
    )
    if (
        not re.fullmatch(r"[a-f0-9]{64}", image_hash)
        or runner_result.get("release") != image_hash
        or runner_result.get("free") is not True
    ):
        raise ValueError(
            "Ops and runner execution releases differ or runner is not free-only"
        )
    return {"imageId": identity, "runnerId": runner["Id"], "releaseSha256": image_hash}


def check_runtime(state, settings, run_id=None, *, expected_image=None):
    """Read source/runtime releases and readiness without applying or executing work."""
    require_dev(state, settings)
    state = Path(state)
    record = read_connection(state / PROFILE, settings)
    if read_connection(state / BRIDGE, settings) != record:
        raise ValueError("Active Ops and bridge projects differ")
    project = record["composeProject"]
    ops_bridge.connect(state, settings, project, check=True)
    baseline_path = state / "baseline.json"
    if baseline_path.is_symlink() or (state / "dev-images.json").exists():
        raise ValueError(
            "Inspect local baseline or restore development overrides first"
        )
    baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
    if baseline.get("source") != "local":
        raise ValueError("This runtime check requires a local-image baseline")
    # A paused first rollout verifies its image before updating the saved baseline.
    image = baseline["images"]["ops-service"] if expected_image is None else expected_image
    if not re.fullmatch(
        r"govbiz-ops-service:[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}", image
    ) or image.endswith(":latest"):
        raise ValueError("Expected a tagged local govbiz-ops-service image")
    source = (
        REPOSITORY_ROOT / "backend/ops-service/apps/evaluations/execution_release.json"
    )
    if source.is_symlink():
        raise ValueError("Source execution release must not be a symlink")
    run(
        [
            sys.executable,
            "-B",
            source.with_name("execution_spec.py"),
            "--root",
            REPOSITORY_ROOT,
        ],
        capture=True,
    )
    expected = hashlib.sha256(source.read_bytes()).hexdigest()
    _, nk, _ = commands(state, settings)
    deployment = json.loads(
        quiet(nk + ["get", "deployment", "ops-service", "-o", "json"])
    )
    containers = deployment["spec"]["template"]["spec"]["containers"]
    if (
        [item["name"] for item in containers] != ["ops-service", "ops-sync"]
        or any(
            item["image"] != image or item.get("imagePullPolicy") != "Never"
            for item in containers
        )
        or any(
            key.startswith("argocd.argoproj.io/")
            for field in ("labels", "annotations")
            for key in deployment["metadata"].get(field, {})
        )
    ):
        raise ValueError("Ops API/sync do not match the activated local baseline")
    selector = ",".join(
        key + "=" + value
        for key, value in sorted(deployment["spec"]["selector"]["matchLabels"].items())
    )
    pods = json.loads(quiet(nk + ["get", "pods", "-l", selector, "-o", "json"]))[
        "items"
    ]
    if len(pods) != 1:
        raise ValueError("Expected one stable Ops Pod; wait for rollout")
    pod = pods[0]
    owners = [
        item
        for item in pod["metadata"].get("ownerReferences", [])
        if item.get("controller") and item["kind"] == "ReplicaSet"
    ]
    if len(owners) != 1 or pod["metadata"].get("deletionTimestamp"):
        raise ValueError("Ops Pod ownership or lifecycle changed")
    replica = json.loads(
        quiet(nk + ["get", "replicaset", owners[0]["name"], "-o", "json"])
    )
    if replica["metadata"]["uid"] != owners[0]["uid"] or not any(
        item.get("controller")
        and item["kind"] == "Deployment"
        and item["uid"] == deployment["metadata"]["uid"]
        for item in replica["metadata"].get("ownerReferences", [])
    ):
        raise ValueError("Ops Pod belongs to another Deployment")
    statuses = pod.get("status", {}).get("containerStatuses", [])
    if (
        pod.get("status", {}).get("phase") != "Running"
        or {item["name"] for item in statuses} != {"ops-service", "ops-sync"}
        or any(
            item.get("ready") is not True or not item.get("containerID")
            for item in statuses
        )
        or [
            {
                key: item.get(key)
                for key in (
                    "name",
                    "image",
                    "imagePullPolicy",
                    "env",
                    "command",
                    "args",
                )
            }
            for item in pod["spec"]["containers"]
        ]
        != [
            {
                key: item.get(key)
                for key in (
                    "name",
                    "image",
                    "imagePullPolicy",
                    "env",
                    "command",
                    "args",
                )
            }
            for item in containers
        ]
    ):
        raise ValueError("Ops API/sync Pod is not ready or its configuration differs")
    snapshot = ops_bridge.topology(settings, project)
    runner = evaluation_runner(project)
    targets = [
        (
            name,
            nk + ["exec", pod["metadata"]["name"], "-c", name, "--", "python"],
            "/app/apps/evaluations/execution_release.json",
        )
        for name in ("ops-service", "ops-sync")
    ] + [
        (
            "evaluation-runner",
            [
                "docker",
                "exec",
                runner["Id"],
                "/app/backend/ai-service/.venv/bin/python",
            ],
            "/app/backend/ops-service/apps/evaluations/execution_release.json",
        ),
        (
            "ops-artifacts",
            ["docker", "exec", snapshot["containers"]["ops-artifacts"], "python"],
            "/app/apps/evaluations/execution_release.json",
        ),
    ]
    for name, command, path in targets:
        program = (
            "import hashlib,json,os; from pathlib import Path; print(json.dumps({'release':hashlib.sha256(Path("
            + repr(path)
            + ").read_bytes()).hexdigest(),'free':os.environ.get('LLMOPS_LIVE_ENABLED','').lower()=='false' and not os.environ.get('OPENAI_API_KEY')}))"
        )
        result = json.loads(quiet(command + ["-c", program]))
        if result.get("release") != expected:
            raise ValueError(
                "Execution release differs from this checkout: "
                + name
                + "; rebuild and update matching Ops, runner and artifacts"
            )
        if name != "ops-artifacts" and result.get("free") is not True:
            raise ValueError("Runtime is not free-only: " + name)
    selected_run = None if run_id is None else str(UUID(str(run_id)))
    program = (
        "import os,json; os.environ.setdefault('DJANGO_SETTINGS_MODULE','config.settings'); "
        "import django; django.setup(); from apps.health.schema import schema_is_ready; "
        "from apps.evaluations.runtime_checks import inspect_runtime; "
        "print(json.dumps({'schema_ready':schema_is_ready(),'runtime':inspect_runtime("
        + repr(selected_run)
        + ")}))"
    )
    diagnostics = json.loads(quiet(targets[0][1] + ["-c", program]))
    if (
        diagnostics.get("schema_ready") is not True
        or diagnostics.get("runtime", {}).get("status") != "PASS"
        or diagnostics["runtime"].get("storage_transport") != "http"
    ):
        raise ValueError("Ops database schema or evaluation configuration is not ready")
    latest = json.loads(
        quiet(nk + ["get", "pod", pod["metadata"]["name"], "-o", "json"])
    )
    latest_deployment = json.loads(
        quiet(nk + ["get", "deployment", "ops-service", "-o", "json"])
    )
    if (
        latest["metadata"]["uid"] != pod["metadata"]["uid"]
        or latest["metadata"].get("deletionTimestamp")
        or latest.get("status", {}).get("containerStatuses") != statuses
        or latest_deployment["metadata"]["uid"] != deployment["metadata"]["uid"]
        or latest_deployment["spec"] != deployment["spec"]
        or ops_bridge.topology(settings, project) != snapshot
        or evaluation_runner(project)["Id"] != runner["Id"]
        or hashlib.sha256(source.read_bytes()).hexdigest() != expected
        or json.loads(baseline_path.read_text(encoding="utf-8")) != baseline
    ):
        raise ValueError("Runtime or source changed during the read-only check; retry")
    ops_bridge.connect(state, settings, project, check=True)
    return {
        "status": "PASS",
        "scope": "local_ops_release_and_configuration",
        "release_sha256": expected,
        "checked_components": [item[0] for item in targets],
        "pod_uid": pod["metadata"]["uid"],
        **diagnostics,
        "evaluation_executed": False,
        "core_admin_auth_verified": False,
    }


def activate(
    state, settings, artifact_env, helm="helm", *, ops_image=None, kind="kind"
):
    require_dev(state, settings)
    state = Path(state)
    if (state / "dev-images.json").exists():
        raise ValueError("Restore development image overrides before activating Ops")
    baseline_path = state / "baseline.json"
    if baseline_path.is_symlink():
        raise ValueError("Local baseline must not be a symlink")
    baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
    if baseline.get("source") != "local":
        raise ValueError(
            "Ops activation requires a local-image baseline; published inputs cannot use local overrides"
        )
    record = read_connection(state / BRIDGE, settings)
    values_path = state / "ops-bridge-values.json"
    if (
        values_path.is_symlink()
        or json.loads(values_path.read_text()) != ops_bridge.values()
    ):
        raise ValueError("Bridge values changed; run ops_bridge.py connect again")
    project = record["composeProject"]
    ops_bridge.connect(state, settings, project, check=True)
    kube, nk, _ = commands(state, settings)
    current = json.loads(
        run(nk + ["get", "deployment", "ops-service", "-o", "json"], capture=True)
    )
    containers = current["spec"]["template"]["spec"]["containers"]
    previous_image = baseline["images"]["ops-service"]
    image = previous_image if ops_image is None else ops_image
    images = {**baseline["images"], "ops-service": image}
    if not re.fullmatch(
        r"govbiz-ops-service:[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}", image
    ) or image.endswith(":latest"):
        raise ValueError("Expected a tagged local govbiz-ops-service image")
    if (
        [item["name"] for item in containers]
        not in (["ops-service"], ["ops-service", "ops-sync"])
        or any(
            item["image"] not in {previous_image, image}
            or item.get("imagePullPolicy") != "Never"
            for item in containers
        )
        or len({item["image"] for item in containers}) != 1
        or any(
            key.startswith("argocd.argoproj.io/")
            for field in ("labels", "annotations")
            for key in current.get("metadata", {}).get(field, {})
        )
    ):
        raise ValueError("Current Ops workload does not match the local baseline")
    rendered = render_services(
        helm,
        images,
        overlay={"ops-service": ops_bridge.values()},
        services=("ops-service",),
    )["ops-service"]
    resources = list(yaml.safe_load_all(rendered))
    desired = next(item for item in resources if item["kind"] == "Deployment")
    expected_env = {
        item["name"]: item
        for item in desired["spec"]["template"]["spec"]["containers"][0]["env"]
    }
    for container in containers:
        actual_env = {item["name"]: item for item in container.get("env", [])}
        if any(
            actual_env.get(key) != expected_env[key]
            for key in (
                "DB_HOST",
                "DB_PORT",
                "DB_NAME",
                "DB_USER",
                "DB_PASSWORD",
                "DJANGO_SECRET_KEY",
            )
        ):
            raise ValueError(
                "Current Ops database or credential references differ; refusing to switch databases"
            )
    release = verify_release(image, project)
    if ops_image is not None:
        load_image(SimpleNamespace(kind=kind), settings, image, state)
    token = read_artifact_token(artifact_env)
    patch = prepare_secret(nk, token)
    verify_artifact_token(settings, project, token)
    require_dev(state, settings)
    ops_bridge.connect(state, settings, project, check=True)
    if verify_release(image, project) != release:
        raise ValueError("Ops image or runner changed during activation preflight")
    preflight = None
    # Only the explicit disabled bootstrap value can skip this guard. An absent
    # variable may inherit an image default; an indirect Secret value is unknown.
    bootstrap = all(
        [item for item in container.get("env", []) if item["name"] == "PREFECT_API_URL"]
        == [{"name": "PREFECT_API_URL", "value": "http://disabled-prefect.invalid/api"}]
        for container in containers
    )
    if (state / PROFILE).exists() or (state / PROFILE).is_symlink() or not bootstrap:
        if (state / PROFILE).exists() or (state / PROFILE).is_symlink():
            read_connection(state / PROFILE, settings)
        preflight = upgrade_preflight(state, settings)
        if preflight["status"] != "PASS":
            raise ValueError(
                "Ops upgrade preflight did not pass; run --preflight, verify supported "
                "and paused admission control, and drain outstanding work"
            )
    latest = json.loads(
        run(nk + ["get", "deployment", "ops-service", "-o", "json"], capture=True)
    )
    if (
        latest != current
        or json.loads(baseline_path.read_text(encoding="utf-8")) != baseline
    ):
        raise ValueError("Ops workload or baseline changed during activation preflight")
    desired["metadata"]["resourceVersion"] = current["metadata"]["resourceVersion"]
    journal_dir = state / "ops-updates"
    if journal_dir.is_symlink():
        raise ValueError("Ops update journal must not be a symlink")
    journal = journal_dir / (str(uuid4()) + ".json")
    attempt = {
        "schemaVersion": 1,
        **record,
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "status": "RUNNING",
        "upgradePreflight": preflight,
        "previousImage": previous_image,
        "targetImage": image,
        "targetImageId": release["imageId"],
        "releaseSha256": release["releaseSha256"],
        "stages": {},
        "evaluationExecuted": False,
        "adminAuthVerified": False,
        "automaticImageRollback": False,
        "automaticDatabaseRestore": False,
    }
    # Persist before mutations. An interrupted RUNNING stage has an unknown outcome;
    # neither a lost API response nor a completed migration implies DB rollback.
    write_json(journal, attempt)

    def stage(name, action):
        attempt["stages"][name] = "RUNNING"
        write_json(journal, attempt)
        action()
        attempt["stages"][name] = "COMPLETED"
        write_json(journal, attempt)

    try:
        if patch:
            stage(
                "artifact_secret",
                lambda: quiet(
                    nk
                    + [
                        "patch",
                        "secret",
                        "ops-runtime",
                        "--type=merge",
                        "--patch-file=/dev/stdin",
                    ],
                    json.dumps(patch),
                ),
            )
        for job in (item for item in resources if item["kind"] == "Job"):
            stage("migration", lambda job=job: run_migration(job, kube, nk, run))
        stage(
            "workload_apply",
            lambda: run(
                kube
                + ["apply", "--server-side", "--field-manager=govbiz-local", "-f", "-"],
                data=yaml.safe_dump_all(
                    item for item in resources if item["kind"] != "Job"
                ),
            ),
        )
        stage(
            "rollout",
            lambda: run(
                nk + ["rollout", "status", "deployment/ops-service", "--timeout=600s"]
            ),
        )
        stage(
            "runtime_check",
            lambda: run(
                nk
                + [
                    "exec",
                    "deployment/ops-service",
                    "-c",
                    "ops-service",
                    "--",
                    "python",
                    "manage.py",
                    "check_evaluation_runtime",
                ],
                capture=True,
            ),
        )
        if json.loads(baseline_path.read_text(encoding="utf-8")) != baseline:
            raise ValueError(
                "Ops baseline changed; runtime is applied but success was not recorded"
            )
        if ops_image is not None:
            stage(
                "baseline_record",
                lambda: write_json(baseline_path, {**baseline, "images": images}),
            )
        stage("activation_record", lambda: write_json(state / PROFILE, record))
        attempt["status"] = "ACTIVATED"
        write_json(journal, attempt)
    except BaseException as error:
        attempt["status"] = "FAILED"
        # Never store exception text: subprocess failures may include sensitive input.
        attempt["errorType"] = type(error).__name__
        try:
            write_json(journal, attempt)
        except OSError:
            raise ValueError(
                "Ops activation failed and journal persistence is unconfirmed; inspect DB and workloads"
            ) from None
        raise
    print(
        "Ops activation journal: "
        + str(journal)
        + "; activation does not verify a new evaluation or administrator authentication."
    )
    print(
        "Ops API + sync activated; credentials preserved and runtime checked. Run a new free evaluation to verify execution."
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, default=STATE)
    parser.add_argument("--artifact-env", type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--check",
        action="store_true",
        help="Read source/runtime releases, schema and connection without activation",
    )
    mode.add_argument(
        "--preflight",
        action="store_true",
        help="Read admission control, outstanding evaluations, reservations, Prefect runs and schedules",
    )
    parser.add_argument(
        "--run-id",
        type=UUID,
        help="With --check, verify an existing completed evaluation",
    )
    parser.add_argument("--helm", default="helm")
    parser.add_argument(
        "--ops-image",
        help="Explicit tagged local Ops image; update only Ops after checks and migration",
    )
    parser.add_argument("--kind", default="kind")
    args = parser.parse_args()
    if (args.check or args.preflight) and (
        args.artifact_env is not None or args.ops_image is not None
    ):
        parser.error("Read-only checks cannot be combined with activation inputs")
    if args.run_id is not None and not args.check:
        parser.error("--run-id requires --check")
    if not (args.check or args.preflight) and args.artifact_env is None:
        parser.error("Activation requires --artifact-env; --run-id requires --check")
    if os.name == "nt":
        parser.error(
            "Run activation inside WSL2 with Linux Python, as for fork_cluster.py"
        )
    try:
        settings = load_settings(args.state_dir)
        with locked(args.state_dir):
            if args.preflight:
                result = upgrade_preflight(args.state_dir, settings)
                print(json.dumps(result, sort_keys=True))
                if result["status"] != "PASS":
                    parser.exit(1)
                return
            if args.check:
                print(
                    json.dumps(
                        check_runtime(args.state_dir, settings, args.run_id),
                        sort_keys=True,
                    )
                )
                return
            activate(
                args.state_dir,
                settings,
                args.artifact_env,
                args.helm,
                ops_image=args.ops_image,
                kind=args.kind,
            )
    except (
        ValueError,
        KeyError,
        TypeError,
        OSError,
        subprocess.SubprocessError,
    ) as error:
        message = str(error) if isinstance(error, ValueError) else type(error).__name__
        parser.exit(
            1,
            "Ops "
            + (
                "preflight"
                if args.preflight
                else "runtime check"
                if args.check
                else "activation"
            )
            + " stopped: "
            + message
            + "\n",
        )


if __name__ == "__main__":
    main()
