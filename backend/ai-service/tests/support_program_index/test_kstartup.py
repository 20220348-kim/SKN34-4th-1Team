import pytest
from pydantic import ValidationError

from app.support_program_index.models import (
    IndexedDocumentIdentity,
    SupportProgramIndexBatchRequest,
    SupportProgramIndexPruneRequest,
    SupportProgramIndexSearchRequest,
)
from app.support_program_index.service import SupportProgramIndexError, _point_id
from .conftest import document, identity


@pytest.mark.anyio
async def test_same_original_id_and_text_stay_distinct_across_all_four_sources(index_environment):
    service, stub = index_environment
    sources = ("BIZINFO", "KSTARTUP", "MSIT", "CNTRADE_NOTICE")
    documents = [document(f"{source}:174321", "서울 AI 창업기업 사업화 지원")
                 for source in sources]

    await service.index_batch(SupportProgramIndexBatchRequest(documents=documents))
    assert len({item.content_hash for item in documents}) == 1
    assert len({_point_id(item) for item in documents}) == len(sources)
    stored, _ = await service.qdrant_client.scroll(service.collection_name, limit=10)
    assert {point.payload["id"]: point.payload["sourceCode"] for point in stored} == {
        f"{source}:174321": source for source in sources
    }

    result = await service.search(SupportProgramIndexSearchRequest(
        query="서울 AI", eligibleDocuments=[identity(item) for item in documents], limit=20,
    ))
    assert {match.id for match in result.matches} == {item.id for item in documents}

    for item in documents:
        only_current_source = await service.search(SupportProgramIndexSearchRequest(
            query="서울 AI", eligibleDocuments=[identity(item)], limit=20,
        ))
        assert [(match.id, match.content_hash) for match in only_current_source.matches] == [
            (item.id, item.content_hash),
        ]
    # 재사용한 질의 임베딩도 이번 요청의 제공처별 허용 목록을 완화하지 않습니다.
    assert len(stub.requests) == 2


@pytest.mark.anyio
@pytest.mark.parametrize("source,title,organization,target,summary", [
    (
        "MSIT", "서울 AI 연구개발 사업 공고", "과학기술정보통신부", "정보 없음",
        "공식 API에 지원 대상·접수 기간·본문이 제공되지 않습니다. 모집 여부와 신청 자격은 원문을 확인해 주세요.",
    ),
    (
        "CNTRADE_NOTICE", "수출 지원 공고", "국제통상과",
        "경기 소재 기업 대상. 제외 대상: 체납 기업.",
        "경기 소재 기업 대상. 제외 대상: 체납 기업.\n\n개별 원문은 공식 공지 목록에서 공고 제목으로 찾아 주세요.",
    ),
])
async def test_new_provider_documents_keep_their_identity_without_inventing_missing_eligibility(
    index_environment, source, title, organization, target, summary,
):
    service, stub = index_environment
    # Core의 실제 문서 형식입니다. 두 API 모두 접수 기간은 미상이며,
    # MSIT에 없는 본문/자격 정보나 CN 공지의 충남 소재 제한을 만들어 넣지 않습니다.
    # 이 테스트는 식별자·문서 전달 경계 검증이며 실제 검색/자격 판정 품질 평가는 아닙니다.
    text = "\n".join([
        f"제목: {title}", f"기관: {organization}", f"지원대상: {target}",
        "분야: ", "지역: ", "신청기간: 정보 없음", f"내용: {summary}",
    ])
    item = document(f"{source}:3862", text)
    other_sources = [document(f"{other}:3862", "서울 AI 타 제공처 공고")
                     for other in ("BIZINFO", "KSTARTUP", "MSIT", "CNTRADE_NOTICE") if other != source]
    await service.index_batch(SupportProgramIndexBatchRequest(documents=[*other_sources, item]))
    assert stub.requests[0]["input"][-1] == text

    stored = await service.qdrant_client.retrieve(service.collection_name, ids=[_point_id(item)], with_payload=True)
    assert stored[0].payload == {"id": item.id, "contentHash": item.content_hash, "sourceCode": source}
    result = await service.search(SupportProgramIndexSearchRequest(
        query="서울 AI", eligibleDocuments=[identity(item)], limit=20,
    ))
    assert [(match.id, match.content_hash) for match in result.matches] == [(item.id, item.content_hash)]
    assert result.query == "서울 AI"

    # 신규 제공처의 공지가 없어져도 원본 번호가 같은 다른 제공처 문서는 유지합니다.
    await service.prune(SupportProgramIndexPruneRequest(sourceCode=source, documents=[]))
    remaining, _ = await service.qdrant_client.scroll(service.collection_name, limit=10)
    assert {point.payload["id"] for point in remaining} == {item.id for item in other_sources}


