"""서버 없이 실행 가능한 실패 판정과 실제 SDK→HTTP 모델 대역 계약 검증."""

import asyncio
import importlib.util
import json
import socket
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Event, Thread
from unittest.mock import Mock
from uuid import uuid4

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import cancellation_probe as probe  # noqa: E402 - standalone tools live beside this test.
import cancellation_smoke as smoke  # noqa: E402


def load_runner():
    spec = importlib.util.spec_from_file_location(
        "cancellation_runner_fixture", HERE / "cancellation_runner.py"
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def server():
    state = probe.Probe()
    instance = ThreadingHTTPServer(("127.0.0.1", 0), probe.handler(state))
    thread = Thread(target=instance.serve_forever, daemon=True)
    thread.start()
    yield state, f"http://127.0.0.1:{instance.server_port}"
    instance.shutdown()
    instance.server_close()
    thread.join(timeout=2)


def test_barrier_waits_for_explicit_release(server):
    state, base = server
    run_id = str(uuid4())
    state.configure(run_id, {"hold": "model_sent"})
    finished = Event()
    errors = []

    def send():
        try:
            code, body = smoke.request(base + "/model/" + run_id, {"model": "offline"})
            assert code == 200 and body["usage"]["output_tokens"] == 50
        except Exception as error:
            errors.append(error)
        finally:
            finished.set()

    thread = Thread(target=send, daemon=True)
    thread.start()
    try:
        smoke.wait_for(
            lambda: state.snapshot(run_id)["events"],
            bool,
            label="model received",
            timeout=2,
        )
        assert not finished.is_set()
        state.release(run_id)
        assert finished.wait(2)
        assert not errors
    finally:
        state.release(run_id)
        thread.join(timeout=2)


def test_lost_reply_forwards_once_but_never_returns_success(monkeypatch):
    state = probe.Probe()
    run_id = str(uuid4())
    state.configure(run_id, {"fault": "authorize_lost"})
    forwarded = Mock(return_value=(200, b'{"accepted":true}'))
    monkeypatch.setattr(probe, "exchange", forwarded)
    status, _ = state.forward(
        run_id, "authorize", "http://ops-service:8000/internal", "POST", b"{}", {}
    )
    assert status is None and forwarded.call_count == 1
    assert state.snapshot(run_id)["events"] == [
        {"stage": "authorize", "status": 200, "forwarded": True}
    ]


def test_http_failure_does_not_forward_or_claim_commit(monkeypatch):
    state = probe.Probe()
    run_id = str(uuid4())
    state.configure(run_id, {"fault": "settle_error"})
    forwarded = Mock()
    monkeypatch.setattr(probe, "exchange", forwarded)
    status, _ = state.forward(
        run_id, "settle", "http://ops-service:8000/internal", "POST", b"{}", {}
    )
    assert status == 503 and not forwarded.called
    assert state.snapshot(run_id)["events"][0]["forwarded"] is False


def test_timeout_is_failure(monkeypatch):
    monkeypatch.setattr(smoke.time, "monotonic", Mock(side_effect=[0, 2]))
    with pytest.raises(TimeoutError, match="still running"):
        smoke.wait_for(
            lambda: "CANCELLING",
            lambda value: value == "CANCELLED",
            label="still running",
            timeout=1,
        )


def test_barrier_timeout_is_recorded_as_failure():
    state = probe.Probe()
    run_id = str(uuid4())
    state.configure(run_id, {"hold": "model_sent"})
    state.runs[run_id]["release"] = Mock(wait=Mock(return_value=False))
    with pytest.raises(TimeoutError):
        state.gate(run_id, "model_sent")
    assert state.snapshot(run_id)["events"][-1]["stage"] == "barrier_timeout"


def accounting():
    before = {"allocated": [3, 100]}
    after = {
        "allocated": [4, 2100],
        "closed": True,
        "calls": [{"sequence": 0, "output_tokens": None}],
    }
    events = [{"stage": "authorize", "status": 200}, {"stage": "model_sent"}]
    return before, after, events


def test_unknown_usage_keeps_full_cap():
    before, after, events = accounting()
    assert smoke.verify_budget(
        before, after, calls=1, output=2000, closed=True, sent=1, events=events
    )["retained_delta"] == [1, 2000]


@pytest.mark.parametrize(
    "defect",
    [
        "refund_unknown",
        "double_send",
        "false_settle",
        "duplicate_sequence",
        "timeout",
        "still_open",
    ],
)
def test_invalid_accounting_cannot_pass(defect):
    before, after, events = accounting()
    if defect == "refund_unknown":
        after["allocated"][1] = 100
    elif defect == "double_send":
        events.append({"stage": "model_sent"})
    elif defect == "false_settle":
        events.append({"stage": "settle", "status": 200})
    elif defect == "duplicate_sequence":
        after["calls"].append(dict(after["calls"][0]))
    elif defect == "timeout":
        events.append({"stage": "barrier_timeout"})
    else:
        after["closed"] = False
    with pytest.raises(AssertionError):
        smoke.verify_budget(before, after, calls=1, output=2000, closed=True, sent=1, events=events)


def test_pid_reuse_is_not_a_live_evaluation(monkeypatch, tmp_path):
    runner = load_runner()
    marker = tmp_path / "process.json"
    marker.write_text(json.dumps({"pid": 123, "birth": "100"}))
    monkeypatch.setattr(
        runner, "process_info", lambda pid: {"pid": pid, "birth": "200", "alive": True}
    )
    assert runner.alive(marker) == {"started": True, "pid": 123, "alive": False}


def test_real_sdk_and_evaluator_accept_http_double(monkeypatch, tmp_path, server):
    import httpx2

    evaluation_dir = HERE.parents[1] / "evaluation/support-program-evidence"
    monkeypatch.syspath_prepend(str(evaluation_dir))
    import evaluate
    from budget_client import BudgetClient

    runner = load_runner()
    state, base = server
    run_id = str(uuid4())
    state.configure(run_id, {})
    monkeypatch.setattr(runner, "PROBE", base)
    # install_http_double의 국소 교체를 반드시 원복한다.
    monkeypatch.setattr(httpx2, "AsyncClient", httpx2.AsyncClient)
    monkeypatch.setattr(BudgetClient, "authorize", BudgetClient.authorize)
    monkeypatch.setattr(BudgetClient, "settle", BudgetClient.settle)
    monkeypatch.setenv("OPENAI_API_KEY", "offline-model-double-key")
    monkeypatch.setenv("LANGFUSE_ENABLED", "false")
    monkeypatch.setenv("LLMOPS_OPS_API_URL", base)
    monkeypatch.setenv("LLMOPS_BUDGET_TOKEN", probe.TOKEN)
    budget_actions = []

    def budget_http(url, method, body, headers):
        assert url.startswith(
            f"http://ops-service:8000/internal/llmops/evaluations/{run_id}/budget/"
        )
        assert method == "POST" and headers["Authorization"] == "Bearer " + probe.TOKEN
        budget_actions.append((url.rsplit("/", 1)[-1], json.loads(body)))
        return 200, b'{"accepted":true}'

    monkeypatch.setattr(probe, "exchange", budget_http)
    runner.install_http_double(run_id)
    budget = BudgetClient(run_id, str(uuid4()), "f" * 64)
    budget.claim()
    _, prepared, fixture_hash = evaluate.load_fixture(
        evaluation_dir / "target-coverage-fixture.json"
    )

    async def run():
        capture = await evaluate.execute(
            prepared[:1],
            fixture_hash,
            tmp_path / "capture",
            max_model_calls=1,
            budget=budget,
        )
        assert capture["completed"], capture["cases"]
        assert capture["modelApiCalls"] == 1
        assert capture["apiResponses"][0]["usage"] == probe.USAGE
        async with httpx2.AsyncClient() as client:
            with pytest.raises(RuntimeError, match="non-allowlisted"):
                await client.get("https://example.com/")

    asyncio.run(run())
    budget.close()
    assert [action for action, _ in budget_actions] == [
        "claim",
        "authorize",
        "settle",
        "close",
    ]
    assert budget_actions[1][1]["sequence"] == 0
    assert budget_actions[2][1]["usage"] == probe.USAGE
    assert [event["stage"] for event in state.snapshot(run_id)["events"]] == [
        "claim",
        "before_authorize_0",
        "authorize",
        "model_sent",
        "settle",
        "after_settle_0",
        "close",
    ]


def test_readiness_checks_real_langfuse_endpoint_without_model_calls(server, monkeypatch):
    state, base = server
    forwarded = Mock(return_value=(200, b'{"status":"OK"}'))
    monkeypatch.setattr(probe, "exchange", forwarded)
    assert smoke.request(base + "/health") == (200, {"ready": True})
    assert not forwarded.called
    assert smoke.request(base + "/langfuse-health") == (200, {"status": "OK"})
    forwarded.assert_called_once_with("http://langfuse-web:3000/api/public/health", "GET")
    assert not state.runs


@pytest.fixture
def control_server(monkeypatch):
    received = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            self.handle_request()

        def do_POST(self):
            self.handle_request()

        def handle_request(self):
            data = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            received.append({"path": self.path, "headers": dict(self.headers), "body": data})
            status = {"/redirect": 302, "/unavailable": 503}.get(self.path, 200)
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            if self.path == "/session":
                self.send_header("Set-Cookie", "csrftoken=csrf-cookie; Path=/; SameSite=Lax")
            if self.path == "/redirect":
                self.send_header("Location", "https://example.com/should-not-be-called")
            self.end_headers()
            self.wfile.write(
                b"<html>private failure detail</html>"
                if self.path == "/invalid"
                else b'{"csrf_token":"csrf-header"}'
            )

    instance = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=instance.serve_forever, daemon=True)
    resolve = socket.getaddrinfo

    def local_only(host, port, *args, **kwargs):
        assert (host, port) == ("ops-service", 8000), "Unexpected outbound destination"
        return resolve("127.0.0.1", instance.server_port, *args, **kwargs)

    monkeypatch.setattr(socket, "getaddrinfo", local_only)
    thread.start()
    try:
        yield received
    finally:
        instance.shutdown()
        instance.server_close()
        thread.join(timeout=2)


