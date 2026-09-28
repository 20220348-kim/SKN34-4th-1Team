import asyncio
import json

import httpx
import pytest
from app.main import create_app
from app.support_program_index.models import (
    SupportProgramIndexBatchRequest,
    SupportProgramIndexSearchRequest,
)
from app.support_program_ranking.agent import SupportProgramRecommendationAgent
from app.support_program_ranking.errors import AgentExecutionError
from app.support_program_ranking.service import SupportProgramRankingService
from app.tracing import LLMTracing, remote_parent
from tests.langchain_stub import ResponsesChatStub, response_message
from tests.support_program_evidence.test_tracing import (
    trace_environment as trace_environment,
)
from tests.support_program_index.conftest import document, identity
from tests.support_program_index.conftest import index_environment as index_environment
from tests.support_program_ranking.test_agent import llm_output_json, ranking_request
from tests.test_bootstrap import OPENAI_SETTINGS


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.parametrize(
    "header",
    [
        None,
        "private",
        "00-" + "0" * 32 + "-" + "a" * 16 + "-01",
        "00-" + "a" * 32 + "-" + "0" * 16 + "-01",
        "ff-" + "a" * 32 + "-" + "b" * 16 + "-01",
    ],
)
def test_invalid_parent_never_enters_telemetry(header):
    assert remote_parent(header) == {}


@pytest.mark.anyio
async def test_search_http_spans_join_core_parent_without_bodies(
    trace_environment, index_environment
):
    from dataclasses import replace

    settings, exporter = trace_environment
    index, embeddings = index_environment
    item = document("BIZINFO:test", "서울 AI 비공개 검색 자료")
    await index.index_batch(SupportProgramIndexBatchRequest(documents=[item]))
    stub = ResponsesChatStub([[response_message(llm_output_json())]])
    agent = SupportProgramRecommendationAgent(
        model=stub.model, model_timeout_seconds=10, run_timeout_seconds=15
    )
    app = create_app(
        settings=replace(OPENAI_SETTINGS, langfuse=settings),
        support_program_recommendation_agent=agent,
    )
    tracing = app.state.container.llm_tracing
    agent._tracing = index._tracing = tracing
    app.state.container.support_program_index_service = index
    parent = "00-" + "a" * 32 + "-" + "b" * 16 + "-01"
    request = SupportProgramIndexSearchRequest(
        query="서울 AI 비공개 질문", eligibleDocuments=[identity(item)], limit=1
    )
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            for path, payload in [
                ("support-program-index/search", request),
                ("support-program-rankings/rank", ranking_request()),
            ]:
                response = await client.post(
                    "/internal/v1/" + path,
                    json=payload.model_dump(mode="json", by_alias=True),
                    headers={"traceparent": parent},
                )
                assert response.status_code == 200
            # 캐시 적중 요청은 별도 trace이며 새 embedding/generation을 만들지 않는다.
            second = await client.post(
                "/internal/v1/support-program-index/search",
                json=request.model_dump(mode="json", by_alias=True),
                headers={"traceparent": "00-" + "c" * 32 + "-" + "d" * 16 + "-01"},
            )
            assert second.status_code == 200
    finally:
        await app.state.container.close()
    spans = exporter.get_finished_spans()
    roots = [s for s in spans if s.name.endswith(".request")]
    assert [(s.context.trace_id, s.parent.span_id) for s in roots[:2]] == [
        (int("a" * 32, 16), int("b" * 16, 16))
    ] * 2
    assert len([s for s in spans if s.name == "search.embedding"]) == 1
    assert len([s for s in spans if s.name == "search.ranking.model"]) == 1
    assert len(stub.calls) == 1 and len(embeddings.requests) == 2  # seed + query
    for span in spans:
        if not span.name.endswith(".request"):
            assert any(
                parent.context.span_id == span.parent.span_id
                and parent.context.trace_id == span.context.trace_id
                for parent in spans
            )
    embedding = next(s for s in spans if s.name == "search.embedding")
    assert embedding.attributes["langfuse.observation.usage_details"] == '{"input": 1}'
    exported = json.dumps([s.to_json() for s in spans], ensure_ascii=False)
    for private in [
        request.query,
        item.text,
        ranking_request().original_query,
        settings.secret_key,
    ]:
        assert private not in exported
    assert all(not s.events for s in spans)


