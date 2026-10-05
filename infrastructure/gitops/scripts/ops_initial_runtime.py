"""Roll out matching free Ops/Compose images after a verified first migration.

Default: verify only. Explicit execution keeps admission paused, preserves named stores,
and records partial failures without automatic image rollback or database restore.
"""

import argparse
import base64
import hashlib
import inspect
import io
import json
import os
import re
import stat
import sys
import time
from contextlib import redirect_stdout
from pathlib import Path
from uuid import UUID

import ops_initial_migration as initial
import ops_runtime as runtime
from ops_db_upgrade_probe import source_digest

database = initial.database
cluster = initial.cluster
storage = database.storage
SERVICES = ("ops-artifacts", "evaluation-runner")
PREFECT_HEALTH_PROBE = """import http.client
connection = http.client.HTTPConnection('127.0.0.1', 4200, timeout=2)
try:
    connection.request('GET', '/api/health')
    ready = connection.getresponse().status == 200
except (OSError, http.client.HTTPException):
    ready = False
finally:
    connection.close()
print('READY' if ready else 'NOT_READY')
"""


def read_migration(state, request_id, settings):
    path = (
        Path(state) / "ops-initial-migrations" / (str(UUID(str(request_id))) + ".json")
    )
    info = path.lstat()
    if (
        path.parent.is_symlink()
        or not stat.S_ISREG(info.st_mode)
        or info.st_mode & 0o077
        or info.st_nlink != 1
        or info.st_uid != os.getuid()
    ):
        raise ValueError("Use the private original migration journal")
    report = json.loads(path.read_text(encoding="utf-8"))
    if (
        report.get("schema_version") != 1
        or report.get("scope") != "ops_initial_migration"
        or report.get("status") != "MIGRATED_PAUSED"
        or report.get("stage") != "completed"
        or report.get("state_id") != settings["stateId"]
        or report.get("pause", {}).get("request_id") != str(UUID(str(request_id)))
        or report.get("original_database_migration_attempted") is not True
        or report.get("admission_paused") is not True
        or report.get("writers_resumed") is not False
        or not isinstance(report.get("frozen_source"), dict)
        or not re.fullmatch(r"[a-f0-9]{64}", report.get("deployment_spec_sha256", ""))
    ):
        raise ValueError("A completed, still-paused first migration is required")
    return report


def require_loaded_image(state, settings, record):
    path = Path(state) / "loaded-images.json"
    if path.is_symlink():
        raise ValueError("Image load record must not be a symlink")
    ledger = json.loads(path.read_text())
    cached = ledger["images"].get(record["target_image"], {})
    if (
        any(
            ledger.get(key) != settings[key]
            for key in ("repository", "cluster", "stateId")
        )
        or cached.get("dockerId") != record["target_image_id"]
        or not cached.get("criId")
        or cluster.node_image_id(settings, record["target_image"]) != cached["criId"]
        or database.read_json(["docker", "image", "inspect", record["target_image"]])[
            0
        ]["Id"]
        != record["target_image_id"]
    ):
        raise ValueError("Migration image is no longer the verified kind image")


def require_completed_job(namespaced, record):
    job = database.read_json(
        namespaced + ["get", "job", "ops-service-migrate", "-o", "json"]
    )
    containers = job["spec"]["template"]["spec"]["containers"]
    if (
        job["metadata"].get("deletionTimestamp")
        or job.get("status", {}).get("succeeded") != 1
        or not any(
            row.get("type") == "Complete" and row.get("status") == "True"
            for row in job.get("status", {}).get("conditions", [])
        )
        or len(containers) != 1
        or containers[0].get("image") != record["target_image"]
        or containers[0].get("command") != ["python", "manage.py", "migrate_deployment"]
        or containers[0].get("args")
        != [
            "--verbosity=0",
            "--pause-request-id=" + record["pause"]["request_id"],
            "--pause-actor=" + record["pause"]["actor"],
            "--pause-reason=" + record["pause"]["reason"],
        ]
    ):
        raise ValueError("Retained migration Job does not confirm the selected pause")


