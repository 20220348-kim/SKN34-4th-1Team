from hashlib import sha256
from unittest.mock import AsyncMock

import pytest

from app.support_program_evidence.models import (
    EvidenceChunkIdentity,
    SupportProgramEvidenceBatchRequest,
    SupportProgramEvidenceSearchRequest,
)
from app.support_program_evidence.errors import SupportProgramEvidenceError
from app.support_program_evidence.service import _point_id

from .conftest import chunk, identity


@pytest.mark.anyio
async def test_indexes_and_searches_only_the_eligible_detail_document_chunks(
    evidence_environment,
):
    service, stub = evidence_environment
    application = chunk("BIZINFO:PBLN:100", 0, "신청 접수 기간은 2026년 3월입니다.")
    target = chunk("BIZINFO:PBLN:100", 1, "지원 대상은 서울 소재 AI 중소기업입니다.")
    other_document = chunk("BIZINFO:PBLN:200", 0, "접수 기간은 2027년 1월입니다.")

    indexed = await service.index_chunks(
        SupportProgramEvidenceBatchRequest(chunks=[application, target, other_document])
    )
    result = await service.search(
        SupportProgramEvidenceSearchRequest(
            question="접수 기간이 언제인가요?",
            eligibleChunks=[identity(application), identity(target)],
            limit=5,
        )
    )

    assert indexed.indexed_count == 3
    assert result.question == "접수 기간이 언제인가요?"
    assert [match.id for match in result.matches] == [application.id, target.id]
    assert {match.document_id for match in result.matches} == {"BIZINFO:PBLN:100"}
    assert result.matches[0].content_hash == application.content_hash
    assert result.matches[0].order == 0
    assert len(stub.requests) == 2
    assert "evidence" in service.collection_name


@pytest.mark.anyio
async def test_search_requires_every_eligible_chunk_before_embedding_the_question(
    evidence_environment,
):
    service, stub = evidence_environment
    indexed = chunk("BIZINFO:PBLN:100", 0, "서울 AI 지원")
    missing = chunk("BIZINFO:PBLN:100", 1, "추가 제출 서류")
    await service.index_chunks(SupportProgramEvidenceBatchRequest(chunks=[indexed]))

    with pytest.raises(SupportProgramEvidenceError, match="EVIDENCE_NOT_READY"):
        await service.search(
            SupportProgramEvidenceSearchRequest(
                question="제출 서류가 무엇인가요?",
                eligibleChunks=[identity(indexed), identity(missing)],
                limit=2,
            )
        )

    assert len(stub.requests) == 1


@pytest.mark.anyio
async def test_search_checks_readiness_and_identity_with_one_payload_lookup(
    evidence_environment, monkeypatch,
):
    service, _ = evidence_environment
    indexed = chunk("BIZINFO:PBLN:100", 0, "서울 AI 지원")
    await service.index_chunks(SupportProgramEvidenceBatchRequest(chunks=[indexed]))
    retrieve = AsyncMock(wraps=service.qdrant_client.retrieve)
    count = AsyncMock(wraps=service.qdrant_client.count)
    monkeypatch.setattr(service.qdrant_client, "retrieve", retrieve)
    monkeypatch.setattr(service.qdrant_client, "count", count)

    result = await service.search(
        SupportProgramEvidenceSearchRequest(
            question="서울 AI 지원인가요?",
            eligibleChunks=[identity(indexed)],
            limit=1,
        )
    )

    assert [match.id for match in result.matches] == [indexed.id]
    retrieve.assert_awaited_once_with(
        collection_name=service.collection_name,
        ids=[_point_id(indexed)],
        with_payload=True,
        with_vectors=False,
    )
    count.assert_not_awaited()


@pytest.mark.anyio
@pytest.mark.parametrize("payload", [
    {"id": "0" * 64},
    {"contentHash": "0" * 64},
    {"order": 1},
])
async def test_search_rejects_mismatched_indexed_payload_before_embedding(
    evidence_environment, payload,
):
    service, stub = evidence_environment
    indexed = chunk("BIZINFO:PBLN:100", 0, "서울 AI 지원")
    await service.index_chunks(SupportProgramEvidenceBatchRequest(chunks=[indexed]))
    await service.qdrant_client.set_payload(
        collection_name=service.collection_name,
        payload=payload,
        points=[_point_id(indexed)],
        wait=True,
    )

    with pytest.raises(SupportProgramEvidenceError, match="EVIDENCE_UNAVAILABLE"):
        await service.search(
            SupportProgramEvidenceSearchRequest(
                question="서울 AI 지원인가요?",
                eligibleChunks=[identity(indexed)],
                limit=1,
            )
        )

    assert len(stub.requests) == 1


@pytest.mark.anyio
async def test_rejects_a_chunk_identity_reused_for_a_different_document(
    evidence_environment,
):
    service, _ = evidence_environment
    shared_chunk_id = sha256(b"stable-chunk-id").hexdigest()
    first = chunk("BIZINFO:PBLN:100", 0, "서울 AI 지원", chunk_id=shared_chunk_id)
    different_document = chunk(
        "BIZINFO:PBLN:200",
        0,
        "서울 AI 지원",
        chunk_id=shared_chunk_id,
    )
    await service.index_chunks(SupportProgramEvidenceBatchRequest(chunks=[first]))

    with pytest.raises(SupportProgramEvidenceError, match="EVIDENCE_UNAVAILABLE"):
        await service.index_chunks(
            SupportProgramEvidenceBatchRequest(chunks=[different_document])
        )


