import json
from hashlib import sha256

import pytest

from app.assistant_agent.errors import AssistantAgentError
from app.assistant_agent.graph import build_assistant_agent_graph
from app.assistant_agent.models import SCHEMA_VERSION, AssistantAgentRequest, SavedProgramDocument
from app.assistant_agent.nodes.verify import TOOL_FAILURE_ANSWER
from app.assistant_agent.retriever import RetrievedChunk
from app.assistant_agent.service import AssistantAgentService
from app.assistant_agent.tools import CoreToolClient
from tests.assistant_agent.fakes import FakeCoreTools, FakeRetriever, ScriptedChatModel


def chunk_ref(document_id: str, order: int, text: str) -> tuple[dict, RetrievedChunk]:
    chunk_id = sha256(f"{document_id}:{order}".encode()).hexdigest()
    content_hash = sha256(text.encode("utf-8")).hexdigest()
    return {"id": chunk_id, "contentHash": content_hash}, RetrievedChunk(chunk_id, content_hash, order, text, 0.9 - order * 0.1)


SEOUL = "BIZINFO:PBLN_000000000000001"
GYEONGGI = "BIZINFO:PBLN_000000000000002"
BUSAN = "BIZINFO:PBLN_000000000000003"
SEOUL_REF, SEOUL_CHUNK = chunk_ref(SEOUL, 0, "신청방법: 기업마당 온라인 신청 후 사업계획서를 제출합니다.")
SEOUL_REF2, SEOUL_CHUNK2 = chunk_ref(SEOUL, 1, "제출서류: 사업계획서, 사업자등록증 사본.")
GYEONGGI_REF, GYEONGGI_CHUNK = chunk_ref(GYEONGGI, 0, "신청방법: 방문 접수만 가능합니다.")


def documents() -> list[dict]:
    return [
        {"sourceCode": "BIZINFO", "sourceProgramId": "PBLN_000000000000001", "title": "서울 AI 실증 지원사업", "applicationEndDate": "2026-09-30",
         "documentId": SEOUL, "chunks": [SEOUL_REF, SEOUL_REF2]},
        {"sourceCode": "BIZINFO", "sourceProgramId": "PBLN_000000000000002", "title": "경기 데이터 바우처", "applicationEndDate": None,
         "documentId": GYEONGGI, "chunks": [GYEONGGI_REF]},
        {"sourceCode": "BIZINFO", "sourceProgramId": "PBLN_000000000000003", "title": "부산 창업 지원", "applicationEndDate": "2026-10-15",
         "documentId": BUSAN, "chunks": []},
    ]


def finding(verdict: str, value: str | None = None, quote: str | None = None, confidence: str = "HIGH") -> dict:
    return {"verdict": verdict, "value": value, "quote": quote, "confidence": confidence}


def reduce_output(*document_ids: str, answer: str = "관심 공고 3건 중 1건이 온라인으로 접수해요. 부산 창업 지원은 원문을 확인하지 못했어요.") -> dict:
    return {"answer": answer, "cards": [{"documentId": identifier, "reason": "온라인 접수로 확인됐어요."} for identifier in document_ids], "navigation": "SAVED_PROGRAMS"}


class Harness:
    def __init__(self, *, classify: list, agent: list, retriever: FakeRetriever | None = None, timeout: float = 5) -> None:
        self.fake = FakeCoreTools()
        self.classify_model = ScriptedChatModel(responses=classify)
        self.agent_model = ScriptedChatModel(responses=agent)
        self.retriever = retriever or FakeRetriever({SEOUL: [SEOUL_CHUNK, SEOUL_CHUNK2], GYEONGGI: [GYEONGGI_CHUNK]})
        self.client = CoreToolClient(base_url="http://core-service:8080", secret=self.fake.secret, timeout_seconds=1, transport=self.fake.transport())
        graph = build_assistant_agent_graph(
            classify_model=self.classify_model, agent_model=self.agent_model, tool_client=self.client, max_tool_calls=3, retriever=self.retriever,
        )
        self.service = AssistantAgentService(graph=graph, timeout_seconds=timeout)

    async def run(self, request_data: dict):
        try:
            return await self.service.answer(AssistantAgentRequest.model_validate(request_data))
        finally:
            await self.client.aclose()

    def assert_complete(self) -> None:
        self.classify_model.assert_complete()
        self.agent_model.assert_complete()


@pytest.fixture
def saved_question(request_data):
    request_data["message"] = "내가 담은 공고 중 온라인으로 접수하는 건 어떤 거야?"
    return request_data