def require_same_database(namespaced, source):
    pod = database.read_json(namespaced + ["get", "pod", "ops-mysql-0", "-o", "json"])
    if (
        pod["metadata"]["uid"] != source["pod_uid"]
        or pod["metadata"].get("deletionTimestamp")
        or any(
            source.get(key) != value
            for key, value in database.database_identity(namespaced, pod).items()
        )
    ):
        raise ValueError("Original MySQL identity or route changed")


def image_release(image, *, runner=False):
    if runner and not re.fullmatch(r"sha256:[a-f0-9]{64}", image):
        raise ValueError("Select the runner by immutable local image ID")
    item = database.read_json(["docker", "image", "inspect", image])[0]
    identity = item["Id"]
    if (
        not re.fullmatch(r"sha256:[a-f0-9]{64}", identity)
        or item["Config"].get("User") != "10001:10001"
    ):
        raise ValueError("Use an existing immutable non-root runtime image")
    if runner:
        python = "/app/backend/ai-service/.venv/bin/python"
        release = "/app/backend/ops-service/apps/evaluations/execution_release.json"
        program = (
            "import hashlib,subprocess,sys;from pathlib import Path;"
            "subprocess.run([sys.executable,'/app/backend/ops-service/apps/evaluations/execution_spec.py',"
            "'--root','/app'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);"
            f"print(hashlib.sha256(Path({release!r}).read_bytes()).hexdigest())"
        )
    else:
        python = "python"
        program = (
            "import hashlib;from pathlib import Path\n"
            + inspect.getsource(source_digest)
            + "\nassert not Path('/app/.env').exists()\n"
            + f"assert source_digest(Path('/app')) == {source_digest(database.REPOSITORY_ROOT / 'backend/ops-service')!r}\n"
            + "print(hashlib.sha256(Path('/app/apps/evaluations/execution_release.json').read_bytes()).hexdigest())"
        )
    digest = (
        storage.run(
            [
                "docker",
                "run",
                "--rm",
                "--pull=never",
                "--network=none",
                "--read-only",
                "--cap-drop=ALL",
                "--security-opt=no-new-privileges:true",
                "--memory=384m",
                "--pids-limit=64",
                "--tmpfs=/tmp:rw,noexec,nosuid,size=32m,mode=1777",
                "--entrypoint",
                python,
                identity,
                "-B",
                "-c",
                program,
            ]
        )
        .decode()
        .strip()
    )
    expected = hashlib.sha256(
        (
            database.REPOSITORY_ROOT
            / "backend/ops-service/apps/evaluations/execution_release.json"
        ).read_bytes()
    ).hexdigest()
    if digest != expected:
        raise ValueError("Runtime image release differs from the checked-out source")
    return {"image_id": identity, "release_sha256": digest}


