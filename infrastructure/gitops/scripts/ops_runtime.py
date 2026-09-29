"""Activate the owned kind/Compose Ops connection using local development images."""

import argparse
import base64
import json
import os
import re
import stat
import subprocess
from pathlib import Path

import ops_bridge
import yaml
from connected_runtime import quiet
from fork_cluster import (
    STATE,
    commands,
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


def load_overlay(state, settings):
    path = Path(state) / PROFILE
    if not path.exists() and not path.is_symlink():
        return {}
    read_connection(path, settings)
    return {"ops-service": ops_bridge.values()}


def check_connection(state, settings):
    record = read_connection(Path(state) / PROFILE, settings)
    ops_bridge.connect(state, settings, record["composeProject"], check=True)


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


def activate(state, settings, artifact_env, helm="helm"):
    require_dev(state, settings)
    state = Path(state)
    if (state / "dev-images.json").exists():
        raise ValueError("Restore development image overrides before activating Ops")
    baseline = json.loads((state / "baseline.json").read_text(encoding="utf-8"))
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
    image = baseline["images"]["ops-service"]
    if not re.fullmatch(
        r"govbiz-ops-service:[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}", image
    ) or image.endswith(":latest"):
        raise ValueError("Expected a tagged local govbiz-ops-service image")
    if (
        [item["name"] for item in containers]
        not in (["ops-service"], ["ops-service", "ops-sync"])
        or any(
            item["image"] != image or item.get("imagePullPolicy") != "Never"
            for item in containers
        )
        or any(
            key.startswith("argocd.argoproj.io/")
            for field in ("labels", "annotations")
            for key in current.get("metadata", {}).get(field, {})
        )
    ):
        raise ValueError("Current Ops workload does not match the local baseline")
    rendered = render_services(
        helm,
        baseline["images"],
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
    token = read_artifact_token(artifact_env)
    patch = prepare_secret(nk, token)
    verify_artifact_token(settings, project, token)
    require_dev(state, settings)
    ops_bridge.connect(state, settings, project, check=True)
    if patch:
        quiet(
            nk
            + [
                "patch",
                "secret",
                "ops-runtime",
                "--type=merge",
                "--patch-file=/dev/stdin",
            ],
            json.dumps(patch),
        )
    for job in (item for item in resources if item["kind"] == "Job"):
        run_migration(job, kube, nk, run)
    run(
        kube + ["apply", "--server-side", "--field-manager=govbiz-local", "-f", "-"],
        data=yaml.safe_dump_all(item for item in resources if item["kind"] != "Job"),
    )
    run(nk + ["rollout", "status", "deployment/ops-service", "--timeout=600s"])
    run(
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
    )
    write_json(state / PROFILE, record)
    print(
        "Ops API + sync activated; credentials preserved and runtime checked. Run a new free evaluation to verify execution."
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, default=STATE)
    parser.add_argument("--artifact-env", type=Path, required=True)
    parser.add_argument("--helm", default="helm")
    args = parser.parse_args()
    if os.name == "nt":
        parser.error(
            "Run activation inside WSL2 with Linux Python, as for fork_cluster.py"
        )
    try:
        settings = load_settings(args.state_dir)
        with locked(args.state_dir):
            activate(args.state_dir, settings, args.artifact_env, args.helm)
    except (
        ValueError,
        KeyError,
        TypeError,
        OSError,
        subprocess.SubprocessError,
    ) as error:
        message = str(error) if isinstance(error, ValueError) else type(error).__name__
        parser.exit(1, "Ops activation stopped: " + message + "\n")


if __name__ == "__main__":
    main()
