"""Run the evaluation chart on restored PVCs in the bridge smoke's owned cluster.

No standalone CLI or personal cluster target. The caller owns and deletes the
cluster and Compose fixtures. Langfuse remains an explicit Compose dependency.
"""

import base64
import ipaddress
import json
import re
import subprocess
import tempfile
import time
from contextlib import contextmanager
from urllib.error import URLError
from urllib.request import ProxyHandler, build_opener

import check_evaluation
import evaluation_pvc_restore as pvc
import fork_cluster
import fork_web
import ops_state_snapshot as snapshot
import smoke_ops_artifacts as artifacts
import smoke_ops_sync_recovery as sync
import smoke_ops_volumes as volumes
import yaml
from check_msa import REPOSITORY_ROOT
from smoke_ops_bridge import execute


def stopped_sources(compose, env, project):
    containers = {}
    for service in volumes.SERVICES:
        identities = execute(compose + ["ps", "--all", "-q", service], env=env).split()
        if len(identities) != 1 or not re.fullmatch(r"[a-f0-9]{64}", identities[0]):
            raise ValueError("One stopped source container is required per component")
        item = volumes.container(identities[0], project, service)
        state = item["State"]
        if (
            state["Running"]
            or state.get("Paused")
            or state.get("Restarting")
            or state["OOMKilled"]
            or state["Status"] != "exited"
            or state["ExitCode"] not in (0, 143)
        ):
            raise ValueError("Evaluation source must remain cleanly stopped")
        containers[service] = item
    source = {
        "compose_project": project,
        "writers": {
            row["Id"]: {"service": service, "image": row["Image"]}
            for service, row in containers.items()
            if service != "ops-artifacts"
        },
    }
    return containers, snapshot.volume_sources(source)


def collect(sources):
    return {
        kind: snapshot.volume_helper(row["image"], kind, source=row["volume"])
        for kind, row in sources.items()
    }


def langfuse_url(compose, env, project):
    """Connect only this disposable kind node to its owned observation fixture."""
    identity = execute(compose + ["ps", "-q", "langfuse-web"], env=env).strip()
    if not re.fullmatch(r"[a-f0-9]{64}", identity):
        raise ValueError("The isolated Langfuse fixture is missing")
    item = snapshot.storage.inspect(identity)
    network = project + "_default"
    labels = item["Config"].get("Labels") or {}
    info = json.loads(execute(["docker", "network", "inspect", network]))[0]
    if (
        labels.get("com.docker.compose.project") != project
        or labels.get("com.docker.compose.service") != "langfuse-web"
        or not item["State"]["Running"]
        or info.get("Driver") != "bridge"
        or (info.get("Labels") or {}).get("com.docker.compose.project") != project
    ):
        raise ValueError("Langfuse fixture ownership differs")
    address = item["NetworkSettings"]["Networks"][network]["IPAddress"]
    parsed = ipaddress.ip_address(address)
    if parsed.version != 4 or not parsed.is_private or parsed.is_loopback:
        raise ValueError("Expected an internal fixture address")
    execute(["docker", "network", "connect", network, project + "-control-plane"])
    return f"http://{address}:3000"


def bundle(images, node, observation_url):
    # Exercise the deployment profiles, including each component's resources.
    # Only fixture identities, routes and activation differ in the owned CI cluster.
    values = {
        name: yaml.safe_load(
            pvc.PREFECT_VALUES.with_name(name + ".yaml").read_text(encoding="utf-8")
        )
        for name in check_evaluation.COMPONENTS
    }
    for name, value in values.items():
        value.update(replicas=1, allowLocalImages=True, image=images[name])
        value["storage"] = {
            "existingClaim": "prefect" if name == "prefect" else "results",
            "node": node,
        }
    values["ops-artifacts"]["evidenceImage"] = images["evaluation-runner"]
    values["evaluation-runner"]["runner"] = {
        "opsApiUrl": "http://ops-service.govbiz-msa.svc.cluster.local:8000",
        "langfuseUrl": observation_url,
    }
    return values


def switch_ops(nk, namespace):
    """The fixture is stopped; route both API and sync before resuming either."""
    routes = {
        "PREFECT_API_URL": f"http://prefect.{namespace}.svc.cluster.local:4200/api",
        "LLMOPS_ARTIFACT_URL": f"http://ops-artifacts.{namespace}.svc.cluster.local:8010",
    }
    patch = {
        "spec": {
            "replicas": 1,
            "template": {
                "spec": {
                    "containers": [
                        {
                            "name": name,
                            "env": [
                                {"name": key, "value": value}
                                for key, value in routes.items()
                            ],
                        }
                        for name in ("ops-service", "ops-sync")
                    ]
                }
            },
        }
    }
    execute(
        nk
        + [
            "patch",
            "deployment",
            "ops-service",
            "--type=strategic",
            "--patch-file=/dev/stdin",
        ],
        data=json.dumps(patch),
    )
    execute(
        nk + ["rollout", "status", "deployment/ops-service", "--timeout=300s"],
        timeout=315,
    )
    return routes["LLMOPS_ARTIFACT_URL"]


