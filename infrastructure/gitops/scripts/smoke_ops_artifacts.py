"""Artifact failures and recovery in the bridge smoke's disposable environment only."""

import hashlib
import json
import re
import secrets
from contextlib import contextmanager
from http.cookiejar import CookieJar
from urllib.error import HTTPError
from urllib.request import HTTPCookieProcessor, ProxyHandler, Request, build_opener
from uuid import UUID

import fork_web
from smoke_ops_bridge import execute

BASE = "http://localhost:5173"
TOKEN_KEY = "LLMOPS_ARTIFACT_TOKEN"

MOVE_REPORT = r"""
import hashlib,json,os
from pathlib import Path
from uuid import UUID
import sys
value=json.load(sys.stdin)
run_id=str(UUID(value["run_id"]))
assert run_id==value["run_id"]
root=Path(os.environ["LLMOPS_RESULTS_DIR"]).resolve(strict=True)
folder=root/run_id/"evaluation"
assert not (root/run_id).is_symlink() and not folder.is_symlink()
assert folder.resolve(strict=True).is_relative_to(root)
report=folder/"report.html"
backup=folder/"report.html.smoke-held"
assert not report.is_symlink() and not backup.is_symlink()
source,target=(backup,report) if value["restore"] else (report,backup)
assert source.is_file() and not target.exists()
assert hashlib.sha256(source.read_bytes()).hexdigest()==value["sha256"]
source.rename(target)
print("restored" if value["restore"] else "hidden")
"""


TAMPER_REPORT = r"""
import hashlib,json,os,sys
from pathlib import Path
from uuid import UUID
value=json.load(sys.stdin)
run_id=str(UUID(value["run_id"]))
assert run_id==value["run_id"]
root=Path(os.environ["LLMOPS_RESULTS_DIR"]).resolve(strict=True)
folder=root/run_id/"evaluation"
assert not (root/run_id).is_symlink() and not folder.is_symlink()
assert folder.resolve(strict=True).is_relative_to(root)
report=folder/"report.html"
backup=folder/"report.html.smoke-held"
assert not report.is_symlink() and not backup.is_symlink()
assert backup.is_file()
raw=backup.read_bytes()
assert 0<len(raw)<=8*1024*1024
assert hashlib.sha256(raw).hexdigest()==value["sha256"]
changed=raw[:-1]+bytes([raw[-1]^1])
if value["remove"]:
    assert report.is_file() and report.read_bytes()==changed
    report.unlink()
else:
    with report.open("xb") as target:
        target.write(changed)
print(json.dumps({"sha256":hashlib.sha256(changed).hexdigest(),"size":len(changed)}))
"""


def response(client, target, *, allow_error=False):
    try:
        result = client.open(target, timeout=15)
    except HTTPError as error:
        if not allow_error:
            error.close()
            raise
        result = error
    with result:
        return result.status, result.headers, result.read()


def authenticated_client(password):
    client = build_opener(ProxyHandler({}), HTTPCookieProcessor(CookieJar()))
    status, _, raw = response(
        client,
        Request(
            BASE + "/api/v1/auth/login",
            data=json.dumps(
                {
                    "email": "admin@govbiz.local",
                    "password": password,
                    "rememberMe": False,
                }
            ).encode(),
            headers={"Origin": BASE, "Content-Type": "application/json"},
        ),
    )
    assert status == 200 and json.loads(raw)["account"]["role"] == "ADMIN"
    return client


def completed_run(client, run_id):
    status, _, raw = response(client, BASE + "/api/v1/ops/evaluations")
    assert status == 200
    matches = [item for item in json.loads(raw)["results"] if item["id"] == run_id]
    assert len(matches) == 1
    run = matches[0]
    assert run["status"] == "COMPLETED" and not run["status_stale"]
    return run


def report_hash(client, run):
    status, headers, raw = response(client, BASE + run["report_url"])
    assert status == 200 and len(raw) > 1000
    assert "sandbox allow-scripts;" in headers["Content-Security-Policy"]
    return hashlib.sha256(raw).hexdigest()


def read_completed_report(password, run_id):
    client = authenticated_client(password)
    return report_hash(client, completed_run(client, run_id))


def check_access(password, expected_run, expected_hash, failed_checks=()):
    client = authenticated_client(password)
    run = completed_run(client, expected_run["id"])
    assert {key: run[key] for key in expected_run} == expected_run
    for path in ("/api/v1/health", "/api/v1/health/ready"):
        status, _, raw = response(client, "http://127.0.0.1:18001" + path)
        assert status == 200 and json.loads(raw)["status"] == "UP"
    status, _, raw = response(
        client,
        BASE + "/api/v1/ops/runtime?run_id=" + expected_run["id"],
        allow_error=True,
    )
    diagnostics = json.loads(raw)
    assert status == (503 if failed_checks else 200)
    assert diagnostics["storage_transport"] == "http"
    assert diagnostics["status"] == ("FAIL" if failed_checks else "PASS")
    assert diagnostics["checks"] == {
        key: "FAIL" if key in failed_checks else "PASS"
        for key in (
            "evidence",
            "results_directory",
            "prefect_deployment",
            "result_artifact",
        )
    }
    if failed_checks:
        status, _, raw = response(client, BASE + run["report_url"], allow_error=True)
        assert status == 404 and set(json.loads(raw)) == {"detail"}
    else:
        assert report_hash(client, run) == expected_hash
    return {
        "report_http_status": 404 if failed_checks else 200,
        "runtime_http_status": 503 if failed_checks else 200,
        "checks": diagnostics["checks"],
        "probes": "PASS",
        "completed_record_preserved": True,
    }


