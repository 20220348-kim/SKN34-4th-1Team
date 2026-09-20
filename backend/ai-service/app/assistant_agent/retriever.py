"""관심 공고 묶음 질문의 근거 검색. 기존 근거 컬렉션(Qdrant)을 문서 id 허용 목록으로 좁혀 읽는다."""

from dataclasses import dataclass
from typing import Protocol

from app.assistant_agent.models import SavedProgramDocument
from app.support_program_evidence.service import SupportProgramEvidenceService


@dataclass(frozen=True, slots=True)
class RetrievedChunk:
    id: str
    content_hash: str
    order: int
    text: str
    score: float


class EvidenceRetriever(Protocol):
    async def retrieve(
        self, question: str, documents: list[SavedProgramDocument], per_document_limit: int,
    ) -> dict[str, list[RetrievedChunk]]:
        """문서 id → 질문과 가까운 청크(문서당 최대 per_document_limit개). 없는 문서는 키가 없다."""


class QdrantEvidenceRetriever:
    """Core가 청킹·색인한 공고 원문 청크만 읽는다. 허용 목록 밖의 청크는 결과에 들어오지 않는다."""

    def __init__(self, evidence_service: SupportProgramEvidenceService) -> None:
        self._service = evidence_service

    async def retrieve(
        self, question: str, documents: list[SavedProgramDocument], per_document_limit: int,
    ) -> dict[str, list[RetrievedChunk]]:
        allowed = {
            document.document_id: [(chunk.id, chunk.content_hash) for chunk in document.chunks]
            for document in documents if document.chunks
        }
        if not allowed:
            return {}
        found = await self._service.search_documents(question, allowed, per_document_limit)
        return {
            document_id: [RetrievedChunk(chunk.id, chunk.content_hash, chunk.order, chunk.text, chunk.score) for chunk in chunks]
            for document_id, chunks in found.items()
        }
