"""Prefect outage and sync restart checks using one additional free replay."""

import json
import time
from contextlib import contextmanager
from urllib.request import Request
from uuid import UUID, uuid4

import fork_web
import smoke_ops_artifacts as artifacts
from smoke_ops_bridge import execute

BASE = artifacts.BASE
DATASET = "target-coverage-20260907-v1"
PAUSED_COMMAND = [
    "python",
    "-c",
    "import signal,sys,time; signal.signal(signal.SIGTERM, lambda *_: sys.exit(0)); print('sync stopped for smoke',flush=True); time.sleep(900)",
]


def session(password):
    client = artifacts.authenticated_client(password)
    status, _, raw = artifacts.response(client, BASE + "/api/v1/ops/session")
    value = json.loads(raw)
    assert status == 200 and value["live_enabled"] is False
    dataset = next(item for item in value["datasets"] if item["id"] == DATASET)
    return client, value["csrf_token"], dataset["execution_profiles"]["replay"]


def submit(client, csrf, payload):
    status, _, raw = artifacts.response(
        client,
        Request(
            BASE + "/api/v1/ops/evaluations",
            data=json.dumps(payload).encode(),
            headers={
                "Origin": BASE,
                "Content-Type": "application/json",
                "X-CSRFToken": csrf,
            },
        ),
        allow_error=True,
    )
    return status, json.loads(raw)


def list_run(client, run_id):
    status, _, raw = artifacts.response(client, BASE + "/api/v1/ops/evaluations")
    assert status == 200
    rows = [item for item in json.loads(raw)["results"] if item["id"] == run_id]
    assert len(rows) == 1
    run = rows[0]
    assert run["status"] in {"REQUESTED", "QUEUED", "RUNNING", "COMPLETED"}, run[
        "status"
    ]
    assert run["execution_mode"] == "replay" and run["model_api_calls"] == 0
    return run


def wait_for(label, read, accept, timeout=120):
    deadline = time.monotonic() + timeout
    while True:
        value = read()
        if accept(value):
            return value
        if time.monotonic() >= deadline:
            raise TimeoutError(label)
        time.sleep(3)


def check_runtime(client, *, prefect_available):
    for path in ("/api/v1/health", "/api/v1/health/ready"):
        status, _, raw = artifacts.response(client, "http://127.0.0.1:18001" + path)
        assert status == 200 and json.loads(raw)["status"] == "UP"
    status, _, raw = artifacts.response(
        client, BASE + "/api/v1/ops/runtime", allow_error=True
    )
    result = json.loads(raw)
    assert status == (200 if prefect_available else 503)
    assert result["status"] == ("PASS" if prefect_available else "FAIL")
    assert result["checks"] == {
        "evidence": "PASS",
        "results_directory": "PASS",
        "prefect_deployment": "PASS" if prefect_available else "FAIL",
        "result_artifact": "NOT_CHECKED",
    }
    assert result["runner_liveness_verified"] is False
    return {"http_status": status, "checks": result["checks"], "probes": "PASS"}


@contextmanager
def stopped_prefect(compose, env, project):
    identity = execute(compose + ["ps", "-q", "prefect"], env=env).strip()
    info = json.loads(
        execute(
            [
                "docker",
                "inspect",
                "--format",
                '{"Labels":{{json .Config.Labels}},"Running":{{json .State.Running}},"Paused":{{json .State.Paused}}}',
                identity,
            ]
        )
    )
    assert info["Running"] is True and info["Paused"] is False
    assert info["Labels"]["com.docker.compose.project"] == project
    assert info["Labels"]["com.docker.compose.service"] == "prefect"
    execute(["docker", "pause", identity])
    try:
        yield
    finally:
        execute(["docker", "unpause", identity])


