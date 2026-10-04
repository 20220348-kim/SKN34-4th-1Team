"""Kubernetes Core/Ops/MySQL plus Compose runner integration for the disposable bridge smoke."""

import hashlib
import json
import os
import re
import runpy
import secrets
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import ProxyHandler, build_opener

import fork_cluster
import fork_web
import ops_runtime
import smoke_ops_artifacts
import smoke_ops_backup
import smoke_ops_replacement
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


def verify_upgrade_probe_database(nk):
    """Run read checks against isolated MySQL fixtures, then roll back fixtures."""
    probe = Path(__file__).with_name("ops_upgrade_probe.py").read_text()
    program = (
        "import os; os.environ.setdefault('DJANGO_SETTINGS_MODULE','config.settings')\n"
        "import django; django.setup()\n"
        "namespace={'__name__':'upgrade_probe'}\n"
        f"exec({probe!r}, namespace)\n"
        "snapshot=namespace['database_snapshot']\n"
        "from django.contrib.auth import get_user_model\n"
        "from django.db import transaction\n"
        "from django.utils import timezone\n"
        "from datetime import time, timedelta\n"
        "from uuid import uuid4\n"
        "from apps.evaluations.models import EvaluationRun, EvaluationBudget, EvaluationBudgetReservation\n"
        "from apps.evaluations.models import EvaluationSchedule, EvaluationScheduleOccurrence\n"
        "from apps.evaluations.schedules import pause_schedule\n"
        "before=snapshot()\n"
        "with transaction.atomic():\n"
        "    user=get_user_model().objects.create_user('upgrade-probe-'+uuid4().hex)\n"
        "    states=[*EvaluationRun.Status.values, 'UNKNOWN']\n"
        "    for state in states:\n"
        "        EvaluationRun.objects.create(requested_by=user,dataset_id='probe-fixture',status=state)\n"
        "    expected=dict(before['states'])\n"
        "    for state in states: expected[state]=expected.get(state,0)+1\n"
        "    assert snapshot()['states']==expected\n"
        "    run=EvaluationRun.objects.get(requested_by=user,status='FAILED')\n"
        "    budget,_=EvaluationBudget.objects.get_or_create(pk=1)\n"
        "    reservation=EvaluationBudgetReservation.objects.create(run=run,budget=budget,max_calls=0,max_output_tokens=0)\n"
        "    assert snapshot()['open_reservations']==before['open_reservations']+1\n"
        "    reservation.closed_at=timezone.now(); reservation.save(update_fields=['closed_at'])\n"
        "    assert snapshot()['open_reservations']==before['open_reservations']\n"
        "    for offset in (-3, 3):\n"
        "        day=timezone.now().date()+timedelta(days=offset)\n"
        "        schedule=EvaluationSchedule.objects.create(\n"
        "            id=uuid4(),dataset_id='probe-schedule',active_dataset='probe-schedule',\n"
        "            requested_by=user,request={},max_usage={},daily_at=time(9),\n"
        "            starts_on=day,ends_on=day,reason='synthetic upgrade probe')\n"
        "        assert snapshot()['unpaused_ops_schedules']==before['unpaused_ops_schedules']+1\n"
        "        occurrence=EvaluationScheduleOccurrence.objects.create(\n"
        "            id=uuid4(),schedule=schedule,scheduled_on=day)\n"
        "        assert snapshot()['unsettled_schedule_occurrences']==before['unsettled_schedule_occurrences']+1\n"
        "        pause_schedule(schedule.pk,user,request_id=uuid4(),reason='synthetic pause')\n"
        "        assert snapshot()['unpaused_ops_schedules']==before['unpaused_ops_schedules']\n"
        "        assert snapshot()['unsettled_schedule_occurrences']==before['unsettled_schedule_occurrences']+1\n"
        "        occurrence.status='BLOCKED'; occurrence.reason_code='SYNTHETIC_UPGRADE_CHECK'\n"
        "        occurrence.save(update_fields=['status','reason_code'])\n"
        "        assert snapshot()['unsettled_schedule_occurrences']==before['unsettled_schedule_occurrences']\n"
        "        EvaluationScheduleOccurrence.objects.create(\n"
        "            id=uuid4(),schedule=schedule,scheduled_on=day+timedelta(days=1),\n"
        "            status='SUBMITTED',run=run)\n"
        "        assert snapshot()['unsettled_schedule_occurrences']==before['unsettled_schedule_occurrences']\n"
        "        run=EvaluationRun.objects.get(requested_by=user,status='CANCELLED')\n"
        "    transaction.set_rollback(True)\n"
        "assert snapshot()==before\n"
        "print('PASS')\n"
    )
    result = ops_runtime.quiet(
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
    assert result.strip() == "PASS", "Upgrade probe database verification failed"


def set_admission(nk, action, version):
    from uuid import uuid4

    result = json.loads(
        ops_runtime.quiet(
            nk
            + [
                "exec",
                "deployment/ops-service",
                "-c",
                "ops-service",
                "--",
                "python",
                "manage.py",
                "evaluation_admission",
                action,
                "--expected-version",
                str(version),
                "--request-id",
                str(uuid4()),
                "--actor",
                "isolated-bridge-smoke",
                "--reason",
                "Verify upgrade admission control without model calls",
            ],
        )
    )
    assert result["version"] == version + 1
    assert result["accepting"] is (action == "resume")
    return result


def free_evaluation(output, password, web_env, *, seed=False, rag_replay=False):
    env = {
        **web_env,
        "CORE_ADMIN_EMAIL": "admin@govbiz.local",
        "CORE_ADMIN_PASSWORD": password,
    }
    execute(
        [
            sys.executable,
            REPOSITORY_ROOT / "infrastructure/llmops/ops_smoke.py",
            *(["--seed-dev-accounts"] if seed else []),
            *(["--rag-replay"] if rag_replay else []),
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
    assert result["status"] == "COMPLETED" and result["model_api_calls"] == 0
    if rag_replay:
        assert result["case_count"] == 3 and result["comparison"] == "self-replay"
        assert result["rag_replay"]["scope"] == "source-chunks-retrieval-answer"
        assert result["rag_replay"]["measurement_kind"] == "synthetic-contract-check"
        assert result["rag_replay"]["baseline_eligible"] is False
        assert result["rag_replay"]["live_execution_performed"] is False
    return result


def browser_login(password, expected, web_env):
    """Use only the Vite and forwards owned by this disposable smoke."""
    result = json.loads(
        execute(
            ["node", Path(__file__).with_name("ops_browser_login.mjs")],
            data=json.dumps(
                {
                    "origin": BASE,
                    "email": "admin@govbiz.local",
                    "password": password,
                    "expected": expected,
                }
            ),
            env=web_env,
            timeout=180,
        )
    )
    version = result.get("browser_version") if isinstance(result, dict) else None
    if not isinstance(version, str) or not re.fullmatch(
        r"[0-9]+(?:\.[0-9]+){3}", version
    ):
        raise ValueError("Missing Kubernetes browser version evidence")
    count = result.get("listed_run_count")
    if type(count) is not int or not len(expected) <= count <= 1000:
        raise ValueError("Incomplete Kubernetes browser pagination evidence")
    required = {
        "status": "PASS",
        "response_source": "core_ops_http",
        "browser_version": version,
        "password_login_verified": True,
        "httponly_cookie_received": True,
        "core_ops_identity_verified": True,
        "listed_run_count": count,
        "pages_verified": (count + 24) // 25,
        "pagination_complete": True,
        "reload_verified": True,
        "details_verified": len(expected),
        "reports_verified": len(expected),
        "logout_verified": True,
        "unauthorized_after_logout": True,
        "revoked_session_rejected": True,
        "browser_closed": True,
    }
    if json.dumps(result, sort_keys=True) != json.dumps(required, sort_keys=True):
        raise ValueError("Incomplete Kubernetes browser login evidence")
    return result


def verify_execution_record(nk, result):
    record = database_record(nk, result["request_id"])
    assert record["run"]["id"] == result["request_id"]
    for key in (
        "status",
        "prefect_flow_run_id",
        "execution_spec_sha256",
        "model_api_calls",
    ):
        assert record["run"][key] == result[key]
    flows = smoke_ops_sync_recovery.prefect_runs(nk, result["request_id"])
    assert len(flows) == 1 and flows[0]["state"] == "COMPLETED"
    assert flows[0]["id"] == result["prefect_flow_run_id"]
    assert flows[0]["spec"] == result["execution_spec_sha256"]
    return record


def rag_evaluation(nk, output, password, web_env):
    result = free_evaluation(output, password, web_env, rag_replay=True)
    evidence = {"evaluation": result}
    evidence["kubernetes_database"] = verify_execution_record(nk, result)
    evidence["request_flow_count"] = 1
    evidence["report_sha256"] = smoke_ops_artifacts.read_completed_report(
        password, result["request_id"]
    )
    return evidence


def check_rag_preserved(nk, password, evidence):
    assert (
        database_record(nk, evidence["evaluation"]["request_id"])
        == evidence["kubernetes_database"]
    )
    return smoke_ops_artifacts.check_access(
        password, evidence["kubernetes_database"]["run"], evidence["report_sha256"]
    )


def verify(state, settings, compose, compose_env, ops_image, kind, helm, report):
    kube, nk, _ = fork_cluster.commands(state, settings)
    project = report["compose_project"]
    core_image = "govbiz-core-service:" + project
    image_loaded = False
    password = secrets.token_urlsafe(32)
    report["evaluation_status"] = "FAIL"
    report["rag_replay"] = {"status": "FAIL"}
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
        report["upgrade_preflight_open_admission"] = ops_runtime.upgrade_preflight(
            state, settings
        )
        open_preflight = report["upgrade_preflight_open_admission"]
        assert open_preflight["status"] == "BLOCKED"
        assert open_preflight["reason"] == "admission_open"
        assert open_preflight["admission_supported"] is True
        assert open_preflight["admission_blocked"] is False
        assert open_preflight["admission_version"] == 0
        assert open_preflight["checks"]["open_admission"] == 1
        report["admission_pause"] = set_admission(nk, "pause", 0)
        ops_runtime.activate(state, settings, state / ".env", helm)
        assert (
            json.loads(
                ops_runtime.quiet(nk + ["get", "secret", "ops-runtime", "-o", "json"])
            )["data"]
            == secret_after
        )
        report["activation"] = "PASS"
        report["repeated_activation_preserves_secrets"] = True
        verify_upgrade_probe_database(nk)
        report["upgrade_probe_mysql"] = "PASS"
        report["upgrade_preflight_before_evaluation"] = ops_runtime.upgrade_preflight(
            state, settings
        )
        paused_preflight = report["upgrade_preflight_before_evaluation"]
        assert paused_preflight["schemaVersion"] == 4
        assert paused_preflight["status"] == "PASS"
        assert paused_preflight["admission_supported"] is True
        assert paused_preflight["admission_blocked"] is True
        assert (
            paused_preflight["admission_version"]
            == report["admission_pause"]["version"]
        )
        assert paused_preflight["checks"]["open_admission"] == 0
        assert paused_preflight["checks"]["unpaused_ops_schedules"] == 0
        assert paused_preflight["checks"]["unsettled_schedule_occurrences"] == 0
        report["admission_resume"] = set_admission(nk, "resume", 1)
        report["runtime_check_before_evaluation"] = ops_runtime.check_runtime(
            state, settings
        )
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 5173))
        web_env = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith("VITE_")
        }
        web_env.update(
            K8S_CORE_PORT="18080", K8S_OPS_PORT="18001", K8S_DEV_LOGIN="false"
        )
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
                result = free_evaluation(
                    state / "evaluation.json", password, web_env, seed=True
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
                report["evaluation_phase"] = "authenticated_rag_replay"
                rag_before = rag_evaluation(
                    nk, state / "rag-evaluation.json", password, web_env
                )
                report["rag_replay"]["initial"] = rag_before
                report["evaluation_phase"] = "kubernetes_browser_login"
                report["browser_login"] = browser_login(
                    password,
                    {
                        item["request_id"]: {
                            "execution_spec_sha256": item["execution_spec_sha256"],
                            "report_sha256": report_hash,
                        }
                        for item, report_hash in (
                            (result, original_report),
                            (rag_before["evaluation"], rag_before["report_sha256"]),
                        )
                    },
                    web_env,
                )
                if (
                    database_record(nk, result["request_id"]) != before
                    or database_record(nk, rag_before["evaluation"]["request_id"])
                    != rag_before["kubernetes_database"]
                ):
                    raise ValueError("Browser verification changed evaluation records")
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
                    report["rag_replay"]["pod_restart"] = check_rag_preserved(
                        nk,
                        password,
                        rag_before,
                    )
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
                smoke_ops_replacement.verify(
                    state,
                    settings,
                    compose,
                    compose_env,
                    password,
                    before["run"],
                    original_report,
                    report,
                )
                report["evaluation_phase"] = "evaluation_after_replacement"
                with fork_web.forwards(nk):
                    fresh = free_evaluation(
                        state / "replacement-evaluation.json", password, web_env
                    )
                    report["evaluation_phase"] = "rag_replay_after_replacement"
                    rag_after = rag_evaluation(
                        nk, state / "replacement-rag-evaluation.json", password, web_env
                    )
                    report["rag_replay"]["after_replacement"] = rag_after
                    report["rag_replay"]["endpoint_replacement"] = check_rag_preserved(
                        nk,
                        password,
                        rag_before,
                    )
                assert fresh["request_id"] not in {
                    result["request_id"],
                    recovered["id"],
                }
                assert fresh["prefect_flow_run_id"] not in {
                    result["prefect_flow_run_id"],
                    recovered["prefect_flow_run_id"],
                }
                fresh_db = verify_execution_record(nk, fresh)
                requests = [
                    result,
                    fresh,
                    rag_before["evaluation"],
                    rag_after["evaluation"],
                ]
                assert (
                    len({item["request_id"] for item in requests} | {recovered["id"]})
                    == 5
                )
                assert (
                    len(
                        {item["prefect_flow_run_id"] for item in requests}
                        | {recovered["prefect_flow_run_id"]}
                    )
                    == 5
                )
                assert (
                    rag_before["evaluation"]["execution_spec_sha256"]
                    == rag_after["evaluation"]["execution_spec_sha256"]
                )
                assert (
                    database_record(nk, rag_before["evaluation"]["request_id"])
                    == rag_before["kubernetes_database"]
                )
                assert database_record(nk, recovered["id"]) == recovered_db
                assert database_record(nk, result["request_id"]) == before
                report["runtime_check_after_replacement"] = ops_runtime.check_runtime(
                    state, settings, rag_after["evaluation"]["request_id"]
                )
                report["replacement_recovery"].update(
                    status="PASS",
                    new_evaluation=fresh,
                    kubernetes_database=fresh_db,
                    new_request_flow_count=1,
                )
                report["rag_replay"]["status"] = "PASS"
            finally:
                web.terminate()
                try:
                    web.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    web.kill()
                    web.wait(timeout=5)
        report["evaluation_phase"] = "database_restore_rehearsal"
        report["backup_admission_pause"] = set_admission(
            nk, "pause", report["admission_resume"]["version"]
        )
        runner_image_id = smoke_ops_backup.verify(
            state,
            settings,
            report,
            ops_image=ops_image,
            core_image=core_image,
            core_password=password,
            compose=compose,
            compose_env=compose_env,
            expected={
                item["request_id"]: {
                    "flow_id": item["prefect_flow_run_id"],
                    "execution_spec_sha256": item["execution_spec_sha256"],
                    "report_sha256": report_hash,
                }
                for item, report_hash in (
                    (result, original_report),
                    (rag_before["evaluation"], rag_before["report_sha256"]),
                    (rag_after["evaluation"], rag_after["report_sha256"]),
                )
            },
            release_sha256=before["execution_release_sha256"],
        )
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
            runner_image_id=runner_image_id,
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
