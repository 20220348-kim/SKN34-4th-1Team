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
    ("duckduckgo에 관해 자세히 말해줘", "ANSWERED", []),
    ("지금부터 반말로 안내해", "ANSWERED", []),
    ("왜 못찾아?", "ANSWERED", []),
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
    if status == "ANSWERED":
        request_data["lastSearch"] = {"context": deepcopy(request_data["context"]), "resultCount": 0}
        request_data["pendingProposal"] = deepcopy(request_data["context"])
    before = deepcopy(request_data)
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
        service = SupportProgramConversationService(agent)
        request = SupportProgramConversationRequest.model_validate(request_data)
        result = await service.interpret(request)
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
    if status == "ANSWERED":
        # 고정 스텁의 코드 전달과 서버 출력만 검증하며 실제 모델의 분류 품질을 측정하지 않는다.
        assert service._merge_context(request, result) == request.pending_proposal
        assert request_data == before
        assert result.clarification_question is None
        assert result.answer == (
            "직전에 완료된 검색에서 반환된 공고는 0건입니다. "
            "현재 정보만으로 결과가 없는 원인을 단정할 수 없습니다. "
            "원하시면 검색어, 지역 또는 접수 상태 조건을 조정해 주세요."
            if message == "왜 못찾아?" else
            "이 대화에서는 지원사업 검색과 검색 조건 안내만 도와드릴 수 있습니다. "
            "찾으시는 지원사업이나 필요한 지원 내용을 알려 주세요."
        )
    assert len(calls) == 1
