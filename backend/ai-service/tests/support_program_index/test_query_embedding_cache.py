import asyncio
import logging
import re
from unittest.mock import AsyncMock

import pytest

from app.support_program_index import service as service_module
from app.support_program_index.models import (
    SupportProgramIndexBatchRequest,
    SupportProgramIndexPruneRequest,
    SupportProgramIndexSearchRequest,
)
from app.support_program_index.service import SupportProgramIndexError, SupportProgramIndexService
from .conftest import document, identity


@pytest.mark.anyio
async def test_cache_hit_checks_current_collection_versions_and_queries_current_candidates(index_environment, monkeypatch):
    service, stub = index_environment
    first = document("BIZINFO:first", "서울 AI 지원")
    second = document("BIZINFO:second", "부산 제조업 지원")
    await service.index_batch(SupportProgramIndexBatchRequest(documents=[first, second]))
    exists = AsyncMock(wraps=service.qdrant_client.collection_exists)
    count = AsyncMock(wraps=service.qdrant_client.count)
    query_points = AsyncMock(wraps=service.qdrant_client.query_points)
    monkeypatch.setattr(service.qdrant_client, "collection_exists", exists)
    monkeypatch.setattr(service.qdrant_client, "count", count)
    monkeypatch.setattr(service.qdrant_client, "query_points", query_points)

    initial = await service.search(SupportProgramIndexSearchRequest(
        query="서울 AI", eligibleDocuments=[identity(first)], limit=1,
    ))
    refreshed = await service.search(SupportProgramIndexSearchRequest(
        query="서울 AI", eligibleDocuments=[identity(second)], limit=20,
    ))

    assert [match.id for match in initial.matches] == [first.id]
    assert [match.id for match in refreshed.matches] == [second.id]
    assert refreshed.matches[0].score == pytest.approx(0)
    assert len(stub.requests) == 2  # 공고 batch와 질의 임베딩 각 한 번.
    assert exists.await_count == count.await_count == query_points.await_count == 2
    assert query_points.call_args_list[0].kwargs["query_filter"] != query_points.call_args_list[1].kwargs["query_filter"]


@pytest.mark.anyio
@pytest.mark.parametrize("unavailable", ["collection", "version", "removed"])
async def test_warm_cache_is_not_accessed_when_current_index_is_not_ready(index_environment, monkeypatch, unavailable):
    service, stub = index_environment
    item = document("BIZINFO:current", "서울 AI 지원")
    await service.index_batch(SupportProgramIndexBatchRequest(documents=[item]))
    request = SupportProgramIndexSearchRequest(query="서울 AI", eligibleDocuments=[identity(item)], limit=1)
    await service.search(request)
    if unavailable == "collection":
        await service.qdrant_client.delete_collection(service.collection_name)
    elif unavailable == "removed":
        await service.prune(SupportProgramIndexPruneRequest(sourceCode="BIZINFO", documents=[]))
    else:
        changed = document(item.id, "서울 AI 변경된 지원 조건")
        request = request.model_copy(update={"eligible_documents": [identity(changed)]})
    embed_query = AsyncMock(wraps=service._embed_query)
    query_points = AsyncMock(wraps=service.qdrant_client.query_points)
    monkeypatch.setattr(service, "_embed_query", embed_query)
    monkeypatch.setattr(service.qdrant_client, "query_points", query_points)

    with pytest.raises(SupportProgramIndexError, match="INDEX_NOT_READY"):
        await service.search(request)

    embed_query.assert_not_awaited()
    query_points.assert_not_awaited()
    assert len(stub.requests) == 2


@pytest.mark.anyio
async def test_query_cache_uses_exact_embedding_input_without_case_or_whitespace_folding(index_environment):
    service, stub = index_environment
    queries = ["서울 AI", "서울  AI", "서울 ai", "서울\nAI"]
    for query in queries:
        assert (await service._embed_query(query))[1] == "miss"
    for query in queries:
        assert (await service._embed_query(query))[1] == "hit"
    assert [request["input"] for request in stub.requests] == [[query] for query in queries]


@pytest.mark.anyio
@pytest.mark.parametrize("model,dimensions", [
    ("text-embedding-3-small", 3),
    ("text-embedding-3-large", 3),
    ("text-embedding-3-small", 2),
])
async def test_query_cache_is_instance_local_even_for_same_model_dimensions_and_preprocessing(index_environment, monkeypatch, model, dimensions):
    service, _ = index_environment
    await service._embed_query("서울 AI")
    other = SupportProgramIndexService(
        service.openai_client, service.qdrant_client,
        embedding_model=model, embedding_dimensions=dimensions, embedding_timeout_seconds=10,
    )
    vector = [0.0] * (dimensions - 1) + [1.0]
    embed = AsyncMock(return_value=[vector])
    monkeypatch.setattr(other, "_embed", embed)

    assert await other._embed_query("서울 AI") == (vector, "miss")
    embed.assert_awaited_once_with(["서울 AI"])
    assert await service._embed_query("서울 AI") == ([1.0, 0.0, 0.0], "hit")


