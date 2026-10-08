"""Reject broken distributed assistant traces and exercise the offline HTTP model."""

import importlib.util
import json
import threading
from dataclasses import replace
from http.server import ThreadingHTTPServer
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

import core_assistant_trace as trace
from app.main import create_app
from tests.assistant_agent.test_tracing import trace_environment as trace_environment
from tests.test_bootstrap import OPENAI_SETTINGS

spec = importlib.util.spec_from_file_location(
    "assistant_openai_fixture", Path(__file__).resolve().parents[1] / "stubs/openai/server.py"
)
stub = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stub)
TRACE_ID = "c" * 32
ENV = {
    "LANGFUSE_BASE_URL": "http://localhost:13000",
    "LANGFUSE_PUBLIC_KEY": "pk-local",
    "LANGFUSE_SECRET_KEY": "sk-local",
}


def documents(scenario, trace_id=TRACE_ID):
    nodes = [("total", None), ("core.request", 1), ("agent", 2), ("classify", 3)]
    if scenario == "ok":
        nodes += [("finalize", 3), ("core.validate", 1)]
    rows = [
        {
            "id": f"{number:016x}",
            "traceId": trace_id,
            "name": "assistant." + name,
            "parentObservationId": f"{parent:016x}" if parent else None,
            "endTime": "2026-09-30T00:00:00Z",
            "level": "DEFAULT" if scenario == "ok" else "ERROR",
            "metadata": {"outcome": {"ok": "completed", "fail": "failed", "timeout": "timeout"}[scenario]},
        }
        for number, (name, parent) in enumerate(nodes, 1)
    ]
    rows[2]["metadata"].update(model_calls=1, usage_unknown_calls=1, usage_complete=False)
    return rows


@pytest.mark.parametrize("scenario", ["ok", "fail", "timeout"])
def test_complete_wire_trace(scenario):
    rows = documents(scenario)
    assert len(trace.verify_observations(rows, TRACE_ID, scenario, ["PRIVATE"])) == len(rows)


@pytest.mark.parametrize(
    "mutation",
    [
        lambda rows: rows.pop(),
        lambda rows: rows[0].update(parentObservationId="public-parent"),
        lambda rows: rows[2].update(parentObservationId=rows[0]["id"]),
        lambda rows: rows[3].update(traceId="f" * 32),
        lambda rows: rows[3].update(id=rows[2]["id"]),
        lambda rows: rows[3].update(endTime=None),
        lambda rows: rows[2]["metadata"].update(usage_unknown_calls=0),
        lambda rows: rows[2]["metadata"].update(usage_complete=True),
        lambda rows: rows[2]["metadata"].update(usage_input_tokens=0),
        lambda rows: rows[2]["metadata"].update(model_calls=2),
        lambda rows: rows[0].update(level="DEFAULT"),
        lambda rows: rows[0]["metadata"].update(outcome="completed"),
        lambda rows: rows[0].update(input="PRIVATE"),
        lambda rows: rows[2]["metadata"].update(error="PRIVATE"),
    ],
)
def test_broken_wire_trace_is_rejected(mutation):
    rows = documents("fail")
    mutation(rows)
    with pytest.raises(AssertionError):
        trace.verify_observations(rows, TRACE_ID, "fail", ["PRIVATE"])


@pytest.mark.parametrize("fail", [False, True])
def test_driver_keeps_allowlisted_success_and_failure_evidence(tmp_path, monkeypatch, fail):
    logs, counts = [], {}

    def post(url, message, *, session_token):
        assert session_token == "member-session"
        assert trace.re.fullmatch(r"이 공고 PRIVATE-ASSISTANT-TRACE-[a-f]{32}-(ok|fail|timeout)", message)
        scenario = message.rsplit("-", 1)[1]
        index = {"ok": 1, "fail": 2, "timeout": 3}[scenario]
        logs.append(f"assistant_request trace_id={index:032x}")
        counts[message] = {"assistant": 1}
        return {"ok": 200, "fail": 503, "timeout": 504}[scenario], {
            "intent": "PROGRAM_QUESTION",
            "code": "AI_SERVICE_TIMEOUT" if scenario == "timeout" else "AI_SERVICE_UNAVAILABLE",
        }

    def read(env, trace_id):
        index = int(trace_id, 16)
        rows = documents(["ok", "fail", "timeout"][index - 1], trace_id)
        if fail:
            rows[2]["parentObservationId"] = "broken"
        return rows

    monkeypatch.setattr(trace, "post_question", post)
    monkeypatch.setattr(trace, "read_observations", read)
    output = tmp_path / "trace.json"
    kwargs = dict(
        core_url="http://localhost:8080",
        session_token="member-session",
        stub_url="http://localhost:8002",
        environment=ENV,
        core_logs=lambda: "\n".join(logs),
        call_json=lambda url: (200, counts),
        output=output,
    )
    if fail:
        with pytest.raises(AssertionError, match="Wrong assistant parent"):
            trace.verify_assistant_traces(**kwargs)
    else:
        trace.verify_assistant_traces(**kwargs)
    report = json.loads(output.read_text())
    assert report["status"] == ("failed" if fail else "passed")
    assert report["scenarios"][-1]["status"] == report["status"]
    assert report["model_api_calls"] == 0
    assert "PRIVATE" not in output.read_text() and "sk-local" not in output.read_text()