def test_internal_client_preserves_real_http_csrf_cookies_and_failure(control_server):
    commands = []

    def compose(*parts, **kwargs):
        commands.append((parts, kwargs))
        payload = json.loads(kwargs["input"])
        reply = probe.control_request(payload)
        return subprocess.CompletedProcess(parts, 0, stdout=json.dumps(reply))

    client = smoke.Smoke(compose)
    status, session = client.api("/session")
    assert status == 200
    client.csrf = session["csrf_token"]
    assert client.api("/unavailable", {"test": "한글"})[0] == 503
    request = control_server[-1]
    assert request["headers"]["Origin"] == "http://ops-service:8000"
    assert request["headers"]["X-Csrftoken"] == "csrf-header"
    assert (
        request["headers"]["Cookie"]
        == "govbiz_session=offline-admin-session; csrftoken=csrf-cookie"
    )
    assert json.loads(request["body"]) == {"test": "한글"}
    for parts, kwargs in commands:
        assert parts == (
            "exec",
            "-T",
            "cancellation-probe",
            "python",
            "/test/cancellation_probe.py",
            "request",
        )
        assert kwargs["capture"] is True
        assert "csrf-cookie" not in str(parts)  # Credentials travel through stdin only.


def test_internal_client_does_not_follow_redirects_or_use_ambient_proxy(
    control_server, monkeypatch
):
    monkeypatch.setenv("http_proxy", "http://unexpected-proxy.invalid:8080")
    monkeypatch.setenv("HTTP_PROXY", "http://unexpected-proxy.invalid:8080")
    monkeypatch.setenv("no_proxy", "")
    monkeypatch.setenv("NO_PROXY", "")
    reply = probe.control_request({"url": "http://ops-service:8000/redirect"})
    assert reply["status"] == 302 and len(control_server) == 1


