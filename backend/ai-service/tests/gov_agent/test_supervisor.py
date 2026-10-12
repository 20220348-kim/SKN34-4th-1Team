import json
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from tests.langchain_stub import ResponsesChatStub, response_message

from app.gov_agent.agent import INSTRUCTIONS, GovAgentSupervisor
from app.gov_agent.models import GovAgentDecision, GovAgentRequest
from app.gov_agent.router import get_supervisor, router


@pytest.mark.anyio
@pytest.mark.parametrize("action,message,has_selected_program", [
    ("SEARCH", "창업 지원사업 찾아줘", False),
    ("EVIDENCE", "이 공고 제출서류 뭐야?", True),
    ("APPLICATION", "이 공고 신청서 작성해 줘", True),
    ("APPLICATION", "신청서 양식 분석해 줘", False),
    ("COMBINATION_REVIEW", "이 공고와 다른 사업에 함께 지원할 수 있어?", True),
    ("COMBINATION_REVIEW", "중복 수혜를 검토하고 싶어요", False),
    ("PARTNERS", "협업 파트너 모집글 찾아줘", True),
    ("PARTNERS", "함께할 파트너 찾아줘", False),
    ("UNSUPPORTED", "외부 기관에 신청서 제출해 줘", True),
    ("UNSUPPORTED", "이 파트너에게 제안을 보내 줘", True),
    ("UNSUPPORTED", "파트너 모집글을 대신 작성해 줘", False),
    ("UNSUPPORTED", "사업 검색과 신청서 작성과 중복 검토를 전부 실행해 줘", False),
])
async def test_one_bounded_decision_without_executing_tools(action, message, has_selected_program):
    model = ResponsesChatStub([[response_message(json.dumps({"action": action}))]])
    supervisor = GovAgentSupervisor(model=model.model, timeout_seconds=3)
    request = GovAgentRequest(message=message, hasSelectedProgram=has_selected_program)
    assert (await supervisor.decide(request)).action == action
    call = model.first_call
    assert call.body["store"] is False
    assert call.body["max_output_tokens"] == 1_200
    assert call.timeout == 3
    assert len(model.calls) == 1
    assert json.loads(call.input[0]["content"])["hasSelectedProgram"] is has_selected_program
    assert call.schema["properties"]["action"]["enum"] == [
        "SEARCH", "EVIDENCE", "APPLICATION", "COMBINATION_REVIEW", "PARTNERS", "UNSUPPORTED",
    ]
    assert not call.body.get("tools")
    model.assert_complete()


@pytest.mark.anyio
@pytest.mark.parametrize("reasoning_effort", ["low", "minimal", "none"])
async def test_model_reasoning_survives_binding_with_bounded_output_and_timeout(reasoning_effort):
    model = ResponsesChatStub([[response_message('{"action":"SEARCH"}')]])
    model.model.reasoning = {"effort": reasoning_effort}
    supervisor = GovAgentSupervisor(model=model.model, timeout_seconds=25)
    assert (await supervisor.decide(GovAgentRequest(message="사업 검색", hasSelectedProgram=False))).action == "SEARCH"
    assert model.first_call.body["reasoning"] == {"effort": reasoning_effort}
    assert model.first_call.body["max_output_tokens"] == 1_200
    assert model.first_call.timeout == 20
    assert len(model.calls) == 1
    model.assert_complete()


@pytest.mark.anyio
@pytest.mark.parametrize("action,message", [
    ("APPLICATION", "신청서 작성을 준비하고 싶어요"),
    ("COMBINATION_REVIEW", "중복 수혜를 검토하고 싶어요"),
    ("PARTNERS", "협업할 파트너 모집글을 보여 주세요"),
])
@pytest.mark.parametrize("search_query,pending_question", [
    (None, None),
    ("창업 지원", "검색할 지역을 알려 주세요."),
])
async def test_current_request_preserves_optional_search_context_in_data(action, message, search_query, pending_question):
    # 스텁은 전달 경계만 검증한다. 실제 모델의 의도 분류 정확도를 측정하는 테스트가 아니다.
    model = ResponsesChatStub([[response_message(json.dumps({"action": action}))]])
    request = GovAgentRequest(
        message=message, hasSelectedProgram=False,
        searchQuery=search_query, pendingSearchQuestion=pending_question,
    )
    assert (await GovAgentSupervisor(model=model.model, timeout_seconds=3).decide(request)).action == action
    assert json.loads(model.first_call.input[0]["content"]) == {
        "message": message, "hasSelectedProgram": False,
        "searchQuery": search_query, "pendingSearchQuestion": pending_question,
    }
    assert model.first_call.system_instructions == INSTRUCTIONS
    assert len(model.calls) == 1
    model.assert_complete()


