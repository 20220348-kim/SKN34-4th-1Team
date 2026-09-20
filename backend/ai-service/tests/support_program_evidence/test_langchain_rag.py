"""Qdrant 검색 결과 → LangChain 답변의 연결 계약. 모델 의미 품질 평가는 아니다."""

import json

import pytest

from app.support_program_evidence.agent import SupportProgramEvidenceAnswerAgent
from app.support_program_evidence.answer_service import SupportProgramEvidenceAnswerService
from app.support_program_evidence.models import (
    SupportProgramEvidenceAnswerRequest, SupportProgramEvidenceBatchRequest, SupportProgramEvidenceSearchRequest,
)
from tests.langchain_stub import ResponsesChatStub, response_message
from .conftest import chunk, identity


@pytest.mark.anyio
async def test_only_retrieved_current_document_text_reaches_langchain_and_citations_are_restored(evidence_environment):
    retrieval, embedding_stub = evidence_environment
    old = chunk("BIZINFO:rag", 0, "이전 버전의 접수 기간은 2025년 3월입니다.")
    current = chunk("BIZINFO:rag", 0, "접수 기간은 2026년 9월입니다. 제출 항목: {company}.")
    foreign = chunk("KSTARTUP:rag", 0, "다른 공고 접수 기간은 2027년 1월입니다.")
    await retrieval.index_chunks(SupportProgramEvidenceBatchRequest(chunks=[old, foreign]))
    await retrieval.index_chunks(SupportProgramEvidenceBatchRequest(chunks=[current]))
    found = await retrieval.search(SupportProgramEvidenceSearchRequest(
        question="접수 기간은?", eligibleChunks=[identity(current)], limit=5,
    ))
    assert [(match.id, match.content_hash, match.document_id) for match in found.matches] == [
        (current.id, current.content_hash, current.document_id),
    ]
    # Core가 검증된 검색 ID를 공식 원문으로 복원해 answers API에 전달하는 경계를 재현한다.
    catalog = {current.id: current}
    selected = [
        catalog[match.id].model_dump(by_alias=True, exclude={"content_hash"}) for match in found.matches
    ]
    stub = ResponsesChatStub([[response_message(json.dumps({
        "answer": "접수 기간은 2026년 9월입니다.", "answerStatus": "ANSWERED", "citationChunkIndexes": [0],
    }, ensure_ascii=False))]])
    answers = SupportProgramEvidenceAnswerService(SupportProgramEvidenceAnswerAgent(
        model=stub.model, model_timeout_seconds=3, run_timeout_seconds=4,
    ))
    result = await answers.answer(SupportProgramEvidenceAnswerRequest(question=found.question, chunks=selected))
    sent = json.loads(stub.first_call.input[0]["content"])
    assert sent["question"] == "접수 기간은?"
    assert sent["chunks"] == [{"index": 0, "documentId": current.document_id, "order": 0, "text": current.text}]
    assert old.text not in json.dumps(sent, ensure_ascii=False)
    assert foreign.text not in json.dumps(sent, ensure_ascii=False)
    assert result.citation_chunk_ids == [current.id]
    assert len(stub.calls) == 1
    assert len(embedding_stub.requests) == 3
