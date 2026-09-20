import asyncio
import json
import logging
from time import perf_counter
from typing import Any

from langchain_core.messages import ToolMessage

from app.assistant_agent.errors import AssistantAgentError
from app.assistant_agent.state import AgentState, ToolResult
from app.assistant_agent.tools import CoreToolClient, build_tools


logger = logging.getLogger(__name__)


async def run_tools(state: AgentState, *, tool_client: CoreToolClient, max_tool_calls: int) -> dict:
    """계획이 고른 도구를 병렬로 부른다. 실패는 예외가 아니라 ok=false 결과와 오류 ToolMessage로 남긴다."""
    principal = state["request"].principal
    if principal is None:
        raise AssistantAgentError("tools require a principal")
    tools = {tool.name: tool for tool in build_tools(tool_client, principal)}
    calls = state.get("pending_tool_calls", [])

    async def run(call: dict[str, Any]) -> tuple[ToolMessage, ToolResult]:
        started = perf_counter()
        ok = False
        data: Any = None
        try:
            message = await tools[call["name"]].ainvoke(call)
            if not isinstance(message, ToolMessage):
                raise AssistantAgentError("tool must return a ToolMessage")
            ok = True
            data = message.artifact
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - 도구 실패는 답을 강등할 뿐 요청을 실패시키지 않는다.
            # 도구 이름과 오류 종류만 남긴다. 인자·응답 본문은 남기지 않는다.
            logger.warning("assistant_agent_tool_failed name=%s error_type=%s", call["name"], type(error).__name__)
            message = ToolMessage(
                content=json.dumps({"error": "TOOL_FAILED"}), tool_call_id=call["id"], name=call["name"], status="error",
            )
        ms = round((perf_counter() - started) * 1000)
        return message, ToolResult(name=call["name"], args=dict(call["args"]), ms=ms, ok=ok, data=data)

    outcomes = await asyncio.gather(*(run(call) for call in calls))
    return {
        "messages": [message for message, _ in outcomes],
        "tool_results": [result for _, result in outcomes],
        "pending_tool_calls": [],
    }


def route_after_tools(state: AgentState, *, max_tool_calls: int) -> str:
    results = state.get("tool_results", [])
    if len(results) < max_tool_calls and all(result["ok"] for result in results):
        return "plan"
    # 실패했거나 상한에 닿았으면 더 계획하지 않고 지금 자료로 답한다.
    return "answer"
