"""그래프 테스트용 대역: 대본대로 답하는 채팅 모델과 Core 도구 API 흉내."""

import asyncio
import json
from typing import Any

import httpx
from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.runnables import RunnableLambda
from pydantic import BaseModel, Field, ValidationError

from app.assistant_agent.models import SavedProgramDocument
from app.assistant_agent.retriever import RetrievedChunk
from app.assistant_agent.tools import SECRET_HEADER, TOKEN_HEADER


HANG = object()


def tool_call_message(*calls: tuple[str, dict[str, Any]], content: str = "") -> AIMessage:
    return AIMessage(
        content=content,
        tool_calls=[{"name": name, "args": args, "id": f"call_{index}_{name}", "type": "tool_call"} for index, (name, args) in enumerate(calls)],
        usage_metadata={"input_tokens": 100, "output_tokens": 10, "total_tokens": 110},
    )


class ScriptedChatModel(BaseChatModel):
    """responses의 항목을 차례로 낸다. AIMessage는 계획 호출, dict는 구조화 출력, HANG은 영원히 기다린다."""

    responses: list[Any] = Field(default_factory=list)
    calls: list[list[BaseMessage]] = Field(default_factory=list)
    bound_tool_names: list[list[str]] = Field(default_factory=list)
    structured_schemas: list[str] = Field(default_factory=list)

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def _next(self) -> Any:
        assert self.responses, "script exhausted"
        return self.responses.pop(0)

    def _generate(self, messages: list[BaseMessage], stop=None, run_manager: CallbackManagerForLLMRun | None = None, **kwargs) -> ChatResult:
        self.calls.append(list(messages))
        item = self._next()
        assert isinstance(item, AIMessage), "plan calls must be scripted as AIMessage"
        return ChatResult(generations=[ChatGeneration(message=item)])

    async def _agenerate(self, messages: list[BaseMessage], stop=None, run_manager=None, **kwargs) -> ChatResult:
        self.calls.append(list(messages))
        item = self._next()
        if item is HANG:
            await asyncio.Event().wait()
        if isinstance(item, Exception):
            raise item
        assert isinstance(item, AIMessage), "plan calls must be scripted as AIMessage"
        return ChatResult(generations=[ChatGeneration(message=item)])

    def bind_tools(self, tools, **kwargs):
        self.bound_tool_names.append([tool.name for tool in tools])
        return self

    def with_structured_output(self, schema: type[BaseModel], *, include_raw: bool = False, **kwargs):
        self.structured_schemas.append(schema.__name__)

        async def run(messages: list[BaseMessage]) -> Any:
            self.calls.append(list(messages))
            item = self._next()
            if item is HANG:
                await asyncio.Event().wait()
            if isinstance(item, Exception):
                raise item
            raw = AIMessage(content=json.dumps(item, ensure_ascii=False), usage_metadata={"input_tokens": 200, "output_tokens": 20, "total_tokens": 220})
            try:
                parsed = schema.model_validate(item)
            except ValidationError as error:
                if not include_raw:
                    raise
                return {"raw": raw, "parsed": None, "parsing_error": error}
            return {"raw": raw, "parsed": parsed, "parsing_error": None} if include_raw else parsed

        return RunnableLambda(run)

    def assert_complete(self) -> None:
        assert not self.responses, f"unused scripted responses: {len(self.responses)}"


