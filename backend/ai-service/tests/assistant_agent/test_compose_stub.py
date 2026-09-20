"""실제 ChatOpenAI(Responses API)와 Compose 스텁 서버 사이의 요청·응답 형식을 검증한다. 모델은 부르지 않는다."""

import importlib.util
from io import BytesIO
from pathlib import Path

import httpx2
import pytest
from langchain_openai import ChatOpenAI

from app.assistant_agent.graph import build_assistant_agent_graph
from app.assistant_agent.models import AssistantAgentRequest
from app.assistant_agent.retriever import RetrievedChunk
from app.assistant_agent.service import AssistantAgentService
from app.assistant_agent.tools import CoreToolClient
from hashlib import sha256

from tests.assistant_agent.fakes import FakeCoreTools, FakeRetriever


def load_stub():
    stub_path = Path(__file__).resolve().parents[4] / "infrastructure/stubs/openai/server.py"
    spec = importlib.util.spec_from_file_location("assistant_agent_compose_stub", stub_path)
    stub = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(stub)
    return stub


def chat_model(stub, monkeypatch, calls: list, *, model: str, effort: str) -> ChatOpenAI:
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

    return ChatOpenAI(
        model=model, api_key="test-key", base_url="https://openai.test/v1/", use_responses_api=True, store=False,
        reasoning={"effort": effort}, timeout=4, max_retries=0,
        http_async_client=httpx2.AsyncClient(transport=httpx2.MockTransport(handle)),
    )


@pytest.mark.anyio
@pytest.mark.parametrize("message,intent,card_kinds,tools", [
    ("나한테 맞는 파트너 모집글 있어?", "PARTNER_MATCH", ["RECRUITMENT", "RECRUITMENT"], ["get_my_company_profile", "search_partner_recruitments"]),
    ("관심 공고 마감 언제야?", "ACCOUNT_STATE", ["PROGRAM", "PROGRAM"], ["list_saved_programs"]),
    ("점수는 무슨 뜻이야?", "PRODUCT_HELP", [], []),
])
async def test_actual_compose_stub_through_langchain_graph(request_data, monkeypatch, message, intent, card_kinds, tools):
    stub = load_stub()
    request_data["message"] = message
    model_calls: list = []
    fake = FakeCoreTools()
    tool_client = CoreToolClient(base_url="http://core-service:8080", secret=fake.secret, timeout_seconds=1, transport=fake.transport())
    graph = build_assistant_agent_graph(
        classify_model=chat_model(stub, monkeypatch, model_calls, model="gpt-5-nano", effort="low"),
        agent_model=chat_model(stub, monkeypatch, model_calls, model="gpt-5.6-luna", effort="none"),
        tool_client=tool_client, max_tool_calls=3, retriever=FakeRetriever(),
    )
    try:
        response = await AssistantAgentService(graph=graph, timeout_seconds=10).answer(AssistantAgentRequest.model_validate(request_data))
    finally:
        await tool_client.aclose()
    assert response.intent == intent
    assert [card.kind for card in response.cards] == card_kinds
    assert [call.name for call in response.tool_calls] == tools
    assert all(call.ok for call in response.tool_calls)
    if intent == "PARTNER_MATCH":
        assert {card.id for card in response.cards} == {"21", "22"}
        assert response.navigation.to == "/app/partners"
        # 분류 1 + 계획 3(프로필·모집글·READY) + 답 1
        assert len(model_calls) == 5
    if intent == "PRODUCT_HELP":
        assert response.citations == ["search-score-meaning"]
        assert len(model_calls) == 1
    # 모든 모델 요청은 Responses API이며 계정 토큰은 어디에도 없다.
    for call in model_calls:
        assert call.url.path == "/v1/responses"
        assert b"7.1900000000.sig" not in call.content
        assert b"toolToken" not in call.content


@pytest.mark.anyio
async def test_actual_compose_stub_runs_the_saved_programs_subgraph(request_data, monkeypatch):
    stub = load_stub()
    text = "신청방법: 기업마당 온라인 신청 후 사업계획서를 제출합니다."
    chunk_id, content_hash = sha256(b"chunk-1").hexdigest(), sha256(text.encode("utf-8")).hexdigest()
    document_id = "BIZINFO:PBLN_000000000000001"
    request_data["message"] = "내가 담은 공고 중 온라인으로 접수하는 건 어떤 거야?"
    request_data["resumeIntent"] = "SAVED_PROGRAMS_QUESTION"
    request_data["savedProgramDocuments"] = [
        {"sourceCode": "BIZINFO", "sourceProgramId": "PBLN_000000000000001", "title": "서울 AI 실증 지원사업", "applicationEndDate": "2026-09-30",
         "documentId": document_id, "chunks": [{"id": chunk_id, "contentHash": content_hash}]},
        {"sourceCode": "BIZINFO", "sourceProgramId": "PBLN_000000000000002", "title": "경기 데이터 바우처", "applicationEndDate": None,
         "documentId": "BIZINFO:PBLN_000000000000002", "chunks": []},
    ]
    model_calls: list = []
    fake = FakeCoreTools()
    tool_client = CoreToolClient(base_url="http://core-service:8080", secret=fake.secret, timeout_seconds=1, transport=fake.transport())
    graph = build_assistant_agent_graph(
        classify_model=chat_model(stub, monkeypatch, model_calls, model="gpt-5-nano", effort="low"),
        agent_model=chat_model(stub, monkeypatch, model_calls, model="gpt-5.6-luna", effort="none"),
        tool_client=tool_client, max_tool_calls=3,
        retriever=FakeRetriever({document_id: [RetrievedChunk(chunk_id, content_hash, 0, text, 0.9)]}),
    )
    try:
        response = await AssistantAgentService(graph=graph, timeout_seconds=10).answer(AssistantAgentRequest.model_validate(request_data))
    finally:
        await tool_client.aclose()
    assert response.intent == "SAVED_PROGRAMS_QUESTION" and response.needs_documents is False
    assert "1건이 질문에 해당" in response.answer and "1건은 원문을 확인하지 못했어요" in response.answer
    assert [card.id for card in response.cards] == [document_id]
    assert response.cards[0].quote == text[:200]
    assert response.cards[0].to == "/app/support-programs/detail?sourceCode=BIZINFO&sourceProgramId=PBLN_000000000000001"
    # map 1(청크 있는 공고만) + reduce 1. 분류는 건너뛴다.
    assert len(model_calls) == 2