def compose_definition(settings, project, items, images):
    """Preserve inspected runtime inputs; create no networks, stores or dependencies."""
    definition = {"name": project, "services": {}, "volumes": {}, "networks": {}}
    evidence_path = str(
        (database.REPOSITORY_ROOT / "evaluation/support-program-evidence").resolve()
    )
    for name in SERVICES:
        item = items[name]
        config, host = item["Config"], item["HostConfig"]
        labels = config.get("Labels") or {}
        env = storage.environment(item)
        if (
            labels.get("com.docker.compose.project") != project
            or labels.get("com.docker.compose.service") != name
            or str(labels.get("com.docker.compose.oneoff", "false")).lower() != "false"
            or config.get("User") != "10001:10001"
            or config.get("Entrypoint")
            or config.get("Healthcheck")
            or len(config["Env"]) != len(env)
            or host.get("Privileged")
            or host.get("PortBindings")
            or host.get("CapAdd")
            or host.get("Devices")
            or host.get("Sysctls")
            or host.get("ExtraHosts")
            or host.get("PidMode")
            or host.get("IpcMode") not in (None, "private")
            or not host.get("Init")
            or host.get("RestartPolicy", {}).get("Name") != "unless-stopped"
            or any(env.get(flag, "false").lower() != "false" for flag in storage.FLAGS)
            or env.get("OPENAI_API_KEY")
        ):
            raise ValueError("Unsupported or non-free Compose runtime configuration")
        base = database.read_json(["docker", "image", "inspect", item["Image"]])[0]
        defaults = dict(row.split("=", 1) for row in base["Config"].get("Env", []))
        env = {key: value for key, value in env.items() if defaults.get(key) != value}
        if name == "evaluation-runner":
            env.update({flag: "false" for flag in storage.FLAGS})
            env["OPENAI_API_KEY"] = ""
        mounts = item["Mounts"]
        results = [row for row in mounts if row["Destination"] == "/results"]
        if (
            len(results) != 1
            or results[0].get("Type") != "volume"
            or results[0].get("Name") != project + "_ops-results"
            or results[0].get("RW") is not (name == "evaluation-runner")
        ):
            raise ValueError("Result volume identity or write ownership changed")
        volumes = [
            {
                "type": "volume",
                "source": "ops-results",
                "target": "/results",
                "read_only": name == "ops-artifacts",
            }
        ]
        if name == "ops-artifacts":
            evidence = [
                row for row in mounts if row["Destination"] == "/evaluation-data"
            ]
            if (
                len(mounts) != 2
                or len(evidence) != 1
                or evidence[0].get("Type") != "bind"
                or evidence[0].get("RW") is not False
            ):
                raise ValueError(
                    "Artifact evidence must be this checkout's read-only data"
                )
            verify_evidence_mount(
                item, evidence[0]["Source"], evidence_path, images[name]
            )
            volumes.append(
                {
                    "type": "bind",
                    "source": evidence_path,
                    "target": "/evaluation-data",
                    "read_only": True,
                    "bind": {"create_host_path": False},
                }
            )
            if (
                config.get("Cmd", [])[:2]
                != ["gunicorn", "apps.evaluations.artifact_server:create_app()"]
                or host.get("ReadonlyRootfs") is not True
            ):
                raise ValueError("Unexpected artifact process or writable root")
        elif (
            len(mounts) != 1
            or config.get("Cmd")
            != [
                ".venv/bin/python",
                "/app/evaluation/support-program-evidence/ops_flow.py",
            ]
            or config.get("WorkingDir") != "/app/backend/ai-service"
        ):
            raise ValueError("Unexpected runner command, working directory or mount")
        networks = item["NetworkSettings"]["Networks"]
        required = {project + "_default"}
        if name == "ops-artifacts":
            required.add(runtime.ops_bridge.network_name(settings))
        if set(networks) != required:
            raise ValueError("Unexpected Compose network attachment")
        for network in required:
            actual = database.read_json(["docker", "network", "inspect", network])[0]
            allowed_ids = {actual["Id"]} | (
                {""} if not item["State"]["Running"] else set()
            )
            if (
                networks[network]["NetworkID"] not in allowed_ids
                or actual.get("Labels", {}).get("com.docker.compose.project") != project
            ):
                raise ValueError("Compose network ownership changed")
            definition["networks"][network] = {"external": True, "name": network}
        service = {
            "image": images[name],
            "init": True,
            "user": config["User"],
            "working_dir": config["WorkingDir"],
            "command": config["Cmd"],
            "environment": env,
            "volumes": volumes,
            "networks": {network: {} for network in sorted(required)},
            "read_only": bool(host.get("ReadonlyRootfs")),
            "restart": "unless-stopped",
            "cap_drop": host.get("CapDrop") or [],
            "security_opt": host.get("SecurityOpt") or [],
        }
        if host.get("Tmpfs"):
            service["tmpfs"] = [
                name + ":" + value for name, value in host["Tmpfs"].items()
            ]
        for source, target in (("Memory", "mem_limit"), ("PidsLimit", "pids_limit")):
            if host.get(source):
                service[target] = host[source]
        if host.get("NanoCpus"):
            service["cpus"] = host["NanoCpus"] / 1_000_000_000
        definition["services"][name] = service
    volume = database.read_json(
        ["docker", "volume", "inspect", project + "_ops-results"]
    )[0]
    if (
        volume.get("Labels", {}).get("com.docker.compose.project") != project
        or volume.get("Labels", {}).get("com.docker.compose.volume") != "ops-results"
    ):
        raise ValueError("Result store belongs to another project")
    definition["volumes"]["ops-results"] = {
        "external": True,
        "name": project + "_ops-results",
    }
    return definition


