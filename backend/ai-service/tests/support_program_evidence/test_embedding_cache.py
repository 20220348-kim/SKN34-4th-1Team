import asyncio
import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from qdrant_client import models

from app.support_program_evidence import service as service_module
from app.support_program_evidence.errors import SupportProgramEvidenceError
from app.support_program_evidence.models import (
    SupportProgramEvidenceBatchRequest,
    SupportProgramEvidenceSearchRequest,
)
from app.support_program_evidence.service import SupportProgramEvidenceService, _point_id

from .conftest import chunk, identity


async def prepared_search(service, question="비공개 질문: 신청 기간"):
    document = chunk("BIZINFO:PBLN:100", 0, "비공개 공고: 신청 기간은 3월입니다.")
    await service.index_chunks(SupportProgramEvidenceBatchRequest(chunks=[document]))
    return SupportProgramEvidenceSearchRequest(
        question=question, eligibleChunks=[identity(document)], limit=1,
    ), document


@pytest.mark.anyio
async def test_repeated_question_reuses_only_embedding_and_still_searches_qdrant(evidence_environment, monkeypatch, caplog):
    service, stub = evidence_environment
    request, document = await prepared_search(service)
    retrieve = AsyncMock(wraps=service.qdrant_client.retrieve)
    search = AsyncMock(wraps=service.qdrant_client.query_points)
    monkeypatch.setattr(service.qdrant_client, "retrieve", retrieve)
    monkeypatch.setattr(service.qdrant_client, "query_points", search)
    with caplog.at_level(logging.INFO, logger=service_module.__name__):
        first = await service.search(request)
        second = await service.search(request)
    assert first == second
    assert len(stub.requests) == 2  # Initial document and one question embedding.
    assert retrieve.await_count == search.await_count == 2
    assert "cache_state=miss" in caplog.text and "cache_state=hit" in caplog.text
    for timing in ("readiness_ms=", "embedding_ms=", "vector_search_ms=", "elapsed_ms="):
        assert timing in caplog.text
    assert request.question not in caplog.text and document.text not in caplog.text
    assert document.id not in caplog.text
    assert request.question not in service._query_embedding_cache


@pytest.mark.anyio
@pytest.mark.parametrize("damage", ["missing", "wrong_document", "invalid_search"])
async def test_warm_embedding_cache_never_skips_qdrant_integrity_checks(evidence_environment, monkeypatch, damage):
    service, stub = evidence_environment
    request, document = await prepared_search(service)
    await service.search(request)
    if damage == "missing":
        await service.qdrant_client.delete(
            service.collection_name, models.PointIdsList(points=[_point_id(document)]), wait=True,
        )
    elif damage == "wrong_document":
        await service.qdrant_client.set_payload(
            service.collection_name, {"documentId": "BIZINFO:PBLN:200"}, [_point_id(document)], wait=True,
        )
    else:
        monkeypatch.setattr(service.qdrant_client, "query_points", AsyncMock(return_value=SimpleNamespace(points=[])))
    with pytest.raises(SupportProgramEvidenceError):
        await service.search(request)
    assert len(stub.requests) == 2


@pytest.mark.anyio
async def test_failed_question_embedding_is_not_cached(evidence_environment, caplog):
    service, stub = evidence_environment
    request, _ = await prepared_search(service)
    stub.transform = lambda body: {**body, "data": []}
    with caplog.at_level(logging.INFO, logger=service_module.__name__):
        with pytest.raises(SupportProgramEvidenceError):
            await service.search(request)
    assert "support_program_evidence_search_failed stage=embedding" in caplog.text
    assert not service._query_embedding_cache and not service._query_embedding_locks
    stub.transform = lambda body: body
    await service.search(request)
    assert len(stub.requests) == 3


@pytest.mark.anyio
async def test_query_cache_returns_detached_vectors(evidence_environment):
    service, stub = evidence_environment
    vector, state = await service._embed_query("서울 AI")
    vector[0] = 999.0
    again, state = await service._embed_query("서울 AI")
    assert state == "hit" and again == [1.0, 0.0, 0.0]
    assert len(stub.requests) == 1


