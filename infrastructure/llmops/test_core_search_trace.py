"""Reject disconnected/error-masked/private traces before the container smoke runs."""

import importlib.util
import io
import json
from pathlib import Path
from unittest.mock import Mock
from urllib.parse import parse_qs, urlsplit

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "core_trace", Path(__file__).with_name("core_search_trace.py")
)
trace = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trace)
spec = importlib.util.spec_from_file_location(
    "openai_fixture", ROOT / "infrastructure/stubs/openai/server.py"
)
stub = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stub)
ENV = {
    "LANGFUSE_BASE_URL": "http://localhost:13000",
    "LANGFUSE_PUBLIC_KEY": "pk-local",
    "LANGFUSE_SECRET_KEY": "sk-local",
}
TRACE_ID = "a" * 32


def documents(scenario="ok", trace_id=TRACE_ID):
    # Independent fixed wire representation: two search.ranking nodes, real Core root.
    nodes = [
        ("total", None),
        ("database_fetch", 1),
        ("eligibility_prepare", 1),
        ("retrieval", 1),
        ("document_prepare", 4),
        ("keyword_search", 4),
        ("semantic_search", 4),
        ("candidate_merge", 4),
        ("ranking", 1),
        ("semantic.request", 7),
        ("semantic", 10),
        ("embedding", 11),
        ("vector", 11),
        ("ranking.request", 9),
        ("ranking", 14),
        ("ranking.model", 15),
        ("selection", 15),
    ]
    result = []
    for number, (name, parent) in enumerate(nodes, 1):
        if (scenario == "hit" and number in {12, 16, 17}) or (
            scenario in {"fail", "timeout"} and number == 17
        ):
            continue
        error = scenario in {"fail", "timeout"} and number in {1, 9, 14, 15, 16}
        outcome = (
            ("timeout" if scenario == "timeout" else "failed") if error else "completed"
        )
        metadata = {"outcome": outcome}
        if number >= 10:
            # The actual Langfuse SDK includes this public project identifier in
            # instrumentation scope. It is not an input, output or secret key.
            metadata["scope"] = {
                "attributes": {"public_key": ENV["LANGFUSE_PUBLIC_KEY"]}
            }
        if number in {11, 15}:
            metadata["embedding_cache_state" if number == 11 else "cache_state"] = (
                "hit" if scenario == "hit" else "miss"
            )
        result.append(
            {
                "id": f"{number:016x}",
                "parentObservationId": f"{parent:016x}" if parent else None,
                "traceId": trace_id,
                "name": "search." + name,
                "endTime": "2026-09-29T00:00:00Z",
                "level": "ERROR" if error else "DEFAULT",
                "metadata": metadata,
                "input": None,
                "output": None,
            }
        )
    return result


@pytest.mark.parametrize(
    "scenario,count", [("ok", 17), ("hit", 14), ("fail", 16), ("timeout", 16)]
)
def test_complete_core_and_ai_tree(scenario, count):
    safe = trace.verify_observations(
        documents(scenario), TRACE_ID, scenario, ["PRIVATE"]
    )
    assert len(safe) == count
    assert set(safe[0]) == {"id", "parent_id", "name", "outcome"}


@pytest.mark.parametrize(
    "mutation",
    [
        lambda rows: rows.pop(0),
        lambda rows: rows.append(dict(rows[-1])),
        lambda rows: rows[0].update(parentObservationId="invented-core-parent"),
        lambda rows: rows[9].update(parentObservationId=rows[8]["id"]),
        lambda rows: rows[13].update(parentObservationId=rows[6]["id"]),
        lambda rows: rows[14].update(traceId="b" * 32),
        lambda rows: rows[15].update(endTime=None),
        lambda rows: rows[15].update(level="ERROR"),
        lambda rows: rows[0].update(input="captured query"),
        lambda rows: rows[15].update(output="captured answer"),
        lambda rows: rows[15]["metadata"].update(exception="PRIVATE"),
        lambda rows: rows[14]["metadata"].update(cache_state="hit"),
        lambda rows: rows[10]["metadata"].update(embedding_cache_state="hit"),
    ],
)
def test_rejects_broken_parentage_privacy_and_cache(mutation):
    rows = documents()
    mutation(rows)
    with pytest.raises(AssertionError):
        trace.verify_observations(rows, TRACE_ID, "ok", ["PRIVATE"])


@pytest.mark.parametrize("scenario", ["fail", "timeout"])
def test_does_not_accept_failure_masked_as_success(scenario):
    rows = documents(scenario)
    rows[0]["metadata"]["outcome"] = "completed"
    rows[0]["level"] = "DEFAULT"
    with pytest.raises(AssertionError, match="outcome"):
        trace.verify_observations(rows, TRACE_ID, scenario, [])


@pytest.mark.parametrize(
    "url",
    [
        "",
        "https://cloud.langfuse.com",
        "http://localhost.evil",
        "http://user:pass@localhost:13000",
        "http://localhost:13000/wrong",
        "http://localhost:13000?redirect=1",
    ],
)
def test_refuses_nonlocal_or_ambiguous_langfuse(url):
    with pytest.raises(AssertionError):
        trace.tracing_env(ENV | {"LANGFUSE_BASE_URL": url})


