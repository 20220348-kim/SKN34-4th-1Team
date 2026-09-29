"""기존 Core 관리자 로그인·Django CSRF·평가 접수·재전송·보고서 HTTP 경로를 무료로 검증한다."""

import argparse
from http.cookiejar import CookieJar
import json
import os
from pathlib import Path
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPCookieProcessor, Request, build_opener
from uuid import UUID, uuid4


def wait_for_list_state(request, run_id, expected="COMPLETED"):
    # 상세 API 호출로 상태 갱신을 유발하지 않는다. ops-sync의 DB 반영을 검증한다.
    deadline = time.monotonic() + 360
    while True:
        status, body, _ = request("/api/v1/ops/evaluations?page=1")
        assert status == 200, f"Ops list returned HTTP {status}"
        run = next((item for item in json.loads(body)["results"] if item["id"] == run_id), None)
        if run and run["status"] == expected:
            assert run["synced_at"] and run["sync_attempted_at"] and not run["status_stale"]
            return run
        if run and run["status"] in {"FAILED", "CRASHED", "CANCELLED", "RESULT_ERROR", "COMPLETED"}:
            raise RuntimeError(f'Unexpected evaluation state: {run["status"]} / {run["error_code"]}')
        if time.monotonic() >= deadline:
            raise RuntimeError("Background evaluation synchronization timed out")
        time.sleep(3)


