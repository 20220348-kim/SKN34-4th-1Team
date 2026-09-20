from unittest.mock import AsyncMock

import pytest
import tiktoken
from qdrant_client import models

from app.support_program_index.models import (
    SupportProgramIndexBatchRequest,
    SupportProgramIndexPruneRequest,
    SupportProgramIndexSearchRequest,
)
from app.support_program_index.service import SupportProgramIndexError, SupportProgramIndexService, _point_id
from .conftest import document, identity


@pytest.mark.anyio
async def test_search_finds_related_program_beyond_the_twenty_latest_programs(index_environment):
    service, stub = index_environment
    documents = [document(f"BIZINFO:recent-{index}", f"부산 제조설비 지원 공고 {index}") for index in range(25)]
    oldest_related = document("BIZINFO:oldest", "서울 AI 창업기업 기술 사업화 지원")
    documents.append(oldest_related)

    indexed = await service.index_batch(SupportProgramIndexBatchRequest(documents=documents))
    result = await service.search(SupportProgramIndexSearchRequest(
        query="서울 AI 기업 지원", eligibleDocuments=[identity(item) for item in documents], limit=20,
    ))

    assert indexed.indexed_count == 26
    assert len(result.matches) == 20
    assert result.matches[0].id == "BIZINFO:oldest"
    assert result.matches[0].content_hash == oldest_related.content_hash
    assert result.matches[0].score == pytest.approx(1)
    assert stub.requests[0]["encoding_format"] == "float"
    assert stub.requests[0]["dimensions"] == 3
    assert len(stub.requests[0]["input"]) == 26


@pytest.mark.anyio
async def test_same_input_is_idempotent_and_changed_text_gets_a_new_version(index_environment):
    service, stub = index_environment
    original = document("BIZINFO:A", "서울 AI 지원")
    changed = document("BIZINFO:A", "부산 제조업 지원")
    assert (await service.index_batch(SupportProgramIndexBatchRequest(documents=[original]))).indexed_count == 1
    assert (await service.index_batch(SupportProgramIndexBatchRequest(documents=[original]))).indexed_count == 1
    assert len(stub.requests) == 1

    await service.index_batch(SupportProgramIndexBatchRequest(documents=[changed]))
    assert (await service.qdrant_client.count(service.collection_name, exact=True)).count == 2
    result = await service.search(SupportProgramIndexSearchRequest(query="서울 AI", eligibleDocuments=[identity(changed)], limit=20))
    assert [match.content_hash for match in result.matches] == [changed.content_hash]
    assert result.matches[0].score == pytest.approx(0)


@pytest.mark.anyio
async def test_search_excludes_inactive_closed_other_source_and_old_hash(index_environment):
    service, _ = index_environment
    current = document("BIZINFO:current", "부산 제조업 지원")
    old = document("BIZINFO:current", "서울 AI 이전 내용")
    excluded = [document("BIZINFO:inactive", "서울 AI 삭제됨"), document("BIZINFO:closed", "서울 AI 마감"), document("OTHER:current", "서울 AI 타 제공처")]
    await service.index_batch(SupportProgramIndexBatchRequest(documents=[old, *excluded]))
    await service.index_batch(SupportProgramIndexBatchRequest(documents=[current]))

    result = await service.search(SupportProgramIndexSearchRequest(query="서울 AI", eligibleDocuments=[identity(current)], limit=20))

    assert [(match.id, match.content_hash) for match in result.matches] == [(current.id, current.content_hash)]


@pytest.mark.anyio
async def test_unindexed_current_document_fails_before_query_embedding(index_environment):
    service, stub = index_environment
    old = document("BIZINFO:known", "서울 AI 이전 내용")
    changed = document("BIZINFO:known", "서울 AI 새 내용")
    await service.index_batch(SupportProgramIndexBatchRequest(documents=[old]))
    missing = document("BIZINFO:missing", "부산 새 공고")

    for eligible in [[identity(changed)], [identity(old), identity(missing)]]:
        with pytest.raises(SupportProgramIndexError, match="INDEX_NOT_READY"):
            await service.search(SupportProgramIndexSearchRequest(query="서울 AI", eligibleDocuments=eligible, limit=20))
    assert len(stub.requests) == 1


