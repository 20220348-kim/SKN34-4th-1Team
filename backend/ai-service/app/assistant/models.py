import re
from typing import Annotated, Literal, Self

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator

from app.support_program_conversation.models import validate_text


SCHEMA_VERSION = "govbiz-assistant-v1"

MAX_HISTORY_MESSAGES = 6
MAX_HELP_ENTRIES = 40
MAX_CITATIONS = 3

MessageText = Annotated[str, Field(min_length=1, max_length=500), AfterValidator(
    lambda value: validate_text(value, 500, allow_layout=True)
)]
HistoryText = Annotated[str, Field(min_length=1, max_length=1000), AfterValidator(
    lambda value: validate_text(value, 1000, allow_layout=True)
)]
ShortText = Annotated[str, Field(min_length=1, max_length=160), AfterValidator(
    lambda value: validate_text(value, 160)
)]
ParagraphText = Annotated[str, Field(min_length=1, max_length=600), AfterValidator(
    lambda value: validate_text(value, 600, allow_layout=True)
)]
AnswerText = Annotated[str, Field(min_length=1, max_length=600), AfterValidator(
    lambda value: validate_text(value, 600, allow_layout=True)
)]
HelpEntryId = Annotated[str, Field(min_length=1, max_length=64, pattern=r"^[a-z0-9]+(-[a-z0-9]+)*$")]


def validate_route(value: str) -> str:
    if re.fullmatch(r"/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*", value) is None:
        raise ValueError("route must be an absolute path without query or fragment")
    return value


RouteText = Annotated[str, Field(min_length=1, max_length=200), AfterValidator(validate_route)]

AssistantIntent = Literal["PRODUCT_HELP", "ACCOUNT_STATE", "SEARCH", "PROGRAM_QUESTION", "OUT_OF_SCOPE", "UNCLEAR"]
AccountTopic = Literal["SAVED_PROGRAMS", "RECEIVED_PROPOSALS", "COMPANY_PROFILE"]


class AssistantHelpAction(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    label: ShortText
    to: RouteText


class AssistantHelpEntry(BaseModel):
    """프런트 도움말 한 항목이다. 모델은 이 항목들만 근거로 사용법을 답한다."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    id: HelpEntryId
    title: ShortText
    question: ShortText
    summary: ParagraphText
    body: list[ParagraphText] = Field(max_length=10)
    limitation: ParagraphText | None
    audience: Literal["public", "member", "company", "admin"]
    status: Literal["available", "demo", "planned"]
    action: AssistantHelpAction | None


class AssistantHistoryMessage(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    role: Literal["USER", "ASSISTANT"]
    content: HistoryText


class AssistantSession(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    authenticated: bool = Field(strict=True)
    has_company: bool = Field(alias="hasCompany", strict=True)

    @model_validator(mode="after")
    def validate_company_requires_login(self) -> Self:
        if self.has_company and not self.authenticated:
            raise ValueError("hasCompany requires an authenticated session")
        return self


class AssistantContext(BaseModel):
    """사용자가 지금 보고 있는 화면이다. programSelected는 공고 상세처럼 원문 질문이 가능한 화면인지다."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    route: RouteText
    program_selected: bool = Field(alias="programSelected", strict=True)


class AssistantAnswerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    schema_version: Literal[SCHEMA_VERSION] = Field(alias="schemaVersion")
    message: MessageText
    history: list[AssistantHistoryMessage] = Field(max_length=MAX_HISTORY_MESSAGES)
    session: AssistantSession
    context: AssistantContext
    help_entries: list[AssistantHelpEntry] = Field(alias="helpEntries", min_length=1, max_length=MAX_HELP_ENTRIES)

    @model_validator(mode="after")
    def validate_unique_help_entries(self) -> Self:
        if len({entry.id for entry in self.help_entries}) != len(self.help_entries):
            raise ValueError("help entry ids must be unique")
        return self

    def help_entry_ids(self) -> frozenset[str]:
        return frozenset(entry.id for entry in self.help_entries)


class AssistantAnswerOutput(BaseModel):
    """모델은 의도 하나를 고르고, 의도에 맞는 필드만 채운다. 실제 기능 호출은 Core가 한다."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    intent: AssistantIntent
    answer: AnswerText | None
    citations: list[HelpEntryId] = Field(max_length=MAX_CITATIONS)
    clarification_question: ShortText | None = Field(alias="clarificationQuestion")
    search_query: MessageText | None = Field(alias="searchQuery")
    account_topic: AccountTopic | None = Field(alias="accountTopic")

    @model_validator(mode="after")
    def validate_fields_for_intent(self) -> Self:
        if len(set(self.citations)) != len(self.citations):
            raise ValueError("citations must be unique")
        expected = {
            "PRODUCT_HELP": {"answer", "citations"},
            "ACCOUNT_STATE": {"accountTopic"},
            "SEARCH": {"searchQuery"},
            "PROGRAM_QUESTION": set(),
            "OUT_OF_SCOPE": {"answer"},
            "UNCLEAR": {"clarificationQuestion"},
        }[self.intent]
        present = {
            name for name, value in (
                ("answer", self.answer), ("citations", self.citations or None),
                ("clarificationQuestion", self.clarification_question),
                ("searchQuery", self.search_query), ("accountTopic", self.account_topic),
            ) if value is not None
        }
        if present != expected:
            raise ValueError(f"{self.intent} requires exactly {sorted(expected)}")
        return self


class AssistantAnswerResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    schema_version: Literal[SCHEMA_VERSION] = Field(alias="schemaVersion")
    intent: AssistantIntent
    answer: AnswerText | None
    citations: list[HelpEntryId] = Field(max_length=MAX_CITATIONS)
    clarification_question: ShortText | None = Field(alias="clarificationQuestion")
    search_query: MessageText | None = Field(alias="searchQuery")
    account_topic: AccountTopic | None = Field(alias="accountTopic")

    @model_validator(mode="after")
    def validate_response_contract(self) -> Self:
        AssistantAnswerOutput.model_validate(self.model_dump(by_alias=True, exclude={"schema_version"}))
        return self