def test_fault_injection_requires_explicit_fixture_and_exact_classify_message(monkeypatch):
    payload = {"step": "classify", "message": f"이 공고 PRIVATE-ASSISTANT-TRACE-{uuid4().hex}-fail"}
    monkeypatch.delenv("CORE_TRACE_FIXTURE", raising=False)
    assert stub.record_assistant_trace_call(payload) is None
    monkeypatch.setenv("CORE_TRACE_FIXTURE", "true")
    assert stub.record_assistant_trace_call({**payload, "step": "answer"}) is None
    assert stub.record_assistant_trace_call({**payload, "message": payload["message"] + " extra"}) is None
    assert stub.record_assistant_trace_call(payload) == "fail"
    assert stub.TRACE_COUNTS[payload["message"]] == {"assistant": 1}


@pytest.mark.parametrize("scenario,status", [("ok", 200), ("fail", 503), ("timeout", 504)])
def test_real_ai_router_sdk_and_offline_http_fixture(trace_environment, monkeypatch, scenario, status):
    _, exporter, settings = trace_environment
    monkeypatch.setenv("CORE_TRACE_FIXTURE", "true")
    server = ThreadingHTTPServer(("127.0.0.1", 0), stub.Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("OPENAI_BASE_URL", f"http://127.0.0.1:{server.server_port}/v1")
    message = f"이 공고 PRIVATE-ASSISTANT-TRACE-{uuid4().hex}-{scenario}"
    payload = {
        "schemaVersion": "govbiz-assistant-agent-v1",
        "message": message,
        "history": [],
        "session": {"authenticated": False, "hasCompany": False},
        "principal": None,
        "context": {"route": "/app/chat", "programSelected": True},
        "helpEntries": [
            {
                "id": "help",
                "title": "안내",
                "question": "안내 질문",
                "summary": "설명",
                "body": ["설명"],
                "limitation": None,
                "audience": "public",
                "status": "available",
                "action": None,
            }
        ],
    }
    try:
        app = create_app(
            settings=replace(
                OPENAI_SETTINGS,
                langfuse=replace(settings, public_key="pk-lf-" + uuid4().hex),
            )
        )
        with TestClient(app) as client:
            response = client.post(
                "/internal/v1/assistant/agent",
                json=payload,
                headers={"traceparent": f"00-{TRACE_ID}-0000000000000002-01"},
            )
            assert response.status_code == status, response.text
        spans = exporter.get_finished_spans()
        # Core spans here are wire fixtures; actual JVM + Langfuse runs in LLMOps CI.
        rows = [
            row
            for row in documents(scenario)
            if row["name"] in {"assistant.total", "assistant.core.request", "assistant.core.validate"}
        ]
        for span in spans:
            rows.append(
                {
                    "id": f"{span.context.span_id:016x}",
                    "traceId": f"{span.context.trace_id:032x}",
                    "name": span.name,
                    "parentObservationId": f"{span.parent.span_id:016x}",
                    "endTime": span.end_time,
                    "level": span.attributes.get("langfuse.observation.level", "DEFAULT"),
                    "metadata": {
                        key.removeprefix("langfuse.observation.metadata."): value
                        for key, value in span.attributes.items()
                        if key.startswith("langfuse.observation.metadata.")
                    },
                }
            )
        trace.verify_observations(rows, TRACE_ID, scenario, [message, "PRIVATE-ASSISTANT-", "private-key"])
        assert stub.TRACE_COUNTS[message] == {"assistant": 1}
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