@pytest.mark.anyio
async def test_first_call_without_documents_asks_core_for_them(saved_question, empty_classification):
    harness = Harness(classify=[{**empty_classification, "intent": "SAVED_PROGRAMS_QUESTION"}], agent=[])
    response = await harness.run(saved_question)
    harness.assert_complete()
    assert response.intent == "SAVED_PROGRAMS_QUESTION"
    assert response.needs_documents is True
    assert response.answer is None and response.cards == [] and response.tool_calls == []
    assert harness.retriever.calls == []
    assert harness.fake.requests == []


@pytest.mark.anyio
async def test_second_call_resumes_without_classifying_and_answers_with_verified_quotes(saved_question, empty_classification):
    saved_question["savedProgramDocuments"] = documents()
    saved_question["resumeIntent"] = "SAVED_PROGRAMS_QUESTION"
    # map: 서울(YES, 인용은 청크 원문 그대로), 경기(NO). 부산은 청크가 없어 모델을 부르지 않는다.
    harness = Harness(
        classify=[finding("YES", "온라인 신청", "기업마당 온라인 신청"), finding("NO", "방문 접수", "방문 접수만 가능합니다.")],
        agent=[reduce_output(SEOUL)],
    )
    response = await harness.run(saved_question)
    harness.assert_complete()

    assert response.intent == "SAVED_PROGRAMS_QUESTION" and response.needs_documents is False
    assert response.answer.startswith("관심 공고 3건 중 1건")
    assert [card.model_dump() for card in response.cards] == [{
        "kind": "PROGRAM", "id": SEOUL, "title": "서울 AI 실증 지원사업", "subtitle": "2026-09-30 마감", "reason": "온라인 접수로 확인됐어요.",
        "quote": "기업마당 온라인 신청", "to": "/app/support-programs/detail?sourceCode=BIZINFO&sourceProgramId=PBLN_000000000000001",
    }]
    assert response.navigation.to == "/app/saved-programs"
    assert response.tool_calls == []
    # 검색은 청크가 있는 문서만, 공고당 4개까지.
    assert harness.retriever.calls == [(saved_question["message"], [SEOUL, GYEONGGI, BUSAN], 4)]
    # map 호출은 청크 원문을 받고, reduce는 판단만 받는다(원문 없음).
    map_payloads = [json.loads(call[1].content) for call in harness.classify_model.calls]
    assert [payload["step"] for payload in map_payloads] == ["map", "map"]
    assert map_payloads[0]["chunks"][0]["text"].startswith("신청방법: 기업마당")
    reduce_payload = json.loads(harness.agent_model.calls[0][1].content)
    assert reduce_payload["step"] == "reduce" and reduce_payload["unfetchedCount"] == 1
    assert [program["fetched"] for program in reduce_payload["programs"]] == [True, True, False]
    assert reduce_payload["programs"][0]["finding"]["verdict"] == "YES"
    assert "text" not in json.dumps(reduce_payload["programs"])
    for call in harness.classify_model.calls + harness.agent_model.calls:
        assert "toolToken" not in str(call[1].content)


@pytest.mark.anyio
async def test_quote_not_found_in_chunks_is_dropped_but_the_card_stays(saved_question, empty_classification):
    saved_question["savedProgramDocuments"] = documents()
    saved_question["resumeIntent"] = "SAVED_PROGRAMS_QUESTION"
    harness = Harness(
        classify=[finding("YES", "온라인 신청", "원문에 없는 문장입니다"), finding("UNKNOWN")],
        agent=[reduce_output(SEOUL)],
    )
    response = await harness.run(saved_question)
    harness.assert_complete()
    assert response.cards[0].quote is None
    assert response.cards[0].reason == "온라인 접수로 확인됐어요."


@pytest.mark.anyio
async def test_unknown_document_id_triggers_one_regeneration_then_degrades(saved_question, empty_classification):
    saved_question["savedProgramDocuments"] = documents()
    saved_question["resumeIntent"] = "SAVED_PROGRAMS_QUESTION"
    harness = Harness(
        classify=[finding("YES", "온라인 신청", "기업마당 온라인 신청"), finding("NO")],
        agent=[reduce_output("BIZINFO:PBLN_999"), reduce_output("BIZINFO:PBLN_999", answer="다시 만든 답이에요.")],
    )
    response = await harness.run(saved_question)
    harness.assert_complete()
    assert response.answer == "다시 만든 답이에요." and response.cards == []
    assert response.navigation.to == "/app/saved-programs"
    assert len(harness.agent_model.calls) == 2