@pytest.mark.parametrize(
    "key", ["", "secret\nOPENAI_BASE_URL=https://external", "${OPENAI_API_KEY}"]
)
def test_keys_cannot_inject_compose_environment(key):
    with pytest.raises(AssertionError):
        trace.tracing_env(ENV | {"LANGFUSE_SECRET_KEY": key})


def test_runner_reads_core_ids_checks_calls_and_writes_only_safe_evidence(
    tmp_path, monkeypatch
):
    called = []
    queries = []

    def call(url):
        if url.endswith("/trace-counts"):
            return 200, {query: {"embedding": 1, "ranking": 1} for query in queries}
        query = parse_qs(urlsplit(url).query)["query"][0]
        queries.append(query)
        called.append(f"{len(called) + 1:032x}")
        scenario = ["ok", "hit", "fail", "timeout"][len(called) - 1]
        if scenario in {"ok", "hit"}:
            return 200, {"totalCount": 2}
        return (
            (503, {"code": "AI_SERVICE_UNAVAILABLE"})
            if scenario == "fail"
            else (504, {"code": "AI_SERVICE_TIMEOUT"})
        )

    monkeypatch.setattr(
        trace,
        "read_observations",
        lambda env, tid: documents(
            ["ok", "hit", "fail", "timeout"][int(tid, 16) - 1], tid
        ),
    )
    output = tmp_path / "evidence.json"
    trace.verify_search_traces(
        core_url="http://localhost:18080",
        stub_url="http://localhost:18002",
        environment=ENV,
        core_logs=lambda: "\n".join(
            "support_program_search trace_id=" + tid for tid in called
        ),
        call_json=call,
        output=output,
    )
    report = json.loads(output.read_text())
    assert report["status"] == "passed" and len(report["scenarios"]) == 4
    assert queries[0] == queries[1]
    assert all(item["status"] == "passed" for item in report["scenarios"])
    assert "PRIVATE" not in output.read_text() and "sk-local" not in output.read_text()


def test_failed_http_keeps_failure_evidence(tmp_path):
    output = tmp_path / "failed.json"
    with pytest.raises(AssertionError, match="HTTP status"):
        trace.verify_search_traces(
            core_url="http://localhost",
            stub_url="http://localhost",
            environment=ENV,
            core_logs=lambda: "",
            call_json=lambda url: (503, {}),
            output=output,
        )
    report = json.loads(output.read_text())
    assert report["status"] == report["scenarios"][0]["status"] == "failed"
    assert report["scenarios"][0]["http_status"] == 503


def request_stub(path, body):
    handler = object.__new__(stub.Handler)
    data = json.dumps(body).encode()
    handler.path = path
    handler.headers = {"Content-Length": len(data)}
    handler.rfile = io.BytesIO(data)
    handler.respond = Mock()
    handler.do_POST()
    return handler.respond.call_args.args


def test_http_fixture_faults_are_limited_to_exact_synthetic_queries(monkeypatch):
    stub.TRACE_COUNTS.clear()
    sleep = Mock()
    monkeypatch.setattr(stub.time, "sleep", sleep)
    for scenario in ("ok", "fail", "timeout"):
        query = "서울 AI PRIVATE-CORE-TRACE-" + "a" * 32 + "-" + scenario
        code, _ = request_stub(
            "/v1/embeddings", {"model": "fixture", "input": [query], "dimensions": 3}
        )
        assert code == 200
        code, body = request_stub(
            "/v1/responses",
            {
                "model": "fixture",
                "input": json.dumps({"originalQuery": query, "candidates": []}),
            },
        )
        assert code == (503 if scenario == "fail" else 200)
        if scenario == "fail":
            assert body["error"]["message"] == "PRIVATE-CORE-MODEL-ERROR"
        assert stub.TRACE_COUNTS[query] == {"embedding": 1, "ranking": 1}
    sleep.assert_called_once_with(5)
    for query in (
        "서울 AI",
        "PRIVATE-CORE-TRACE-invalid-fail",
        "서울 AI PRIVATE-CORE-TRACE-" + "a" * 32 + "-fail extra",
    ):
        assert stub.record_trace_call(query, "ranking") is None
    code, _ = request_stub(
        "/v1/responses",
        {
            "model": "fixture",
            "input": json.dumps({"originalQuery": "서울 AI", "candidates": []}),
        },
    )
    assert code == 200 and len(stub.TRACE_COUNTS) == 3


def test_opt_in_embeddings_distinguish_texts_without_changing_default_fixture(
    monkeypatch,
):
    monkeypatch.delenv("CORE_TRACE_FIXTURE", raising=False)
    assert (
        stub.embedding_vector("서울 AI 사업 A", 3)
        == stub.embedding_vector("서울 AI 사업 B", 3)
        == [0, 1, 0]
    )
    monkeypatch.setenv("CORE_TRACE_FIXTURE", "true")
    first = stub.embedding_vector("서울 AI 사업 A", 3)
    second = stub.embedding_vector("서울 AI 사업 B", 3)
    assert first != second
    assert first == stub.embedding_vector("서울 AI 사업 A", 3)
    assert first[1] == second[1] == 1
    assert all(
        0.05 <= value < 0.35 for value in [first[0], first[2], second[0], second[2]]
    )
