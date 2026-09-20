from typing import Any
from urllib.parse import urlencode

from pydantic import ValidationError

from app.assistant_agent.models import (
    NAVIGATIONS, PROGRAM_DETAIL_ROUTE, RECRUITMENT_DETAIL_ROUTE, SCHEMA_VERSION, TOOL_INTENTS, AssistantAgentResponse,
    AssistantCard, AssistantNavigation, AssistantToolCallReport, MAX_TOOL_CALL_REPORTS,
)
from app.assistant_agent.state import AgentState, ToolResult


MAX_ANSWER_ATTEMPTS = 2

TOOL_FAILURE_ANSWER = "지금은 자료를 확인하지 못했어요. 잠시 뒤 다시 물어봐 주시거나 아래 버튼으로 직접 확인해 주세요."
NO_COMPANY_ANSWER = (
    "맞는 모집글을 찾으려면 먼저 기업을 등록해야 해요. "
    "프로필에서 기업을 등록하면 지역·역할·역량에 맞는 모집글을 찾아드릴게요."
)


def card_catalog(results: list[ToolResult]) -> dict[tuple[str, str], dict[str, Any]]:
    """도구 결과에서 카드가 될 수 있는 항목. 제목·부제·경로는 모델이 아니라 여기서 정한다."""
    catalog: dict[tuple[str, str], dict[str, Any]] = {}
    for result in results:
        if not result["ok"] or not isinstance(result["data"], list):
            continue
        for item in result["data"]:
            if not isinstance(item, dict):
                continue
            if result["name"] == "search_partner_recruitments" and isinstance(item.get("id"), int):
                identifier = str(item["id"])
                catalog[("RECRUITMENT", identifier)] = {
                    "kind": "RECRUITMENT", "id": identifier, "title": _short(item.get("title")),
                    "subtitle": _subtitle(item.get("companyName"), item.get("region"), item.get("recruitmentDeadline")),
                    "to": f"{RECRUITMENT_DETAIL_ROUTE}?{urlencode({'recruitmentId': identifier})}",
                }
            elif result["name"] == "list_saved_programs" and isinstance(item.get("sourceCode"), str) and isinstance(item.get("sourceProgramId"), str):
                identifier = f"{item['sourceCode']}:{item['sourceProgramId']}"
                catalog[("PROGRAM", identifier)] = {
                    "kind": "PROGRAM", "id": identifier, "title": _short(item.get("title")),
                    "subtitle": _subtitle(item.get("organization"), None, item.get("applicationEndDate")),
                    "to": f"{PROGRAM_DETAIL_ROUTE}?{urlencode({'sourceCode': item['sourceCode'], 'sourceProgramId': item['sourceProgramId']})}",
                }
    return catalog


def verify(state: AgentState) -> dict:
    """카드 id가 전부 도구 결과 안에 있어야 통과한다. 하나라도 없으면 답 전체를 다시 만들거나 강등한다."""
    output = state.get("answer_output")
    if output is None:
        return {"verified": False, "verified_cards": []}
    catalog = card_catalog(state.get("tool_results", []))
    cards: list[AssistantCard] = []
    try:
        for choice in output.cards:
            base = catalog.get((choice.kind, choice.id))
            if base is None:
                return {"verified": False, "verified_cards": []}
            cards.append(AssistantCard(**base, reason=choice.reason, quote=None))
    except ValidationError:
        return {"verified": False, "verified_cards": []}
    return {"verified": True, "verified_cards": cards}


def route_after_verify(state: AgentState) -> str:
    if not state.get("verified") and state.get("answer_attempts", 0) < MAX_ANSWER_ATTEMPTS:
        return "answer"
    return "finalize"


def finalize(state: AgentState) -> dict:
    """분류 결과와 (있다면) 검증된 답·카드를 응답 계약으로 합친다."""
    request = state["request"]
    classification = state["classification"]
    principal = request.principal
    intent = classification.intent
    base = classification.model_dump(by_alias=True)
    reports = [
        AssistantToolCallReport(name=result["name"], ms=result["ms"], ok=result["ok"])
        for result in state.get("tool_results", [])
    ][:MAX_TOOL_CALL_REPORTS]
    cards: list[AssistantCard] = []
    navigation: AssistantNavigation | None = None
    needs_documents = False
    if intent in TOOL_INTENTS and principal is not None:
        if intent == "PARTNER_MATCH" and not principal.has_company:
            base["answer"] = NO_COMPANY_ANSWER
            navigation = _navigation("PROFILE")
        elif intent == "ACCOUNT_STATE" and classification.account_topic == "RECEIVED_PROPOSALS":
            pass
        elif intent == "SAVED_PROGRAMS_QUESTION":
            if request.saved_program_documents is None:
                # 첫 호출: Core가 관심 공고 원문 청크 목록을 준비한 뒤 다시 부른다.
                needs_documents = True
            else:
                base["answer"] = state.get("agent_answer") or TOOL_FAILURE_ANSWER
                cards = list(state.get("verified_cards", [])) if state.get("verified") else []
                navigation = _navigation(state.get("agent_navigation") or "SAVED_PROGRAMS")
        else:
            output = state.get("answer_output")
            if output is None:
                base["answer"] = TOOL_FAILURE_ANSWER
                navigation = _navigation(_default_navigation(intent, classification.account_topic))
            else:
                base["answer"] = output.answer
                cards = list(state.get("verified_cards", [])) if state.get("verified") else []
                navigation = _navigation(output.navigation)
    response = AssistantAgentResponse(
        schemaVersion=SCHEMA_VERSION, cards=cards, navigation=navigation, toolCalls=reports, needsDocuments=needs_documents, **base,
    )
    return {"response": response}


def _navigation(key: str) -> AssistantNavigation | None:
    entry = NAVIGATIONS.get(key)
    return AssistantNavigation(label=entry[0], to=entry[1]) if entry else None


def _default_navigation(intent: str, account_topic: str | None) -> str:
    if intent == "PARTNER_MATCH":
        return "PARTNERS"
    if intent == "SAVED_PROGRAMS_QUESTION" or account_topic == "SAVED_PROGRAMS":
        return "SAVED_PROGRAMS"
    if account_topic == "COMPANY_PROFILE":
        return "PROFILE"
    return "NONE"


def _short(value: Any) -> str:
    text = str(value).strip() if isinstance(value, str) and value.strip() else "제목 없음"
    return text if len(text) <= 160 else text[:159] + "…"


def _subtitle(*parts: Any) -> str | None:
    text = " · ".join(str(part).strip() for part in parts if isinstance(part, (str, int)) and str(part).strip())
    return (text if len(text) <= 160 else text[:159] + "…") or None