@pytest.mark.anyio
async def test_missing_collection_never_created_during_search(index_environment):
    service, stub = index_environment
    item = document("BIZINFO:A", "서울 AI")
    with pytest.raises(SupportProgramIndexError, match="INDEX_NOT_READY"):
        await service.search(SupportProgramIndexSearchRequest(query="서울 AI", eligibleDocuments=[identity(item)], limit=20))
    assert not await service.qdrant_client.collection_exists(service.collection_name)
    assert not stub.requests


@pytest.mark.anyio
async def test_empty_catalog_needs_no_embedding_or_collection(index_environment):
    service, stub = index_environment
    result = await service.search(SupportProgramIndexSearchRequest(query="서울 AI", eligibleDocuments=[], limit=20))
    assert result.matches == []
    assert (await service.prune(SupportProgramIndexPruneRequest(sourceCode="BIZINFO", documents=[]))).retained_count == 0
    assert not await service.qdrant_client.collection_exists(service.collection_name)
    assert not stub.requests


@pytest.mark.anyio
async def test_prune_removes_old_versions_and_missing_programs_only_for_one_source(index_environment):
    service, _ = index_environment
    old = document("BIZINFO:A", "서울 AI 이전 내용")
    changed = document("BIZINFO:A", "서울 AI 갱신됨")
    removed = document("BIZINFO:B", "부산 제조업")
    other = document("OTHER:A", "서울 AI 다른 제공처")
    await service.index_batch(SupportProgramIndexBatchRequest(documents=[old, removed, other]))
    await service.index_batch(SupportProgramIndexBatchRequest(documents=[changed]))

    assert (await service.prune(SupportProgramIndexPruneRequest(sourceCode="BIZINFO", documents=[identity(changed)]))).retained_count == 1
    stored, _ = await service.qdrant_client.scroll(service.collection_name, limit=10)
    assert {str(point.id) for point in stored} == {_point_id(changed), _point_id(other)}

    await service.prune(SupportProgramIndexPruneRequest(sourceCode="BIZINFO", documents=[]))
    stored, _ = await service.qdrant_client.scroll(service.collection_name, limit=10)
    assert {str(point.id) for point in stored} == {_point_id(other)}


@pytest.mark.anyio
async def test_failed_batch_preserves_old_points_and_prune_refuses_incomplete_snapshot(index_environment):
    service, stub = index_environment
    old = document("BIZINFO:A", "서울 AI 이전 내용")
    changed = document("BIZINFO:A", "서울 AI 변경됨")
    new = document("BIZINFO:B", "부산 제조업 신규")
    await service.index_batch(SupportProgramIndexBatchRequest(documents=[old]))
    await service.index_batch(SupportProgramIndexBatchRequest(documents=[new]))
    stub.failure_status = 503
    with pytest.raises(SupportProgramIndexError, match="INDEX_UNAVAILABLE"):
        await service.index_batch(SupportProgramIndexBatchRequest(documents=[changed]))
    assert len(stub.requests) == 3  # max_retries=0
    with pytest.raises(SupportProgramIndexError, match="INDEX_NOT_READY"):
        await service.prune(SupportProgramIndexPruneRequest(sourceCode="BIZINFO", documents=[identity(changed), identity(new)]))
    stored, _ = await service.qdrant_client.scroll(service.collection_name, limit=10)
    assert {str(point.id) for point in stored} == {_point_id(old), _point_id(new)}

    stub.failure_status = None
    await service.index_batch(SupportProgramIndexBatchRequest(documents=[changed, new]))
    assert len(stub.requests[-1]["input"]) == 1
    await service.prune(SupportProgramIndexPruneRequest(sourceCode="BIZINFO", documents=[identity(changed), identity(new)]))
    stored, _ = await service.qdrant_client.scroll(service.collection_name, limit=10)
    assert {str(point.id) for point in stored} == {_point_id(changed), _point_id(new)}


