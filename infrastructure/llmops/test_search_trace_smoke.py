"""CI의 실제 Langfuse 재조회 시나리오를 서버 없이 먼저 검증한다."""

import asyncio
import importlib.util
import json
from pathlib import Path

import httpx
import pytest
from tests.support_program_evidence.test_tracing import (
    trace_environment as trace_environment,
)

spec = importlib.util.spec_from_file_location("trace_smoke", Path(__file__).with_name("smoke.py"))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


def test_search_smoke_exports_miss_hit_and_checks_parent_and_privacy(
    trace_environment, monkeypatch
):
    settings, exporter = trace_environment
    records = asyncio.run(smoke.search_trace_examples(settings))
    spans = exporter.get_finished_spans()
    assert len(spans) == 71  # 근거 4+3, RAG miss/hit/실패 15+11+2, 도우미 10+10+3, 검색 8+5
    documents = {}
    for span in spans:
        attrs = span.attributes
        documents.setdefault(f"{span.context.trace_id:032x}", []).append(
            {
                "id": f"{span.context.span_id:016x}",
                "name": span.name,
                "parentObservationId": f"{span.parent.span_id:016x}" if span.parent else None,
                "level": attrs.get("langfuse.observation.level", "DEFAULT"),
                "usageDetails": json.loads(attrs.get("langfuse.observation.usage_details", "{}")),
                "metadata": {
                    k.removeprefix("langfuse.observation.metadata."): v
                    for k, v in attrs.items()
                    if k.startswith("langfuse.observation.metadata.")
                },
            }
        )
    client_type = httpx.Client
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            json={
                "data": documents[request.url.params["traceId"]],
            },
        )
    )
    monkeypatch.setattr(
        smoke.httpx, "Client", lambda **kwargs: client_type(**kwargs, transport=transport)
    )
    smoke.verify_traces(settings, records)
    evidence_records = [item for item in records if "evidence_scenario" in item]
    hit = next(item for item in evidence_records if item["evidence_scenario"] == "hit")
    search = next(item for item in documents[hit["trace_id"]] if item["name"] == "evidence.search")
    search["metadata"]["embedding_cache_state"] = "miss"
    with pytest.raises(AssertionError):
        smoke.verify_traces(settings, [hit])
    search["metadata"]["embedding_cache_state"] = "hit"
    search["parentObservationId"] = "wrong-parent"
    with pytest.raises(AssertionError):
        smoke.verify_traces(settings, [hit])
    search["parentObservationId"] = hit["parents"]["evidence.search"]
    assistant_records = [item for item in records if "assistant_scenario" in item]
    failed_map = next(item for item in assistant_records if item["assistant_scenario"] == "map-failure")
    root = next(item for item in documents[failed_map["trace_id"]] if item["name"] == "assistant.agent")
    root["metadata"]["usage_unknown_calls"] = 0
    with pytest.raises(AssertionError):
        smoke.verify_traces(settings, [failed_map])
    root["metadata"]["usage_unknown_calls"] = 1
    judge = next(item for item in documents[failed_map["trace_id"]] if item["name"] == "assistant.saved.judge")
    parent = judge["parentObservationId"]
    judge["parentObservationId"] = root["id"]
    with pytest.raises(AssertionError):
        smoke.verify_traces(settings, [failed_map])
    judge["parentObservationId"] = parent
    search_records = [item for item in records if "names" in item]
    root = next(
        item
        for item in documents[search_records[0]["trace_id"]]
        if item["name"].endswith(".request")
    )
    root["parentObservationId"] = "wrong-parent"
    with pytest.raises(AssertionError):
        smoke.verify_traces(settings, search_records)
    root["parentObservationId"] = search_records[0]["parent_id"]
    root["input"] = "PRIVATE-SMOKE"
    with pytest.raises(AssertionError):
        smoke.verify_traces(settings, search_records)