def verify_evidence_mount(item, mounted_source, evidence_path, image):
    if str(Path(mounted_source).resolve()) == evidence_path:
        return
    # Docker Desktop rewrites WSL paths. Never trust the rewritten prefix alone:
    # compare the existing mount's device/inode with a probe of ONLY repo data.
    if not item["State"]["Running"] or not re.fullmatch(
        r"/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/[^/]+/[a-f0-9]{64}",
        mounted_source,
    ):
        raise ValueError("Artifact data mount is not this checkout")
    program = (
        "import os,json,stat;s=os.stat('/evaluation-data',follow_symlinks=False);"
        "assert stat.S_ISDIR(s.st_mode);print(json.dumps([s.st_dev,s.st_ino]))"
    )
    expected = json.loads(
        storage.run(
            [
                "docker",
                "run",
                "--rm",
                "--pull=never",
                "--network=none",
                "--read-only",
                "--cap-drop=ALL",
                "--security-opt=no-new-privileges:true",
                "--mount",
                "type=bind,source="
                + evidence_path
                + ",target=/evaluation-data,readonly",
                "--entrypoint",
                "python",
                image,
                "-B",
                "-c",
                program,
            ]
        )
    )
    actual = json.loads(
        storage.run(
            [
                "docker",
                "exec",
                item["Id"],
                "python",
                "-B",
                "-c",
                program,
            ]
        )
    )
    if (
        not isinstance(expected, list)
        or len(expected) != 2
        or any(type(value) is not int or value <= 0 for value in expected)
        or actual != expected
    ):
        raise ValueError("Docker Desktop mount differs from this checkout's data")


def verify_compose_input(definition):
    escaped = compose_input(definition)
    resolved = json.loads(
        storage.run(
            [
                "docker",
                "compose",
                "--env-file",
                "/dev/null",
                "--project-name",
                definition["name"],
                "-f",
                "-",
                "config",
                "--format",
                "json",
            ],
            data=json.dumps(escaped).encode(),
        )
    )
    for name in SERVICES:
        for field in ("environment", "image", "command"):
            # `config` retains escaped dollars; Compose unescapes them at create.
            # The opt-in Docker test checks the actual container environment too.
            if resolved["services"][name][field] != escaped["services"][name][field]:
                raise ValueError(
                    "Compose interpolation changed the private runtime inputs"
                )


def compose_input(value):
    # Compose interpolates even resolved JSON; literal credentials must remain literal.
    if isinstance(value, str):
        return value.replace("$", "$$")
    if isinstance(value, dict):
        return {key: compose_input(item) for key, item in value.items()}
    if isinstance(value, list):
        return [compose_input(item) for item in value]
    return value


def service_container(project, service):
    ids = (
        storage.run(
            [
                "docker",
                "ps",
                "-aq",
                "--no-trunc",
                "--filter",
                "label=com.docker.compose.project=" + project,
                "--filter",
                "label=com.docker.compose.service=" + service,
            ]
        )
        .decode()
        .split()
    )
    if len(ids) != 1 or not re.fullmatch(r"[a-f0-9]{64}", ids[0]):
        raise ValueError("Expected exactly one owned Compose service container")
    return storage.inspect(ids[0])