@pytest.mark.anyio
async def test_query_cache_expires_at_ttl_and_hits_do_not_extend_lifetime(index_environment, monkeypatch):
    service, stub = index_environment
    now = [10.0]
    monkeypatch.setattr(service_module, "monotonic", lambda: now[0])
    assert (await service._embed_query("서울 AI"))[1] == "miss"
    now[0] = 309.9
    assert (await service._embed_query("서울 AI"))[1] == "hit"
    now[0] = 310.0
    assert (await service._embed_query("서울 AI"))[1] == "miss"
    assert len(stub.requests) == 2


@pytest.mark.anyio
async def test_query_cache_evicts_least_recently_used_and_removes_expired_entries(index_environment, monkeypatch):
    service, stub = index_environment
    now = [10.0]
    monkeypatch.setattr(service_module, "monotonic", lambda: now[0])
    monkeypatch.setattr(service_module, "_QUERY_EMBEDDING_CACHE_MAX_SIZE", 2)
    await service._embed_query("서울 AI")
    await service._embed_query("부산 제조업")
    assert (await service._embed_query("서울 AI"))[1] == "hit"
    await service._embed_query("대전 창업")
    assert len(service._query_embedding_cache) == 2
    assert (await service._embed_query("서울 AI"))[1] == "hit"
    assert (await service._embed_query("부산 제조업"))[1] == "miss"
    assert len(stub.requests) == 4
    now[0] = 310.0
    await service._embed_query("새로운 질의")
    assert list(service._query_embedding_cache) == ["새로운 질의"]


@pytest.mark.anyio
async def test_query_cache_owns_vector_and_returns_a_copy_on_both_miss_and_hit(index_environment, monkeypatch):
    service, _ = index_environment
    original = [1.0, 0.0, 0.0]
    embed = AsyncMock(return_value=[original])
    monkeypatch.setattr(service, "_embed", embed)
    first, _ = await service._embed_query("서울 AI")
    original[0] = 99.0
    first[1] = 98.0
    second, _ = await service._embed_query("서울 AI")
    second[2] = 97.0

    assert await service._embed_query("서울 AI") == ([1.0, 0.0, 0.0], "hit")
    embed.assert_awaited_once()


@pytest.mark.anyio
async def test_qdrant_cannot_mutate_cached_vector(index_environment, monkeypatch):
    service, stub = index_environment
    item = document("BIZINFO:current", "서울 AI 지원")
    await service.index_batch(SupportProgramIndexBatchRequest(documents=[item]))
    query_points = service.qdrant_client.query_points
    async def mutate_query(**kwargs):
        result = await query_points(**kwargs)
        kwargs["query"][0] = -99.0
        return result
    monkeypatch.setattr(service.qdrant_client, "query_points", mutate_query)
    request = SupportProgramIndexSearchRequest(query="서울 AI", eligibleDocuments=[identity(item)], limit=1)

    first = await service.search(request)
    second = await service.search(request)

    assert first == second
    assert second.matches[0].score == pytest.approx(1)
    assert len(stub.requests) == 2


@pytest.mark.anyio
@pytest.mark.parametrize("failure", ["http", "model", "dimensions", "boolean", "zero"])
async def test_failed_or_invalid_embedding_is_never_cached_and_next_search_retries(index_environment, failure):
    service, stub = index_environment
    item = document("BIZINFO:current", "서울 AI 지원")
    await service.index_batch(SupportProgramIndexBatchRequest(documents=[item]))
    request = SupportProgramIndexSearchRequest(query="서울 AI", eligibleDocuments=[identity(item)], limit=1)
    if failure == "http":
        stub.failure_status = 503
    elif failure == "model":
        stub.transform = lambda body: {**body, "model": "wrong-model"}
    else:
        invalid_vectors = {"dimensions": [1.0], "boolean": [True, 0.0, 0.0], "zero": [0.0, 0.0, 0.0]}
        stub.transform = lambda body: {**body, "data": [{"index": 0, "embedding": invalid_vectors[failure]}]}

    with pytest.raises(SupportProgramIndexError, match="INDEX_UNAVAILABLE"):
        await service.search(request)
    assert not service._query_embedding_cache
    assert not service._query_embedding_locks
    stub.failure_status = None
    stub.transform = lambda body: body
    assert (await service.search(request)).matches[0].score == pytest.approx(1)
    assert len(stub.requests) == 3