@contextmanager
def stopped_sync(nk):
    deployment = json.loads(
        execute(nk + ["get", "deployment/ops-service", "-o", "json"])
    )
    containers = deployment["spec"]["template"]["spec"]["containers"]
    index = next(i for i, item in enumerate(containers) if item["name"] == "ops-sync")
    original = containers[index]["command"]
    assert original == ["python", "manage.py", "sync_evaluations", "--watch"]
    path = f"/spec/template/spec/containers/{index}/command"

    def replace(expected, value):
        execute(
            nk
            + [
                "patch",
                "deployment/ops-service",
                "--type=json",
                "--patch-file=/dev/stdin",
            ],
            data=json.dumps(
                [
                    {
                        "op": "test",
                        "path": "/metadata/uid",
                        "value": deployment["metadata"]["uid"],
                    },
                    {"op": "test", "path": path, "value": expected},
                    {"op": "replace", "path": path, "value": value},
                ]
            ),
        )

    replace(original, PAUSED_COMMAND)
    try:
        execute(nk + ["rollout", "status", "deployment/ops-service", "--timeout=180s"])
        yield
    finally:
        replace(PAUSED_COMMAND, original)
        execute(nk + ["rollout", "status", "deployment/ops-service", "--timeout=180s"])


def prefect_runs(nk, run_id):
    run_id = str(UUID(run_id))
    program = (
        "import os,json; os.environ.setdefault('DJANGO_SETTINGS_MODULE','config.settings'); "
        "from apps.evaluations.prefect_client import request_json; "
        f"key='ops-{run_id}'; "
        "rows=request_json('/flow_runs/filter',"
        "{'flow_runs':{'idempotency_key':{'any_':[key]}},'limit':2},expected_type=list); "
        "print(json.dumps([{'id':r['id'],'state':r['state_type'],"
        "'key':r['idempotency_key'],'request_id':r['parameters']['request_id'],"
        "'spec':r['parameters']['execution_spec_sha256']} for r in rows]))"
    )
    rows = json.loads(
        execute(
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
    assert len(rows) <= 1, "Duplicate Prefect flows for the same request"
    for row in rows:
        UUID(row["id"])
        assert row["key"] == "ops-" + run_id and row["request_id"] == run_id
        assert row["state"] not in {"FAILED", "CRASHED", "CANCELLED"}, row["state"]
    return rows


def snapshot(run):
    return {
        key: run[key]
        for key in (
            "id",
            "status",
            "prefect_flow_run_id",
            "execution_spec_sha256",
            "model_api_calls",
            "error_code",
            "synced_at",
            "sync_attempted_at",
            "status_stale",
        )
    }


def same_execution(run, request_id, fingerprint):
    assert run["id"] == request_id and run["execution_spec_sha256"] == fingerprint
    assert run["execution_mode"] == "replay" and run["model_api_calls"] == 0


def verify(nk, compose, env, password, original_run, original_hash, report):
    project = report["compose_project"]
    artifacts.require_disposable(nk, compose, env, project)
    evidence = {"status": "FAIL"}
    report["sync_recovery"] = evidence
    report["evaluation_phase"] = "prefect_outage"
    with fork_web.forwards(nk):
        client, csrf, profile = session(password)
        payload = {
            "request_id": str(uuid4()),
            "dataset_id": DATASET,
            "execution_mode": "replay",
            "execution_profile": profile,
        }
        evidence["request_id"] = payload["request_id"]
        with stopped_prefect(compose, env, project):
            status, first = submit(client, csrf, payload)
            assert status == 503 and first["status"] == "REQUESTED"
            assert first["prefect_flow_run_id"] is None
            assert first["error_code"] in {
                "PREFECT_DISPATCH_UNCONFIRMED",
                "PREFECT_STATUS_UNAVAILABLE",
            }
            fingerprint = first["execution_spec_sha256"]
            same_execution(first, payload["request_id"], fingerprint)
            outage = wait_for(
                "Prefect outage was not exposed as a stale, unconfirmed request",
                lambda: list_run(client, payload["request_id"]),
                lambda run: (
                    run["status_stale"]
                    and run["error_code"] == "PREFECT_STATUS_UNAVAILABLE"
                ),
            )
            assert (
                outage["status"] == "REQUESTED"
                and outage["prefect_flow_run_id"] is None
            )
            assert outage["synced_at"] is None and outage["sync_attempted_at"]
            assert outage["error_message"]
            same_execution(outage, payload["request_id"], fingerprint)
            evidence["prefect_outage"] = snapshot(outage)
            evidence["prefect_outage"]["runtime"] = check_runtime(
                client, prefect_available=False
            )
            # A completed result remains readable during a scheduler outage.
            assert (
                artifacts.report_hash(
                    client, artifacts.completed_run(client, original_run["id"])
                )
                == original_hash
            )

        report["evaluation_phase"] = "prefect_recovery_without_dispatch"
        # A changed attempt timestamp and unconfirmed-dispatch code prove the worker queried again.
        restored = wait_for(
            "Sync did not resume lookup after Prefect recovery",
            lambda: list_run(client, payload["request_id"]),
            lambda run: (
                run["error_code"] == "PREFECT_DISPATCH_UNCONFIRMED"
                and run["sync_attempted_at"] != outage["sync_attempted_at"]
            ),
        )
        assert (
            restored["status"] == "REQUESTED"
            and restored["prefect_flow_run_id"] is None
        )
        assert restored["synced_at"] is None and restored["status_stale"]
        same_execution(restored, payload["request_id"], fingerprint)
        assert prefect_runs(nk, payload["request_id"]) == []
        evidence["automatic_dispatch_count"] = 0
        evidence["prefect_recovered"] = check_runtime(client, prefect_available=True)

    report["evaluation_phase"] = "sync_stopped"
    with stopped_sync(nk), fork_web.forwards(nk):
        client, csrf, resumed_profile = session(password)
        assert resumed_profile == profile
        status, first = submit(client, csrf, payload)
        assert status == 200 and first["status"] == "QUEUED"
        flow_id = str(UUID(first["prefect_flow_run_id"]))
        same_execution(first, payload["request_id"], fingerprint)
        status, repeated = submit(client, csrf, payload)
        assert status == 200 and repeated["prefect_flow_run_id"] == flow_id
        same_execution(repeated, payload["request_id"], fingerprint)
        pending = snapshot(list_run(client, payload["request_id"]))

        remote = wait_for(
            "Free replay did not complete while the Ops sync worker was stopped",
            lambda: prefect_runs(nk, payload["request_id"]),
            lambda rows: bool(rows) and rows[0]["state"] == "COMPLETED",
            timeout=360,
        )
        assert remote[0]["id"] == flow_id and remote[0]["spec"] == fingerprint
        unchanged = list_run(client, payload["request_id"])
        assert snapshot(unchanged) == pending
        assert unchanged["status"] == "QUEUED" and unchanged["status_stale"]
        assert unchanged["synced_at"] is None and unchanged["report_url"] is None
        same_execution(unchanged, payload["request_id"], fingerprint)
        evidence["sync_stopped"] = {
            "database": pending,
            "prefect_state": "COMPLETED",
            "runtime": check_runtime(client, prefect_available=True),
            "list_does_not_repair_state": True,
        }

    report["evaluation_phase"] = "sync_resumed"
    with fork_web.forwards(nk):
        client, _, _ = session(password)
        completed = wait_for(
            "Restarted sync worker did not update the completed replay",
            lambda: list_run(client, payload["request_id"]),
            lambda run: run["status"] == "COMPLETED",
            timeout=120,
        )
        same_execution(completed, payload["request_id"], fingerprint)
        assert completed["prefect_flow_run_id"] == flow_id
        assert (
            completed["synced_at"]
            and completed["sync_attempted_at"] != pending["sync_attempted_at"]
        )
        assert not completed["status_stale"] and completed["error_code"] == ""
        assert prefect_runs(nk, payload["request_id"]) == remote
        evidence["completed"] = snapshot(completed)
        evidence["report_sha256"] = artifacts.report_hash(client, completed)
        evidence["runtime"] = check_runtime(client, prefect_available=True)
    evidence.update(
        status="PASS",
        prefect_flow_count=1,
        model_api_calls=0,
        duplicate_request_same_flow=True,
        automatic_recovery=True,
        background_sync_without_detail=True,
    )
