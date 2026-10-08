"""Reject broken RAG traces and exercise the real AI HTTP/SDK path against the CI fixture."""

import importlib.util
import io
import json
import threading
from dataclasses import replace
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import Mock
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from qdrant_client import AsyncQdrantClient

import core_evidence_trace as trace
from app.main import create_app
from tests.support_program_evidence.conftest import chunk, identity
from tests.support_program_evidence.test_tracing import trace_environment as trace_environment
from tests.test_bootstrap import OPENAI_SETTINGS

spec = importlib.util.spec_from_file_location(
    "evidence_openai_fixture", Path(__file__).resolve().parents[1] / "stubs/openai/server.py"
)
stub = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stub)
TRACE_ID = "c" * 32
ENV = {
    "LANGFUSE_BASE_URL": "http://localhost:13000",
    "LANGFUSE_PUBLIC_KEY": "pk-local",
    "LANGFUSE_SECRET_KEY": "sk-local",
}
PROGRAM = {
    "id": "PBLN_COMPOSE_EXPORT",
    "sourceCode": "BIZINFO",
    "sourceUrl": "https://www.bizinfo.go.kr/view.do?pblancId=PBLN_COMPOSE_EXPORT",
}


def documents(scenario="ok", trace_id=TRACE_ID, query_cache=None):
    # Fixed wire representation independent of the checker's span_tree builder.
    nodes = [
        ("total", None),
        ("core.detail", 1),
        ("core.source", 1),
        ("core.chunk", 1),
        ("core.index", 1),
        ("core.search", 1),
        ("core.answer", 1),
        ("core.validate", 1),
        ("index", 5),
        ("index.readiness", 9),
        ("index.embedding", 9),
        ("index.upsert", 9),
        ("search", 6),
        ("search.readiness", 13),
        ("search.embedding", 13),
        ("search.vector", 13),
        ("search.validate", 13),
        ("answer", 7),
        ("model", 18),
        ("validate_selection", 18),
        ("validate_response", 18),
    ]
    omitted = {
        "ok": set(),
        "hit": {11, 12},
        "fail": {8, 11, 12, 20, 21},
        "timeout": {8, 11, 12, 20, 21},
        "invalid-citation": {8, 11, 12, 21},
        "search-fail": {7, 8, 11, 12, 16, 17, 18, 19, 20, 21},
    }[scenario]
    failed = {
        "ok": set(),
        "hit": set(),
        "fail": {1, 7, 18, 19},
        "timeout": {1, 7, 18, 19},
        "invalid-citation": {1, 7, 18, 20},
        "search-fail": {1, 6, 13, 15},
    }[scenario]
    rows = []
    for number, (name, parent) in enumerate(nodes, 1):
        if number in omitted:
            continue
        outcome = "failed" if number in failed else "completed"
        if scenario == "timeout" and number in {18, 19}:
            outcome = "timeout"
        metadata = {"outcome": outcome}
        if number == 3:
            metadata["cache_state"] = "hit"
        if number == 4:
            metadata.update(cache_state="miss" if scenario == "ok" else "hit", chunk_count=1)
        if number == 9:
            metadata["missing_count"] = 1 if scenario == "ok" else 0
        if number == 13 and scenario != "search-fail":
            metadata["embedding_cache_state"] = "hit" if scenario == "hit" else "miss"
        if number == 19:
            metadata["usage_reported"] = False
        rows.append(
            {
                "id": f"{number:016x}",
                "parentObservationId": f"{parent:016x}" if parent else None,
                "name": "evidence." + name,
                "traceId": trace_id,
                "endTime": "2026-09-30T00:00:00Z",
                "level": "ERROR" if number in failed else "DEFAULT",
                "metadata": metadata,
            }
        )
    parents = ([11] if scenario == "ok" else []) + (
        [] if (query_cache or ("hit" if scenario == "hit" else "miss")) == "hit" else [15]
    )
    for number, parent in enumerate(parents, 22):
        failed = scenario == "search-fail"
        rows.append({
            "id": f"{number:016x}", "parentObservationId": f"{parent:016x}",
            "name": "evidence.embedding.request", "traceId": trace_id,
            "endTime": "2026-09-30T00:00:00Z", "level": "ERROR" if failed else "DEFAULT",
            "metadata": {"batch_sequence": 0, "batch_size": 1, "estimated_tokens": 20,
                         "request_token_limit": 262112, "usage_reported": not failed,
                         "usage_state": "unknown" if failed else "reported",
                         "outcome": "failed" if failed else "completed"},
            "usageDetails": {} if failed else {"input": 1, "output": 0, "total": 1},
        })
    return rows


@pytest.mark.parametrize(
    "scenario,count",
    [("ok", 23), ("hit", 19), ("fail", 17), ("timeout", 17), ("invalid-citation", 18), ("search-fail", 12)],
)
def test_complete_tree_and_safe_evidence(scenario, count):
    rows = trace.verify_observations(documents(scenario), TRACE_ID, scenario, ["PRIVATE"])
    assert len(rows) == count
    assert all(set(item) == {"id", "parent_id", "name", "outcome"} for item in rows)


