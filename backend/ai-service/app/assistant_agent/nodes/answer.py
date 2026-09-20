from typing import Any

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import HumanMessage, SystemMessage

from app.assistant_agent.models import AssistantAgentAnswer
from app.assistant_agent.nodes.common import request_payload, structured_call
from app.assistant_agent.prompts import ANSWER_INSTRUCTIONS
from app.assistant_agent.state import AgentState, ToolResult


MAX_RECRUITMENTS_IN_DATA = 30


def data_block(results: list[ToolResult]) -> dict[str, Any]:
    """도구 결과를 답 모델이 읽는 한 덩어리로 합친다. 같은 도구를 여러 번 불렀으면 합치고 중복 id는 앞의 것을 남긴다."""
    data: dict[str, Any] = {"companyProfile": None, "recruitments": [], "savedPrograms": [], "errors": []}
    seen_recruitments: set[Any] = set()
    for result in results:
        if not result["ok"]:
            data["errors"].append(result["name"])
            continue
        if result["name"] == "get_my_company_profile" and isinstance(result["data"], dict):
            data["companyProfile"] = result["data"]
        elif result["name"] == "search_partner_recruitments" and isinstance(result["data"], list):
            for item in result["data"]:
                if isinstance(item, dict) and item.get("id") not in seen_recruitments and len(data["recruitments"]) < MAX_RECRUITMENTS_IN_DATA:
                    seen_recruitments.add(item.get("id"))
                    data["recruitments"].append(item)
        elif result["name"] == "list_saved_programs" and isinstance(result["data"], list):
            data["savedPrograms"] = [item for item in result["data"] if isinstance(item, dict)]
    return data


async def answer(state: AgentState, *, model: BaseChatModel) -> dict:
    """도구 결과만 근거로 구조화 답을 만든다. 스키마에 맞지 않으면 None을 남겨 verify가 재시도·강등을 정한다."""
    request = state["request"]
    classification = state["classification"]
    messages = [
        SystemMessage(ANSWER_INSTRUCTIONS),
        HumanMessage(request_payload(
            request, "answer", intent=classification.intent, accountTopic=classification.account_topic,
            data=data_block(state.get("tool_results", [])),
        )),
    ]
    parsed, counts = await structured_call(model, AssistantAgentAnswer, messages)
    return {"answer_output": parsed, "answer_attempts": 1, **counts}