@pytest.mark.parametrize(
    "url",
    [
        "https://api.openai.com/v1/responses",
        "http://169.254.169.254/",
        "http://ops-service:8000.evil.test/path",
        "http://ops-service:8001/path",
        "http://user@ops-service:8000/path",
        "https://ops-service:8000/path",
        "http://ops-service:8000/path#fragment",
    ],
)
def test_internal_client_rejects_other_destinations(url, monkeypatch):
    opener = Mock()
    monkeypatch.setattr(probe, "build_opener", opener)
    with pytest.raises(ValueError, match="Only cancellation test services"):
        probe.control_request({"url": url})
    assert not opener.called


def test_transport_failure_never_becomes_http_success():
    compose = Mock(
        return_value=subprocess.CompletedProcess([], 0, stdout='{"transport_error":"URLError"}')
    )
    with pytest.raises(smoke.URLError):
        smoke.Smoke(compose).api("/session")


def isolated_config():
    return {
        "networks": {"default": {"internal": True}},
        "services": {"ops-service": {"networks": {"default": None}}},
    }


@pytest.mark.parametrize("defect", ["egress", "extra_network", "host", "port"])
def test_network_regression_is_rejected_before_startup(defect):
    config = isolated_config()
    smoke.verify_isolation(config)
    if defect == "egress":
        config["networks"]["default"]["internal"] = False
    elif defect == "extra_network":
        config["networks"]["egress"] = {}
    elif defect == "host":
        config["services"]["ops-service"]["network_mode"] = "host"
    else:
        config["services"]["ops-service"]["ports"] = [{"target": 8000, "published": "18001"}]
    with pytest.raises(ValueError):
        smoke.verify_isolation(config)