@pytest.mark.anyio
async def test_query_cache_expires_without_extending_ttl_on_hits(evidence_environment, monkeypatch):
    service, stub = evidence_environment
    now = [0.0]
    monkeypatch.setattr(service_module, "monotonic", lambda: now[0])
    await service._embed_query("서울 AI")
    now[0] = 299.0
    assert (await service._embed_query("서울 AI"))[1] == "hit"
    now[0] = 300.0
    assert (await service._embed_query("서울 AI"))[1] == "miss"
    assert len(stub.requests) == 2


@pytest.mark.anyio
async def test_query_cache_has_lru_capacity_and_model_instance_isolation(evidence_environment, monkeypatch):
    service, stub = evidence_environment
    monkeypatch.setattr(service_module, "_QUERY_EMBEDDING_CACHE_MAX_SIZE", 2)
    for question in ("질문 하나", "질문 둘", "질문 하나", "질문 셋", "질문 둘"):
        await service._embed_query(question)
    assert len(stub.requests) == 4
    assert len(service._query_embedding_cache) == 2
    other = SupportProgramEvidenceService(
        service.openai_client, service.qdrant_client,
        embedding_model="different-model", embedding_dimensions=3, embedding_timeout_seconds=10,
    )
    await other._embed_query("질문 둘")
    assert len(stub.requests) == 5
    assert stub.requests[-1]["model"] == "different-model"
    assert other.collection_name != service.collection_name


@pytest.mark.anyio
async def test_identical_concurrent_questions_share_one_embedding(evidence_environment, monkeypatch):
    service, _ = evidence_environment
    entered, release = asyncio.Event(), asyncio.Event()

    async def embed(texts):
        entered.set()
        await release.wait()
        return [[1.0, 0.0, 0.0]]

    mock = AsyncMock(side_effect=embed)
    monkeypatch.setattr(service, "_embed", mock)
    first = asyncio.create_task(service._embed_query("서울 AI"))
    await entered.wait()
    second = asyncio.create_task(service._embed_query("서울 AI"))
    await asyncio.sleep(0)
    release.set()
    results = await asyncio.gather(first, second)
    assert [result[1] for result in results] == ["miss", "coalesced"]
    assert mock.await_count == 1
    results[0][0][0] = 999.0
    assert results[1][0][0] == 1.0
    assert not service._query_embedding_locks


@pytest.mark.anyio
async def test_different_questions_are_not_serialized(evidence_environment, monkeypatch):
    service, _ = evidence_environment
    both_entered, release = asyncio.Event(), asyncio.Event()
    entered = []

    async def embed(texts):
        entered.append(texts[0])
        if len(entered) == 2:
            both_entered.set()
        await release.wait()
        return [[1.0, 0.0, 0.0]]

    monkeypatch.setattr(service, "_embed", embed)
    tasks = [asyncio.create_task(service._embed_query(question)) for question in ("서울 AI", "부산 무역")]
    try:
        async with asyncio.timeout(2):
            await both_entered.wait()
    finally:
        release.set()
        await asyncio.gather(*tasks)
    assert not service._query_embedding_locks


@pytest.mark.anyio
async def test_cancelled_owner_releases_same_question_for_waiting_request(evidence_environment, monkeypatch):
    service, _ = evidence_environment
    entered = asyncio.Event()
    calls = 0

    async def embed(texts):
        nonlocal calls
        calls += 1
        if calls == 1:
            entered.set()
            await asyncio.Event().wait()
        return [[1.0, 0.0, 0.0]]

    monkeypatch.setattr(service, "_embed", embed)
    first = asyncio.create_task(service._embed_query("서울 AI"))
    await entered.wait()
    second = asyncio.create_task(service._embed_query("서울 AI"))
    await asyncio.sleep(0)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    async with asyncio.timeout(2):
        assert (await second)[1] == "miss"
    assert calls == 2 and not service._query_embedding_locks


@pytest.mark.anyio
async def test_cancelled_waiter_does_not_cancel_embedding_owner(evidence_environment, monkeypatch):
    service, _ = evidence_environment
    entered, release = asyncio.Event(), asyncio.Event()

    async def embed(texts):
        entered.set()
        await release.wait()
        return [[1.0, 0.0, 0.0]]

    mock = AsyncMock(side_effect=embed)
    monkeypatch.setattr(service, "_embed", mock)
    first = asyncio.create_task(service._embed_query("서울 AI"))
    await entered.wait()
    second = asyncio.create_task(service._embed_query("서울 AI"))
    await asyncio.sleep(0)
    second.cancel()
    with pytest.raises(asyncio.CancelledError):
        await second
    release.set()
    assert (await first)[1] == "miss"
    assert (await service._embed_query("서울 AI"))[1] == "hit"
    assert mock.await_count == 1 and not service._query_embedding_locks


