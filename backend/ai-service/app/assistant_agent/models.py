"""도우미 에이전트 계약(`govbiz-assistant-agent-v1`). Core가 보내는 요청과 Core가 재검증하는 응답, 모델이 내는 구조화 출력."""

import re
from typing import Annotated, Literal, Self

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator

from app.assistant.models import (
    MAX_CITATIONS, MAX_HELP_ENTRIES, MAX_HISTORY_MESSAGES, AccountTopic, AnswerText, AssistantContext,
    AssistantHelpEntry, AssistantHistoryMessage, AssistantSession, HelpEntryId, MessageText, ShortText,
)
from app.support_program_conversation.models import validate_text
from app.support_program_identity import (
    MAX_CANONICAL_SOURCE_PROGRAM_ID_LENGTH, MAX_SOURCE_CODE_LENGTH, MAX_SOURCE_PROGRAM_ID_LENGTH,
    SOURCE_CODE_PATTERN, require_canonical_source_program_id,
)


SCHEMA_VERSION = "govbiz-assistant-agent-v1"

MAX_CARDS = 5
MAX_SAVED_PROGRAM_DOCUMENTS = 10
MAX_DOCUMENT_CHUNKS = 50
MAX_QUOTE_LENGTH = 300
MAX_TOOL_CALL_REPORTS = 12
MAX_TOOL_TOKEN_LENGTH = 400

AgentIntent = Literal[
    "PRODUCT_HELP", "ACCOUNT_STATE", "SEARCH", "PROGRAM_QUESTION", "OUT_OF_SCOPE", "UNCLEAR",
    "PARTNER_MATCH", "SAVED_PROGRAMS_QUESTION",
]
# 도구 경로로 가는 의도. 나머지는 분류 한 번으로 끝난다.
TOOL_INTENTS: frozenset[str] = frozenset({"ACCOUNT_STATE", "PARTNER_MATCH", "SAVED_PROGRAMS_QUESTION"})

CardKind = Literal["RECRUITMENT", "PROGRAM"]
NavigationKey = Literal["NONE", "PARTNERS", "SAVED_PROGRAMS", "PROPOSALS", "PROFILE", "CHAT"]

# 카드·이동 버튼이 가리킬 수 있는 화면. Core도 같은 목록으로 다시 검사한다.
NAVIGATIONS: dict[str, tuple[str, str]] = {
    "PARTNERS": ("파트너 모집 열기", "/app/partners"),
    "SAVED_PROGRAMS": ("관심 공고함 열기", "/app/saved-programs"),
    "PROPOSALS": ("제안함 열기", "/app/proposals"),
    "PROFILE": ("프로필 열기", "/app/profile"),
    "CHAT": ("검색 화면 열기", "/app/chat"),
}
RECRUITMENT_DETAIL_ROUTE = "/app/partners/detail"
PROGRAM_DETAIL_ROUTE = "/app/support-programs/detail"