def wait_prefect_ready(identity, *, timeout_seconds=120):
    """Check the pinned server's loopback API, including legacy containers without healthchecks."""
    if not re.fullmatch(r"[a-f0-9]{64}", identity) or timeout_seconds <= 0:
        raise ValueError(
            "Use a pinned Prefect container and a positive readiness timeout"
        )
    deadline = time.monotonic() + timeout_seconds

    def observation():
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ValueError("Prefect API did not become ready before the deadline")
        item = json.loads(
            storage.run(
                ["docker", "inspect", identity],
                timeout=min(5, remaining),
            )
        )[0]
        state = item["State"]
        if (
            item["Id"] != identity
            or state.get("Status") != "running"
            or state.get("Running") is not True
            or state.get("Paused")
            or state.get("Restarting")
            or state.get("Dead")
        ):
            raise ValueError("Pinned Prefect container is not stably running")
        check = item["Config"].get("Healthcheck") or {}
        configured = bool(check.get("Test") and check["Test"] != ["NONE"])
        health = (state.get("Health") or {}).get("Status")
        healthy = health == "healthy" or (not configured and health is None)
        return (state["StartedAt"], item["RestartCount"]), healthy

    started, _ = observation()
    while True:
        before, healthy = observation()
        if before != started:
            raise ValueError("Prefect restarted during readiness verification")
        if healthy:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ValueError("Prefect API did not become ready before the deadline")
            # http.client ignores proxy environment and does not follow redirects.
            # Probe only the fixed local API; never print headers, body or credentials.
            result = storage.run(
                [
                    "docker",
                    "exec",
                    identity,
                    "python",
                    "-I",
                    "-B",
                    "-c",
                    PREFECT_HEALTH_PROBE,
                ],
                timeout=min(5, remaining),
            ).strip()
            after, still_healthy = observation()
            if after != started:
                raise ValueError("Prefect restarted during readiness verification")
            if result not in {b"READY", b"NOT_READY"}:
                raise ValueError("Unexpected Prefect readiness response")
            if result == b"READY" and still_healthy:
                return
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ValueError("Prefect API did not become ready before the deadline")
        time.sleep(min(2, remaining))