def pod_identity(ek, component):
    rows = json.loads(
        execute(
            ek
            + [
                "get",
                "pods",
                "-l",
                "app.kubernetes.io/name=" + component,
                "-o",
                "json",
            ]
        )
    )["items"]
    if len(rows) != 1 or rows[0]["metadata"].get("deletionTimestamp"):
        raise ValueError("Expected one active evaluation Pod")
    statuses = rows[0].get("status", {}).get("containerStatuses", [])
    if len(statuses) != 1 or statuses[0].get("ready") is not True:
        raise ValueError("Evaluation container is not ready")
    return {"uid": rows[0]["metadata"]["uid"], "image_id": statuses[0]["imageID"]}


def failure_signals(text):
    """Only fixed diagnostic codes may leave raw Kubernetes responses/logs."""
    patterns = {
        "permission_denied": r"PermissionError|Permission denied",
        "read_only_filesystem": r"Read-only file system",
        "missing_database_schema": r"no such (table|column)",
        "database_locked": r"database is locked",
        "invalid_cli_option": r"No such option|unrecognized arguments",
        "port_in_use": r"Address already in use|Port .* is already in use",
        "insufficient_memory": r"Insufficient memory",
        "insufficient_cpu": r"Insufficient cpu",
        "node_disk_pressure": r"node.kubernetes.io/disk-pressure",
        "node_memory_pressure": r"node.kubernetes.io/memory-pressure",
        "failed_mount": r"MountVolume.*failed|Unable to attach or mount volumes",
        "probe_connection_refused": r"[Pp]robe failed.*connection refused",
    }
    return sorted(
        name for name, pattern in patterns.items() if re.search(pattern, text)
    )


def rollout(ek, component, evidence, *, seconds=240):
    """Keep failure evidence before the owned namespace is deleted; never recover silently."""
    if component not in check_evaluation.COMPONENTS:
        raise ValueError("Unknown evaluation component")
    try:
        execute(
            ek
            + ["rollout", "status", "deployment/" + component, f"--timeout={seconds}s"],
            timeout=seconds + 15,
        )
    except (OSError, subprocess.SubprocessError) as error:
        failure = evidence["rollout_failure"] = {
            "component": component,
            "error_type": type(error).__name__,
            "pods": [],
            "signals": [],
            "diagnostic_errors": [],
        }
        try:
            rows = json.loads(
                execute(
                    ek
                    + [
                        "get",
                        "pods",
                        "-l",
                        "app.kubernetes.io/name=" + component,
                        "-o",
                        "json",
                    ],
                    timeout=15,
                )
            )["items"]
            failure["pod_count"] = len(rows)
            reasons = {
                "ContainerCreating",
                "PodInitializing",
                "CrashLoopBackOff",
                "ErrImagePull",
                "ImagePullBackOff",
                "ErrImageNeverPull",
                "CreateContainerConfigError",
                "CreateContainerError",
                "RunContainerError",
                "OOMKilled",
                "Error",
                "Completed",
            }
            allowed = {component, "restored-prefect-database", "evaluation-evidence"}
            for row in rows[:4]:
                status = row.get("status", {})
                pod = {
                    "phase": status.get("phase")
                    if status.get("phase")
                    in {"Pending", "Running", "Succeeded", "Failed", "Unknown"}
                    else "Unknown",
                    "scheduled": any(
                        c.get("type") == "PodScheduled" and c.get("status") == "True"
                        for c in status.get("conditions", [])
                    ),
                    "containers": [],
                }
                failure["pods"].append(pod)
                for container in status.get("initContainerStatuses", []) + status.get(
                    "containerStatuses", []
                ):
                    name = container.get("name")
                    if name not in allowed:
                        continue
                    item = {
                        "name": name,
                        "ready": container.get("ready") is True,
                        "restarts": container.get("restartCount")
                        if type(container.get("restartCount")) is int
                        else None,
                    }
                    for field in ("state", "lastState"):
                        state = container.get(field, {})
                        item[field] = {
                            kind: {
                                "reason": value.get("reason")
                                if value.get("reason") in reasons
                                else "Unknown",
                                **(
                                    {
                                        "exit_code": value.get("exitCode")
                                        if type(value.get("exitCode")) is int
                                        else None
                                    }
                                    if kind == "terminated"
                                    else {}
                                ),
                            }
                            for kind, value in state.items()
                            if kind in {"running", "waiting", "terminated"}
                        }
                    pod["containers"].append(item)
                    for previous in (
                        (False, True) if container.get("restartCount", 0) else (False,)
                    ):
                        try:
                            logs = execute(
                                ek
                                + [
                                    "logs",
                                    row["metadata"]["name"],
                                    "-c",
                                    name,
                                    "--tail=100",
                                    "--limit-bytes=16384",
                                    *(["--previous"] if previous else []),
                                ],
                                timeout=15,
                            )
                            failure["signals"].extend(failure_signals(logs))
                        except Exception:  # noqa: BLE001 - diagnostics must not mask the original failure
                            failure["diagnostic_errors"].append(
                                "container_logs_unavailable"
                            )
        except Exception:  # noqa: BLE001 - retain the original rollout failure even for malformed diagnostics
            failure["diagnostic_errors"].append("pod_status_unavailable")
        try:
            events = json.loads(
                execute(
                    ek
                    + [
                        "get",
                        "events",
                        "--field-selector=involvedObject.kind=Pod",
                        "-o",
                        "json",
                    ],
                    timeout=15,
                )
            )["items"]
            failure["signals"].extend(
                failure_signals(
                    "\n".join(str(row.get("message", "")) for row in events)
                )
            )
        except Exception:  # noqa: BLE001 - diagnostics cannot turn a failed rollout into another outcome
            failure["diagnostic_errors"].append("pod_events_unavailable")
        failure["signals"] = sorted(set(failure["signals"]))
        failure["diagnostic_errors"] = sorted(set(failure["diagnostic_errors"]))
        raise


