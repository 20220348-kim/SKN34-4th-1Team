import pytest
from pydantic import ValidationError

from app.assistant_agent.models import (
    SCHEMA_VERSION, AssistantAgentAnswer, AssistantAgentRequest, AssistantAgentResponse, AssistantClassification,
)


def test_request_accepts_a_principal_bound_to_the_session(request_data):
    request = AssistantAgentRequest.model_validate(request_data)
    assert request.principal is not None
    assert request.principal.account_id == 7
    assert request.help_entry_ids() == {"search-score-meaning", "partner-write-requires-company"}


@pytest.mark.parametrize("mutation", [
    {"principal": {"accountId": 0, "toolToken": "t", "hasCompany": True}},
    {"principal": {"accountId": 7, "toolToken": "", "hasCompany": True}},
    {"principal": {"accountId": 7, "toolToken": "has space", "hasCompany": True}},
    {"session": {"authenticated": False, "hasCompany": False}},
    {"session": {"authenticated": True, "hasCompany": False}},
    {"schemaVersion": "govbiz-assistant-v1"},
    {"helpEntries": []},
])
def test_request_rejects_inconsistent_principals_and_wrong_schema(request_data, mutation):
    request_data.update(mutation)
    with pytest.raises(ValidationError):
        AssistantAgentRequest.model_validate(request_data)


def test_request_without_principal_is_the_anonymous_case(request_data):
    request_data["principal"] = None
    request_data["session"] = {"authenticated": False, "hasCompany": False}
    assert AssistantAgentRequest.model_validate(request_data).principal is None


@pytest.mark.parametrize("intent", ["PARTNER_MATCH", "SAVED_PROGRAMS_QUESTION", "PROGRAM_QUESTION"])
def test_classification_new_intents_carry_no_fields(empty_classification, intent):
    parsed = AssistantClassification.model_validate({**empty_classification, "intent": intent})
    assert parsed.intent == intent and parsed.answer is None


@pytest.mark.parametrize("intent", ["PROGRAM_QUESTION", "PARTNER_MATCH", "SAVED_PROGRAMS_QUESTION"])
def test_classification_drops_stray_fields_on_field_free_intents(empty_classification, intent):
    parsed = AssistantClassification.model_validate({
        **empty_classification, "intent": intent, "accountTopic": "SAVED_PROGRAMS", "answer": "군더더기", "citations": ["search-score-meaning"], "searchQuery": "검색어",
    })
    assert parsed.intent == intent
    assert parsed.account_topic is None and parsed.answer is None and parsed.citations == [] and parsed.search_query is None
    # 필드가 있는 의도는 그대로 엄격하다.
    with pytest.raises(ValidationError):
        AssistantClassification.model_validate({**empty_classification, "intent": "SEARCH", "searchQuery": "검색어", "answer": "답"})


def test_agent_answer_requires_unique_cards_and_known_navigation():
    AssistantAgentAnswer.model_validate({"answer": "답", "cards": [{"kind": "RECRUITMENT", "id": "21", "reason": "지역 일치"}], "navigation": "PARTNERS"})
    with pytest.raises(ValidationError):
        AssistantAgentAnswer.model_validate({
            "answer": "답", "navigation": "PARTNERS",
            "cards": [{"kind": "RECRUITMENT", "id": "21", "reason": "a"}, {"kind": "RECRUITMENT", "id": "21", "reason": "b"}],
        })
    with pytest.raises(ValidationError):
        AssistantAgentAnswer.model_validate({"answer": "답", "cards": [], "navigation": "ADMIN"})


def _response(**overrides):
    base = {
        "schemaVersion": SCHEMA_VERSION, "intent": "PARTNER_MATCH", "answer": None, "citations": [], "clarificationQuestion": None,
        "searchQuery": None, "accountTopic": None, "cards": [], "navigation": None, "toolCalls": [], "needsDocuments": False,
    }
    return AssistantAgentResponse.model_validate({**base, **overrides})


def test_response_tool_intents_allow_an_optional_answer_with_cards():
    card = {"kind": "RECRUITMENT", "id": "21", "title": "AI 실증 참여기관 구합니다", "subtitle": "서울AI 주식회사 · 서울", "reason": "지역과 역할이 맞습니다.",
            "quote": None, "to": "/app/partners/detail?recruitmentId=21"}
    anonymous = _response()
    assert anonymous.answer is None and anonymous.cards == []
    answered = _response(answer="세 건이 맞습니다.", cards=[card], navigation={"label": "파트너 모집 열기", "to": "/app/partners"},
                         toolCalls=[{"name": "get_my_company_profile", "ms": 12, "ok": True}])
    assert answered.cards[0].to == "/app/partners/detail?recruitmentId=21"
    assert _response(intent="ACCOUNT_STATE", accountTopic="SAVED_PROGRAMS").answer is None
    assert _response(intent="ACCOUNT_STATE", accountTopic="SAVED_PROGRAMS", answer="다섯 건이 있습니다.").answer


@pytest.mark.parametrize("overrides", [
    {"intent": "PRODUCT_HELP", "answer": "답"},
    {"intent": "SEARCH", "searchQuery": "서울 제조", "answer": "답"},
    {"intent": "OUT_OF_SCOPE", "answer": "답", "cards": [{"kind": "RECRUITMENT", "id": "1", "title": "t", "subtitle": None, "reason": "r", "quote": None, "to": "/app/partners"}]},
    {"intent": "PARTNER_MATCH", "navigation": {"label": "열기", "to": "/app/partners"}},
    {"intent": "PARTNER_MATCH", "answer": "답", "cards": [{"kind": "RECRUITMENT", "id": "1", "title": "t", "subtitle": None, "reason": "r", "quote": None, "to": "https://evil.example/x"}]},
    {"intent": "PARTNER_MATCH", "answer": "답", "cards": [{"kind": "RECRUITMENT", "id": "1", "title": "t", "subtitle": None, "reason": "r", "quote": None, "to": "/login"}]},
    {"intent": "PARTNER_MATCH", "answer": "답", "cards": [{"kind": "RECRUITMENT", "id": "1", "title": "t", "subtitle": None, "reason": "r", "quote": "인용", "to": "/app/partners/detail?recruitmentId=1"}]},
    {"intent": "ACCOUNT_STATE", "answer": "답"},
    {"intent": "PARTNER_MATCH", "needsDocuments": True},
    {"intent": "SAVED_PROGRAMS_QUESTION", "answer": "답", "needsDocuments": True},
])
def test_response_rejects_fields_outside_the_intent_contract(overrides):
    with pytest.raises(ValidationError):
        _response(**overrides)
