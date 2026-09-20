import re
from enum import StrEnum
from hashlib import sha256
from typing import Annotated
from unicodedata import category

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.support_program_identity import (
    MAX_CANONICAL_SOURCE_PROGRAM_ID_LENGTH,
    require_canonical_source_program_id,
)

MAX_DOCUMENT_ID_LENGTH = MAX_CANONICAL_SOURCE_PROGRAM_ID_LENGTH
MAX_CHUNK_TEXT_LENGTH = 12_000
MAX_ANSWER_LENGTH = 1_200
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


class EvidenceChunkLocator(BaseModel):
    """공고 상세 원문 안에서 근거 청크를 식별하는 불변 내부 계약."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    id: str = Field(pattern=r"^[0-9a-f]{64}$")
    document_id: str = Field(alias="documentId", min_length=3, max_length=MAX_DOCUMENT_ID_LENGTH)
    order: int = Field(ge=0, strict=True)

    @field_validator("document_id", mode="before")
    @classmethod
    def require_canonical_document_id(cls, value: object) -> object:
        return require_canonical_source_program_id(value)


class EvidenceChunkIdentity(EvidenceChunkLocator):
    """Qdrant에서 현재 버전 청크를 찾기 위한 ID·내용 해시 계약."""

    content_hash: str = Field(alias="contentHash", pattern=r"^[0-9a-f]{64}$")


class SupportProgramEvidenceChunk(EvidenceChunkIdentity):
    """Core가 검증한 공식 상세 원문 청크. 해시는 UTF-8 text와 일치해야 한다."""

    text: str = Field(min_length=1, max_length=MAX_CHUNK_TEXT_LENGTH)

    @model_validator(mode="after")
    def require_valid_text_hash(self) -> "SupportProgramEvidenceChunk":
        if not self.text.strip() or any(
            category(character).startswith("C") and character not in "\n\r\t"
            for character in self.text
        ):
            raise ValueError("chunk text must contain readable text")
        if sha256(self.text.encode("utf-8")).hexdigest() != self.content_hash:
            raise ValueError("contentHash does not match text")
        return self


class SupportProgramEvidenceBatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    chunks: list[SupportProgramEvidenceChunk] = Field(min_length=1, max_length=50)

    @model_validator(mode="after")
    def require_unique_chunk_ids(self) -> "SupportProgramEvidenceBatchRequest":
        _require_unique_chunk_ids(self.chunks)
        return self


class SupportProgramEvidenceBatchResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    indexed_count: int = Field(alias="indexedCount", ge=0, le=50)


class SupportProgramEvidenceSearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    question: str = Field(min_length=1, max_length=500)
    eligible_chunks: list[EvidenceChunkIdentity] = Field(
        alias="eligibleChunks",
        min_length=1,
        max_length=50,
    )
    limit: int = Field(ge=1, le=5, strict=True)

    @field_validator("question", mode="before")
    @classmethod
    def strip_question(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @field_validator("question")
    @classmethod
    def require_readable_question(cls, value: str) -> str:
        if any(category(character).startswith("C") and character not in "\n\r\t" for character in value):
            raise ValueError("question contains control characters")
        return value

    @model_validator(mode="after")
    def require_unique_chunk_ids(self) -> "SupportProgramEvidenceSearchRequest":
        _require_unique_chunk_ids(self.eligible_chunks)
        return self


class SupportProgramEvidenceDocumentChunk(EvidenceChunkIdentity):
    """문서 묶음 검색(도우미 관심 공고 질문)이 돌려주는 청크. 색인 때 저장한 원문을 함께 준다."""

    text: str = Field(min_length=1, max_length=MAX_CHUNK_TEXT_LENGTH)
    score: float


class SupportProgramEvidenceMatch(EvidenceChunkIdentity):
    score: float = Field(allow_inf_nan=False)


class SupportProgramEvidenceSearchResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    question: str
    matches: list[SupportProgramEvidenceMatch] = Field(max_length=5)


class SupportProgramEvidenceAnswerChunk(EvidenceChunkLocator):
    """답변 Agent에 전달하는 검색 완료 근거 청크."""

    text: str = Field(min_length=1, max_length=MAX_CHUNK_TEXT_LENGTH)

    @field_validator("text")
    @classmethod
    def require_readable_text(cls, value: str) -> str:
        if not value.strip() or any(
            category(character).startswith("C") and character not in "\n\r\t"
            for character in value
        ):
            raise ValueError("chunk text must contain readable text")
        return value


class SupportProgramEvidenceAnswerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    question: str = Field(min_length=1, max_length=500)
    chunks: list[SupportProgramEvidenceAnswerChunk] = Field(min_length=1, max_length=5)

    @field_validator("question", mode="before")
    @classmethod
    def strip_question(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @field_validator("question")
    @classmethod
    def require_readable_question(cls, value: str) -> str:
        if any(category(character).startswith("C") and character not in "\n\r\t" for character in value):
            raise ValueError("question contains control characters")
        return value

    @model_validator(mode="after")
    def require_unique_chunk_ids(self) -> "SupportProgramEvidenceAnswerRequest":
        _require_unique_chunk_ids(self.chunks)
        return self


class SupportProgramEvidenceAnswerStatus(StrEnum):
    ANSWERED = "ANSWERED"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"


class SupportProgramEvidenceAnswerOutput(BaseModel):
    """Agent가 선택 결과를 검증하고 원래 청크 ID로 복원한 내부 답변."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    answer: str = Field(min_length=1, max_length=MAX_ANSWER_LENGTH)
    answer_status: SupportProgramEvidenceAnswerStatus = Field(alias="answerStatus")
    citation_chunk_ids: list[str] = Field(alias="citationChunkIds", max_length=5)

    @field_validator("answer", mode="before")
    @classmethod
    def strip_answer(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @field_validator("citation_chunk_ids")
    @classmethod
    def require_chunk_hashes(cls, values: list[str]) -> list[str]:
        if any(not _SHA256_PATTERN.fullmatch(value) for value in values):
            raise ValueError("citation chunk ids must be lowercase SHA-256 hashes")
        return values

    @model_validator(mode="after")
    def require_status_consistent_citations(self) -> "SupportProgramEvidenceAnswerOutput":
        if len(self.citation_chunk_ids) != len(set(self.citation_chunk_ids)):
            raise ValueError("citation chunk ids must be unique")
        if self.answer_status is SupportProgramEvidenceAnswerStatus.ANSWERED and not self.citation_chunk_ids:
            raise ValueError("ANSWERED requires at least one citation")
        if (
            self.answer_status is SupportProgramEvidenceAnswerStatus.INSUFFICIENT_EVIDENCE
            and self.citation_chunk_ids
        ):
            raise ValueError("INSUFFICIENT_EVIDENCE must not include citations")
        return self


class SupportProgramEvidenceAnswerResponse(SupportProgramEvidenceAnswerOutput):
    """Core에 반환하는 검증 완료 상세 공고 근거 답변."""


class SupportProgramEvidenceAnswerSelection(BaseModel):
    """LLM은 요청 배열의 짧은 위치만 선택하고, 실제 청크 ID는 Agent가 복원한다."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    answer: str = Field(min_length=1, max_length=MAX_ANSWER_LENGTH)
    answer_status: SupportProgramEvidenceAnswerStatus = Field(alias="answerStatus")
    citation_chunk_indexes: list[Annotated[int, Field(strict=True, ge=0, le=4)]] = Field(
        alias="citationChunkIndexes", max_length=5,
    )

    @field_validator("answer", mode="before")
    @classmethod
    def strip_answer(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @model_validator(mode="after")
    def require_status_consistent_citations(self) -> "SupportProgramEvidenceAnswerSelection":
        if len(self.citation_chunk_indexes) != len(set(self.citation_chunk_indexes)):
            raise ValueError("citation chunk indexes must be unique")
        if self.answer_status is SupportProgramEvidenceAnswerStatus.ANSWERED and not self.citation_chunk_indexes:
            raise ValueError("ANSWERED requires at least one citation")
        if (
            self.answer_status is SupportProgramEvidenceAnswerStatus.INSUFFICIENT_EVIDENCE
            and self.citation_chunk_indexes
        ):
            raise ValueError("INSUFFICIENT_EVIDENCE must not include citations")
        return self


def _require_unique_chunk_ids(chunks: list[EvidenceChunkLocator]) -> None:
    ids = [chunk.id for chunk in chunks]
    if len(ids) != len(set(ids)):
        raise ValueError("chunk ids must be unique")
