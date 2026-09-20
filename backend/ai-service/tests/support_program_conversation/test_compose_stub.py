import importlib.util
from copy import deepcopy
from io import BytesIO
from pathlib import Path

import httpx2
import pytest
from tests.langchain_stub import chat_model
from openai import AsyncOpenAI

from app.support_program_conversation.agent import SupportProgramConversationAgent
from app.support_program_conversation.models import SupportProgramConversationRequest
from app.support_program_conversation.service import SupportProgramConversationService


@pytest.mark.anyio
@pytest.mark.parametrize("message,status,fields", [
    ("부산으로 변경", "READY", ["REGION"]),
    ("지원금 위주", "READY", ["QUERY", "SUPPORT_PURPOSE"]),
    ("사업화 말고 수출 지원으로 바꿔줘", "READY", ["QUERY", "SUPPORT_PURPOSE"]),
    ("사업화 지원을 찾고 싶어요", "READY", ["QUERY"]),
    ("지역 조건 삭제", "READY", ["REGION"]),
    ("전체 초기화", "CLARIFICATION_REQUIRED", ["QUERY", "REGION", "INDUSTRY", "ESTABLISHED_ON", "SUPPORT_PURPOSE", "ACCEPTING_ONLY"]),
    ("설립 2년", "CLARIFICATION_REQUIRED", []),
    ("부산이나 대구로", "CLARIFICATION_REQUIRED", []),
    ("2024-01-01", "READY", ["ESTABLISHED_ON"]),
])
async def test_actual_compose_stub_through_sdk_and_service(request_data, monkeypatch, message, status, fields):
    stub_path = Path(__file__).resolve().parents[4] / "infrastructure/stubs/openai/server.py"
    spec = importlib.util.spec_from_file_location("conversation_compose_stub", stub_path)
    stub = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(stub)
    request_data["message"] = message
    if message == "2024-01-01":
        draft = deepcopy(request_data["context"])
        draft["companyConditions"]["region"] = "부산"
        request_data["pendingClarification"] = {"question": "정확한 설립일은?", "draftContext": draft}
    calls = []
    def handle(http_request):
        calls.append(http_request)
        handler = object.__new__(stub.Handler)
        handler.path = http_request.url.path
        handler.headers = {"Content-Length": str(len(http_request.content))}
        handler.rfile = BytesIO(http_request.content)
        responses = []
        monkeypatch.setattr(handler, "respond", lambda code, body: responses.append(httpx2.Response(code, json=body)))
        handler.do_POST()
        assert len(responses) == 1
        return responses[0]
    client = AsyncOpenAI(api_key="test-key", base_url="https://openai.test/v1/", max_retries=0,
                         http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(handle)))
    agent = SupportProgramConversationAgent(model=chat_model(model="gpt-5.6-luna", openai_client=client),
                                             model_timeout_seconds=4, run_timeout_seconds=5)
    try:
        result = await SupportProgramConversationService(agent).interpret(SupportProgramConversationRequest.model_validate(request_data))
    finally:
        await client.close()
    assert result.status == status
    assert [update.field for update in result.updates] == fields
    if message == "지원금 위주":
        assert {update.field: update.value for update in result.updates} == {
            "QUERY": "사업화 지원금", "SUPPORT_PURPOSE": "지원금",
        }
    if message == "사업화 말고 수출 지원으로 바꿔줘":
        assert {update.field: update.value for update in result.updates} == {
            "QUERY": "수출 지원", "SUPPORT_PURPOSE": "수출",
        }
    assert len(calls) == 1
