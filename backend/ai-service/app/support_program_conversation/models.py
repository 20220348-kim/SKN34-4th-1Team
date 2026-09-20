import re
import unicodedata
from datetime import date
from typing import Annotated, Literal, Self

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator


SCHEMA_VERSION = "govbiz-support-program-conversation-v1"


def validate_text(value: str, maximum: int, *, allow_layout: bool = False) -> str:
    if not value.strip():
        raise ValueError("text must not be blank")
    if sum(2 if ord(character) > 0xFFFF else 1 for character in value) > maximum:
        raise ValueError("text exceeds the UTF-16 length limit")
    if any(
        unicodedata.category(character).startswith("C")
        and not (allow_layout and character in "\n\r\t")
        for character in value
    ):
        raise ValueError("text contains a forbidden control character")
    return value


def validate_calendar_date(value: str) -> str:
    if re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value) is None:
        raise ValueError("date must be YYYY-MM-DD")
    date.fromisoformat(value)
    return value


QueryText = Annotated[str, Field(min_length=1, max_length=500), AfterValidator(
    lambda value: validate_text(value, 500, allow_layout=True)
)]
RegionText = Annotated[str, Field(min_length=1, max_length=50), AfterValidator(
    lambda value: validate_text(value, 50)
)]
ConditionText = Annotated[str, Field(min_length=1, max_length=100), AfterValidator(
    lambda value: validate_text(value, 100)
)]
ShortText = Annotated[str, Field(min_length=1, max_length=160), AfterValidator(
    lambda value: validate_text(value, 160)
)]
AnswerText = Annotated[str, Field(min_length=1, max_length=1000), AfterValidator(
    lambda value: validate_text(value, 1000, allow_layout=True)
)]
DateText = Annotated[str, Field(min_length=10, max_length=10), AfterValidator(validate_calendar_date)]
UpdateField = Literal["QUERY", "REGION", "INDUSTRY", "ESTABLISHED_ON", "FOUNDED_YEAR", "SUPPORT_PURPOSE", "ACCEPTING_ONLY"]