@pytest.mark.anyio
async def test_search_rejects_an_eligible_chunk_from_another_document_before_embedding(
    evidence_environment,
):
    service, stub = evidence_environment
    indexed = chunk("BIZINFO:PBLN:100", 0, "서울 AI 지원")
    await service.index_chunks(SupportProgramEvidenceBatchRequest(chunks=[indexed]))
    cross_document_identity = EvidenceChunkIdentity(
        id=indexed.id,
        contentHash=indexed.content_hash,
        documentId="BIZINFO:PBLN:200",
        order=indexed.order,
    )

    with pytest.raises(SupportProgramEvidenceError, match="EVIDENCE_UNAVAILABLE"):
        await service.search(
            SupportProgramEvidenceSearchRequest(
                question="서울 AI 지원인가요?",
                eligibleChunks=[cross_document_identity],
                limit=1,
            )
        )

    assert len(stub.requests) == 1


@pytest.mark.anyio
async def test_changed_chunk_content_creates_a_new_version_but_searches_only_the_current_hash(
    evidence_environment,
):
    service, _ = evidence_environment
    stable_chunk_id = sha256(b"stable-chunk-id").hexdigest()
    old = chunk("BIZINFO:PBLN:100", 0, "접수 기간은 2025년입니다.", chunk_id=stable_chunk_id)
    current = chunk("BIZINFO:PBLN:100", 0, "접수 기간은 2026년입니다.", chunk_id=stable_chunk_id)
    await service.index_chunks(SupportProgramEvidenceBatchRequest(chunks=[old]))
    await service.index_chunks(SupportProgramEvidenceBatchRequest(chunks=[current]))

    result = await service.search(
        SupportProgramEvidenceSearchRequest(
            question="접수 기간이 언제인가요?",
            eligibleChunks=[identity(current)],
            limit=1,
        )
    )

    assert [match.content_hash for match in result.matches] == [current.content_hash]
    assert (await service.qdrant_client.count(service.collection_name, exact=True)).count == 2
    assert _point_id(old) != _point_id(current)


@pytest.mark.anyio
async def test_rejects_malformed_embeddings_without_writing_points(evidence_environment):
    service, stub = evidence_environment
    stub.transform = lambda body: {**body, "data": []}

    with pytest.raises(SupportProgramEvidenceError):
        await service.index_chunks(
            SupportProgramEvidenceBatchRequest(
                chunks=[chunk("BIZINFO:PBLN:100", 0, "서울 AI 지원")]
            )
        )

    assert (await service.qdrant_client.count(service.collection_name, exact=True)).count == 0


@pytest.mark.anyio
async def test_search_documents_groups_matches_per_document_within_the_allowed_chunks(evidence_environment):
    service, stub = evidence_environment
    seoul_apply = chunk("BIZINFO:PBLN:100", 0, "신청 접수 기간은 2026년 3월입니다.")
    seoul_target = chunk("BIZINFO:PBLN:100", 1, "지원 대상은 서울 소재 AI 중소기업입니다.")
    gyeonggi = chunk("BIZINFO:PBLN:200", 0, "접수 기간은 2027년 1월입니다.")
    not_indexed = chunk("BIZINFO:PBLN:300", 0, "색인하지 않은 공고입니다.")
    await service.index_chunks(SupportProgramEvidenceBatchRequest(chunks=[seoul_apply, seoul_target, gyeonggi]))

    found = await service.search_documents(
        "접수 기간이 언제인가요?",
        {
            "BIZINFO:PBLN:100": [(seoul_apply.id, seoul_apply.content_hash), (seoul_target.id, seoul_target.content_hash)],
            "BIZINFO:PBLN:200": [(gyeonggi.id, gyeonggi.content_hash)],
            "BIZINFO:PBLN:300": [(not_indexed.id, not_indexed.content_hash)],
        },
        per_document_limit=1,
    )

    assert set(found) == {"BIZINFO:PBLN:100", "BIZINFO:PBLN:200"}
    assert [item.id for item in found["BIZINFO:PBLN:100"]] == [seoul_apply.id]
    assert found["BIZINFO:PBLN:100"][0].text == seoul_apply.text
    assert found["BIZINFO:PBLN:100"][0].document_id == "BIZINFO:PBLN:100"
    assert found["BIZINFO:PBLN:200"][0].text == gyeonggi.text
    # 색인 임베딩 1회 + 질문 임베딩 1회.
    assert len(stub.requests) == 2
    assert await service.search_documents("질문", {}, per_document_limit=4) == {}


@pytest.mark.anyio
async def test_index_attaches_text_to_legacy_points_without_re_embedding(evidence_environment):
    service, stub = evidence_environment
    legacy = chunk("BIZINFO:PBLN:100", 0, "신청 접수 기간은 2026년 3월입니다.")
    await service.index_chunks(SupportProgramEvidenceBatchRequest(chunks=[legacy]))
    point_id = next(iter({service_point.id for service_point in await service.qdrant_client.retrieve(service.collection_name, ids=[
        __import__("app.support_program_evidence.service", fromlist=["_point_id"])._point_id(legacy)
    ])}))
    await service.qdrant_client.overwrite_payload(
        service.collection_name, payload={"id": legacy.id, "contentHash": legacy.content_hash, "documentId": legacy.document_id, "order": 0},
        points=[point_id], wait=True,
    )
    assert await service.search_documents("접수", {"BIZINFO:PBLN:100": [(legacy.id, legacy.content_hash)]}, per_document_limit=2) == {}

    await service.index_chunks(SupportProgramEvidenceBatchRequest(chunks=[legacy]))
    found = await service.search_documents("접수", {"BIZINFO:PBLN:100": [(legacy.id, legacy.content_hash)]}, per_document_limit=2)
    assert found["BIZINFO:PBLN:100"][0].text == legacy.text
    # 원문만 붙였으므로 청크 임베딩은 처음 한 번뿐이다(나머지는 질문 임베딩).
    assert sum(1 for request in stub.requests if legacy.text in request["input"]) == 1