def restart(ek, component, evidence=None):
    before = pod_identity(ek, component)
    execute(ek + ["rollout", "restart", "deployment/" + component])
    rollout(ek, component, evidence if evidence is not None else {})
    after = pod_identity(ek, component)
    if before["uid"] == after["uid"] or before["image_id"] != after["image_id"]:
        raise ValueError("Pod replacement must preserve the evaluation image")
    return {"before": before, "after": after}


@contextmanager
def web_session(nk, web_env):
    with tempfile.TemporaryFile(mode="w+t") as log, fork_web.forwards(nk):
        web = subprocess.Popen(
            [
                "node",
                "node_modules/vite/bin/vite.js",
                "--mode",
                "portfolio",
                "--host",
                "127.0.0.1",
            ],
            cwd=REPOSITORY_ROOT / "frontend/web",
            env=web_env,
            stdout=log,
            stderr=log,
        )
        try:
            deadline = time.monotonic() + 90
            while True:
                if web.poll() is not None:
                    raise ValueError("Evaluation runtime Vite process exited")
                try:
                    with build_opener(ProxyHandler({})).open(
                        artifacts.BASE, timeout=3
                    ) as response:
                        if response.status != 200:
                            raise ValueError("Evaluation web proxy is not ready")
                    break
                except (URLError, OSError):
                    if time.monotonic() >= deadline:
                        raise ValueError(
                            "Evaluation web proxy startup timed out"
                        ) from None
                    time.sleep(1)
            yield
        finally:
            web.terminate()
            try:
                web.wait(timeout=10)
            except subprocess.TimeoutExpired:
                web.kill()
                web.wait(timeout=5)


def preserved(nk, password, expected, artifact_url):
    from smoke_ops_evaluation import database_record

    records = {}
    for request_id, row in expected.items():
        record = database_record(nk, request_id, artifact_url=artifact_url)
        run = record["run"]
        flows = sync.prefect_runs(nk, request_id)
        if (
            run["prefect_flow_run_id"] != row["flow_id"]
            or run["execution_spec_sha256"] != row["execution_spec_sha256"]
            or len(flows) != 1
            or flows[0]["state"] != "COMPLETED"
            or flows[0]["id"] != row["flow_id"]
            or flows[0]["spec"] != row["execution_spec_sha256"]
            or artifacts.read_completed_report(password, request_id)
            != row["report_sha256"]
        ):
            raise ValueError(
                "Restored execution, unique flow or authenticated report differs"
            )
        records[request_id] = record
    return records