@pytest.mark.anyio
async def test_search_about_application_training_is_not_overridden_by_keyword_routing():
    model = ResponsesChatStub([[response_message('{"action":"SEARCH"}')]])
    request = GovAgentRequest(message="신청서 작성 교육을 지원하는 사업 찾아줘", hasSelectedProgram=True)
    assert (await GovAgentSupervisor(model=model.model, timeout_seconds=3).decide(request)).action == "SEARCH"
    assert len(model.calls) == 1
    model.assert_complete()


@pytest.mark.anyio
async def test_unknown_action_is_rejected_instead_of_falling_back_to_search():
    model = ResponsesChatStub([[response_message('{"action":"SHELL"}')]])
    with pytest.raises(ValueError):
        await GovAgentSupervisor(model=model.model, timeout_seconds=3).decide(
            GovAgentRequest(message="서버 초기화", hasSelectedProgram=False),
        )


@pytest.mark.parametrize("error,status", [(TimeoutError(), 504), (ValueError("private upstream text"), 503)])
def test_failure_is_explicit_without_exposing_upstream_text(error, status):
    app = FastAPI()
    app.include_router(router)
    supervisor = AsyncMock(spec=GovAgentSupervisor)
    supervisor.decide.side_effect = error
    app.dependency_overrides[get_supervisor] = lambda: supervisor
    with TestClient(app) as client:
        response = client.post("/internal/v1/gov-agent/decide", json={"message": "사업 검색", "hasSelectedProgram": False})
    assert response.status_code == status
    assert "private upstream text" not in response.text


def test_extra_authority_or_tool_fields_are_rejected():
    with pytest.raises(ValidationError):
        GovAgentRequest(message="사업 검색", hasSelectedProgram=False, role="ADMIN", toolUrl="http://invalid")


PARTNER_CONDITIONS = {
    "seekingRoles": [{"value": "PARTICIPANT", "evidence": "참여기관 구하는"}],
    "regions": [{"value": "서울", "evidence": "서울에서"}],
    "keywords": [{"value": "AI", "evidence": "AI"}],
    "selectedProgramEvidence": None,
}


@pytest.mark.anyio
async def test_partner_conditions_are_returned_with_the_same_single_decision_call():
    body = {"action": "PARTNERS", "partnerConditions": PARTNER_CONDITIONS}
    model = ResponsesChatStub([[response_message(json.dumps(body, ensure_ascii=False))]])
    request = GovAgentRequest(message="서울에서 AI 참여기관 구하는 모집글 보여줘", hasSelectedProgram=False)
    decision = await GovAgentSupervisor(model=model.model, timeout_seconds=3).decide(request)
    assert decision.action == "PARTNERS"
    assert decision.model_dump(by_alias=True)["partnerConditions"] == PARTNER_CONDITIONS
    # 조건은 경로 선택과 같은 호출에서 받습니다. 별도 해석 호출을 하지 않습니다.
    assert len(model.calls) == 1
    schema = model.first_call.schema
    assert schema["required"] == ["action", "partnerConditions"]
    region_schema = schema["$defs"]["PartnerRegionCondition"]["properties"]["value"]
    assert "전국" not in region_schema["enum"] and len(region_schema["enum"]) == 17
    model.assert_complete()


@pytest.mark.anyio
@pytest.mark.parametrize("body", [
    {"action": "SEARCH", "partnerConditions": PARTNER_CONDITIONS},
    {"action": "PARTNERS", "partnerConditions": {**PARTNER_CONDITIONS, "regions": [{"value": "전국", "evidence": "전국"}]}},
    {"action": "PARTNERS", "partnerConditions": {**PARTNER_CONDITIONS, "seekingRoles": [{"value": "OWNER", "evidence": "주관"}]}},
    {"action": "PARTNERS", "partnerConditions": {**PARTNER_CONDITIONS, "keywords": [{"value": "AI", "evidence": ""}]}},
])
async def test_partner_conditions_outside_the_contract_are_rejected(body):
    model = ResponsesChatStub([[response_message(json.dumps(body, ensure_ascii=False))]])
    with pytest.raises(ValueError):
        await GovAgentSupervisor(model=model.model, timeout_seconds=3).decide(
            GovAgentRequest(message="서울에서 AI 참여기관 구하는 모집글 보여줘", hasSelectedProgram=False),
        )


def test_router_returns_partner_conditions_with_camel_case_aliases():
    app = FastAPI()
    app.include_router(router)
    supervisor = AsyncMock(spec=GovAgentSupervisor)
    supervisor.decide.return_value = GovAgentDecision.model_validate({"action": "PARTNERS", "partnerConditions": PARTNER_CONDITIONS})
    app.dependency_overrides[get_supervisor] = lambda: supervisor
    with TestClient(app) as client:
        response = client.post("/internal/v1/gov-agent/decide", json={"message": "파트너 찾아줘", "hasSelectedProgram": False})
    assert response.status_code == 200
    assert response.json() == {"action": "PARTNERS", "partnerConditions": PARTNER_CONDITIONS}