@pytest.mark.anyio
async def test_shared_ranking_has_one_model_call_and_separate_request_traces(trace_environment):
    settings, exporter = trace_environment
    tracing = LLMTracing(settings)
    started, finish = asyncio.Event(), asyncio.Event()

    async def delayed(_):
        started.set()
        await finish.wait()
        return [response_message(llm_output_json())]

    stub = ResponsesChatStub([delayed])
    agent = SupportProgramRecommendationAgent(
        model=stub.model, model_timeout_seconds=10, run_timeout_seconds=15, tracing=tracing
    )
    service = SupportProgramRankingService(agent, tracing=tracing)

    async def request(trace_id):
        with tracing.observation("search.ranking.request", trace_id=trace_id):
            return await service.rank(ranking_request())

    first = asyncio.create_task(request("a" * 32))
    await started.wait()
    second = asyncio.create_task(request("b" * 32))
    await asyncio.sleep(0)
    finish.set()
    await asyncio.gather(first, second)
    await request("c" * 32)
    await tracing.close()
    spans = exporter.get_finished_spans()
    assert len(stub.calls) == 1
    assert len([s for s in spans if s.name == "search.ranking.model"]) == 1
    requests = [s for s in spans if s.name == "search.ranking"]
    assert {s.attributes["langfuse.observation.metadata.cache_state"] for s in requests} == {
        "miss",
        "shared",
        "hit",
    }
    shared = next(s for s in requests if s.context.trace_id == int("b" * 32, 16))
    assert shared.attributes["langfuse.observation.metadata.shared_source_trace_id"] == "a" * 32


@pytest.mark.anyio
async def test_trace_start_failure_preserves_search_result_and_call_count(
    trace_environment, monkeypatch, caplog
):
    settings, _ = trace_environment
    tracing = LLMTracing(settings)
    stub = ResponsesChatStub([[response_message(llm_output_json())]])
    agent = SupportProgramRecommendationAgent(
        model=stub.model, model_timeout_seconds=10, run_timeout_seconds=15, tracing=tracing
    )
    service = SupportProgramRankingService(agent, tracing=tracing)

    def broken(**kwargs):
        raise RuntimeError("PRIVATE telemetry detail")

    monkeypatch.setattr(tracing.client, "start_as_current_observation", broken)
    try:
        result = await service.rank(ranking_request())
        assert result.rankings
        assert len(stub.calls) == 1
        assert "PRIVATE" not in caplog.text
    finally:
        await tracing.close()


@pytest.mark.anyio
async def test_vector_failure_retains_embedding_usage_without_error_body(
    trace_environment, index_environment, monkeypatch
):
    from unittest.mock import AsyncMock

    from app.support_program_index.service import SupportProgramIndexError

    settings, exporter = trace_environment
    tracing = LLMTracing(settings)
    index, _ = index_environment
    item = document("BIZINFO:test", "서울 AI 비공개 검색 자료")
    await index.index_batch(SupportProgramIndexBatchRequest(documents=[item]))
    index._tracing = tracing
    monkeypatch.setattr(
        index.qdrant_client,
        "query_points",
        AsyncMock(side_effect=RuntimeError("PRIVATE vector error")),
    )
    try:
        with pytest.raises(SupportProgramIndexError):
            await index.search(
                SupportProgramIndexSearchRequest(
                    query="서울 AI", eligibleDocuments=[identity(item)], limit=1
                )
            )
    finally:
        await tracing.close()
    spans = exporter.get_finished_spans()
    embedding = next(s for s in spans if s.name == "search.embedding")
    vector = next(s for s in spans if s.name == "search.vector")
    assert embedding.attributes["langfuse.observation.metadata.usage_reported"] is True
    assert vector.attributes["langfuse.observation.status_message"] == "failed"
    assert "PRIVATE" not in str([s.to_json() for s in spans])


@pytest.mark.anyio
@pytest.mark.parametrize("kind", ["timeout", "cancelled", "invalid"])
async def test_ranking_failure_never_fabricates_usage_or_leaks_errors(trace_environment, kind):
    settings, exporter = trace_environment
    tracing = LLMTracing(settings)
    started = asyncio.Event()

    async def failed(_):
        if kind == "timeout":
            raise TimeoutError("PRIVATE upstream body")
        started.set()
        await asyncio.Event().wait()

    stub = ResponsesChatStub(
        [[response_message("invalid PRIVATE body")]] if kind == "invalid" else [failed]
    )
    agent = SupportProgramRecommendationAgent(
        model=stub.model, model_timeout_seconds=10, run_timeout_seconds=15, tracing=tracing
    )
    service = SupportProgramRankingService(agent, tracing=tracing)
    try:
        task = asyncio.create_task(service.rank(ranking_request()))
        if kind == "cancelled":
            await asyncio.wait_for(started.wait(), 2)
            task.cancel("PRIVATE upstream body")
        with pytest.raises(asyncio.CancelledError if kind == "cancelled" else AgentExecutionError):
            await task
    finally:
        await tracing.close()
    spans = exporter.get_finished_spans()
    model = next(s for s in spans if s.name == "search.ranking.model")
    assert model.attributes["langfuse.observation.status_message"] == (
        "failed" if kind == "invalid" else kind
    )
    if kind != "invalid":
        assert model.attributes["langfuse.observation.metadata.usage_reported"] is False
        assert "langfuse.observation.usage_details" not in model.attributes
    assert "PRIVATE" not in str([s.to_json() for s in spans])
    assert all(not s.events for s in spans)
    assert len(stub.calls) == 1