class ConversationCompanyConditions(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    region: RegionText | None
    industry: ConditionText | None
    established_on: DateText | None = Field(alias="establishedOn")
    support_purpose: ConditionText | None = Field(alias="supportPurpose")
    founded_year: int | None = Field(default=None, alias="foundedYear", strict=True, ge=1900, le=9999, exclude_if=lambda value: value is None)


class ConversationContext(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    query: QueryText | None
    accepting_only: bool = Field(alias="acceptingOnly", strict=True)
    company_conditions: ConversationCompanyConditions = Field(alias="companyConditions")

    def validate_reference_date(self, reference_date: str) -> None:
        founded_year = self.company_conditions.founded_year
        established_on = self.company_conditions.established_on
        if founded_year is not None and founded_year > int(reference_date[:4]):
            raise ValueError("foundedYear must not be in the future")
        if founded_year is not None and established_on is not None:
            raise ValueError("provide either foundedYear or establishedOn")
        if established_on is not None and not "1900-01-01" <= established_on <= reference_date:
            raise ValueError("establishedOn must be between 1900-01-01 and referenceDate")


class PendingClarification(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    question: ShortText
    draft_context: ConversationContext = Field(alias="draftContext")


class LastConversationSearch(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    context: ConversationContext
    result_count: int = Field(alias="resultCount", strict=True, ge=0)


class SupportProgramConversationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    schema_version: Literal[SCHEMA_VERSION] = Field(alias="schemaVersion")
    message: QueryText
    context: ConversationContext
    pending_clarification: PendingClarification | None = Field(default=None, alias="pendingClarification")
    pending_proposal: ConversationContext | None = Field(default=None, alias="pendingProposal")
    last_search: LastConversationSearch | None = Field(default=None, alias="lastSearch")
    reference_date: DateText = Field(alias="referenceDate")

    @model_validator(mode="after")
    def validate_context_dates(self) -> Self:
        if self.pending_clarification is not None and self.pending_proposal is not None:
            raise ValueError("pendingClarification and pendingProposal are mutually exclusive")
        self.context.validate_reference_date(self.reference_date)
        if self.pending_clarification is not None:
            self.pending_clarification.draft_context.validate_reference_date(self.reference_date)
        if self.pending_proposal is not None:
            self.pending_proposal.validate_reference_date(self.reference_date)
        if self.last_search is not None:
            self.last_search.context.validate_reference_date(self.reference_date)
        return self


class ConversationUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    field: UpdateField
    operation: Literal["SET", "CLEAR"]
    value: Annotated[str, Field(min_length=1, max_length=500)] | None
    evidence: ShortText

    @model_validator(mode="after")
    def validate_operation(self) -> Self:
        if self.operation == "CLEAR":
            if self.value is not None:
                raise ValueError("CLEAR requires a null value")
            return self
        if self.value is None:
            raise ValueError("SET requires a value")
        if self.field == "ACCEPTING_ONLY":
            if self.value not in ("true", "false"):
                raise ValueError("ACCEPTING_ONLY requires the string true or false")
        elif self.field == "FOUNDED_YEAR":
            if re.fullmatch(r"[0-9]{4}", self.value) is None or self.evidence not in (self.value, self.value + "년"):
                raise ValueError("foundedYear must equal the explicitly quoted year")
        elif self.field == "ESTABLISHED_ON":
            validate_calendar_date(self.value)
            # Quote the full date alone. Neither relative age nor a date mentioned
            # only in the previous question/context can authorize a new date.
            korean_date = re.fullmatch(r"([0-9]{4})년\s*([0-9]{1,2})월\s*([0-9]{1,2})일", self.evidence)
            if korean_date is not None:
                explicit_date = date(*(int(part) for part in korean_date.groups())).isoformat()
            else:
                explicit_date = validate_calendar_date(self.evidence)
            if explicit_date != self.value:
                raise ValueError("establishedOn must equal the explicitly quoted date")
        else:
            maximum = {"QUERY": 500, "REGION": 50, "INDUSTRY": 100, "SUPPORT_PURPOSE": 100}[self.field]
            validate_text(self.value, maximum, allow_layout=self.field == "QUERY")
        return self


class SupportProgramConversationOutput(BaseModel):
    """모델은 명확한 조건 변경을 제안하거나 제공된 검색 요약을 설명한다."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    status: Literal["READY", "CLARIFICATION_REQUIRED", "ANSWERED"]
    updates: list[ConversationUpdate] = Field(max_length=7)
    clarification_question: ShortText | None = Field(alias="clarificationQuestion")
    answer: AnswerText | None = None

    @model_validator(mode="after")
    def validate_status_and_unique_fields(self) -> Self:
        if len({update.field for update in self.updates}) != len(self.updates):
            raise ValueError("each field can be updated only once")
        if (self.status == "CLARIFICATION_REQUIRED") != (self.clarification_question is not None):
            raise ValueError("only CLARIFICATION_REQUIRED requires a question")
        if self.status == "ANSWERED":
            if self.answer is None or self.updates:
                raise ValueError("ANSWERED requires an answer and no updates")
        elif self.answer is not None:
            raise ValueError("only ANSWERED permits an answer")
        return self


class SupportProgramConversationResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    schema_version: Literal[SCHEMA_VERSION] = Field(alias="schemaVersion")
    status: Literal["READY", "CLARIFICATION_REQUIRED", "ANSWERED"]
    updates: list[ConversationUpdate] = Field(max_length=7)
    clarification_question: ShortText | None = Field(alias="clarificationQuestion")
    answer: AnswerText | None = None

    @model_validator(mode="after")
    def validate_response_contract(self) -> Self:
        SupportProgramConversationOutput.model_validate(
            self.model_dump(by_alias=True, exclude={"schema_version"})
        )
        return self
