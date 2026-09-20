import json
from typing import Any

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from app.assistant_agent.errors import AssistantAgentError
from app.assistant_agent.nodes.common import request_payload, usage_update
from app.assistant_agent.prompts import PLAN_INSTRUCTIONS
from app.assistant_agent.state import AgentState
from app.assistant_agent.tools import CoreToolClient, build_tools


def _call_key(name: str, args: dict[str, Any]) -> tuple[str, str]:
    return name, json.dumps(args, sort_keys=True, ensure_ascii=False)


async def plan(state: AgentState, *, model: BaseChatModel, tool_client: CoreToolClient, max_tool_calls: int) -> dict:
    """도구를 묶어 준 모델이 다음에 부를 도구를 고른다. 같은 호출 반복과 상한 초과는 여기서 잘라 낸다."""
    request = state["request"]
    principal = request.principal
    if principal is None:
        raise AssistantAgentError("plan requires a principal")
    classification = state["classification"]
    tools = build_tools(tool_client, principal)
    executed = state.get("tool_results", [])
    remaining = max(0, max_tool_calls - len(executed))
    messages = [
        SystemMessage(PLAN_INSTRUCTIONS),
        HumanMessage(request_payload(
            request, "plan", intent=classification.intent, accountTopic=classification.account_topic,
            toolCallsUsed=len(executed), toolCallsRemaining=remaining,
        )),
        *state.get("messages", []),
    ]
    response = await model.bind_tools(tools).ainvoke(messages)
    if not isinstance(response, AIMessage):
        raise AssistantAgentError("plan must return an assistant message")
    known = {tool.name for tool in tools}
    seen = {_call_key(result["name"], result["args"]) for result in executed}
    pending: list[dict[str, Any]] = []
    for call in response.tool_calls:
        key = _call_key(call["name"], call["args"])
        if call["name"] not in known or key in seen or len(pending) >= remaining:
            continue
        seen.add(key)
        pending.append({"name": call["name"], "args": call["args"], "id": call["id"], "type": "tool_call"})
    update: dict[str, Any] = {"pending_tool_calls": pending, **usage_update(response)}
    if pending:
        # 실제로 실행할 호출만 대화에 남겨 ToolMessage와 짝이 맞게 한다.
        update["messages"] = [AIMessage(content=response.content, tool_calls=pending)]
    return update


def route_after_plan(state: AgentState) -> str:
    return "tools" if state.get("pending_tool_calls") else "answer"