def rollout(args):
    state = Path(args.state_dir)
    settings = database.load_settings(state)
    record = read_migration(state, args.migration_request_id, settings)
    source = record["frozen_source"]
    evidence = initial.source_evidence(
        settings, record["source_sha"], record["source_branch"]
    )
    namespaced, frozen = database.frozen_source(state, settings)
    if frozen != source:
        raise ValueError("Original writers or database changed after migration")
    require_completed_job(namespaced, record)
    require_loaded_image(state, settings, record)
    command = [
        *namespaced,
        "exec",
        "-i",
        "ops-mysql-0",
        "-c",
        "mysql",
        "--",
        *storage.AUTH,
    ]
    initial.verify_pause(command, record["pause"])
    database.quiet_database(command, database.inventory(command))
    deployment = database.read_json(
        namespaced + ["get", "deployment", "ops-service", "-o", "json"]
    )
    if (
        hashlib.sha256(
            json.dumps(deployment["spec"], sort_keys=True).encode()
        ).hexdigest()
        != record["deployment_spec_sha256"]
    ):
        raise ValueError("Original Deployment specification changed")
    if any(
        "valueFrom" in row or row.get("value", "false").lower() != "false"
        for container in deployment["spec"]["template"]["spec"]["containers"]
        for row in container.get("env", [])
        if row["name"] in storage.FLAGS
    ):
        raise ValueError("Only free, unscheduled Ops workloads may be resumed")
    baseline_path = state / "baseline.json"
    if baseline_path.is_symlink() or (state / "dev-images.json").exists():
        raise ValueError("Restore development overrides before the first rollout")
    baseline = json.loads(baseline_path.read_text())
    if baseline.get("source") != "local" or any(
        row["image"] != baseline["images"]["ops-service"]
        for row in deployment["spec"]["template"]["spec"]["containers"]
    ):
        raise ValueError("Current images differ from the local baseline")
    ops = image_release(record["target_image"])
    runner = image_release(args.runner_image, runner=True)
    if ops["image_id"] != record["target_image_id"]:
        raise ValueError("Migration target image changed")
    project = source["compose_project"]
    items = {name: service_container(project, name) for name in SERVICES}
    if items["evaluation-runner"]["Id"] not in source["writers"]:
        raise ValueError("Runner differs from the frozen migration source")
    images = {"ops-artifacts": ops["image_id"], "evaluation-runner": runner["image_id"]}
    definition = compose_definition(settings, project, items, images)
    verify_compose_input(definition)
    prefect_id = next(
        key for key, row in source["writers"].items() if row["service"] == "prefect"
    )
    secret = database.read_json(
        namespaced + ["get", "secret", "ops-runtime", "-o", "json"]
    )
    token = base64.b64decode(
        secret["data"]["LLMOPS_ARTIFACT_TOKEN"], validate=True
    ).decode()
    if (
        storage.environment(items["ops-artifacts"]).get("LLMOPS_ARTIFACT_TOKEN")
        != token
    ):
        raise ValueError("Artifact authentication differs from Ops")
    report = {
        "schema_version": 1,
        "scope": "ops_initial_runtime",
        "status": "VERIFIED_FOR_ROLLOUT",
        "migration_request_id": record["pause"]["request_id"],
        "state_id": settings["stateId"],
        "source_sha": record["source_sha"],
        "images": images,
        "release_sha256": ops["release_sha256"],
        "ci": evidence,
        "stages": {},
        "admission_resumed": False,
        "automatic_image_rollback": False,
        "automatic_database_restore": False,
        "evaluation_executed": False,
        "admin_auth_verified": False,
    }
    journal = state / "ops-initial-rollouts" / (record["pause"]["request_id"] + ".json")
    if journal.parent.is_symlink() or journal.exists() or journal.is_symlink():
        raise ValueError("Inspect the existing rollout journal; no automatic retry")

    def verify_frozen():
        if (
            read_migration(state, args.migration_request_id, settings) != record
            or database.frozen_source(state, settings)[1] != source
        ):
            raise ValueError("Migration record or frozen source changed")
        if (
            initial.source_evidence(
                settings, record["source_sha"], record["source_branch"]
            )
            != evidence
        ):
            raise ValueError("CI changed during rollout verification")
        if json.loads(baseline_path.read_text()) != baseline:
            raise ValueError("Local baseline changed")
        for name in SERVICES:
            if (
                service_container(project, name) != items[name]
                or database.read_json(["docker", "image", "inspect", images[name]])[0][
                    "Id"
                ]
                != images[name]
            ):
                raise ValueError("Compose runtime changed before rollout")
        initial.verify_pause(command, record["pause"])
        require_loaded_image(state, settings, record)
        require_completed_job(namespaced, record)

    verify_frozen()
    if not args.execute:
        return report
    report["status"] = "RUNNING"
    cluster.write_json(journal, report)

    def stage(name, action):
        report["stages"][name] = "RUNNING"
        cluster.write_json(journal, report)
        action()
        report["stages"][name] = "COMPLETED"
        cluster.write_json(journal, report)

    try:
        verify_frozen()
        stage("prefect_start", lambda: storage.run(["docker", "start", prefect_id]))
        stage("prefect_health", lambda: wait_prefect_ready(prefect_id))
        for service in SERVICES:
            stage(
                service + "_replace",
                lambda service=service: storage.run(
                    [
                        "docker",
                        "compose",
                        "--env-file",
                        "/dev/null",
                        "--project-name",
                        project,
                        "-f",
                        "-",
                        "up",
                        "-d",
                        "--no-deps",
                        "--no-build",
                        "--pull",
                        "never",
                        "--force-recreate",
                        service,
                    ],
                    data=json.dumps(compose_input(definition)).encode(),
                    timeout=180,
                ),
            )
        actual = {name: service_container(project, name) for name in SERVICES}
        if (
            any(
                actual[name]["Image"] != images[name]
                or not actual[name]["State"]["Running"]
                for name in SERVICES
            )
            or compose_definition(settings, project, actual, images) != definition
        ):
            raise ValueError(
                "Recreated Compose runtime differs from the verified inputs"
            )
        for identity, writer in source["writers"].items():
            if (
                writer["service"] not in {"prefect", "evaluation-runner"}
                and storage.inspect(identity)["State"]["Running"]
            ):
                raise ValueError("A previously stopped legacy writer was restarted")
        stage(
            "bridge_refresh",
            lambda: runtime.ops_bridge.connect(state, settings, project),
        )
        stage(
            "artifact_auth",
            lambda: runtime.verify_artifact_token(settings, project, token),
        )
        require_same_database(namespaced, source)
        require_loaded_image(state, settings, record)
        if (
            runtime.verify_release(record["target_image"], project)["imageId"]
            != ops["image_id"]
        ):
            raise ValueError("Ops and running runner no longer match")
        initial.verify_pause(command, record["pause"])
        current = database.read_json(
            namespaced + ["get", "deployment", "ops-service", "-o", "json"]
        )
        if current != deployment:
            raise ValueError("Stopped Deployment changed before activation")
        patch = [
            {
                "op": "test",
                "path": "/metadata/uid",
                "value": deployment["metadata"]["uid"],
            },
            {
                "op": "test",
                "path": "/metadata/resourceVersion",
                "value": deployment["metadata"]["resourceVersion"],
            },
            {"op": "test", "path": "/spec/replicas", "value": 0},
        ]
        for index, _ in enumerate(deployment["spec"]["template"]["spec"]["containers"]):
            patch.append(
                {
                    "op": "replace",
                    "path": f"/spec/template/spec/containers/{index}/image",
                    "value": record["target_image"],
                }
            )
        patch.append({"op": "replace", "path": "/spec/replicas", "value": 1})
        stage(
            "ops_activate",
            lambda: storage.run(
                namespaced
                + [
                    "patch",
                    "deployment",
                    "ops-service",
                    "--type=json",
                    "--patch-file=/dev/stdin",
                ],
                data=json.dumps(patch).encode(),
            ),
        )
        stage(
            "ops_ready",
            lambda: storage.run(
                namespaced
                + ["rollout", "status", "deployment/ops-service", "--timeout=600s"],
                timeout=630,
            ),
        )

        def check_runtime():
            runtime.check_runtime(
                state, settings, expected_image=record["target_image"]
            )
            if runtime.upgrade_preflight(state, settings)["status"] != "PASS":
                raise ValueError("New runtime has outstanding work or open admission")
            initial.verify_pause(command, record["pause"])
            require_same_database(namespaced, source)

        stage("runtime_check", check_runtime)
        if json.loads(baseline_path.read_text()) != baseline:
            raise ValueError(
                "Baseline changed after rollout; inspect before recording success"
            )
        stage(
            "baseline_record",
            lambda: cluster.write_json(
                baseline_path,
                {
                    **baseline,
                    "images": {
                        **baseline["images"],
                        "ops-service": record["target_image"],
                    },
                },
            ),
        )
        report.update(
            status="ROLLED_OUT_PAUSED",
            containers={name: item["Id"] for name, item in actual.items()},
        )
        cluster.write_json(journal, report)
    except BaseException as error:
        report.update(status="FAILED", error_type=type(error).__name__)
        cluster.write_json(journal, report)
        raise
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, default=database.STATE)
    parser.add_argument("--migration-request-id", required=True)
    parser.add_argument(
        "--runner-image", required=True, help="Immutable local runner image ID"
    )
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    if os.name != "posix":
        parser.error("Run inside WSL/Linux")
    os.umask(0o077)
    try:
        with cluster.locked(args.state_dir), redirect_stdout(io.StringIO()):
            report = rollout(args)
        print(json.dumps(report, sort_keys=True))
        return 0
    except Exception:  # noqa: BLE001 - never expose runtime environment or subprocess errors
        print(
            "First runtime rollout stopped; inspect the journal before recovery. Admission was not resumed (private details withheld).",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