def test_startup_failure_records_safe_diagnostics_and_cleans_only_own_project(
    monkeypatch, tmp_path
):
    output = tmp_path / "failure.json"
    monkeypatch.setattr(sys, "argv", ["cancellation_smoke", "--output", str(output)])
    secret = "do-not-include-password"
    monkeypatch.setattr(smoke, "isolated_environment", lambda: {"OPS_DB_PASSWORD": secret})
    commands = []

    def run(command, **kwargs):
        commands.append(command)
        parts = command[command.index("evaluation") + 1 :]
        if parts[0] == "config":
            return subprocess.CompletedProcess(command, 0, stdout=json.dumps(isolated_config()))
        if parts[0] == "up":
            raise subprocess.CalledProcessError(
                1, command, output="private HTTP body", stderr=f"startup failed: {secret}"
            )
        if parts[0] == "ps":
            row = {
                "Service": "ops-service",
                "State": "exited",
                "ExitCode": 1,
                "Command": secret,
                "Env": [secret],
            }
            return subprocess.CompletedProcess(command, 0, stdout=json.dumps(row) + "\n")
        assert parts == ["down", "--volumes", "--remove-orphans", "--timeout", "5"]
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(smoke.subprocess, "run", run)
    with pytest.raises(subprocess.CalledProcessError):
        smoke.main()
    raw = output.read_text(encoding="utf-8")
    report = json.loads(raw)
    assert report["passed"] is False and report["scenarios"] == []
    assert report["diagnostics"]["phase"] == "startup"
    assert report["diagnostics"]["error"]["exit_code"] == 1
    assert report["diagnostics"]["services"][0]["State"] == "exited"
    assert secret not in raw and "private HTTP body" not in raw
    assert "[REDACTED]" in raw
    assert len({c[c.index("--project-name") + 1] for c in commands}) == 1
    assert commands[-1][-5:] == ["down", "--volumes", "--remove-orphans", "--timeout", "5"]


def test_diagnostic_collection_failure_does_not_hide_primary_failure():
    states = smoke.service_states(Mock(side_effect=RuntimeError("private detail")))
    assert states == {"unavailable": "RuntimeError"}


def test_non_json_http_response_preserves_failure_without_body(control_server):
    reply = probe.control_request({"url": "http://ops-service:8000/invalid"})
    assert reply == {"status": 200, "response_error": "invalid_json"}
    compose = Mock(return_value=subprocess.CompletedProcess([], 0, stdout=json.dumps(reply)))
    with pytest.raises(ValueError, match="Invalid JSON response: HTTP 200"):
        smoke.Smoke(compose).api("/invalid")


def test_readiness_waits_for_valid_langfuse_json(monkeypatch):
    client = smoke.Smoke(Mock())
    session = {
        "live_enabled": True,
        "user": {"id": 1},
        "csrf_token": "csrf",
        "datasets": [{"id": "target-coverage-20260907-v1"}],
    }
    client.request = Mock(
        side_effect=[
            ValueError("Invalid JSON response: HTTP 500"),
            (200, {"status": "OK"}),
            (200, session),
            (200, {}),
        ]
    )
    monkeypatch.setattr(smoke.time, "sleep", Mock())
    client.ready()
    assert client.request.call_count == 4 and client.csrf == "csrf"