@pytest.mark.anyio
async def test_same_content_at_new_document_or_order_reuses_vector_but_keeps_identity(evidence_environment):
    service, stub = evidence_environment
    first = chunk("BIZINFO:PBLN:100", 0, "서울 AI 지원")
    changed_id = chunk("BIZINFO:PBLN:100", 1, first.text)
    other_document = chunk("BIZINFO:PBLN:200", 0, first.text)
    await service.index_chunks(SupportProgramEvidenceBatchRequest(chunks=[first]))
    await service.index_chunks(SupportProgramEvidenceBatchRequest(chunks=[changed_id, other_document]))
    assert len(stub.requests) == 1
    assert (await service.qdrant_client.count(service.collection_name, exact=True)).count == 3
    for current in (first, changed_id, other_document):
        result = await service.search(SupportProgramEvidenceSearchRequest(
            question="서울 AI 지원?", eligibleChunks=[identity(current)], limit=1,
        ))
        assert result.matches[0].document_id == current.document_id
        assert result.matches[0].order == current.order
        assert result.matches[0].id == current.id


@pytest.mark.anyio
async def test_chunk_batch_deduplicates_text_and_does_not_change_input_order(evidence_environment):
    service, stub = evidence_environment
    chunks = [chunk("BIZINFO:PBLN:100", index, text) for index, text in enumerate(("서울 AI", "부산 무역", "서울 AI"))]
    await service.index_chunks(SupportProgramEvidenceBatchRequest(chunks=chunks))
    assert stub.requests[0]["input"] == ["서울 AI", "부산 무역"]
    points = await service.qdrant_client.retrieve(
        service.collection_name, [_point_id(item) for item in chunks], with_vectors=True,
    )
    by_id = {str(point.id): point for point in points}
    assert by_id[_point_id(chunks[0])].vector == by_id[_point_id(chunks[2])].vector
    assert by_id[_point_id(chunks[0])].vector != by_id[_point_id(chunks[1])].vector


@pytest.mark.anyio
async def test_chunk_cache_uses_content_not_supplied_document_version(evidence_environment):
    service, stub = evidence_environment
    original = chunk("BIZINFO:PBLN:100", 0, "서울 AI")
    revised = chunk("BIZINFO:PBLN:100", 0, "부산 무역")
    await service.index_chunks(SupportProgramEvidenceBatchRequest(chunks=[original]))
    await service.index_chunks(SupportProgramEvidenceBatchRequest(chunks=[revised]))
    assert len(stub.requests) == 2
    assert _point_id(original) != _point_id(revised)


@pytest.mark.anyio
async def test_chunk_cache_has_lru_limit_and_expiration(evidence_environment, monkeypatch):
    service, stub = evidence_environment
    now = [0.0]
    monkeypatch.setattr(service_module, "monotonic", lambda: now[0])
    monkeypatch.setattr(service_module, "_CHUNK_EMBEDDING_CACHE_MAX_SIZE", 2)
    for index, text in enumerate(("서울 AI", "부산 무역", "서울 AI", "대구 창업", "부산 무역")):
        await service.index_chunks(SupportProgramEvidenceBatchRequest(chunks=[chunk("BIZINFO:PBLN:100", index, text)]))
    assert len(stub.requests) == 4
    assert len(service._chunk_embedding_cache) == 2
    now[0] = 300.0
    await service.index_chunks(SupportProgramEvidenceBatchRequest(chunks=[chunk("BIZINFO:PBLN:200", 0, "부산 무역")]))
    assert len(stub.requests) == 5
    assert len(service._chunk_embedding_cache) == 1


