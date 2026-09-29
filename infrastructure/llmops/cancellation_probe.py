"""격리 취소 테스트의 HTTP 모델 대역·장애 주입기. production 이미지에 포함하지 않는다."""

import json
import os
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Event, Lock
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from uuid import UUID

TOKEN = "offline-cancellation-test-token-not-for-deployment"
USAGE = {"input_tokens": 100, "output_tokens": 50, "total_tokens": 150}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def exchange(url, method, body=None, headers=None):
    try:
        response = build_opener(NoRedirect()).open(
            Request(url, data=body, method=method, headers=headers or {}),
            timeout=10,
        )
    except HTTPError as error:
        response = error
    with response:
        return response.status, response.read()


def control_request(payload):
    """Execute the smoke client's HTTP request inside the isolated test network."""
    url = urlsplit(payload["url"])
    if (
        url.scheme != "http"
        or url.netloc not in {"cancellation-probe:8099", "ops-service:8000", "prefect:4200"}
        or url.fragment
    ):
        raise ValueError("Only cancellation test services are allowed")
    data = payload.get("data")
    raw = json.dumps(data).encode() if data is not None else None
    try:
        response = build_opener(ProxyHandler({}), NoRedirect()).open(
            Request(
                payload["url"],
                data=raw,
                headers={"Content-Type": "application/json", **payload.get("headers", {})},
            ),
            timeout=20,
        )
    except HTTPError as error:
        response = error
    with response:
        body = response.read()
        cookies = SimpleCookie()
        for header in response.headers.get_all("Set-Cookie", []):
            cookies.load(header)
        try:
            decoded = json.loads(body) if body else None
        except json.JSONDecodeError:
            # Preserve the client's decoding failure without leaking an HTML error body.
            return {"status": response.status, "response_error": "invalid_json"}
        return {
            "status": response.status,
            "body": decoded,
            "cookies": {key: value.value for key, value in cookies.items()},
        }


def model_response(model):
    # 품질 정답을 흉내 내지 않는다. 생명주기 검증용으로 유효한 계약/사용량만 반환한다.
    answer = {
        "answer": "테스트 자료만으로는 확인할 수 없습니다.",
        "answerStatus": "INSUFFICIENT_EVIDENCE",
        "citationChunkIndexes": [],
    }
    return {
        "id": "resp_offline",
        "object": "response",
        "created_at": 0,
        "status": "completed",
        "model": model,
        "output": [
            {
                "id": "msg_offline",
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "content": [
                    {
                        "type": "output_text",
                        "annotations": [],
                        "text": json.dumps(answer, ensure_ascii=False),
                    }
                ],
            }
        ],
        "usage": USAGE,
    }


class Probe:
    def __init__(self):
        self.lock = Lock()
        self.runs = {}
        self.flow_runs = {}

    def configure(self, run_id, config):
        UUID(run_id)
        with self.lock:
            if run_id in self.runs:
                raise ValueError("Run already configured")
            self.runs[run_id] = {"config": config, "events": [], "release": Event()}

    def event(self, run_id, stage, **values):
        with self.lock:
            self.runs[run_id]["events"].append({"stage": stage, **values})

    def snapshot(self, run_id):
        with self.lock:
            return {"events": list(self.runs[run_id]["events"])}

    def release(self, run_id):
        with self.lock:
            self.runs[run_id]["release"].set()

    def gate(self, run_id, stage):
        self.event(run_id, stage)
        with self.lock:
            record = self.runs[run_id]
            should_wait = record["config"].get("hold") == stage
        if should_wait and not record["release"].wait(180):
            self.event(run_id, "barrier_timeout")
            raise TimeoutError("Test barrier was not released")

    def forward(self, run_id, action, url, method, body, headers):
        with self.lock:
            fault = self.runs[run_id]["config"].get("fault")
        if fault == action + "_error" or (
            fault == "settle_and_close_error" and action in {"settle", "close"}
        ):
            self.event(run_id, action, status=503, forwarded=False)
            return 503, b'{"error":"injected_http_failure"}'
        status, result = exchange(url, method, body, headers)
        self.event(run_id, action, status=status, forwarded=True)
        if action == "create" and status in (200, 201):
            flow_id = json.loads(result)["id"]
            with self.lock:
                self.flow_runs[flow_id] = run_id
        if fault == action + "_lost":
            # 실제 서버의 처리 이후 연결만 끊는다. DB/Prefect 상태를 덮어쓰지 않는다.
            return None, b""
        return status, result