@contextmanager
def rejected_token(nk):
    deployment = json.loads(
        execute(nk + ["get", "deployment/ops-service", "-o", "json"])
    )
    containers = deployment["spec"]["template"]["spec"]["containers"]
    index = next(
        i for i, item in enumerate(containers) if item["name"] == "ops-service"
    )
    entries = containers[index]["env"]
    token_index = next(i for i, item in enumerate(entries) if item["name"] == TOKEN_KEY)
    original = entries[token_index]
    assert original == {
        "name": TOKEN_KEY,
        "valueFrom": {"secretKeyRef": {"name": "ops-runtime", "key": TOKEN_KEY}},
    }
    invalid = {"name": TOKEN_KEY, "value": secrets.token_urlsafe(48)}
    path = f"/spec/template/spec/containers/{index}/env/{token_index}"

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

    replace(original, invalid)
    try:
        execute(nk + ["rollout", "status", "deployment/ops-service", "--timeout=180s"])
        yield
    finally:
        replace(invalid, original)
        execute(nk + ["rollout", "status", "deployment/ops-service", "--timeout=180s"])


@contextmanager
def missing_report(compose, env, run_id, expected_hash):
    run_id = str(UUID(run_id))
    command = compose + ["exec", "-T", "evaluation-runner", "python", "-c", MOVE_REPORT]

    def move(restore):
        result = execute(
            command,
            env=env,
            data=json.dumps(
                {"run_id": run_id, "sha256": expected_hash, "restore": restore}
            ),
        )
        assert result.strip() == ("restored" if restore else "hidden")

    move(False)
    try:
        yield
    finally:
        move(True)


@contextmanager
def tampered_report(compose, env, run_id, expected_hash):
    run_id = str(UUID(run_id))
    command = compose + [
        "exec",
        "-T",
        "evaluation-runner",
        "python",
        "-c",
        TAMPER_REPORT,
    ]

    def change(remove):
        return json.loads(
            execute(
                command,
                env=env,
                data=json.dumps(
                    {"run_id": run_id, "sha256": expected_hash, "remove": remove}
                ),
            )
        )

    # Hold the verified original outside the served path. Only the synthetic copy
    # is removed; an unexpected writer or changed backup blocks restoration.
    with missing_report(compose, env, run_id, expected_hash):
        altered = change(False)
        try:
            assert altered["sha256"] != expected_hash and altered["size"] > 0
            yield altered
        finally:
            assert change(True) == altered


def artifact_response(nk, run_id):
    run_id = str(UUID(run_id))
    program = (
        "import os,json,hashlib; os.environ.setdefault('DJANGO_SETTINGS_MODULE','config.settings'); "
        "from django.conf import settings; "
        "from urllib.request import Request,build_opener,ProxyHandler; "
        "from urllib.error import HTTPError\n"
        "try:\n"
        " with build_opener(ProxyHandler({})).open(Request("
        f"settings.LLMOPS_ARTIFACT_URL+'/v1/results/{run_id}/evaluation/report.html',"
        "headers={'Authorization':'Bearer '+settings.LLMOPS_ARTIFACT_TOKEN}),timeout=3) as r:\n"
        "  raw=r.read(8*1024*1024+1); assert len(raw)<=8*1024*1024\n"
        "  print(json.dumps({'status':r.status,'sha256':hashlib.sha256(raw).hexdigest(),'size':len(raw)}))\n"
        "except HTTPError as e:\n print(json.dumps({'status':e.code})); e.close()\n"
    )
    return json.loads(
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


def require_disposable(nk, compose, env, project):
    if not re.fullmatch(r"govbiz-bridge-smoke-[a-f0-9]{10}", project):
        raise ValueError("Artifact faults require the generated disposable project")
    if nk[nk.index("--context") + 1] != "kind-" + project:
        raise ValueError("Artifact faults require the matching disposable cluster")
    runner = execute(compose + ["ps", "-q", "evaluation-runner"], env=env).strip()
    owner = execute(
        [
            "docker",
            "inspect",
            "--format",
            '{{index .Config.Labels "com.docker.compose.project"}}',
            runner,
        ]
    ).strip()
    if owner != project:
        raise ValueError("Artifact faults require the matching disposable runner")


def verify(nk, compose, env, password, expected_run, expected_hash, report):
    require_disposable(nk, compose, env, report["compose_project"])
    evidence = {"status": "FAIL", "scenarios": {}}
    report["artifact_recovery"] = evidence
    for name, fault, internal_status, failed_checks in (
        (
            "token_rejected",
            lambda: rejected_token(nk),
            401,
            ("evidence", "results_directory", "result_artifact"),
        ),
        (
            "report_missing",
            lambda: missing_report(compose, env, expected_run["id"], expected_hash),
            404,
            ("result_artifact",),
        ),
        (
            "report_tampered",
            lambda: tampered_report(compose, env, expected_run["id"], expected_hash),
            200,
            ("result_artifact",),
        ),
    ):
        report["evaluation_phase"] = "artifact_" + name
        scenario = {"status": "FAIL", "recovery_verified": False}
        evidence["scenarios"][name] = scenario
        with fault() as altered, fork_web.forwards(nk):
            remote = artifact_response(nk, expected_run["id"])
            assert remote["status"] == internal_status
            if name == "report_tampered":
                assert remote == {"status": 200, **altered}
                assert remote["sha256"] != expected_hash
                scenario["tampered_report_sha256"] = remote["sha256"]
                scenario["report_bytes"] = remote["size"]
            scenario["failure"] = check_access(
                password, expected_run, expected_hash, failed_checks
            )
            scenario["artifact_http_status"] = internal_status
        with fork_web.forwards(nk):
            scenario["recovery"] = check_access(password, expected_run, expected_hash)
        scenario.update(
            status="PASS", recovery_verified=True, report_sha256=expected_hash
        )
    evidence["status"] = "PASS"