COMPANY_PROFILE = {
    "registered": True, "companyName": "데이터브릿지 주식회사", "region": "서울특별시", "industry": "정보통신업", "foundedYear": 2021,
    "roles": ["PARTICIPANT"], "interestAreas": ["AI"], "introduction": "데이터 구축과 라벨링을 합니다.", "capabilities": ["라벨링"],
}
RECRUITMENTS = [
    {
        "id": 21, "title": "AI 실증 참여기관 구합니다", "companyName": "서울AI 주식회사", "companyRegion": "서울특별시", "companyIndustry": "정보통신업",
        "ownRole": "LEAD", "seekingRole": "PARTICIPANT", "seekingCount": 1, "region": "서울", "minimumCompanyAgeYears": None,
        "capabilities": ["라벨링"], "recruitmentDeadline": "2026-09-20", "programTitle": "서울 AI 실증 지원사업",
        "programApplicationEndDate": "2026-09-30", "body": "라벨링 운영을 맡아 주실 참여기관을 찾습니다.",
    },
    {
        "id": 22, "title": "스마트공장 참여기관 모집", "companyName": "경기제조 주식회사", "companyRegion": "경기도", "companyIndustry": "제조업",
        "ownRole": "LEAD", "seekingRole": "PARTICIPANT", "seekingCount": 2, "region": "경기", "minimumCompanyAgeYears": 3,
        "capabilities": ["PLC"], "recruitmentDeadline": "2026-09-25", "programTitle": "스마트공장 고도화",
        "programApplicationEndDate": None, "body": "PLC 경험이 있는 참여기관을 찾습니다.",
    },
]
SAVED_PROGRAMS = [
    {"sourceCode": "BIZINFO", "sourceProgramId": "PBLN_000000000000001", "title": "서울 AI 실증 지원사업", "organization": "서울경제진흥원",
     "applicationEndDate": "2026-09-30", "status": "OPEN", "documentId": "BIZINFO:PBLN_000000000000001"},
    {"sourceCode": "BIZINFO", "sourceProgramId": "PBLN_000000000000002", "title": "경기 데이터 바우처", "organization": "경기도",
     "applicationEndDate": None, "status": "CLOSED", "documentId": None},
]


class FakeCoreTools:
    """httpx MockTransport 핸들러. 헤더·계정을 검사하고 고정 자료를 돌려준다."""

    def __init__(self, *, secret: str = "assistant-tools-secret-for-tests-0123456789", token: str = "7.1900000000.sig", account_id: int = 7) -> None:
        self.secret = secret
        self.token = token
        self.account_id = account_id
        self.requests: list[httpx.Request] = []
        self.fail_with: int | None = None

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.fail_with is not None:
            return httpx.Response(self.fail_with, json={"code": "ASSISTANT_TOOL_UNAUTHORIZED"})
        if request.headers.get(SECRET_HEADER) != self.secret or request.headers.get(TOKEN_HEADER) != self.token:
            return httpx.Response(401, json={"code": "ASSISTANT_TOOL_UNAUTHORIZED"})
        if request.url.params.get("accountId") != str(self.account_id):
            return httpx.Response(401, json={"code": "ASSISTANT_TOOL_UNAUTHORIZED"})
        path = request.url.path
        if path.endswith("/company-profile"):
            return httpx.Response(200, json=COMPANY_PROFILE)
        if path.endswith("/recruitments"):
            region = request.url.params.get("region")
            items = [item for item in RECRUITMENTS if not region or item["region"] == region]
            return httpx.Response(200, json=items)
        if path.endswith("/saved-programs"):
            return httpx.Response(200, json=SAVED_PROGRAMS)
        return httpx.Response(404, json={"code": "NOT_FOUND"})


class FakeRetriever:
    """문서 id별 고정 청크를 돌려준다. raise_error가 있으면 검색 장애를 흉내 낸다."""

    def __init__(self, chunks: dict[str, list[RetrievedChunk]] | None = None, *, raise_error: Exception | None = None) -> None:
        self.chunks = chunks or {}
        self.raise_error = raise_error
        self.calls: list[tuple[str, list[str], int]] = []

    async def retrieve(self, question: str, documents: list[SavedProgramDocument], per_document_limit: int) -> dict[str, list[RetrievedChunk]]:
        self.calls.append((question, [document.document_id for document in documents], per_document_limit))
        if self.raise_error is not None:
            raise self.raise_error
        return {
            document.document_id: self.chunks[document.document_id][:per_document_limit]
            for document in documents if document.chunks and self.chunks.get(document.document_id)
        }