def handler(probe):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # 쿠키/키/질문/응답 원문을 로그에 남기지 않는다.

        def do_GET(self):
            self.handle_request()

        def do_POST(self):
            self.handle_request()

        def handle_request(self):
            try:
                status, body = self.route()
                if status is None:
                    self.close_connection = True
                    return
                raw = body if isinstance(body, bytes) else json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
            except (BrokenPipeError, ConnectionResetError):
                pass  # 종료된 실행기가 의도적으로 연결을 버린 경우.
            except Exception as error:
                self.send_error(500, type(error).__name__)

        def route(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            data = json.loads(body) if body else {}
            parts = self.path.strip("/").split("/")
            if self.path == "/health":
                return 200, {"ready": True}
            if self.path == "/langfuse-health":
                return exchange("http://langfuse-web:3000/api/public/health", "GET")
            if self.path == "/api/v1/admin/session":
                if self.headers.get("Cookie") != "govbiz_session=offline-admin-session":
                    return 401, {}
                return 200, {"accountId": 1, "email": "cancel-test@localhost.test", "role": "ADMIN"}
            if len(parts) == 3 and parts[0] == "control":
                _, run_id, action = parts
                if action == "configure":
                    probe.configure(run_id, data)
                elif action == "release":
                    probe.release(run_id)
                elif action == "state":
                    return 200, probe.snapshot(run_id)
                elif action == "fault":
                    with probe.lock:
                        probe.runs[run_id]["config"]["fault"] = data["fault"]
                else:
                    return 404, {}
                return 200, {"accepted": True}
            if len(parts) == 3 and parts[0] == "barrier":
                probe.gate(parts[1], parts[2])
                return 200, {"accepted": True}
            if len(parts) == 2 and parts[0] == "model":
                run_id = str(UUID(parts[1]))
                probe.gate(run_id, "model_sent")
                with probe.lock:
                    lost = probe.runs[run_id]["config"].get("fault") == "model_lost"
                return (None, b"") if lost else (200, model_response(data["model"]))
            if len(parts) == 6 and parts[:3] == ["internal", "llmops", "evaluations"]:
                run_id, _, action = parts[3:]
                if parts[4] != "budget" or action not in {"claim", "authorize", "settle", "close"}:
                    return 404, {}
                return probe.forward(
                    run_id,
                    action,
                    "http://ops-service:8000" + self.path,
                    self.command,
                    body,
                    {
                        "Content-Type": "application/json",
                        "Authorization": self.headers.get("Authorization", ""),
                    },
                )
            if parts[0] == "api":
                run_id = None
                if len(parts) == 4 and parts[1] == "deployments" and parts[3] == "create_flow_run":
                    run_id = data["parameters"]["request_id"]
                    action = "create"
                elif len(parts) == 4 and parts[1] == "flow_runs" and parts[3] == "set_state":
                    with probe.lock:
                        run_id = probe.flow_runs[parts[2]]
                    action = "cancel"
                url = "http://prefect:4200" + self.path
                headers = {"Content-Type": "application/json"}
                if run_id:
                    return probe.forward(run_id, action, url, self.command, body, headers)
                return exchange(url, self.command, body or None, headers)
            return 404, {}

    return Handler


def database_snapshot(run_id):
    # 읽기만 한다. 실행 접수/취소/정산은 모두 실제 HTTP API로 수행한다.
    import sys

    sys.path.insert(0, "/app")
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
    import django

    django.setup()
    from apps.evaluations.models import EvaluationBudget, EvaluationRun

    budget = EvaluationBudget.objects.get(pk=1)
    result = {"allocated": [budget.allocated_calls, budget.allocated_output_tokens]}
    if run_id:
        run = EvaluationRun.objects.get(pk=UUID(run_id))
        reservation = run.budget_reservation
        result.update(
            status=run.status,
            flow_id=str(run.prefect_flow_run_id),
            worker_id=str(reservation.worker_id) if reservation.worker_id else None,
            spec_hash=run.execution_spec_sha256,
            closed=reservation.closed_at is not None,
            reserved_calls=reservation.max_calls,
            reserved_output_tokens=reservation.max_calls * reservation.max_output_tokens,
            calls=list(reservation.calls.order_by("sequence").values("sequence", "output_tokens")),
        )
    return result


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "snapshot":
        print(json.dumps(database_snapshot(sys.argv[2] if len(sys.argv) > 2 else None)))
    elif len(sys.argv) > 1 and sys.argv[1] == "request":
        # JSON/stdin keeps cookies, authorization and request bodies out of process arguments.
        try:
            result = control_request(json.load(sys.stdin))
        except (URLError, OSError) as error:
            result = {"transport_error": type(error).__name__}
        print(json.dumps(result))
    else:
        ThreadingHTTPServer(("0.0.0.0", 8099), handler(Probe())).serve_forever()
