from datetime import date
from enum import StrEnum
import re
from typing import Annotated, Literal
from unicodedata import category

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator, model_validator

from app.support_program_identity import (
    MAX_CANONICAL_SOURCE_PROGRAM_ID_LENGTH,
    require_canonical_source_program_id,
)


SCORING_VERSION = "govbiz-support-program-ranking-v5"
MAX_CANDIDATES = 20
MAX_CANONICAL_PROGRAM_ID_LENGTH = MAX_CANONICAL_SOURCE_PROGRAM_ID_LENGTH


def _normalize_recommendation_reasons(values: list[str]) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for value in values:
        reason = value.strip()
        if not reason or len(reason) > 120:
            raise ValueError("recommendation reasons must contain 1 to 120 characters")
        if reason not in seen:
            seen.add(reason)
            normalized.append(reason)
    if not normalized:
        raise ValueError("at least one recommendation reason is required")
    return normalized


class SupportProgramStatus(StrEnum):
    OPEN = "OPEN"
    UPCOMING = "UPCOMING"
    CLOSED = "CLOSED"
    UNKNOWN = "UNKNOWN"


class SupportProgramEligibility(StrEnum):
    """질문에서 드러난 조건과 공고 원문의 관계를 나타낸다."""

    MATCH = "MATCH"
    INCOMPATIBLE = "INCOMPATIBLE"
    UNKNOWN = "UNKNOWN"


def _require_assessment_text(value: str) -> str:
    if not value.strip() or any(category(character).startswith("C") for character in value):
        raise ValueError("eligibility text must be nonblank and contain no control characters")
    return value


EligibilityExplanation = Annotated[
    str, Field(min_length=1, max_length=160), AfterValidator(_require_assessment_text),
]