@pytest.mark.parametrize(
    "mutation",
    [
        lambda rows: rows[-1]["metadata"].update(usage_reported=False),
        lambda rows: rows[-1].update(usageDetails={}),
        lambda rows: rows[-1].update(parentObservationId=rows[0]["id"]),
        lambda rows: rows[-1]["metadata"].update(estimated_tokens=262113),
        lambda rows: rows[-1].update(input="PRIVATE embedding"),
        lambda rows: rows.pop(),
        lambda rows: rows.append(dict(rows[-1])),
        lambda rows: rows[0].update(parentObservationId="external"),
        lambda rows: rows[8].update(parentObservationId=rows[5]["id"]),
        lambda rows: rows[17].update(parentObservationId=rows[4]["id"]),
        lambda rows: rows[18].update(traceId="d" * 32),
        lambda rows: rows[18].update(endTime=None),
        lambda rows: rows[18].update(level="ERROR"),
        lambda rows: rows[0].update(input="PRIVATE"),
        lambda rows: rows[18].update(output="answer"),
        lambda rows: rows[18]["metadata"].update(exception="PRIVATE"),
        lambda rows: rows[18]["metadata"].update(usage_reported=True),
        lambda rows: rows[2]["metadata"].update(cache_state="miss"),
        lambda rows: rows[3]["metadata"].update(chunk_count=0),
        lambda rows: rows[8]["metadata"].update(missing_count=0),
        lambda rows: rows[12]["metadata"].update(embedding_cache_state="hit"),
    ],
)
def test_rejects_broken_parents_failures_cache_and_privacy(mutation):
    rows = documents()
    mutation(rows)
    with pytest.raises(AssertionError):
        trace.verify_observations(rows, TRACE_ID, "ok", ["PRIVATE"])


@pytest.mark.parametrize("scenario", ["fail", "timeout", "invalid-citation", "search-fail"])
def test_failures_cannot_be_reported_as_success(scenario):
    rows = documents(scenario)
    rows[0]["metadata"]["outcome"] = "completed"
    with pytest.raises(AssertionError, match="outcome"):
        trace.verify_observations(rows, TRACE_ID, scenario, [])


@pytest.mark.parametrize("failure", [None, "parent", "calls", "http", "source"])
def test_runner_persists_sanitized_pass_or_failure_evidence(tmp_path, monkeypatch, failure):
    logs, calls = [], []
    counts = {trace.SOURCE_TEXT: {"source_embedding": 1}}

    def sql(service, statement):
        assert service == "mysql"
        calls.append(statement)
        return "1" if failure == "source" else "0"

    def post(url, question):
        scenario = trace.SCENARIOS[len(logs)]
        tid = f"{len(logs) + 1:032x}"
        logs.append("support_program_evidence trace_id=" + tid)
        counts[question] = {"embedding": 1, "answer": 0 if scenario == "search-fail" else 2 if scenario == "hit" else 1}
        if failure == "calls":
            counts[question]["answer"] += 1
        if failure == "http":
            return 503, {}
        return (
            (
                200,
                {
                    "answerStatus": "ANSWERED",
                    "answer": "PRIVATE-EVIDENCE-ANSWER",
                    "citations": [
                        {
                            "excerpt": trace.SOURCE_TEXT,
                            "sourceUrl": PROGRAM["sourceUrl"],
                            "sourceLabel": trace.SOURCE_LABEL,
                            "chunkOrder": 0,
                        },
                    ],
                },
            )
            if scenario in {"ok", "hit"}
            else (503, {"code": "AI_SERVICE_UNAVAILABLE"})
        )

    def read(env, tid):
        rows = documents(trace.SCENARIOS[int(tid, 16) - 1], tid)
        if failure == "parent":
            rows[8]["parentObservationId"] = "broken"
        return rows

    monkeypatch.setattr(trace, "post_question", post)
    monkeypatch.setattr(trace, "read_observations", read)
    output = tmp_path / "evidence.json"
    arguments = dict(
        core_url="http://localhost:8080",
        stub_url="http://localhost:8002",
        environment=ENV,
        core_logs=lambda: "\n".join(logs),
        call_json=lambda url: (200, counts),
        sql=sql,
        program=PROGRAM,
        output=output,
    )
    if failure:
        with pytest.raises(AssertionError):
            trace.verify_evidence_traces(**arguments)
    else:
        trace.verify_evidence_traces(**arguments)
    report = json.loads(output.read_text())
    assert report["status"] == ("failed" if failure else "passed") and report["model_api_calls"] == 0
    if failure != "source":
        assert report["scenarios"][-1]["status"] == report["status"]
        assert "INSERT INTO support_program_source_document" in calls[1]
        assert trace.SOURCE_TEXT.encode().hex() in calls[1]
    else:
        assert len(calls) == 1 and not logs
    assert "PRIVATE" not in output.read_text() and "sk-local" not in output.read_text()


