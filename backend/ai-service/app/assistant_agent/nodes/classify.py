from langchain_core.language_models import BaseChatModel
from langchain_core.messages import HumanMessage, SystemMessage

from app.assistant_agent.errors import AssistantAgentError
from app.assistant_agent.models import TOOL_INTENTS, AssistantClassification
from app.assistant_agent.nodes.common import request_payload, structured_call
from app.assistant_agent.prompts import CLASSIFY_INSTRUCTIONS
from app.assistant_agent.state import AgentState


async def classify(state: AgentState, *, model: BaseChatModel) -> dict:
    """싼 모델로 의도를 고른다. 도구가 필요 없는 의도는 여기서 답까지 채워져 바로 끝난다."""
    request = state["request"]
    messages = [
        SystemMessage(CLASSIFY_INSTRUCTIONS),
        HumanMessage(request_payload(
            request, "classify", helpEntries=[entry.model_dump(by_alias=True) for entry in request.help_entries],
        )),
    ]
    parsed, counts = await structured_call(model, AssistantClassification, messages)
    if parsed is None:
        raise AssistantAgentError("classification did not match the schema")
    classification = AssistantClassification.model_validate(parsed.model_dump(by_alias=True))
    if not set(classification.citations) <= request.help_entry_ids():
        # 요청에 없던 도움말을 인용하면 지어낸 근거다.
        raise AssistantAgentError("citation outside the help entries")
    return {"classification": classification, **counts}


def resume(state: AgentState) -> dict:
    """Core가 원문을 준비해 다시 부른 두 번째 호출. 분류를 다시 하지 않고 첫 호출의 의도를 그대로 쓴다."""
    intent = state["request"].resume_intent
    if intent is None:
        raise AssistantAgentError("resume requires resumeIntent")
    return {"classification": AssistantClassification(
        intent=intent, answer=None, citations=[], clarificationQuestion=None, searchQuery=None, accountTopic=None,
    )}


def route_start(state: AgentState) -> str:
    return "resume" if state["request"].resume_intent is not None else "classify"


def route_after_classify(state: AgentState) -> str:
    classification = state["classification"]
    request = state["request"]
    principal = request.principal
    if classification.intent not in TOOL_INTENTS or principal is None:
        return "finalize"
    if classification.intent == "PARTNER_MATCH" and not principal.has_company:
        return "finalize"
    if classification.intent == "ACCOUNT_STATE" and classification.account_topic == "RECEIVED_PROPOSALS":
        # 제안함 도구는 아직 없다. Core가 기존 방식으로 답한다.
        return "finalize"
    if classification.intent == "SAVED_PROGRAMS_QUESTION":
        # 원문 청크 허용 목록이 있어야 근거 검색을 한다. 없으면 needsDocuments로 끝내고 Core가 준비해 다시 부른다.
        return "saved_programs" if request.saved_program_documents is not None else "finalize"
    return "plan"
