"""그래프 상태. 체크포인터 없이 요청마다 새로 만든다. 목록·계수 필드는 노드가 낸 값을 더해 쌓는다."""

import operator
from typing import Annotated, Any, TypedDict

from langchain_core.messages import BaseMessage

from app.assistant_agent.models import (
    AssistantAgentAnswer, AssistantAgentRequest, AssistantAgentResponse, AssistantCard, AssistantClassification,
)


class ToolResult(TypedDict):
    name: str
    args: dict[str, Any]
    ms: int
    ok: bool
    data: Any


class AgentState(TypedDict, total=False):
    request: AssistantAgentRequest
    classification: AssistantClassification
    # 계획 루프의 대화: 도구 호출 AIMessage와 ToolMessage만 쌓인다. 시스템·사용자 메시지는 노드가 매번 붙인다.
    messages: Annotated[list[BaseMessage], operator.add]
    pending_tool_calls: list[dict[str, Any]]
    tool_results: Annotated[list[ToolResult], operator.add]
    answer_output: AssistantAgentAnswer | None
    answer_attempts: Annotated[int, operator.add]
    # 검증에 통과한 카드(제목·경로까지 채운 것). 실패하면 빈 목록으로 강등한다.
    verified_cards: list[AssistantCard]
    verified: bool
    model_calls: Annotated[int, operator.add]
    input_tokens: Annotated[int, operator.add]
    output_tokens: Annotated[int, operator.add]
    response: AssistantAgentResponse
    # 관심 공고 묶음 질문(서브그래프)의 결과. 도구 루프를 거치지 않는다.
    needs_documents: bool
    agent_answer: str | None
    agent_navigation: str | None
