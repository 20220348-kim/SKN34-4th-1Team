"""Kubernetes Core/Ops/MySQL plus Compose runner integration for the disposable bridge smoke."""

import hashlib
import json
import os
import runpy
import secrets
import socket
import subprocess
import sys
import tempfile
import time
from urllib.error import URLError
from urllib.request import ProxyHandler, build_opener

import fork_cluster
import fork_web
import ops_runtime
import smoke_ops_artifacts
import smoke_ops_sync_recovery
import yaml
from check_msa import NAMESPACE, REPOSITORY_ROOT, ROOT
from ops_migration import run_migration
from portfolio_cluster import runtime_secrets
from smoke_ops_bridge import execute

BASE = "http://localhost:5173"


def database_record(nk, run_id):
    # UUID comes from a verified smoke result, never from shell interpolation.
    from uuid import UUID

    run_id = str(UUID(run_id))
    program = (
        "import os,json,hashlib; os.environ.setdefault('DJANGO_SETTINGS_MODULE','config.settings'); "
        "import django; django.setup(); "
        "from apps.evaluations.models import EvaluationRun; "
        "from apps.evaluations.execution_spec import RELEASE_PATH; "
        "from django.conf import settings; "
        f"rows=list(EvaluationRun.objects.filter(pk='{run_id}').values("
        "'id','status','prefect_flow_run_id','execution_spec_sha256','model_api_calls')); "
        "assert len(rows)==1 and rows[0]['status']=='COMPLETED' and rows[0]['model_api_calls']==0; "
        "assert settings.DATABASES['default']['HOST']=='ops-mysql'; "
        "assert settings.DATABASES['default']['NAME']=='govbiz_ops'; "
        "assert settings.LLMOPS_ARTIFACT_URL=='http://ops-compose-artifacts:8010'; "
        "print(json.dumps({'run':rows[0],'db_host':'ops-mysql','db_name':'govbiz_ops',"
        "'execution_release_sha256':hashlib.sha256(RELEASE_PATH.read_bytes()).hexdigest()},default=str))"
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


def verify(state, settings, compose, compose_env, ops_image, kind, helm, report):
    kube, nk, _ = fork_cluster.commands(state, settings)
    project = report["compose_project"]
    core_image = "govbiz-core-service:" + project
    image_loaded = False
    password = secrets.token_urlsafe(32)
    report["evaluation_status"] = "FAIL"
    report["evaluation_phase"] = "compose_preflight"
    try:
        # Validate the actual merged configuration before starting any evaluation runner.
        config = json.loads(
            execute(compose + ["config", "--format", "json"], env=compose_env)
        )
        runpy.run_path(
            str(REPOSITORY_ROOT / "infrastructure/llmops/check_artifact_compose.py")
        )["check"](config)
        # Only runner/observability services start here. Compose Ops and its DB remain absent.
        report["evaluation_phase"] = "compose_runner_start"
        execute(
            compose + ["up", "-d", "--build", "langfuse-worker", "evaluation-runner"],
            env=compose_env,
            timeout=1200,
        )
        services = set(
            execute(
                compose + ["ps", "--services", "--status", "running"], env=compose_env
            ).split()
        )
        assert not services & {
            "ops-service",
            "ops-sync",
            "ops-mysql",
            "auth-core",
            "auth-mysql",
        }
        report["compose_ops_absent"] = True
        execute(
            [
                "docker",
                "build",
                "-t",
                core_image,
                REPOSITORY_ROOT / "backend/core-service",
            ],
            timeout=1200,
        )
        image_loaded = True
        execute(
            [kind, "load", "docker-image", core_image, "--name", settings["cluster"]],
            timeout=300,
        )
        report["evaluation_phase"] = "kubernetes_database_and_auth"
        for resource in runtime_secrets():
            name = resource["metadata"]["name"]
            if name not in {
                "core-runtime",
                "core-mysql-runtime",
                "ops-runtime",
                "ops-mysql-runtime",
            }:
                continue
            if name == "core-runtime":
                resource["stringData"]["ACCOUNT_DEV_LOGIN_PASSWORD"] = password
            execute(kube + ["create", "-f", "-"], data=json.dumps(resource))
        mysql = execute(
            [
                helm,
                "template",
                "evaluation-data",
                ROOT / "charts/govbiz-local-data",
                "-n",
                NAMESPACE,
                "--set",
                "allowDisposableData=true",
                "--show-only",
                "templates/mysql.yaml",
            ]
        )
        resources = [
            item
            for item in yaml.safe_load_all(mysql)
            if item["metadata"]["name"] in {"core-mysql", "ops-mysql"}
        ]
        execute(kube + ["create", "-f", "-"], data=yaml.safe_dump_all(resources))
        for name in ("core-mysql", "ops-mysql"):
            execute(nk + ["rollout", "status", "statefulset/" + name, "--timeout=450s"])
        core_secrets = yaml.safe_load(
            (ROOT / "environments/portfolio/core-service.yaml").read_text()
        )["secretKeys"]
        overlay = {
            "core-service": {
                "env": {
                    "ACCOUNT_DEV_LOGIN_ENABLED": "true",
                    "ACCOUNT_DEV_LOGIN_EMAIL": "admin@govbiz.local",
                    "APP_CORS_ALLOWED_ORIGIN": BASE,
                },
                "secretKeys": core_secrets + ["ACCOUNT_DEV_LOGIN_PASSWORD"],
            }
        }
        images = {"core-service": core_image, "ops-service": ops_image}
        rendered = fork_cluster.render_services(
            helm, images, overlay=overlay, services=tuple(images)
        )
        for job in (
            item
            for item in yaml.safe_load_all(rendered["ops-service"])
            if item["kind"] == "Job"
        ):
            run_migration(job, kube, nk, fork_cluster.run)
        for service, manifest in rendered.items():
            execute(
                kube
                + ["apply", "--server-side", "--field-manager=govbiz-local", "-f", "-"],
                data=yaml.safe_dump_all(
                    item
                    for item in yaml.safe_load_all(manifest)
                    if item["kind"] != "Job"
                ),
            )
            execute(
                nk + ["rollout", "status", "deployment/" + service, "--timeout=600s"]
            )
        fork_cluster.write_json(
            state / "baseline.json", {"source": "local", "images": images}
        )
        # Real production activation: checks ownership/routes, patches only token, migrates, applies and diagnoses.
        report["evaluation_phase"] = "ops_activation"
        secret_before = json.loads(
            ops_runtime.quiet(nk + ["get", "secret", "ops-runtime", "-o", "json"])
        )["data"]
        ops_runtime.activate(state, settings, state / ".env", helm)
        secret_after = json.loads(
            ops_runtime.quiet(nk + ["get", "secret", "ops-runtime", "-o", "json"])
        )["data"]
        assert all(secret_after[key] == value for key, value in secret_before.items())
        ops_runtime.activate(state, settings, state / ".env", helm)
        assert (
            json.loads(
                ops_runtime.quiet(nk + ["get", "secret", "ops-runtime", "-o", "json"])
            )["data"]
            == secret_after
        )
        report["activation"] = "PASS"
        report["repeated_activation_preserves_secrets"] = True
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 5173))
        web_env = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith("VITE_")
        }
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
                        raise ValueError("Isolated Vite process exited")
                    try:
                        with build_opener(ProxyHandler({})).open(
                            BASE, timeout=3
                        ) as response:
                            assert response.status == 200
                        break
                    except (URLError, OSError):
                        if time.monotonic() >= deadline:
                            raise ValueError(
                                "Isolated Vite startup timed out"
                            ) from None
                        time.sleep(1)
                report["evaluation_phase"] = "authenticated_free_evaluation"
                output = state / "evaluation.json"
                env = {
                    **web_env,
                    "CORE_ADMIN_EMAIL": "admin@govbiz.local",
                    "CORE_ADMIN_PASSWORD": password,
                }
                execute(
                    [
                        sys.executable,
                        REPOSITORY_ROOT / "infrastructure/llmops/ops_smoke.py",
                        "--seed-dev-accounts",
                        "--base-url",
                        BASE,
                        "--storage-transport",
                        "http",
                        "--output",
                        output,
                    ],
                    env=env,
                    timeout=600,
                )
                result = json.loads(output.read_text())
                assert (
                    result["status"] == "COMPLETED" and result["model_api_calls"] == 0
                )
                report["evaluation"] = result
                report["evaluation_executed"] = True
                before = database_record(nk, result["request_id"])
                assert (
                    before["run"]["prefect_flow_run_id"]
                    == result["prefect_flow_run_id"]
                )
                original_report = smoke_ops_artifacts.read_completed_report(
                    password, result["request_id"]
                )
            finally:
                web.terminate()
                try:
                    web.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    web.kill()
                    web.wait(timeout=5)
        # Restart the entire API+sync Pod; do not read detail endpoints to repair state.
        report["evaluation_phase"] = "restart_preservation"
        old_pod = json.loads(
            execute(
                nk
                + [
                    "get",
                    "pods",
                    "-l",
                    "app.kubernetes.io/name=ops-service",
                    "-o",
                    "json",
                ]
            )
        )["items"][0]["metadata"]["uid"]
        execute(nk + ["rollout", "restart", "deployment/ops-service"])
        execute(nk + ["rollout", "status", "deployment/ops-service", "--timeout=300s"])
        after = database_record(nk, result["request_id"])
        assert after == before
        pod = json.loads(
            execute(
                nk
                + [
                    "get",
                    "pods",
                    "-l",
                    "app.kubernetes.io/name=ops-service",
                    "-o",
                    "json",
                ]
            )
        )["items"][0]
        assert pod["metadata"]["uid"] != old_pod
        # Query the restarted Pod over its new owned forwarding process.
        with tempfile.TemporaryFile(mode="w+t") as log:
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
                with fork_web.forwards(nk):
                    deadline = time.monotonic() + 90
                    while True:
                        if web.poll() is not None:
                            raise ValueError("Restart verification Vite process exited")
                        try:
                            restored_report = smoke_ops_artifacts.read_completed_report(
                                password, result["request_id"]
                            )
                            break
                        except (URLError, OSError):
                            if time.monotonic() >= deadline:
                                raise
                            time.sleep(1)
                    assert restored_report == original_report
                smoke_ops_artifacts.verify(
                    nk,
                    compose,
                    compose_env,
                    password,
                    before["run"],
                    original_report,
                    report,
                )
                smoke_ops_sync_recovery.verify(
                    nk,
                    compose,
                    compose_env,
                    password,
                    before["run"],
                    original_report,
                    report,
                )
                recovered = report["sync_recovery"]["completed"]
                recovered_db = database_record(nk, recovered["id"])
                assert recovered_db["run"] == {
                    key: recovered[key] for key in recovered_db["run"]
                }
                report["sync_recovery"]["kubernetes_database"] = recovered_db
                assert database_record(nk, result["request_id"]) == before
            finally:
                web.terminate()
                try:
                    web.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    web.kill()
                    web.wait(timeout=5)
        report.update(
            evaluation_status="PASS",
            evaluation_phase="complete",
            restart_preserves_db_and_report=True,
            kubernetes_database=after,
            report_sha256=original_report,
            ops_image_ids={
                item["name"]: item["imageID"]
                for item in pod["status"]["containerStatuses"]
            },
            runner_image_id=execute(
                [
                    "docker",
                    "inspect",
                    "--format",
                    "{{.Image}}",
                    execute(
                        compose + ["ps", "-q", "evaluation-runner"], env=compose_env
                    ).strip(),
                ]
            ).strip(),
            source_sha=execute(
                ["git", "-C", REPOSITORY_ROOT, "rev-parse", "HEAD"]
            ).strip(),
            worktree_diff_sha256=hashlib.sha256(
                execute(
                    [
                        "git",
                        "-C",
                        REPOSITORY_ROOT,
                        "diff",
                        "HEAD",
                        "--",
                        "infrastructure",
                        ".github",
                    ]
                ).encode()
            ).hexdigest(),
        )
    finally:
        if image_loaded:
            execute(["docker", "image", "rm", core_image], timeout=60)
