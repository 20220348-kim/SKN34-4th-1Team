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
from uuid import uuid4


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://localhost:5173")
    parser.add_argument("--seed-dev-accounts", action="store_true", help="격리 CI Core에서만 개발용 계정 생성")
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
    if args.seed_dev_accounts:
        # 이 플래그는 CI의 별도 Core/빈 DB fixture에만 사용한다. 기존 회원의 권한은 변경하지 않는다.
        assert request("/api/v1/auth/dev-login", {"role": "USER"}, csrf=False)[0] == 200
        assert request("/api/v1/ops/session")[0] == 403
        assert request("/api/v1/ops/evaluations")[0] == 403
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
    payload = {"request_id": str(uuid4()), "dataset_id": "target-coverage-20260907-v1"}
    assert request("/api/v1/ops/evaluations", payload, csrf=False)[0] == 403
    assert request("/api/v1/ops/evaluations", {**payload, "dataset_id": "../../invalid"})[0] == 400
    # deployment 등록 직후의 접수 지연도 같은 요청 ID로 복구한다.
    deadline = time.monotonic() + 300
    while True:
        status, body, _ = request("/api/v1/ops/evaluations", payload)
        first = json.loads(body)
        if status in (200, 202) and first["prefect_flow_run_id"]:
            break
        assert status == 503
        if time.monotonic() >= deadline:
            raise RuntimeError("Deployment dispatch timed out")
        time.sleep(3)
    status, body, _ = request("/api/v1/ops/evaluations", payload)
    replay = json.loads(body)
    assert status == 200 and replay["prefect_flow_run_id"] == first["prefect_flow_run_id"]
    deadline = time.monotonic() + 360
    while True:
        status, body, _ = request(f'/api/v1/ops/evaluations/{payload["request_id"]}')
        run = json.loads(body)
        assert status == 200, f"Ops detail returned HTTP {status}"
        if run["status"] == "COMPLETED":
            break
        if run["status"] in {"FAILED", "CRASHED", "CANCELLED", "RESULT_ERROR"}:
            raise RuntimeError(f'Ops evaluation failed: {run["status"]} / {run["error_code"]}')
        if time.monotonic() >= deadline:
            raise RuntimeError("Ops evaluation completion timed out")
        time.sleep(3)
    assert run["summary"]["caseCount"] == 6
    assert run["summary"]["statusAccuracy"] == 1
    assert run["summary"]["referenceCitationRecall"] == 1
    assert run["summary"]["semanticFaithfulness"] is None
    status, body, headers = request(run["report_url"])
    assert status == 200 and len(body) > 1000
    assert "sandbox allow-scripts;" in headers["Content-Security-Policy"]
    # Django 세션을 지우는 대신 Core 로그아웃 한 번으로 Ops도 차단되어야 한다.
    assert request("/api/v1/auth/logout", {}, csrf=False)[0] == 204
    assert request(run["report_url"])[0] == 401
    assert request("/api/v1/ops/evaluations")[0] == 401
    summary = {
        "request_id": run["id"], "prefect_flow_run_id": run["prefect_flow_run_id"],
        "evaluation_run_id": run["evaluation_run_id"], "status": run["status"],
        "case_count": 6, "duplicate_request_same_flow": True, "csrf_enforced": True,
        "core_admin_login": True, "core_logout_revokes_ops": True,
        "report_http_status": status, "model_api_calls": 0,
        "detail_url": base + run["detail_url"],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
