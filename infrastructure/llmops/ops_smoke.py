"""실제 Django 로그인·CSRF·평가 접수·재전송·보고서 HTTP 경로를 무료로 검증한다."""

import argparse
from http.cookiejar import CookieJar
import json
import os
from pathlib import Path
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPCookieProcessor, Request, build_opener
from uuid import uuid4


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://localhost:18001")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    base = args.base_url.rstrip("/")
    if urlsplit(base).hostname not in {"localhost", "127.0.0.1"}:
        parser.error("This smoke test requires a loopback Django endpoint")
    cookies = CookieJar()
    client = build_opener(HTTPCookieProcessor(cookies))

    def request(path, data=None, *, form=False, csrf=True):
        headers = {}
        if data is not None:
            headers["Content-Type"] = "application/x-www-form-urlencoded" if form else "application/json"
            if csrf:
                headers["X-CSRFToken"] = next(c.value for c in cookies if c.name == "govbiz_ops_csrf")
            data = (urlencode(data) if form else json.dumps(data)).encode()
        try:
            response = client.open(Request(base + path, data=data, headers=headers), timeout=15)
        except HTTPError as exc:
            response = exc
        with response:
            return response.status, response.read(), response.headers

    deadline = time.monotonic() + 180
    while True:
        try:
            if request("/api/v1/health/ready")[0] == 200:
                break
        except (URLError, OSError):
            pass
        if time.monotonic() >= deadline:
            raise RuntimeError("Ops readiness timed out")
        time.sleep(2)
    assert request("/api/v1/evaluations")[0] == 403
    assert request("/ops/login")[0] == 200
    status, body, _ = request("/ops/login", {
        "username": os.environ["OPS_ADMIN_USERNAME"],
        "password": os.environ["OPS_ADMIN_PASSWORD"],
    }, form=True)
    assert status == 200 and "평가 실행 관리" in body.decode()
    payload = {"request_id": str(uuid4()), "dataset_id": "target-coverage-20260907-v1"}
    assert request("/api/v1/evaluations", payload, csrf=False)[0] == 403
    assert request("/api/v1/evaluations", {**payload, "dataset_id": "../../invalid"})[0] == 400
    # deployment 등록 직후의 접수 지연도 같은 요청 ID로 복구한다.
    deadline = time.monotonic() + 300
    while True:
        status, body, _ = request("/api/v1/evaluations", payload)
        first = json.loads(body)
        if status in (200, 202) and first["prefect_flow_run_id"]:
            break
        assert status == 503
        if time.monotonic() >= deadline:
            raise RuntimeError("Deployment dispatch timed out")
        time.sleep(3)
    status, body, _ = request("/api/v1/evaluations", payload)
    replay = json.loads(body)
    assert status == 200 and replay["prefect_flow_run_id"] == first["prefect_flow_run_id"]
    deadline = time.monotonic() + 360
    while True:
        status, body, _ = request(f'/api/v1/evaluations/{payload["request_id"]}')
        run = json.loads(body)
        assert status == 200
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
    summary = {
        "request_id": run["id"], "prefect_flow_run_id": run["prefect_flow_run_id"],
        "evaluation_run_id": run["evaluation_run_id"], "status": run["status"],
        "case_count": 6, "duplicate_request_same_flow": True, "csrf_enforced": True,
        "report_http_status": status, "model_api_calls": 0,
        "detail_url": base + run["detail_url"],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
