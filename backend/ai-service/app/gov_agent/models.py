from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator


class GovAgentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    message: str = Field(min_length=1, max_length=500)
    has_selected_program: bool = Field(alias="hasSelectedProgram")
    search_query: str | None = Field(default=None, max_length=500, alias="searchQuery")
    pending_search_question: str | None = Field(default=None, max_length=160, alias="pendingSearchQuestion")


PartnerRegion = Literal[
    "서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종",
    "경기", "강원", "충북", "충남", "전북", "전남", "경북", "경남", "제주",
]
Evidence = Annotated[str, Field(min_length=1, max_length=80)]


class PartnerRoleCondition(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    value: Literal["LEAD", "PARTICIPANT", "DEMAND"]
    evidence: Evidence


class PartnerRegionCondition(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    value: PartnerRegion
    evidence: Evidence


class PartnerKeywordCondition(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    value: Annotated[str, Field(min_length=1, max_length=30)]
    evidence: Evidence


class GovPartnerConditions(BaseModel):
    """사용자가 이번 말에서 직접 밝힌 파트너 모집글 조건입니다. 근거 문구가 원문에 있는지는 Core가 다시 확인합니다."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    seeking_roles: list[PartnerRoleCondition] = Field(max_length=3, alias="seekingRoles")
    regions: list[PartnerRegionCondition] = Field(max_length=17)
    keywords: list[PartnerKeywordCondition] = Field(max_length=3)
    selected_program_evidence: Evidence | None = Field(alias="selectedProgramEvidence")


class GovAgentDecision(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    action: Literal["SEARCH", "EVIDENCE", "APPLICATION", "COMBINATION_REVIEW", "PARTNERS", "UNSUPPORTED"]
    partner_conditions: GovPartnerConditions | None = Field(default=None, alias="partnerConditions")

    @model_validator(mode="after")
    def conditions_only_for_partners(self) -> Self:
        if self.partner_conditions is not None and self.action != "PARTNERS":
            raise ValueError("partnerConditions is only allowed for PARTNERS")
        return self