class SupportProgramEligibilityEvidence(BaseModel):
    """해당 후보의 전달된 공식 API 본문에서 그대로 인용한 자격 근거."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    field: Literal["SUMMARY", "TARGET_DESCRIPTION"]
    quote: Annotated[
        str, Field(min_length=1, max_length=240), AfterValidator(_require_assessment_text),
    ]


class SupportProgramCandidate(BaseModel):
    """Core가 공식 공고 원문에서 검증해 보낸 LLM 평가 후보."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    id: str = Field(min_length=3, max_length=MAX_CANONICAL_PROGRAM_ID_LENGTH)
    title: str = Field(min_length=1, max_length=300)
    organization: str = Field(min_length=1, max_length=200)
    summary: str = Field(min_length=1, max_length=6_000)
    categories: list[str] = Field(max_length=20)
    regions: list[str] = Field(max_length=20)
    target_description: str = Field(
        alias="targetDescription",
        min_length=1,
        max_length=2_000,
    )
    application_period: str = Field(
        alias="applicationPeriod",
        min_length=1,
        max_length=200,
    )
    status: SupportProgramStatus
    source_text_truncated: bool = Field(default=False, alias="sourceTextTruncated", strict=True)

    @field_validator(
        "title",
        "organization",
        "summary",
        "target_description",
        "application_period",
        mode="before",
    )
    @classmethod
    def strip_text(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @field_validator("id", mode="before")
    @classmethod
    def require_canonical_id(cls, value: object) -> object:
        return require_canonical_source_program_id(value)

    @field_validator("categories", "regions")
    @classmethod
    def normalize_terms(cls, values: list[str]) -> list[str]:
        normalized: list[str] = []
        seen: set[str] = set()
        for value in values:
            term = value.strip()
            if not term or len(term) > 100:
                raise ValueError("candidate terms must contain 1 to 100 characters")
            key = term.casefold()
            if key not in seen:
                seen.add(key)
                normalized.append(term)
        return normalized


class SupportProgramCompanyConditions(BaseModel):
    """사용자가 확인한 회사 조건과 Core가 정한 서울 기준일."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    region: str | None = Field(default=None, max_length=50)
    industry: str | None = Field(default=None, max_length=100)
    established_on: date | None = Field(default=None, alias="establishedOn")
    support_purpose: str | None = Field(default=None, alias="supportPurpose", max_length=100)
    reference_date: date = Field(alias="referenceDate")
    founded_year: int | None = Field(default=None, alias="foundedYear", strict=True, ge=1900, le=9999, exclude_if=lambda value: value is None)

    @field_validator("region", "industry", "support_purpose", mode="before")
    @classmethod
    def normalize_optional_conditions(cls, value: object) -> object:
        if isinstance(value, str):
            if any(category(character).startswith("C") for character in value):
                raise ValueError("company conditions contain control characters")
            return value.strip() or None
        return value

    @field_validator("established_on", "reference_date", mode="before")
    @classmethod
    def require_calendar_date(cls, value: object) -> date | None:
        if value is None or type(value) is date:
            return value
        if not isinstance(value, str):
            raise ValueError("company dates must use YYYY-MM-DD")
        if not value.strip(" "):
            return None
        if re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value) is None:
            raise ValueError("company dates must use YYYY-MM-DD")
        return date.fromisoformat(value)

    @model_validator(mode="after")
    def require_establishment_within_reference_date(self) -> "SupportProgramCompanyConditions":
        if self.founded_year is not None and self.founded_year > self.reference_date.year:
            raise ValueError("foundedYear must not be in the future")
        if self.founded_year is not None and self.established_on is not None:
            raise ValueError("provide either foundedYear or establishedOn")
        if self.established_on is not None and not date(1900, 1, 1) <= self.established_on <= self.reference_date:
            raise ValueError("establishedOn must be between 1900-01-01 and referenceDate")
        return self


class SupportProgramRankingRequest(BaseModel):
    """Core가 LLM 평가를 요청할 때 사용하는 내부 계약."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    original_query: str = Field(
        alias="originalQuery",
        min_length=1,
        max_length=500,
    )
    scoring_version: Literal[SCORING_VERSION] = Field(alias="scoringVersion")
    result_limit: int = Field(alias="resultLimit", ge=1, le=5)
    candidates: list[SupportProgramCandidate] = Field(
        min_length=1,
        max_length=MAX_CANDIDATES,
    )
    company_conditions: SupportProgramCompanyConditions | None = Field(
        default=None,
        alias="companyConditions",
        exclude_if=lambda value: value is None,
    )

    @field_validator("original_query", mode="before")
    @classmethod
    def strip_query(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @model_validator(mode="after")
    def require_unique_candidate_ids(self) -> "SupportProgramRankingRequest":
        ids = [candidate.id for candidate in self.candidates]
        if len(ids) != len(set(ids)):
            raise ValueError("candidate ids must be unique")
        return self


class ScoredSupportProgram(BaseModel):
    """Service가 합산·검증해 Core에 반환하는 추천 항목."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    program_id: str = Field(
        alias="programId",
        min_length=3,
        max_length=MAX_CANONICAL_PROGRAM_ID_LENGTH,
    )
    semantic_relevance: int = Field(alias="semanticRelevance", ge=0, le=40)
    target_eligibility: SupportProgramEligibility = Field(alias="targetEligibility")
    target_evidence: list[SupportProgramEligibilityEvidence] = Field(alias="targetEvidence", max_length=1)
    target_explanation: EligibilityExplanation = Field(alias="targetExplanation")
    region_eligibility: SupportProgramEligibility = Field(alias="regionEligibility")
    region_evidence: list[SupportProgramEligibilityEvidence] = Field(alias="regionEvidence", max_length=1)
    region_explanation: EligibilityExplanation = Field(alias="regionExplanation")
    support_type_fit: int = Field(alias="supportTypeFit", ge=0, le=10)
    total_score: int = Field(alias="totalScore", ge=0, le=100)
    recommendation_reasons: list[str] = Field(
        alias="recommendationReasons",
        min_length=1,
        max_length=3,
    )

    @field_validator("program_id", mode="before")
    @classmethod
    def require_canonical_program_id(cls, value: object) -> object:
        return require_canonical_source_program_id(value)

    @field_validator("recommendation_reasons")
    @classmethod
    def normalize_reasons(cls, values: list[str]) -> list[str]:
        return _normalize_recommendation_reasons(values)

    @model_validator(mode="after")
    def require_exact_total(self) -> "ScoredSupportProgram":
        expected = 2 * (self.semantic_relevance + self.support_type_fit)
        if self.total_score != expected:
            raise ValueError("totalScore must equal 2 * (semanticRelevance + supportTypeFit)")
        if self.target_eligibility is not SupportProgramEligibility.UNKNOWN and not self.target_evidence:
            raise ValueError("known target eligibility requires source evidence")
        if self.region_eligibility is not SupportProgramEligibility.UNKNOWN and not self.region_evidence:
            raise ValueError("known region eligibility requires source evidence")
        return self


class TargetEligibilityAssessment(BaseModel):
    """검색 관련도 점수와 분리한 대상 자격·근거."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    eligibility: Literal[SupportProgramEligibility.MATCH, SupportProgramEligibility.UNKNOWN]
    evidence: list[SupportProgramEligibilityEvidence] = Field(max_length=1)
    explanation: EligibilityExplanation

    @model_validator(mode="after")
    def require_match_evidence(self) -> "TargetEligibilityAssessment":
        if self.eligibility is SupportProgramEligibility.MATCH and not self.evidence:
            raise ValueError("MATCH requires source evidence")
        return self


class RegionEligibilityAssessment(BaseModel):
    """검색 관련도 점수와 분리한 지역 자격·근거."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    eligibility: Literal[SupportProgramEligibility.MATCH, SupportProgramEligibility.UNKNOWN]
    evidence: list[SupportProgramEligibilityEvidence] = Field(max_length=1)
    explanation: EligibilityExplanation

    @model_validator(mode="after")
    def require_match_evidence(self) -> "RegionEligibilityAssessment":
        if self.eligibility is SupportProgramEligibility.MATCH and not self.evidence:
            raise ValueError("MATCH requires source evidence")
        return self


class IncompatibleEligibilityAssessment(BaseModel):
    """명백한 대상·지역 부적합에는 본문 근거를 필수로 요구한다."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    eligibility: Literal[SupportProgramEligibility.INCOMPATIBLE]
    evidence: list[SupportProgramEligibilityEvidence] = Field(min_length=1, max_length=1)
    explanation: EligibilityExplanation


class SupportProgramAssessment(BaseModel):
    """AI가 판단하는 세부 점수·자격·근거이며 ID와 계산 가능한 총점은 받지 않는다."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    semantic_relevance: int = Field(alias="semanticRelevance", ge=0, le=40)
    target_assessment: TargetEligibilityAssessment | IncompatibleEligibilityAssessment = Field(
        alias="targetAssessment",
    )
    region_assessment: RegionEligibilityAssessment | IncompatibleEligibilityAssessment = Field(
        alias="regionAssessment",
    )
    support_type_fit: int = Field(alias="supportTypeFit", ge=0, le=10)
    recommendation_reasons: list[str] = Field(
        alias="recommendationReasons",
        min_length=1,
        max_length=3,
    )

    @field_validator("recommendation_reasons")
    @classmethod
    def normalize_reasons(cls, values: list[str]) -> list[str]:
        return _normalize_recommendation_reasons(values)


class AssessedSupportProgram(SupportProgramAssessment):
    """Agent가 요청별 필수 키로 검증한 공고 ID를 붙여 Service에 전달하는 평가 항목."""

    program_id: str = Field(
        alias="programId",
        min_length=3,
        max_length=MAX_CANONICAL_PROGRAM_ID_LENGTH,
    )

    @field_validator("program_id", mode="before")
    @classmethod
    def require_canonical_program_id(cls, value: object) -> object:
        return require_canonical_source_program_id(value)


class SupportProgramRankingOutput(BaseModel):
    """Agent가 키 기반 structured output을 검증한 뒤 Service에 전달하는 후보 평가 목록."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    rankings: list[AssessedSupportProgram] = Field(
        min_length=1,
        max_length=MAX_CANDIDATES,
    )

    @model_validator(mode="after")
    def require_unique_program_ids(self) -> "SupportProgramRankingOutput":
        ids = [ranking.program_id for ranking in self.rankings]
        if len(ids) != len(set(ids)):
            raise ValueError("ranked program ids must be unique")
        return self


class SupportProgramRankingResponse(BaseModel):
    """AI Service가 Core에 반환하는 검증·정렬된 적격 추천 계약."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    original_query: str = Field(alias="originalQuery")
    scoring_version: Literal[SCORING_VERSION] = Field(alias="scoringVersion")
    rankings: list[ScoredSupportProgram] = Field(min_length=0, max_length=5)