@pytest.mark.anyio
async def test_retrieval_failure_marks_everything_unfetched_without_map_calls(saved_question, empty_classification):
    saved_question["savedProgramDocuments"] = documents()
    saved_question["resumeIntent"] = "SAVED_PROGRAMS_QUESTION"
    harness = Harness(
        classify=[], agent=[reduce_output(answer="지금은 관심 공고 원문을 확인하지 못했어요. 관심 공고함에서 각 공고를 확인해 주세요.")],
        retriever=FakeRetriever(raise_error=RuntimeError("qdrant down")),
    )
    response = await harness.run(saved_question)
    harness.assert_complete()
    assert response.cards == [] and response.answer.startswith("지금은 관심 공고 원문을")
    reduce_payload = json.loads(harness.agent_model.calls[0][1].content)
    assert reduce_payload["retrievalFailed"] is True and reduce_payload["unfetchedCount"] == 3


@pytest.mark.anyio
async def test_unparsable_reduce_twice_falls_back_to_the_failure_text(saved_question, empty_classification):
    saved_question["savedProgramDocuments"] = documents()
    saved_question["resumeIntent"] = "SAVED_PROGRAMS_QUESTION"
    harness = Harness(classify=[finding("YES", "온라인", "기업마당 온라인 신청"), finding("NO")], agent=[{"nope": 1}, {"answer": ""}])
    response = await harness.run(saved_question)
    harness.assert_complete()
    assert response.answer == TOOL_FAILURE_ANSWER and response.cards == []


@pytest.mark.anyio
async def test_map_failure_for_one_program_only_marks_that_program_unknown(saved_question, empty_classification):
    saved_question["savedProgramDocuments"] = documents()
    saved_question["resumeIntent"] = "SAVED_PROGRAMS_QUESTION"
    harness = Harness(classify=[RuntimeError("private map failure"), finding("NO")], agent=[reduce_output()])
    response = await harness.run(saved_question)
    harness.assert_complete()
    reduce_payload = json.loads(harness.agent_model.calls[0][1].content)
    findings = {program["documentId"]: program["finding"] for program in reduce_payload["programs"]}
    assert findings[SEOUL] is None and findings[GYEONGGI]["verdict"] == "NO"
    assert response.cards == []


@pytest.mark.anyio
async def test_anonymous_saved_programs_question_returns_the_classification_only(saved_question, empty_classification):
    saved_question["principal"] = None
    saved_question["session"] = {"authenticated": False, "hasCompany": False}
    harness = Harness(classify=[{**empty_classification, "intent": "SAVED_PROGRAMS_QUESTION"}], agent=[])
    response = await harness.run(saved_question)
    harness.assert_complete()
    assert response.needs_documents is False and response.answer is None


@pytest.mark.parametrize("mutation", [
    {"resumeIntent": "SAVED_PROGRAMS_QUESTION"},
    {"resumeIntent": "PARTNER_MATCH", "savedProgramDocuments": []},
    {"savedProgramDocuments": [{**documents()[0], "documentId": "BIZINFO:OTHER"}]},
    {"savedProgramDocuments": [documents()[0], documents()[0]]},
    {"savedProgramDocuments": [{**documents()[0], "chunks": [SEOUL_REF, SEOUL_REF]}]},
    {"savedProgramDocuments": [{**documents()[0], "chunks": [{"id": "abc", "contentHash": SEOUL_REF["contentHash"]}]}]},
    {"savedProgramDocuments": [dict(documents()[0], sourceProgramId=f"PBLN_{i:015d}", documentId=f"BIZINFO:PBLN_{i:015d}") for i in range(11)]},
    {"principal": None, "session": {"authenticated": False, "hasCompany": False}, "savedProgramDocuments": []},
])
def test_request_rejects_inconsistent_document_payloads(request_data, mutation):
    request_data.update(mutation)
    with pytest.raises(ValueError):
        AssistantAgentRequest.model_validate(request_data)


def test_saved_program_document_fetched_flag():
    document = SavedProgramDocument.model_validate(documents()[2])
    assert document.fetched is False
    assert SavedProgramDocument.model_validate(documents()[0]).fetched is True


@pytest.mark.anyio
async def test_resume_without_documents_is_rejected_by_the_contract(request_data):
    request_data["resumeIntent"] = "SAVED_PROGRAMS_QUESTION"
    with pytest.raises(ValueError):
        AssistantAgentRequest.model_validate(request_data)
    assert SCHEMA_VERSION == "govbiz-assistant-agent-v1"
    assert issubclass(AssistantAgentError, Exception)