def verify(
    state,
    settings,
    compose,
    compose_env,
    kind,
    helm,
    password,
    web_env,
    expected,
    report,
):
    from smoke_ops_evaluation import free_evaluation, set_admission

    evidence = report["evaluation_kubernetes_runtime"] = {
        "status": "FAIL",
        "scope": "disposable_kubernetes_evaluation_runtime",
        "personal_environment_verified": False,
        "production_cutover": False,
        "observability_runtime": "isolated_compose",
        "cleanup_complete": False,
    }
    project = settings.get("cluster", "")
    if (
        settings.get("repository") != "bridge-smoke/local"
        or not re.fullmatch(r"govbiz-bridge-smoke-[a-f0-9]{10}", project)
        or report.get("compose_project") != project
        or settings.get("namespace") != "govbiz-msa"
        or report.get("database_restore", {}).get("status") != "PASS"
        or report.get("volume_restore", {}).get("status") != "PASS"
        or report["volume_restore"].get("writers_stopped") is not True
    ):
        raise ValueError(
            "Runtime verification requires the completed disposable backup rehearsal"
        )
    snapshot.probe.expected_runs(expected)
    fork_cluster.require_dev(state, settings)
    kube, nk, _ = fork_cluster.commands(state, settings)
    deployment = json.loads(
        execute(nk + ["get", "deployment", "ops-service", "-o", "json"])
    )
    pods = json.loads(
        execute(
            nk
            + ["get", "pods", "-l", "app.kubernetes.io/name=ops-service", "-o", "json"]
        )
    )
    if deployment["spec"]["replicas"] != 0 or pods["items"]:
        raise ValueError("Ops writers must remain stopped before routing changes")
    containers, sources = stopped_sources(compose, compose_env, project)
    stores = collect(sources)
    # Both the restored database and the runtime use the source's exact image.
    prefect_image = yaml.safe_load(pvc.PREFECT_VALUES.read_text(encoding="utf-8"))[
        "image"
    ]
    if (
        execute(
            ["docker", "image", "inspect", prefect_image, "--format", "{{.Id}}"]
        ).strip()
        != containers["prefect"]["Image"]
    ):
        raise ValueError(
            "Source Prefect differs from the pinned restore/runtime version"
        )
    runner_env = snapshot.storage.environment(
        snapshot.storage.inspect(containers["evaluation-runner"]["Id"])
    )
    artifact_env = snapshot.storage.environment(
        snapshot.storage.inspect(containers["ops-artifacts"]["Id"])
    )
    secret = json.loads(execute(nk + ["get", "secret", "ops-runtime", "-o", "json"]))
    token = base64.b64decode(
        secret["data"]["LLMOPS_ARTIFACT_TOKEN"], validate=True
    ).decode()
    if not token or token != artifact_env.get("LLMOPS_ARTIFACT_TOKEN"):
        raise ValueError(
            "Ops and the restored artifact service must share their fixture token"
        )
    observation_url = langfuse_url(compose, compose_env, project)
    images = {
        name: "govbiz/" + name + ":" + project for name in check_evaluation.COMPONENTS
    }
    tagged = []
    try:
        for component, image in images.items():
            execute(["docker", "image", "tag", containers[component]["Image"], image])
            tagged.append(image)
        execute(
            [kind, "load", "docker-image", *images.values(), "--name", project],
            timeout=600,
        )
        with pvc.restored_pvcs(kube, project + "-control-plane", stores, expected) as (
            namespace,
            proof,
        ):
            evidence["restored_pvc"] = proof
            ek = kube + ["-n", namespace]
            # The restore reader policy is replaced only in this owned CI cluster.
            # The default kind CNI does not demonstrate NetworkPolicy enforcement.
            execute(ek + ["delete", "networkpolicy", "deny-all"])
            for name, data in (
                ("llmops-artifacts", {"LLMOPS_ARTIFACT_TOKEN": token}),
                (
                    "llmops-runner",
                    {
                        key: runner_env[key]
                        for key in (
                            "LLMOPS_BUDGET_TOKEN",
                            "LANGFUSE_PUBLIC_KEY",
                            "LANGFUSE_SECRET_KEY",
                        )
                    },
                ),
            ):
                execute(
                    ek + ["create", "-f", "-"],
                    data=json.dumps(
                        {
                            "apiVersion": "v1",
                            "kind": "Secret",
                            "metadata": {"name": name, "namespace": namespace},
                            "stringData": data,
                        }
                    ),
                )
            rendered = check_evaluation.render_bundle(
                bundle(images, project + "-control-plane", observation_url),
                namespace,
                helm,
            )
            for component in ("prefect", "ops-artifacts", "evaluation-runner"):
                for resource in rendered[component]:
                    execute(ek + ["create", "-f", "-"], data=json.dumps(resource))
                rollout(ek, component, evidence)
            evidence["pods"] = {name: pod_identity(ek, name) for name in images}
            artifact_url = switch_ops(nk, namespace)
            evidence["admission_resume"] = set_admission(
                nk, "resume", report["backup_admission_pause"]["version"]
            )
            with web_session(nk, web_env):
                before = preserved(nk, password, expected, artifact_url)
                evidence["restored_evaluations"] = len(before)
                fresh = free_evaluation(
                    state / "kubernetes-evaluation.json", password, web_env
                )
                if not fresh.get("duplicate_request_same_flow") or not fresh.get(
                    "background_sync_without_detail"
                ):
                    raise ValueError(
                        "Missing duplicate request or background sync evidence"
                    )
                if fresh["request_id"] in expected or fresh["prefect_flow_run_id"] in {
                    row["flow_id"] for row in expected.values()
                }:
                    raise ValueError(
                        "A new evaluation must create a new execution identity"
                    )
                evidence["evaluation"] = fresh
                completed = {
                    **expected,
                    fresh["request_id"]: {
                        "flow_id": fresh["prefect_flow_run_id"],
                        "execution_spec_sha256": fresh["execution_spec_sha256"],
                        "report_sha256": artifacts.read_completed_report(
                            password, fresh["request_id"]
                        ),
                    },
                }
                before = preserved(nk, password, completed, artifact_url)
                evidence["replacements"] = {}
                # Stop the only writer before replacing its database server.
                execute(ek + ["scale", "deployment/evaluation-runner", "--replicas=0"])
                execute(
                    ek
                    + [
                        "wait",
                        "--for=delete",
                        "pod",
                        "-l",
                        "app.kubernetes.io/name=evaluation-runner",
                        "--timeout=120s",
                    ],
                    timeout=135,
                )
                for component in ("prefect", "ops-artifacts"):
                    evidence["replacements"][component] = restart(
                        ek, component, evidence
                    )
                execute(ek + ["scale", "deployment/evaluation-runner", "--replicas=1"])
                rollout(ek, "evaluation-runner", evidence, seconds=180)
                new_runner = pod_identity(ek, "evaluation-runner")
                old_runner = evidence["pods"]["evaluation-runner"]
                if (
                    new_runner["uid"] == old_runner["uid"]
                    or new_runner["image_id"] != old_runner["image_id"]
                ):
                    raise ValueError("Runner replacement was not verified")
                evidence["replacements"]["evaluation-runner"] = {
                    "before": old_runner,
                    "after": new_runner,
                }
                if preserved(nk, password, completed, artifact_url) != before:
                    raise ValueError(
                        "Pod replacement changed completed execution records"
                    )
                after = free_evaluation(
                    state / "kubernetes-evaluation-restarted.json", password, web_env
                )
                if after["request_id"] in completed or after["prefect_flow_run_id"] in {
                    row["flow_id"] for row in completed.values()
                }:
                    raise ValueError(
                        "Restarted runner did not accept a distinct evaluation"
                    )
                evidence["evaluation_after_restart"] = after
                if preserved(nk, password, completed, artifact_url) != before:
                    raise ValueError("New evaluation changed preserved records")
                preserved(
                    nk,
                    password,
                    {
                        after["request_id"]: {
                            "flow_id": after["prefect_flow_run_id"],
                            "execution_spec_sha256": after["execution_spec_sha256"],
                            "report_sha256": artifacts.read_completed_report(
                                password, after["request_id"]
                            ),
                        }
                    },
                    artifact_url,
                )
            # No rollback to the old Compose database after new writes. This
            # fixture cluster is about to be deleted by the outer smoke owner.
            execute(nk + ["scale", "deployment/ops-service", "--replicas=0"])
            execute(
                nk
                + [
                    "wait",
                    "--for=delete",
                    "pod",
                    "-l",
                    "app.kubernetes.io/name=ops-service",
                    "--timeout=120s",
                ],
                timeout=135,
            )
        if (
            stopped_sources(compose, compose_env, project)[1] != sources
            or collect(sources) != stores
        ):
            raise ValueError(
                "Kubernetes evaluation changed the original Compose stores"
            )
        evidence.update(
            source_stores_unchanged=True,
            model_api_calls=0,
            network_policy_enforcement_verified=False,
        )
    finally:
        for image in reversed(tagged):
            execute(["docker", "image", "rm", image], timeout=60)
    evidence.update(status="PASS", cleanup_complete=True)