@pytest.mark.anyio
@pytest.mark.parametrize("mutation", [
    lambda body: body.update(model="wrong-model"),
    lambda body: body.update(data=[]),
    lambda body: body["data"].append(body["data"][0]),
    lambda body: body["data"][0].update(index=1),
    lambda body: body["data"][0].update(embedding=[1.0, 0.0]),
    lambda body: body["data"][0].update(embedding=[0.0, 0.0, 0.0]),
    lambda body: body["data"][0].update(embedding=[True, 0.0, 0.0]),
    lambda body: body["data"][0].update(embedding=["bad", 0.0, 0.0]),
])
async def test_malformed_embedding_does_not_write_points(index_environment, mutation):
    service, stub = index_environment
    def transform(body):
        mutation(body)
        return body
    stub.transform = transform
    with pytest.raises(SupportProgramIndexError):
        await service.index_batch(SupportProgramIndexBatchRequest(documents=[document("BIZINFO:A", "서울 AI")]))
    assert (await service.qdrant_client.count(service.collection_name, exact=True)).count == 0


@pytest.mark.anyio
async def test_reordered_embedding_indices_are_mapped_back_to_correct_documents(index_environment):
    service, stub = index_environment
    stub.transform = lambda body: {**body, "data": list(reversed(body["data"]))}
    documents = [document("BIZINFO:A", "서울 AI 지원"), document("BIZINFO:B", "부산 제조업")]
    await service.index_batch(SupportProgramIndexBatchRequest(documents=documents))
    result = await service.search(SupportProgramIndexSearchRequest(query="서울 AI", eligibleDocuments=[identity(item) for item in documents], limit=1))
    assert result.matches[0].id == "BIZINFO:A"


@pytest.mark.anyio
async def test_bounds_tokens_and_total_batch_tokens(index_environment):
    service, stub = index_environment
    text = "힣" * 12_000
    documents = [document(f"BIZINFO:{index}", text) for index in range(50)]
    await service.index_batch(SupportProgramIndexBatchRequest(documents=documents))
    encoding = tiktoken.get_encoding("cl100k_base")
    assert [len(request["input"]) for request in stub.requests] == [32, 18]
    for request in stub.requests:
        counts = [len(encoding.encode_ordinary(text)) for text in request["input"]]
        assert max(counts) <= 8191
        assert sum(counts) < 300_000


@pytest.mark.anyio
async def test_upsert_failure_does_not_erase_previous_version(index_environment, monkeypatch):
    service, _ = index_environment
    old = document("BIZINFO:A", "서울 AI 이전 내용")
    changed = document("BIZINFO:A", "서울 AI 새 내용")
    await service.index_batch(SupportProgramIndexBatchRequest(documents=[old]))
    monkeypatch.setattr(service.qdrant_client, "upsert", AsyncMock(side_effect=TimeoutError("private qdrant detail")))
    with pytest.raises(SupportProgramIndexError):
        await service.index_batch(SupportProgramIndexBatchRequest(documents=[changed]))
    assert (await service.qdrant_client.count(service.collection_name, exact=True)).count == 1


@pytest.mark.anyio
async def test_rejects_non_finite_embedding(index_environment, monkeypatch):
    service, _ = index_environment
    from types import SimpleNamespace
    response = SimpleNamespace(http_response=SimpleNamespace(json=lambda: {"model": service.embedding_model, "data": [{"index": 0, "embedding": [float("nan"), 1.0, 0.0]}]}))
    monkeypatch.setattr(service.openai_client.embeddings.with_raw_response, "create", AsyncMock(return_value=response))
    with pytest.raises(SupportProgramIndexError):
        await service.index_batch(SupportProgramIndexBatchRequest(documents=[document("BIZINFO:A", "서울 AI")]))
    assert (await service.qdrant_client.count(service.collection_name, exact=True)).count == 0


def test_model_dimensions_and_schema_isolate_collections():
    arguments = {"openai_client": None, "qdrant_client": None, "embedding_model": "text-embedding-3-small", "embedding_dimensions": 1536, "embedding_timeout_seconds": 1}
    first = SupportProgramIndexService(**arguments)
    assert first.collection_name == SupportProgramIndexService(**arguments).collection_name
    assert first.collection_name != SupportProgramIndexService(**{**arguments, "embedding_dimensions": 512}).collection_name
    assert first.collection_name != SupportProgramIndexService(**{**arguments, "embedding_model": "text-embedding-3-large"}).collection_name
