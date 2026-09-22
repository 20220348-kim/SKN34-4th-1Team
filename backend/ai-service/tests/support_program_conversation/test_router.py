import asyncio
import json
import logging
import re

import pytest
from tests.langchain_stub import ResponsesChatStub, response_message
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.support_program_conversation.agent import SupportProgramConversationAgent
from app.support_program_conversation.models import SCHEMA_VERSION


SETTINGS = Settings(openai_api_key="test-key-never-sent", openai_model="test-model",
                    llm_model_timeout_seconds=1, llm_run_timeout_seconds=2)
PATH = "/internal/v1/support-program-conversation/interpret"


def test_http_to_service_to_agent_to_response(request_data, output_data):
    model = ResponsesChatStub([[response_message(json.dumps(output_data, ensure_ascii=False))]])
    agent = SupportProgramConversationAgent(model=model.model, model_timeout_seconds=1, run_timeout_seconds=2)
    with TestClient(create_app(settings=SETTINGS, support_program_conversation_agent=agent)) as client:
        response = client.post(PATH, json=request_data)
    assert response.status_code == 200
    assert response.json() == {"schemaVersion": SCHEMA_VERSION, "status": "READY",
        "updates": output_data["updates"], "answer": None, "clarificationQuestion": None}
    assert "proposedContext" not in response.json()
    assert len(model.calls) == 1


@pytest.mark.parametrize("mutation", [{"message": " "}, {"schemaVersion": "v0"}, {"history": []}, {"referenceDate": "2026-02-30"}])
def test_invalid_internal_request_keeps_existing_fastapi_422_policy(request_data, mutation):
    request_data.update(mutation)
    model = ResponsesChatStub([])
    agent = SupportProgramConversationAgent(model=model.model, model_timeout_seconds=1, run_timeout_seconds=2)
    with TestClient(create_app(settings=SETTINGS, support_program_conversation_agent=agent)) as client:
        response = client.post(PATH, json=request_data)
    assert response.status_code == 422
    assert not model.calls


@pytest.mark.parametrize("kind", ["invalid_json", "fabricated_evidence", "missing_query"])
def test_invalid_upstream_output_returns_safe_503_without_search(request_data, output_data, kind, caplog):
    if kind == "fabricated_evidence":
        output_data["updates"][0]["evidence"] = "private fabricated text"
    if kind == "missing_query":
        request_data["context"]["query"] = None
    output = "private non-json output" if kind == "invalid_json" else json.dumps(output_data)
    model = ResponsesChatStub([[response_message(output)]])
    agent = SupportProgramConversationAgent(model=model.model, model_timeout_seconds=1, run_timeout_seconds=2)
    with TestClient(create_app(settings=SETTINGS, support_program_conversation_agent=agent)) as client:
        response = client.post(PATH, json=request_data)
    assert response.status_code == 503
    assert response.json() == {"detail": "Support program conversation interpretation is temporarily unavailable."}
    assert "private" not in response.text
    assert len(model.calls) == 1
    records = [record for record in caplog.records if record.name.endswith("support_program_conversation.router")]
    assert len(records) == 1
    record = records[0]
    assert record.levelno == logging.WARNING
    assert record.exc_info is None
    assert re.fullmatch(r"support_program_conversation_failed failure_kind=execution error_type=\w+ elapsed_ms=\d+", record.getMessage())
    assert "private" not in record.getMessage()
    assert request_data["message"] not in record.getMessage()


@pytest.mark.parametrize("deadline", ["model", "run"])
def test_deadline_returns_safe_504_and_sanitized_timing_without_retry(request_data, deadline, caplog):
    async def hang_forever(_):
        await asyncio.Event().wait()
        return []
    model = ResponsesChatStub([(hang_forever)])
    agent = SupportProgramConversationAgent(model=model.model,
        model_timeout_seconds=0.1 if deadline == "model" else 1,
        run_timeout_seconds=1 if deadline == "model" else 0.01)
    with TestClient(create_app(settings=SETTINGS, support_program_conversation_agent=agent)) as client:
        response = client.post(PATH, json=request_data)
    assert response.status_code == 504
    assert response.json() == {"detail": "Support program conversation interpretation timed out."}
    assert len(model.calls) <= 1 if deadline == "run" else len(model.calls) == 1
    records = [record for record in caplog.records if record.name.endswith("support_program_conversation.router")]
    assert len(records) == 1
    record = records[0]
    cause = "TimeoutError"
    assert re.fullmatch(rf"support_program_conversation_failed failure_kind=timeout error_type={cause} elapsed_ms=\d+", record.getMessage())
    assert record.exc_info is None
    assert request_data["message"] not in record.getMessage()


def test_http_answered_keeps_completed_search_distinct_from_pending_proposal(request_data):
    request_data["message"] = "왜 못 찾아?"
    request_data["pendingProposal"] = {
        **request_data["context"],
        "companyConditions": {**request_data["context"]["companyConditions"], "region": "서울"},
    }
    request_data["lastSearch"] = {"context": {
        **request_data["context"],
        "companyConditions": {**request_data["context"]["companyConditions"], "region": "대구"},
    }, "resultCount": 0}
    output = {
        "status": "ANSWERED", "updates": [], "answerKind": "RESULT_SUMMARY", "clarificationKind": None,
    }
    model = ResponsesChatStub([[response_message(json.dumps(output, ensure_ascii=False))]])
    agent = SupportProgramConversationAgent(model=model.model, model_timeout_seconds=1, run_timeout_seconds=2)
    with TestClient(create_app(settings=SETTINGS, support_program_conversation_agent=agent)) as client:
        response = client.post(PATH, json=request_data)
    assert response.status_code == 200
    assert response.json() == {"schemaVersion": SCHEMA_VERSION, "status": "ANSWERED",
        "updates": [], "clarificationQuestion": None,
        "answer": "직전에 완료된 검색에서 반환된 공고는 0건입니다. "
                  "현재 정보만으로 결과가 없는 원인을 단정할 수 없습니다. "
                  "원하시면 검색어, 지역 또는 접수 상태 조건을 조정해 주세요."}
    assert json.loads(model.first_call.input[0]["content"]) == request_data
    assert len(model.calls) == 1


@pytest.mark.parametrize("mutation", [
    {"lastSearch": {"context": {}, "resultCount": 0}},
    {"lastSearch": {"context": None, "resultCount": True}},
    {"pendingProposal": {}},
])
def test_invalid_new_context_never_calls_model(request_data, mutation):
    request_data.update(mutation)
    model = ResponsesChatStub([])
    agent = SupportProgramConversationAgent(model=model.model, model_timeout_seconds=1, run_timeout_seconds=2)
    with TestClient(create_app(settings=SETTINGS, support_program_conversation_agent=agent)) as client:
        response = client.post(PATH, json=request_data)
    assert response.status_code == 422
    assert not model.calls
