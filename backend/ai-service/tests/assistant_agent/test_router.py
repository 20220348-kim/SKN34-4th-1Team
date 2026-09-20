import logging
import re

import pytest
from fastapi.testclient import TestClient

from app.assistant_agent.errors import AssistantAgentError, AssistantAgentTimeoutError
from app.assistant_agent.models import SCHEMA_VERSION, AssistantAgentRequest, AssistantAgentResponse
from app.assistant_agent.service import AssistantAgentService
from app.config import Settings
from app.main import create_app


SETTINGS = Settings(openai_api_key="test-key-never-sent", openai_model="test-model", llm_model_timeout_seconds=1, llm_run_timeout_seconds=2)
PATH = "/internal/v1/assistant/agent"


class FakeAgentService(AssistantAgentService):
    def __init__(self, outcome) -> None:
        self.outcome = outcome
        self.requests: list[AssistantAgentRequest] = []

    async def answer(self, request: AssistantAgentRequest) -> AssistantAgentResponse:
        self.requests.append(request)
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self.outcome


def response_data(**overrides) -> dict:
    return {
        "schemaVersion": SCHEMA_VERSION, "intent": "PARTNER_MATCH", "answer": "맞는 모집글 한 건을 찾았어요.", "citations": [],
        "clarificationQuestion": None, "searchQuery": None, "accountTopic": None,
        "cards": [{"kind": "RECRUITMENT", "id": "21", "title": "AI 실증 참여기관 구합니다", "subtitle": "서울AI 주식회사 · 서울",
                   "reason": "지역과 역할이 맞습니다.", "quote": None, "to": "/app/partners/detail?recruitmentId=21"}],
        "navigation": {"label": "파트너 모집 열기", "to": "/app/partners"},
        "toolCalls": [{"name": "get_my_company_profile", "ms": 12, "ok": True}, {"name": "search_partner_recruitments", "ms": 30, "ok": True}],
        "needsDocuments": False,
        **overrides,
    }


def test_http_to_service_to_response(request_data):
    service = FakeAgentService(AssistantAgentResponse.model_validate(response_data()))
    with TestClient(create_app(settings=SETTINGS, assistant_agent_service=service)) as client:
        response = client.post(PATH, json=request_data)
    assert response.status_code == 200
    assert response.json() == response_data()
    assert len(service.requests) == 1 and service.requests[0].principal.account_id == 7


@pytest.mark.parametrize("mutation", [
    {"message": " "}, {"schemaVersion": "govbiz-assistant-v1"}, {"helpEntries": []}, {"principal": {"accountId": 7}},
    {"session": {"authenticated": False, "hasCompany": False}}, {"extra": 1},
])
def test_invalid_request_is_422_before_the_service(request_data, mutation):
    request_data.update(mutation)
    service = FakeAgentService(AssistantAgentResponse.model_validate(response_data()))
    with TestClient(create_app(settings=SETTINGS, assistant_agent_service=service)) as client:
        response = client.post(PATH, json=request_data)
    assert response.status_code == 422
    assert service.requests == []


@pytest.mark.parametrize("error,status,detail,kind", [
    (AssistantAgentError(), 503, "Assistant answer is temporarily unavailable.", "execution"),
    (AssistantAgentTimeoutError(), 504, "Assistant answer timed out.", "timeout"),
])
def test_failures_are_safe_status_codes_without_private_text(request_data, error, status, detail, kind, caplog):
    service = FakeAgentService(error)
    with caplog.at_level(logging.WARNING, logger="app.assistant_agent.router"):
        with TestClient(create_app(settings=SETTINGS, assistant_agent_service=service)) as client:
            response = client.post(PATH, json=request_data)
    assert response.status_code == status
    assert response.json() == {"detail": detail}
    records = [record for record in caplog.records if record.name.endswith("assistant_agent.router")]
    assert len(records) == 1 and records[0].exc_info is None
    assert re.fullmatch(rf"assistant_agent_failed failure_kind={kind} error_type=\w+ elapsed_ms=\d+", records[0].getMessage())
    assert request_data["message"] not in records[0].getMessage()