ReasonText = Annotated[str, Field(min_length=1, max_length=200), AfterValidator(lambda value: validate_text(value, 200))]
QuoteText = Annotated[str, Field(min_length=1, max_length=MAX_QUOTE_LENGTH), AfterValidator(
    lambda value: validate_text(value, MAX_QUOTE_LENGTH, allow_layout=True)
)]
Sha256Hex = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
CalendarDate = Annotated[str, Field(pattern=r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")]
CardId = Annotated[str, Field(min_length=1, max_length=MAX_CANONICAL_SOURCE_PROGRAM_ID_LENGTH)]
CanonicalDocumentId = Annotated[
    str, Field(min_length=3, max_length=MAX_CANONICAL_SOURCE_PROGRAM_ID_LENGTH),
    AfterValidator(require_canonical_source_program_id),
]
# 원본 ID 한 글자는 UTF-8 최대 4 bytes, URL에서는 byte당 %HH 세 글자가 된다.
MAX_CARD_ROUTE_LENGTH = len(PROGRAM_DETAIL_ROUTE + "?sourceCode=&sourceProgramId=") + MAX_SOURCE_CODE_LENGTH + MAX_SOURCE_PROGRAM_ID_LENGTH * 12


def _validate_card_identity(kind: CardKind, identifier: str) -> None:
    if kind == "PROGRAM":
        require_canonical_source_program_id(identifier)
    elif re.fullmatch(r"[1-9][0-9]{0,18}", identifier) is None:
        raise ValueError("recruitment card id must be a positive numeric id")


def validate_card_route(value: str) -> str:
    if re.fullmatch(r"/app/[A-Za-z0-9/_-]+(\?[A-Za-z0-9_=&%.:+~-]*)?", value) is None:
        raise ValueError("route must be an internal /app path with an optional query")
    return value


CardRouteText = Annotated[str, Field(min_length=1, max_length=MAX_CARD_ROUTE_LENGTH), AfterValidator(validate_card_route)]


class AssistantPrincipal(BaseModel):
    """도구가 Core를 되부를 때 쓰는 계정 번호와 단기 토큰. 비로그인은 principal 자체가 null이다."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    account_id: int = Field(alias="accountId", ge=1, strict=True)
    tool_token: str = Field(alias="toolToken", min_length=1, max_length=MAX_TOOL_TOKEN_LENGTH, pattern=r"^[A-Za-z0-9._-]+$")
    has_company: bool = Field(alias="hasCompany", strict=True)


class SavedProgramChunkRef(BaseModel):
    """Core가 색인해 둔 청크의 식별자. 검색은 이 목록 안에서만 한다."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    id: Sha256Hex
    content_hash: Sha256Hex = Field(alias="contentHash")


class SavedProgramDocument(BaseModel):
    """관심 공고 하나와 그 원문 청크 허용 목록. 청크가 비어 있으면 원문을 아직 확보하지 못한 공고다."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    source_code: str = Field(alias="sourceCode", pattern=SOURCE_CODE_PATTERN.pattern)
    source_program_id: str = Field(alias="sourceProgramId", min_length=1, max_length=MAX_SOURCE_PROGRAM_ID_LENGTH)
    title: ShortText
    application_end_date: CalendarDate | None = Field(alias="applicationEndDate")
    document_id: CanonicalDocumentId = Field(alias="documentId")
    chunks: list[SavedProgramChunkRef] = Field(max_length=MAX_DOCUMENT_CHUNKS)

    @model_validator(mode="after")
    def validate_identity(self) -> Self:
        if self.document_id != f"{self.source_code}:{self.source_program_id}":
            raise ValueError("documentId must be sourceCode:sourceProgramId")
        if len({chunk.id for chunk in self.chunks}) != len(self.chunks):
            raise ValueError("chunk ids must be unique")
        return self

    @property
    def fetched(self) -> bool:
        return bool(self.chunks)


class AssistantAgentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    schema_version: Literal[SCHEMA_VERSION] = Field(alias="schemaVersion")
    message: MessageText
    history: list[AssistantHistoryMessage] = Field(max_length=MAX_HISTORY_MESSAGES)
    session: AssistantSession
    context: AssistantContext
    help_entries: list[AssistantHelpEntry] = Field(alias="helpEntries", min_length=1, max_length=MAX_HELP_ENTRIES)
    principal: AssistantPrincipal | None
    # 관심 공고 묶음 질문의 두 번째 호출에서만 온다. 첫 호출은 needsDocuments=true로 끝난다.
    saved_program_documents: list[SavedProgramDocument] | None = Field(
        alias="savedProgramDocuments", default=None, max_length=MAX_SAVED_PROGRAM_DOCUMENTS,
    )
    resume_intent: Literal["SAVED_PROGRAMS_QUESTION"] | None = Field(alias="resumeIntent", default=None)

    @model_validator(mode="after")
    def validate_consistency(self) -> Self:
        if len({entry.id for entry in self.help_entries}) != len(self.help_entries):
            raise ValueError("help entry ids must be unique")
        if self.principal is not None:
            if not self.session.authenticated:
                raise ValueError("principal requires an authenticated session")
            if self.principal.has_company != self.session.has_company:
                raise ValueError("principal.hasCompany must match session.hasCompany")
        if self.saved_program_documents is not None:
            if self.principal is None:
                raise ValueError("savedProgramDocuments require a principal")
            if len({document.document_id for document in self.saved_program_documents}) != len(self.saved_program_documents):
                raise ValueError("savedProgramDocuments must have unique documentIds")
        if self.resume_intent is not None and self.saved_program_documents is None:
            raise ValueError("resumeIntent requires savedProgramDocuments")
        return self

    def help_entry_ids(self) -> frozenset[str]:
        return frozenset(entry.id for entry in self.help_entries)


class AssistantClassification(BaseModel):
    """분류 모델의 구조화 출력. 도구가 필요 없는 의도는 여기서 답까지 끝난다."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    intent: AgentIntent
    answer: AnswerText | None
    citations: list[HelpEntryId] = Field(max_length=MAX_CITATIONS)
    clarification_question: ShortText | None = Field(alias="clarificationQuestion")
    search_query: MessageText | None = Field(alias="searchQuery")
    account_topic: AccountTopic | None = Field(alias="accountTopic")

    @model_validator(mode="before")
    @classmethod
    def drop_stray_fields_for_field_free_intents(cls, data: object) -> object:
        # 싼 분류 모델이 필드가 없는 의도(공고 질문·모집글 매칭·관심 공고 질문)에 accountTopic·answer 같은 값을 함께 채우는 일이 잦다.
        # 이 의도들은 다음 단계가 의도만 쓰므로 나머지 필드를 비운다. 그 밖의 의도는 엄격하게 검사한다.
        if isinstance(data, dict) and data.get("intent") in FIELD_FREE_INTENTS:
            return {
                key: ([] if key == "citations" else None) if key in STRAY_FIELD_KEYS else value
                for key, value in data.items()
            }
        return data

    @model_validator(mode="after")
    def validate_fields_for_intent(self) -> Self:
        if len(set(self.citations)) != len(self.citations):
            raise ValueError("citations must be unique")
        expected = CLASSIFICATION_FIELDS[self.intent]
        present = _present_fields(self)
        if present != expected:
            raise ValueError(f"{self.intent} requires exactly {sorted(expected)}")
        return self


FIELD_FREE_INTENTS: frozenset[str] = frozenset({"PROGRAM_QUESTION", "PARTNER_MATCH", "SAVED_PROGRAMS_QUESTION"})
STRAY_FIELD_KEYS: frozenset[str] = frozenset({
    "answer", "citations", "clarificationQuestion", "clarification_question", "searchQuery", "search_query", "accountTopic", "account_topic",
})

CLASSIFICATION_FIELDS: dict[str, frozenset[str]] = {
    "PRODUCT_HELP": frozenset({"answer", "citations"}),
    "ACCOUNT_STATE": frozenset({"accountTopic"}),
    "SEARCH": frozenset({"searchQuery"}),
    "PROGRAM_QUESTION": frozenset(),
    "OUT_OF_SCOPE": frozenset({"answer"}),
    "UNCLEAR": frozenset({"clarificationQuestion"}),
    "PARTNER_MATCH": frozenset(),
    "SAVED_PROGRAMS_QUESTION": frozenset(),
}


class AssistantCardChoice(BaseModel):
    """답 모델이 고르는 카드. 제목·경로는 모델이 아니라 도구 결과에서 채운다."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    kind: CardKind
    id: CardId
    reason: ReasonText

    @model_validator(mode="after")
    def validate_identity(self) -> Self:
        _validate_card_identity(self.kind, self.id)
        return self


class AssistantAgentAnswer(BaseModel):
    """답 모델의 구조화 출력."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    answer: AnswerText
    cards: list[AssistantCardChoice] = Field(max_length=MAX_CARDS)
    navigation: NavigationKey

    @model_validator(mode="after")
    def validate_unique_cards(self) -> Self:
        if len({(card.kind, card.id) for card in self.cards}) != len(self.cards):
            raise ValueError("cards must be unique")
        return self


class AssistantCard(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    kind: CardKind
    id: CardId
    title: ShortText
    subtitle: ShortText | None
    reason: ReasonText
    # 관심 공고 묶음 질문에서만: 근거 청크 원문에서 글자 그대로 옮긴 한 구절. Core가 청크와 다시 대조한다.
    quote: QuoteText | None
    to: CardRouteText

    @model_validator(mode="after")
    def validate_identity(self) -> Self:
        _validate_card_identity(self.kind, self.id)
        return self


class ProgramFinding(BaseModel):
    """관심 공고 하나에 대한 map 단계(싼 모델)의 판단. 청크 밖의 내용은 UNKNOWN이다."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    verdict: Literal["YES", "NO", "UNKNOWN"]
    value: ShortText | None
    quote: QuoteText | None
    confidence: Literal["HIGH", "MEDIUM", "LOW"]

    @model_validator(mode="after")
    def validate_unknown_has_no_quote(self) -> Self:
        if self.verdict == "UNKNOWN" and (self.quote is not None or self.value is not None):
            raise ValueError("UNKNOWN findings carry no value or quote")
        return self


class SavedProgramsCardChoice(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    document_id: CanonicalDocumentId = Field(alias="documentId")
    reason: ReasonText


class SavedProgramsAnswer(BaseModel):
    """reduce 단계의 구조화 출력. 카드는 관심 공고 문서 id로만 가리킨다."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    answer: AnswerText
    cards: list[SavedProgramsCardChoice] = Field(max_length=MAX_CARDS)
    navigation: NavigationKey

    @model_validator(mode="after")
    def validate_unique_cards(self) -> Self:
        if len({card.document_id for card in self.cards}) != len(self.cards):
            raise ValueError("cards must be unique")
        return self


class AssistantNavigation(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    label: ShortText
    to: CardRouteText


class AssistantToolCallReport(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    name: str = Field(min_length=1, max_length=64, pattern=r"^[a-z_]+$")
    ms: int = Field(ge=0, strict=True)
    ok: bool = Field(strict=True)


class AssistantAgentResponse(BaseModel):
    """Core로 돌아가는 응답. 의도별 필드 집합을 여기서 한 번 더 강제한다."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    schema_version: Literal[SCHEMA_VERSION] = Field(alias="schemaVersion")
    intent: AgentIntent
    answer: AnswerText | None
    citations: list[HelpEntryId] = Field(max_length=MAX_CITATIONS)
    clarification_question: ShortText | None = Field(alias="clarificationQuestion")
    search_query: MessageText | None = Field(alias="searchQuery")
    account_topic: AccountTopic | None = Field(alias="accountTopic")
    cards: list[AssistantCard] = Field(max_length=MAX_CARDS)
    navigation: AssistantNavigation | None
    tool_calls: list[AssistantToolCallReport] = Field(alias="toolCalls", max_length=MAX_TOOL_CALL_REPORTS)
    # 관심 공고 묶음 질문인데 청크 허용 목록이 없을 때 true. Core가 원문을 준비해 resumeIntent로 다시 부른다.
    needs_documents: bool = Field(alias="needsDocuments", strict=True)

    @model_validator(mode="after")
    def validate_fields_for_intent(self) -> Self:
        if len(set(self.citations)) != len(self.citations):
            raise ValueError("citations must be unique")
        required, optional = RESPONSE_FIELDS[self.intent]
        present = _present_fields(self)
        if not (required <= present <= required | optional):
            raise ValueError(f"{self.intent} requires {sorted(required)} and allows {sorted(optional)}")
        if (self.cards or self.navigation is not None) and (self.intent not in TOOL_INTENTS or self.answer is None):
            raise ValueError("cards and navigation belong to tool answers only")
        if len({(card.kind, card.id) for card in self.cards}) != len(self.cards):
            raise ValueError("cards must be unique")
        if self.needs_documents and (self.intent != "SAVED_PROGRAMS_QUESTION" or self.answer is not None or self.cards):
            raise ValueError("needsDocuments is only for an unanswered SAVED_PROGRAMS_QUESTION")
        if any(card.quote is not None and card.kind != "PROGRAM" for card in self.cards):
            raise ValueError("only program cards carry quotes")
        return self


# 도구 의도는 principal이 없으면 분류 결과만 돌려주므로 answer가 선택이다. Core가 로그인 안내를 붙인다.
RESPONSE_FIELDS: dict[str, tuple[frozenset[str], frozenset[str]]] = {
    "PRODUCT_HELP": (frozenset({"answer", "citations"}), frozenset()),
    "ACCOUNT_STATE": (frozenset({"accountTopic"}), frozenset({"answer"})),
    "SEARCH": (frozenset({"searchQuery"}), frozenset()),
    "PROGRAM_QUESTION": (frozenset(), frozenset()),
    "OUT_OF_SCOPE": (frozenset({"answer"}), frozenset()),
    "UNCLEAR": (frozenset({"clarificationQuestion"}), frozenset()),
    "PARTNER_MATCH": (frozenset(), frozenset({"answer"})),
    "SAVED_PROGRAMS_QUESTION": (frozenset(), frozenset({"answer"})),
}


def _present_fields(output: AssistantClassification | AssistantAgentResponse) -> frozenset[str]:
    return frozenset(
        name for name, value in (
            ("answer", output.answer), ("citations", output.citations or None),
            ("clarificationQuestion", output.clarification_question),
            ("searchQuery", output.search_query), ("accountTopic", output.account_topic),
        ) if value is not None
    )