@pytest.mark.anyio
async def test_simultaneous_identical_queries_share_one_embedding_and_independent_vectors(index_environment, monkeypatch):
    service, stub = index_environment
    started, release = asyncio.Event(), asyncio.Event()
    original_embed = service._embed
    async def paused_embed(texts):
        started.set()
        await release.wait()
        return await original_embed(texts)
    embed = AsyncMock(side_effect=paused_embed)
    monkeypatch.setattr(service, "_embed", embed)
    first = asyncio.create_task(service._embed_query("서울 AI"))
    await asyncio.wait_for(started.wait(), 1)
    second = asyncio.create_task(service._embed_query("서울 AI"))
    await asyncio.sleep(0)
    release.set()
    initial, shared = await asyncio.gather(first, second)

    assert initial == ([1.0, 0.0, 0.0], "miss")
    assert shared == ([1.0, 0.0, 0.0], "coalesced")
    assert initial[0] is not shared[0]
    embed.assert_awaited_once()
    assert len(stub.requests) == 1
    assert not service._query_embedding_locks


@pytest.mark.anyio
async def test_different_queries_can_embed_concurrently(index_environment, monkeypatch):
    service, _ = index_environment
    both_started = asyncio.Event()
    started_queries = []
    async def concurrent_embed(texts):
        started_queries.extend(texts)
        if len(started_queries) == 2:
            both_started.set()
        await asyncio.wait_for(both_started.wait(), 1)
        return [[1.0, 0.0, 0.0]]
    monkeypatch.setattr(service, "_embed", concurrent_embed)

    results = await asyncio.gather(service._embed_query("서울 AI"), service._embed_query("부산 제조업"))

    assert [state for _, state in results] == ["miss", "miss"]
    assert not service._query_embedding_locks


@pytest.mark.anyio
@pytest.mark.parametrize("cancelled", ["owner", "waiter", "all"])
async def test_cancellation_releases_query_lock_without_poisoning_other_requests(index_environment, monkeypatch, cancelled):
    service, _ = index_environment
    started, retried, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    calls = 0
    async def paused_embed(texts):
        nonlocal calls
        calls += 1
        (started if calls == 1 else retried).set()
        await release.wait()
        return [[1.0, 0.0, 0.0]]
    monkeypatch.setattr(service, "_embed", paused_embed)
    first = asyncio.create_task(service._embed_query("서울 AI"))
    await asyncio.wait_for(started.wait(), 1)
    second = asyncio.create_task(service._embed_query("서울 AI"))
    await asyncio.sleep(0)
    if cancelled in {"waiter", "all"}:
        second.cancel()
        with pytest.raises(asyncio.CancelledError):
            await second
    if cancelled in {"owner", "all"}:
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
    if cancelled == "owner":
        await asyncio.wait_for(retried.wait(), 1)
    release.set()
    if cancelled == "owner":
        assert await second == ([1.0, 0.0, 0.0], "miss")
    elif cancelled == "waiter":
        assert await first == ([1.0, 0.0, 0.0], "miss")
    else:
        assert not service._query_embedding_cache
        assert await service._embed_query("서울 AI") == ([1.0, 0.0, 0.0], "miss")

    assert not service._query_embedding_locks
    assert await service._embed_query("서울 AI") == ([1.0, 0.0, 0.0], "hit")


@pytest.mark.anyio
async def test_success_logs_only_stage_timings_and_allowlisted_cache_state(index_environment, caplog):
    service, _ = index_environment
    item = document("BIZINFO:private-document-id", "서울 AI 비공개 공고 원문")
    await service.index_batch(SupportProgramIndexBatchRequest(documents=[item]))
    request = SupportProgramIndexSearchRequest(
        query="서울 AI 비공개 검색어", eligibleDocuments=[identity(item)], limit=1,
    )
    with caplog.at_level(logging.INFO, logger=service_module.__name__):
        await service.search(request)
        await service.search(request)

    records = [record for record in caplog.records if record.name == service_module.__name__]
    assert len(records) == 2
    for record, state in zip(records, ["miss", "hit"], strict=True):
        assert re.fullmatch(
            rf"support_program_index_search_completed readiness_ms=\d+ embedding_ms=\d+ vector_search_ms=\d+ elapsed_ms=\d+ cache_state={state}",
            record.getMessage(),
        )
        assert record.exc_info is None