@pytest.mark.anyio
async def test_malformed_chunk_batch_is_not_cached_or_written(evidence_environment):
    service, stub = evidence_environment
    request = SupportProgramEvidenceBatchRequest(chunks=[chunk("BIZINFO:PBLN:100", 0, "서울 AI")])
    stub.transform = lambda body: {**body, "data": []}
    with pytest.raises(SupportProgramEvidenceError):
        await service.index_chunks(request)
    assert not service._chunk_embedding_cache
    assert (await service.qdrant_client.count(service.collection_name, exact=True)).count == 0
    stub.transform = lambda body: body
    await service.index_chunks(request)
    assert len(stub.requests) == 2


@pytest.mark.anyio
async def test_cached_chunk_vector_does_not_hide_failed_upsert(evidence_environment, monkeypatch):
    service, stub = evidence_environment
    request = SupportProgramEvidenceBatchRequest(chunks=[chunk("BIZINFO:PBLN:100", 0, "서울 AI")])
    real_upsert = service.qdrant_client.upsert
    upsert = AsyncMock(side_effect=RuntimeError("private Qdrant detail"))
    monkeypatch.setattr(service.qdrant_client, "upsert", upsert)
    with pytest.raises(SupportProgramEvidenceError):
        await service.index_chunks(request)
    monkeypatch.setattr(service.qdrant_client, "upsert", real_upsert)
    await service.index_chunks(request)
    assert len(stub.requests) == 1  # Valid vector can be reused; the failed DB write is retried.
    assert (await service.qdrant_client.count(service.collection_name, exact=True)).count == 1


@pytest.mark.anyio
async def test_concurrent_chunk_indexing_keeps_one_writer_and_detached_vectors(evidence_environment, monkeypatch):
    service, stub = evidence_environment
    entered, release = asyncio.Event(), asyncio.Event()
    real_embed = service._embed

    async def embed(texts):
        entered.set()
        await release.wait()
        return await real_embed(texts)

    monkeypatch.setattr(service, "_embed", embed)
    requests = [SupportProgramEvidenceBatchRequest(chunks=[chunk("BIZINFO:PBLN:100", index, "서울 AI")]) for index in range(2)]
    first = asyncio.create_task(service.index_chunks(requests[0]))
    await entered.wait()
    second = asyncio.create_task(service.index_chunks(requests[1]))
    await asyncio.sleep(0)
    release.set()
    await asyncio.gather(first, second)
    assert len(stub.requests) == 1
    vectors, _ = await service._embed_chunks(["서울 AI"])
    vectors[0][0] = 999.0
    vectors, _ = await service._embed_chunks(["서울 AI"])
    assert vectors[0][0] == 1.0
    assert not service._write_lock.locked()


@pytest.mark.anyio
async def test_failed_embedding_owner_does_not_poison_waiting_request(evidence_environment, monkeypatch):
    service, _ = evidence_environment
    entered, release = asyncio.Event(), asyncio.Event()
    calls = 0

    async def embed(texts):
        nonlocal calls
        calls += 1
        if calls == 1:
            entered.set()
            await release.wait()
            raise SupportProgramEvidenceError()
        return [[1.0, 0.0, 0.0]]

    monkeypatch.setattr(service, "_embed", embed)
    first = asyncio.create_task(service._embed_query("서울 AI"))
    await entered.wait()
    second = asyncio.create_task(service._embed_query("서울 AI"))
    await asyncio.sleep(0)
    release.set()
    with pytest.raises(SupportProgramEvidenceError):
        await first
    async with asyncio.timeout(2):
        assert (await second)[1] == "miss"
    assert calls == 2 and not service._query_embedding_locks


@pytest.mark.anyio
async def test_cancelled_chunk_embedding_releases_writer_without_caching_or_writing(evidence_environment, monkeypatch):
    service, stub = evidence_environment
    real_embed = service._embed
    entered = asyncio.Event()

    async def blocked_embed(texts):
        entered.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(service, "_embed", blocked_embed)
    request = SupportProgramEvidenceBatchRequest(chunks=[chunk("BIZINFO:PBLN:100", 0, "서울 AI")])
    task = asyncio.create_task(service.index_chunks(request))
    await entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert not service._write_lock.locked()
    assert not service._chunk_embedding_cache
    assert (await service.qdrant_client.count(service.collection_name, exact=True)).count == 0
    monkeypatch.setattr(service, "_embed", real_embed)
    await service.index_chunks(request)
    assert len(stub.requests) == 1
