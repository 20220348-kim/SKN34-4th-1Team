from hashlib import sha256
from unicodedata import category

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.support_program_identity import (
    MAX_CANONICAL_SOURCE_PROGRAM_ID_LENGTH,
    require_canonical_source_program_id,
)


class IndexedDocumentIdentity(BaseModel):
    """현재 MySQL 공고의 제공처 포함 ID와 검색 문서 버전."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    id: str = Field(min_length=3, max_length=MAX_CANONICAL_SOURCE_PROGRAM_ID_LENGTH)
    content_hash: str = Field(alias="contentHash", pattern=r"^[0-9a-f]{64}$")

    @field_validator("id", mode="before")
    @classmethod
    def require_unambiguous_id(cls, value: object) -> object:
        return require_canonical_source_program_id(value)


class SupportProgramIndexDocument(IndexedDocumentIdentity):
    """Core가 구성한 검색 문서. 해시는 전달된 UTF-8 text와 정확히 일치한다."""

    text: str = Field(min_length=1, max_length=12_000)

    @model_validator(mode="after")
    def require_valid_text_hash(self) -> "SupportProgramIndexDocument":
        if not self.text.strip() or any(
            category(character).startswith("C") and character not in "\n\r\t"
            for character in self.text
        ):
            raise ValueError("document text must contain readable text")
        if sha256(self.text.encode("utf-8")).hexdigest() != self.content_hash:
            raise ValueError("contentHash does not match text")
        return self


class SupportProgramIndexBatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    documents: list[SupportProgramIndexDocument] = Field(min_length=1, max_length=50)

    @model_validator(mode="after")
    def require_unique_ids(self) -> "SupportProgramIndexBatchRequest":
        _require_unique_ids(self.documents)
        return self


class SupportProgramIndexBatchResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    indexed_count: int = Field(alias="indexedCount", ge=0, le=50)


class SupportProgramIndexPruneRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    source_code: str = Field(alias="sourceCode", pattern=r"^[A-Z][A-Z0-9_]{0,63}$")
    documents: list[IndexedDocumentIdentity] = Field(max_length=20_000)

    @model_validator(mode="after")
    def require_unique_scoped_ids(self) -> "SupportProgramIndexPruneRequest":
        _require_unique_ids(self.documents)
        if any(document.id.split(":", 1)[0] != self.source_code for document in self.documents):
            raise ValueError("documents must belong to sourceCode")
        return self


class SupportProgramIndexPruneResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    retained_count: int = Field(alias="retainedCount", ge=0, le=20_000)


class SupportProgramIndexSearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    query: str = Field(min_length=1, max_length=1_000)
    eligible_documents: list[IndexedDocumentIdentity] = Field(alias="eligibleDocuments", max_length=20_000)
    limit: int = Field(ge=1, le=20, strict=True)

    @field_validator("query", mode="before")
    @classmethod
    def strip_query(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @field_validator("query")
    @classmethod
    def require_readable_query(cls, value: str) -> str:
        if any(category(character).startswith("C") and character not in "\n\r\t" for character in value):
            raise ValueError("query contains control characters")
        return value

    @model_validator(mode="after")
    def require_unique_ids(self) -> "SupportProgramIndexSearchRequest":
        _require_unique_ids(self.eligible_documents)
        return self


class SupportProgramIndexMatch(IndexedDocumentIdentity):
    score: float = Field(allow_inf_nan=False)


class SupportProgramIndexSearchResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    query: str
    matches: list[SupportProgramIndexMatch] = Field(max_length=20)


def _require_unique_ids(documents: list[IndexedDocumentIdentity]) -> None:
    ids = [document.id for document in documents]
    if len(ids) != len(set(ids)):
        raise ValueError("document ids must be unique")