@pytest.mark.anyio
async def test_kstartup_prune_preserves_bizinfo_and_search_uses_only_current_allowed_version(index_environment):
    service, _ = index_environment
    bizinfo = document("BIZINFO:174321", "서울 AI 기업마당 지원")
    old = document("KSTARTUP:174321", "서울 AI 이전 모집 공고")
    current = document("KSTARTUP:174321", "부산 제조업 갱신 모집 공고")
    removed = document("KSTARTUP:174322", "서울 AI 삭제된 모집 공고")
    await service.index_batch(SupportProgramIndexBatchRequest(documents=[bizinfo, old, removed]))
    await service.index_batch(SupportProgramIndexBatchRequest(documents=[current]))

    result = await service.search(SupportProgramIndexSearchRequest(
        query="서울 AI", eligibleDocuments=[identity(current)], limit=20,
    ))
    assert [(match.id, match.content_hash) for match in result.matches] == [(current.id, current.content_hash)]
    assert result.matches[0].score == pytest.approx(0)

    await service.prune(SupportProgramIndexPruneRequest(sourceCode="KSTARTUP", documents=[identity(current)]))
    stored, _ = await service.qdrant_client.scroll(service.collection_name, limit=10)
    assert {str(point.id) for point in stored} == {_point_id(bizinfo), _point_id(current)}

    await service.prune(SupportProgramIndexPruneRequest(sourceCode="KSTARTUP", documents=[]))
    stored, _ = await service.qdrant_client.scroll(service.collection_name, limit=10)
    assert {str(point.id) for point in stored} == {_point_id(bizinfo)}


@pytest.mark.anyio
async def test_unready_kstartup_only_blocks_requests_that_include_its_unindexed_version(index_environment):
    service, stub = index_environment
    bizinfo = document("BIZINFO:174321", "서울 AI 기업마당 지원")
    missing = document("KSTARTUP:174321", "서울 AI 아직 색인되지 않은 창업지원")
    await service.index_batch(SupportProgramIndexBatchRequest(documents=[bizinfo]))
    ready_request = SupportProgramIndexSearchRequest(
        query="서울 AI", eligibleDocuments=[identity(bizinfo)], limit=20,
    )

    assert [match.id for match in (await service.search(ready_request)).matches] == [bizinfo.id]
    calls_before = len(stub.requests)
    with pytest.raises(SupportProgramIndexError, match="INDEX_NOT_READY"):
        await service.search(SupportProgramIndexSearchRequest(
            query="서울 AI", eligibleDocuments=[identity(bizinfo), identity(missing)], limit=20,
        ))
    with pytest.raises(SupportProgramIndexError, match="INDEX_NOT_READY"):
        await service.prune(SupportProgramIndexPruneRequest(sourceCode="KSTARTUP", documents=[identity(missing)]))

    assert [match.id for match in (await service.search(ready_request)).matches] == [bizinfo.id]
    assert len(stub.requests) == calls_before
    assert (await service.qdrant_client.count(service.collection_name, exact=True)).count == 1


@pytest.mark.anyio
@pytest.mark.parametrize("source", ["KSTARTUP", "MSIT", "CNTRADE_NOTICE"])
async def test_result_rejects_payload_from_another_source(index_environment, source):
    service, _ = index_environment
    item = document(f"{source}:174321", "서울 AI 창업지원")
    await service.index_batch(SupportProgramIndexBatchRequest(documents=[item]))
    await service.qdrant_client.set_payload(
        service.collection_name, payload={"sourceCode": "BIZINFO"}, points=[_point_id(item)], wait=True,
    )

    with pytest.raises(SupportProgramIndexError, match="INDEX_UNAVAILABLE"):
        await service.search(SupportProgramIndexSearchRequest(
            query="서울 AI", eligibleDocuments=[identity(item)], limit=20,
        ))


@pytest.mark.parametrize("operation", ["search", "prune"])
def test_twenty_thousand_document_contract_keeps_every_identity_and_rejects_overflow(operation):
    # 계약 상한 검증입니다. 20,000건 Qdrant 성능이나 실제 모델 검색 품질 평가는 아닙니다.
    documents = [IndexedDocumentIdentity(
        id=f"{'BIZINFO' if operation == 'search' and index % 2 == 0 else 'KSTARTUP'}:{index}",
        contentHash="a" * 64,
    ) for index in range(20_000)]

    def request_for(values):
        if operation == "search":
            return SupportProgramIndexSearchRequest(query="창업지원", eligibleDocuments=values, limit=20)
        return SupportProgramIndexPruneRequest(sourceCode="KSTARTUP", documents=values)

    request = request_for(documents)
    accepted = request.eligible_documents if operation == "search" else request.documents
    assert len(accepted) == 20_000
    assert accepted[-1].id == "KSTARTUP:19999"
    with pytest.raises(ValidationError):
        request_for([*documents, IndexedDocumentIdentity(id="KSTARTUP:20000", contentHash="b" * 64)])
