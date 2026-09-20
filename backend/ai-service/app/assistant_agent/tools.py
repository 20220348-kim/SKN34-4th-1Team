"""Core 내부 도구 API를 부르는 LangChain 도구. 전부 GET·읽기 전용이고 결과는 자료로만 쓴다."""

import json
import re
from typing import Any, Literal

import httpx
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, ConfigDict, Field

from app.assistant_agent.errors import ToolCallError
from app.assistant_agent.models import AssistantPrincipal


SECRET_HEADER = "X-Internal-Token"
TOKEN_HEADER = "X-Assistant-Tool-Token"
TOOLS_PATH_PREFIX = "/internal/v1/assistant/tools"

MAX_LIST_ITEMS = 30
MAX_TEXT_LENGTH = 600
MAX_NESTING = 4
# 식별자·날짜·열거값은 가리지 않는다. 숫자 식별자를 사업자등록번호로 오인해 지우면 카드가 깨진다.
IDENTIFIER_KEYS = frozenset({
    "sourceCode", "sourceProgramId", "documentId", "status", "ownRole", "seekingRole",
    "recruitmentDeadline", "programApplicationEndDate", "applicationEndDate",
})

_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_RESIDENT_NUMBER = re.compile(r"(?<![0-9])[0-9]{6}-?[1-4][0-9]{6}(?![0-9])")
_BUSINESS_NUMBER = re.compile(r"(?<![0-9])[0-9]{3}-?[0-9]{2}-?[0-9]{5}(?![0-9])")
_PHONE_NUMBER = re.compile(r"(?<![0-9])0[0-9]{1,2}[-. ]?[0-9]{3,4}[-. ]?[0-9]{4}(?![0-9])")
_URL = re.compile(r"https?://\S+")


class CoreToolClient:
    """공유 비밀과 계정 묶음 토큰을 붙여 Core를 부른다. 재시도는 하지 않는다."""

    def __init__(
        self, *, base_url: str, secret: str | None, timeout_seconds: float,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._secret = secret
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"), timeout=timeout_seconds, transport=transport,
            headers={"Accept": "application/json"},
        )

    @property
    def enabled(self) -> bool:
        return bool(self._secret)

    async def get(self, path: str, principal: AssistantPrincipal, params: dict[str, str] | None = None) -> Any:
        if not self._secret:
            raise ToolCallError("tools are disabled")
        query = {"accountId": str(principal.account_id), **{k: v for k, v in (params or {}).items() if v}}
        try:
            response = await self._client.get(
                f"{TOOLS_PATH_PREFIX}{path}", params=query,
                headers={SECRET_HEADER: self._secret, TOKEN_HEADER: principal.tool_token},
            )
        except httpx.HTTPError as error:
            raise ToolCallError(type(error).__name__) from error
        if response.status_code != 200:
            raise ToolCallError(f"status {response.status_code}")
        try:
            return response.json()
        except ValueError as error:
            raise ToolCallError("invalid json") from error

    async def aclose(self) -> None:
        await self._client.aclose()


class NoArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SearchPartnerRecruitmentsArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")

    region: str | None = Field(default=None, max_length=50, description="모집 지역 이름(예: 서울, 경기). 모르면 비운다.")
    seekingRole: Literal["LEAD", "PARTICIPANT", "DEMAND"] | None = Field(
        default=None,
        description="모집글이 찾는 역할. 내 기업이 맡을 역할을 넣는다(주관하려면 LEAD, 참여하려면 PARTICIPANT, 수요기업이면 DEMAND).",
    )
    keyword: str | None = Field(default=None, max_length=100, description="제목·본문에서 찾을 짧은 키워드. 모르면 비운다.")


def build_tools(client: CoreToolClient, principal: AssistantPrincipal) -> list[StructuredTool]:
    """요청 하나의 principal에 묶인 도구 목록. 이름과 인자 스키마는 계획 모델이 보는 계약이다."""

    async def get_my_company_profile() -> tuple[str, Any]:
        return _package(await client.get("/company-profile", principal))

    async def search_partner_recruitments(
        region: str | None = None, seekingRole: str | None = None, keyword: str | None = None,
    ) -> tuple[str, Any]:
        params = {"region": region or "", "seekingRole": seekingRole or "", "keyword": keyword or ""}
        return _package(await client.get("/recruitments", principal, params))

    async def list_saved_programs() -> tuple[str, Any]:
        return _package(await client.get("/saved-programs", principal))

    return [
        StructuredTool.from_function(
            coroutine=get_my_company_profile, name="get_my_company_profile", args_schema=NoArguments,
            description="내 기업 프로필(등록 여부·상호·지역·업종·설립연도·파트너 역할·관심 분야·역량)을 읽는다. 연락처는 없다.",
            response_format="content_and_artifact",
        ),
        StructuredTool.from_function(
            coroutine=search_partner_recruitments, name="search_partner_recruitments",
            args_schema=SearchPartnerRecruitmentsArguments,
            description="모집 중인 다른 기업의 파트너 모집글을 마감 임박순으로 최대 30건 찾는다. 내 글은 제외된다.",
            response_format="content_and_artifact",
        ),
        StructuredTool.from_function(
            coroutine=list_saved_programs, name="list_saved_programs", args_schema=NoArguments,
            description="내 관심 공고함의 공고(제목·기관·접수 마감일·상태)를 최대 10건 읽는다.",
            response_format="content_and_artifact",
        ),
    ]


def _package(data: Any) -> tuple[str, Any]:
    sanitized = sanitize(data)
    return json.dumps(sanitized, ensure_ascii=False), sanitized


def sanitize(value: Any, depth: int = 0) -> Any:
    """Core가 이미 가린 결과를 한 번 더 검사한다: 개인정보·URL 제거, 문자열·목록 절단, 깊이 제한."""
    if depth > MAX_NESTING:
        return None
    if isinstance(value, str):
        text = _URL.sub("[링크]", value)
        text = _EMAIL.sub("[이메일]", text)
        text = _RESIDENT_NUMBER.sub("[주민등록번호]", text)
        text = _BUSINESS_NUMBER.sub("[사업자등록번호]", text)
        text = _PHONE_NUMBER.sub("[전화번호]", text)
        text = "".join(character for character in text if character in "\n\t" or (character.isprintable()))
        return text if len(text) <= MAX_TEXT_LENGTH else text[:MAX_TEXT_LENGTH].rstrip() + "…"
    if isinstance(value, bool) or value is None or isinstance(value, (int, float)):
        return value
    if isinstance(value, list):
        return [sanitize(item, depth + 1) for item in value[:MAX_LIST_ITEMS]]
    if isinstance(value, dict):
        return {
            str(key)[:64]: (item[:200] if key in IDENTIFIER_KEYS and isinstance(item, str) else sanitize(item, depth + 1))
            for key, item in list(value.items())[:40]
        }
    return None