def request_stub(path, body):
    handler = object.__new__(stub.Handler)
    data = json.dumps(body).encode()
    handler.path, handler.headers, handler.rfile = path, {"Content-Length": len(data)}, io.BytesIO(data)
    handler.respond = Mock()
    handler.do_POST()
    return handler.respond.call_args.args


def test_fixture_requires_opt_in_and_exact_synthetic_question(monkeypatch):
    question = f"접수 PRIVATE-EVIDENCE-TRACE-{uuid4().hex}-fail"
    monkeypatch.delenv("CORE_TRACE_FIXTURE", raising=False)
    assert stub.record_evidence_trace_call(question, "answer") is None
    assert request_stub("/v1/responses", {"input": json.dumps({"question": question, "chunks": [{}]})})[0] == 400
    monkeypatch.setenv("CORE_TRACE_FIXTURE", "true")
    assert stub.record_evidence_trace_call(question + " extra", "answer") is None
    assert stub.record_evidence_trace_call("일반 질문", "answer") is None
    assert stub.record_evidence_trace_call(question, "answer") == "fail"
    assert stub.TRACE_COUNTS[question] == {"embedding": 0, "answer": 1}


def test_real_ai_routes_sdk_qdrant_cache_and_faults(trace_environment, monkeypatch):
    settings, exporter = trace_environment
    stub.TRACE_COUNTS.clear()
    monkeypatch.setenv("CORE_TRACE_FIXTURE", "true")
    server = ThreadingHTTPServer(("127.0.0.1", 0), stub.Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("OPENAI_BASE_URL", f"http://127.0.0.1:{server.server_port}/v1")
    monkeypatch.setattr("app.bootstrap.AsyncQdrantClient", lambda **kwargs: AsyncQdrantClient(location=":memory:"))
    item = chunk("BIZINFO:" + trace.PROGRAM_ID, 0, trace.SOURCE_TEXT)
    tids = []
    nonce = uuid4().hex
    try:
        app = create_app(settings=replace(OPENAI_SETTINGS, langfuse=settings, openai_embedding_dimensions=3))
        with TestClient(app) as client:
            for scenario in trace.SCENARIOS:
                tid = uuid4().hex
                tids.append(tid)
                question = f"접수 PRIVATE-EVIDENCE-TRACE-{nonce}-{'ok' if scenario == 'hit' else scenario}"
                operations = [
                    ("PUT", "chunks", 5, {"chunks": [item.model_dump(by_alias=True)]}),
                    (
                        "POST",
                        "search",
                        6,
                        {
                            "question": question,
                            "eligibleChunks": [identity(item).model_dump(by_alias=True)],
                            "limit": 1,
                        },
                    ),
                    (
                        "POST",
                        "answers",
                        7,
                        {"question": question, "chunks": [item.model_dump(by_alias=True, exclude={"content_hash"})]},
                    ),
                ]
                for method, path, parent, payload in operations:
                    response = client.request(
                        method,
                        "/internal/v1/support-program-evidence/" + path,
                        json=payload,
                        headers={"traceparent": f"00-{tid}-{parent:016x}-01"},
                    )
                    if response.status_code != 200:
                        assert response.status_code == 503
                        assert (path == "search" and scenario == "search-fail") or (
                            path == "answers" and scenario in {"fail", "timeout", "invalid-citation"}
                        )
                        break
                else:
                    assert scenario in {"ok", "hit"}
                    assert response.json()["citationChunkIds"] == [item.id]
                assert stub.TRACE_COUNTS[question] == {
                    "embedding": 1,
                    "answer": 0 if scenario == "search-fail" else 2 if scenario == "hit" else 1,
                }
        spans = exporter.get_finished_spans()
        assert len(spans) == 63
        for scenario, tid in zip(trace.SCENARIOS, tids, strict=True):
            # JVM spans are wire fixtures here; the actual Core/MySQL path runs in CI.
            rows = [
                row
                for row in documents(scenario, tid)
                if row["name"] == "evidence.total" or row["name"].startswith("evidence.core.")
            ]
            for span in spans:
                if f"{span.context.trace_id:032x}" != tid:
                    continue
                assert not span.events
                rows.append(
                    {
                        "id": f"{span.context.span_id:016x}",
                        "traceId": tid,
                        "name": span.name,
                        "parentObservationId": f"{span.parent.span_id:016x}",
                        "endTime": span.end_time,
                        "level": span.attributes.get("langfuse.observation.level", "DEFAULT"),
                        "usageDetails": json.loads(span.attributes.get("langfuse.observation.usage_details", "{}")),
                        "metadata": {
                            key.removeprefix("langfuse.observation.metadata."): value
                            for key, value in span.attributes.items()
                            if key.startswith("langfuse.observation.metadata.")
                        },
                    }
                )
            trace.verify_observations(rows, tid, scenario, ["PRIVATE-EVIDENCE-", "private-key", settings.secret_key])
        assert stub.TRACE_COUNTS[trace.SOURCE_TEXT] == {"source_embedding": 1}
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