def verify_runtime(request, run_id):
    status, body, _ = request("/api/v1/ops/runtime?run_id=" + run_id)
    runtime = json.loads(body)
    assert status == 200 and runtime["status"] == "PASS"
    assert set(runtime["checks"]) == {"evidence", "results_directory", "prefect_deployment", "result_artifact"}
    assert all(value == "PASS" for value in runtime["checks"].values())
    assert runtime["result_artifact_verified"] is True and runtime["evaluation_executed"] is False
    return runtime


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://localhost:5173")
    parser.add_argument("--seed-dev-accounts", action="store_true", help="격리 CI Core에서만 개발용 계정 생성")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--compare-captures", action="store_true", help="기존 프롬프트 실행의 공통 E01 비교")
    mode.add_argument("--recover-source", type=UUID, help="무료 fixture가 만든 실패 실행을 복구")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    base = args.base_url.rstrip("/")
    if urlsplit(base).hostname not in {"localhost", "127.0.0.1"}:
        parser.error("This smoke test requires a loopback web endpoint")
    cookies = CookieJar()
    client = build_opener(HTTPCookieProcessor(cookies))

    def request(path, data=None, *, csrf=True):
        headers = {"Origin": base}
        if data is not None:
            headers["Content-Type"] = "application/json"
            if csrf:
                headers["X-CSRFToken"] = next(c.value for c in cookies if c.name == "govbiz_ops_csrf")
            data = json.dumps(data).encode()
        try:
            response = client.open(Request(base + path, data=data, headers=headers), timeout=15)
        except HTTPError as exc:
            response = exc
        with response:
            return response.status, response.read(), response.headers

    deadline = time.monotonic() + 180
    while True:
        try:
            if request("/api/v1/ops/session")[0] == 200 and request("/api/v1/health")[0] == 200:
                break
        except (URLError, OSError):
            pass
        if time.monotonic() >= deadline:
            raise RuntimeError("Ops readiness timed out")
        time.sleep(2)
    assert request("/api/v1/ops/evaluations")[0] == 401
    assert request("/api/v1/ops/runtime")[0] == 401
    if args.seed_dev_accounts:
        # 이 플래그는 CI의 별도 Core/빈 DB fixture에만 사용한다. 기존 회원의 권한은 변경하지 않는다.
        assert request("/api/v1/auth/dev-login", {"role": "USER"}, csrf=False)[0] == 200
        assert request("/api/v1/ops/session")[0] == 403
        assert request("/api/v1/ops/evaluations")[0] == 403
        assert request("/api/v1/ops/runtime")[0] == 403
        assert request("/api/v1/auth/dev-login", {"role": "ADMIN"}, csrf=False)[0] == 200
        assert request("/api/v1/auth/logout", {}, csrf=False)[0] == 204
    status, body, _ = request("/api/v1/auth/login", {
        "email": os.environ["CORE_ADMIN_EMAIL"],
        "password": os.environ["CORE_ADMIN_PASSWORD"],
        "rememberMe": False,
    }, csrf=False)
    assert status == 200 and json.loads(body)["account"]["role"] == "ADMIN"
    status, body, _ = request("/api/v1/ops/session")
    assert status == 200 and json.loads(body)["user"]["username"] == os.environ["CORE_ADMIN_EMAIL"]
    datasets = {item["id"]: item for item in json.loads(body)["datasets"]}
    submit_path = "/api/v1/ops/evaluations"
    payload = {"request_id": str(uuid4()), "dataset_id": "target-coverage-20260907-v1"}
    if args.recover_source:
        source_id = str(args.recover_source)
        source = wait_for_list_state(request, source_id, "FAILED")
        status, body, _ = request(f"/api/v1/ops/evaluations/{source_id}")
        assert status == 200 and json.loads(body)["postprocessing"]["can_recover"]
        assert source["execution_mode"] == "replay" and source["model_api_calls"] == 0
        submit_path = f"/api/v1/ops/evaluations/{source_id}/recover"
        payload = {"request_id": payload["request_id"]}
    if args.compare_captures:
        payload.update(dataset_id="fixed-context-e01-v1",
                       candidate_capture_id="fixed-context-20260907-index-v1",
                       reference_capture_id="fixed-context-20260906-diagnostic-v1")
    if not args.recover_source:
        payload["execution_profile"] = datasets[payload["dataset_id"]]["execution_profiles"]["replay"]
    assert request(submit_path, payload, csrf=False)[0] == 403
    if not args.recover_source:
        assert request(submit_path, {**payload, "dataset_id": "../../invalid"})[0] == 400
    # deployment 등록 직후의 접수 지연도 같은 요청 ID로 복구한다.
    deadline = time.monotonic() + 300
    while True:
        status, body, _ = request(submit_path, payload)
        first = json.loads(body)
        if status in (200, 202) and first["prefect_flow_run_id"]:
            break
        assert status == 503
        if time.monotonic() >= deadline:
            raise RuntimeError("Deployment dispatch timed out")
        time.sleep(3)
    status, body, _ = request(submit_path, payload)
    replay = json.loads(body)
    assert status == 200 and replay["prefect_flow_run_id"] == first["prefect_flow_run_id"]
    run = wait_for_list_state(request, payload["request_id"])
    assert run["execution_spec_sha256"] == first["execution_spec_sha256"] == replay["execution_spec_sha256"]
    assert run["execution_spec"] and run["execution_spec"]["generation"] is None
    assert run["execution_spec"]["dataset"]["case_ids"] == run["comparison"]["case_ids"]
    if not args.recover_source:
        assert run["execution_profile"] == payload["execution_profile"]
    if args.recover_source:
        assert run["execution_mode"] == "recovery" and run["source_run_id"] == source_id
        assert run["model_api_calls"] == 0
        assert run["prefect_flow_run_id"] != source["prefect_flow_run_id"]
        assert wait_for_list_state(request, source_id, "FAILED")["prefect_flow_run_id"] == source["prefect_flow_run_id"]
    expected_count = 1 if args.compare_captures else 6
    assert run["summary"]["caseCount"] == expected_count
    comparison = run["comparison"]
    assert comparison["comparison"] == ("candidate-reference" if args.compare_captures else "self-replay")
    if args.compare_captures:
        assert comparison["case_ids"] == ["E01"]
        assert comparison["candidate_execution"]["source_case_ids"] == ["E01", "E07", "E10", "E12"]
        latency = next(item for item in comparison["metrics"] if item["key"] == "meanLatencyMs")
        assert abs(latency["delta"] - 117.477) < 0.001
        tokens = next(item for item in comparison["metrics"] if item["key"] == "meanOutputTokens")
        assert tokens["candidate"] is None and tokens["delta"] is None
        assert request("/api/v1/ops/evaluations", {**payload, "reference_capture_id": payload["candidate_capture_id"]})[0] == 409
    assert run["summary"]["statusAccuracy"] == 1
    assert run["summary"]["referenceCitationRecall"] == 1
    assert run["summary"]["semanticFaithfulness"] is None
    status, body, headers = request(run["report_url"])
    assert status == 200 and len(body) > 1000
    assert "sandbox allow-scripts;" in headers["Content-Security-Policy"]
    runtime = verify_runtime(request, run["id"])
    # Django 세션을 지우는 대신 Core 로그아웃 한 번으로 Ops도 차단되어야 한다.
    assert request("/api/v1/auth/logout", {}, csrf=False)[0] == 204
    assert request(run["report_url"])[0] == 401
    assert request("/api/v1/ops/evaluations")[0] == 401
    assert request("/api/v1/ops/runtime")[0] == 401
    summary = {
        "request_id": run["id"], "prefect_flow_run_id": run["prefect_flow_run_id"],
        "evaluation_run_id": run["evaluation_run_id"], "status": run["status"],
        "execution_spec_sha256": run["execution_spec_sha256"],
        "case_count": expected_count, "comparison": comparison["comparison"],
        "metrics": comparison["metrics"], "duplicate_request_same_flow": True, "csrf_enforced": True,
        "core_admin_login": True, "core_logout_revokes_ops": True,
        "deployment_runtime_checks": runtime,
        "background_sync_without_detail": True, "source_run_id": run.get("source_run_id"),
        "report_http_status": status, "model_api_calls": 0,
        "detail_url": base + run["detail_url"],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
