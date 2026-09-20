import json
import logging
import re

import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from app.assistant_agent.errors import AssistantAgentError, AssistantAgentTimeoutError
from app.assistant_agent.graph import build_assistant_agent_graph
from app.assistant_agent.models import SCHEMA_VERSION, AssistantAgentRequest
from app.assistant_agent.nodes.verify import NO_COMPANY_ANSWER, TOOL_FAILURE_ANSWER
from app.assistant_agent.service import AssistantAgentService
from app.assistant_agent.tools import CoreToolClient
from tests.assistant_agent.fakes import HANG, FakeCoreTools, FakeRetriever, ScriptedChatModel, tool_call_message


PROFILE_CALL = ("get_my_company_profile", {})
SEARCH_CALL = ("search_partner_recruitments", {"region": "서울", "seekingRole": "PARTICIPANT"})
READY = AIMessage(content="READY", usage_metadata={"input_tokens": 50, "output_tokens": 2, "total_tokens": 52})


def partner_answer(*ids: str, navigation: str = "PARTNERS") -> dict:
    return {
        "answer": "지역과 역할이 맞는 모집글을 찾았어요. 카드에서 상세를 확인해 보세요.",
        "cards": [{"kind": "RECRUITMENT", "id": identifier, "reason": "서울 참여기관 모집이고 라벨링 역량이 맞습니다."} for identifier in ids],
        "navigation": navigation,
    }


class Harness:
    def __init__(self, *, classify: list, agent: list, max_tool_calls: int = 3, timeout: float = 5, fake: FakeCoreTools | None = None) -> None:
        self.fake = fake or FakeCoreTools()
        self.classify_model = ScriptedChatModel(responses=classify)
        self.agent_model = ScriptedChatModel(responses=agent)
        self.client = CoreToolClient(base_url="http://core-service:8080", secret=self.fake.secret, timeout_seconds=1, transport=self.fake.transport())
        self.retriever = FakeRetriever()
        graph = build_assistant_agent_graph(
            classify_model=self.classify_model, agent_model=self.agent_model, tool_client=self.client, max_tool_calls=max_tool_calls,
            retriever=self.retriever,
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


@pytest.mark.anyio
async def test_partner_match_runs_profile_then_search_then_answers_with_verified_cards(request_data, empty_classification, caplog):
    harness = Harness(
        classify=[{**empty_classification, "intent": "PARTNER_MATCH"}],
        agent=[tool_call_message(PROFILE_CALL), tool_call_message(SEARCH_CALL), READY, partner_answer("21")],
    )
    with caplog.at_level(logging.INFO, logger="app.assistant_agent"):
        response = await harness.run(request_data)
    harness.assert_complete()

    assert response.intent == "PARTNER_MATCH"
    assert response.answer.startswith("지역과 역할이 맞는")
    assert [card.model_dump() for card in response.cards] == [{
        "kind": "RECRUITMENT", "id": "21", "title": "AI 실증 참여기관 구합니다", "subtitle": "서울AI 주식회사 · 서울 · 2026-09-20",
        "reason": "서울 참여기관 모집이고 라벨링 역량이 맞습니다.", "quote": None, "to": "/app/partners/detail?recruitmentId=21",
    }]
    assert response.navigation.model_dump() == {"label": "파트너 모집 열기", "to": "/app/partners"}
    assert [(call.name, call.ok) for call in response.tool_calls] == [("get_my_company_profile", True), ("search_partner_recruitments", True)]
    assert all(call.ms >= 0 for call in response.tool_calls)
    # Core는 공유 비밀과 계정 토큰이 붙은 요청만 받았다.
    assert [request.url.path.rsplit("/", 1)[1] for request in harness.fake.requests] == ["company-profile", "recruitments"]
    assert dict(harness.fake.requests[1].url.params) == {"accountId": "7", "region": "서울", "seekingRole": "PARTICIPANT"}
    # 계획 모델은 세 도구를 묶어 받았고, 두 번째 계획부터 이전 도구 결과를 대화로 봤다.
    assert harness.agent_model.bound_tool_names == [["get_my_company_profile", "search_partner_recruitments", "list_saved_programs"]] * 3
    second_plan = harness.agent_model.calls[1]
    assert isinstance(second_plan[0], SystemMessage) and isinstance(second_plan[1], HumanMessage)
    assert [type(message) for message in second_plan[2:]] == [AIMessage, ToolMessage]
    assert json.loads(second_plan[3].content)["companyName"] == "데이터브릿지 주식회사"
    # 답 모델은 도구 결과만 data로 받았다.
    answer_payload = json.loads(harness.agent_model.calls[3][1].content)
    assert answer_payload["step"] == "answer" and answer_payload["intent"] == "PARTNER_MATCH"
    assert [item["id"] for item in answer_payload["data"]["recruitments"]] == [21]
    assert answer_payload["data"]["companyProfile"]["registered"] is True
    # 어떤 모델 호출에도 토큰·계정 번호가 실리지 않았다.
    for call in harness.classify_model.calls + harness.agent_model.calls:
        for message in call:
            assert "7.1900000000.sig" not in str(message.content)
            assert "toolToken" not in str(message.content)
    record = next(record for record in caplog.records if record.name == "app.assistant_agent.service")
    assert re.fullmatch(
        r"assistant_agent_run outcome=completed intent=PARTNER_MATCH model_calls=5 tool_calls=2 tool_failures=0 "
        r"answer_attempts=1 input_tokens=\d+ output_tokens=\d+ elapsed_ms=\d+", record.getMessage(),
    )
    assert request_data["message"] not in record.getMessage()


@pytest.mark.anyio
@pytest.mark.parametrize("classification", [
    {"intent": "PRODUCT_HELP", "answer": "점수는 관련도입니다.", "citations": ["search-score-meaning"]},
    {"intent": "SEARCH", "searchQuery": "서울 제조업 R&D 지원"},
    {"intent": "OUT_OF_SCOPE", "answer": "세무 대행은 할 수 없어요."},
    {"intent": "UNCLEAR", "clarificationQuestion": "사용법인가요, 검색인가요?"},
    {"intent": "PROGRAM_QUESTION"},
    {"intent": "ACCOUNT_STATE", "accountTopic": "RECEIVED_PROPOSALS"},
])
async def test_intents_without_tools_finish_after_one_classification_call(request_data, empty_classification, classification):
    harness = Harness(classify=[{**empty_classification, **classification}], agent=[])
    response = await harness.run(request_data)
    harness.assert_complete()
    assert response.model_dump(by_alias=True) == {
        "schemaVersion": SCHEMA_VERSION, **empty_classification, **classification, "cards": [], "navigation": None, "toolCalls": [],
        "needsDocuments": False,
    }
    assert harness.fake.requests == []
    payload = json.loads(harness.classify_model.calls[0][1].content)
    assert payload["schemaVersion"] == SCHEMA_VERSION and payload["step"] == "classify"
    assert [entry["id"] for entry in payload["helpEntries"]] == ["search-score-meaning", "partner-write-requires-company"]


@pytest.mark.anyio
async def test_anonymous_tool_intent_returns_the_classification_only(request_data, empty_classification):
    request_data["principal"] = None
    request_data["session"] = {"authenticated": False, "hasCompany": False}
    harness = Harness(classify=[{**empty_classification, "intent": "PARTNER_MATCH"}], agent=[])
    response = await harness.run(request_data)
    harness.assert_complete()
    assert response.intent == "PARTNER_MATCH" and response.answer is None and response.cards == [] and response.tool_calls == []


@pytest.mark.anyio
async def test_partner_match_without_a_company_answers_deterministically(request_data, empty_classification):
    request_data["principal"]["hasCompany"] = False
    request_data["session"]["hasCompany"] = False
    harness = Harness(classify=[{**empty_classification, "intent": "PARTNER_MATCH"}], agent=[])
    response = await harness.run(request_data)
    harness.assert_complete()
    assert response.answer == NO_COMPANY_ANSWER
    assert response.navigation.to == "/app/profile"
    assert harness.fake.requests == []


@pytest.mark.anyio
async def test_account_state_uses_saved_programs_tool_and_program_cards(request_data, empty_classification):
    request_data["message"] = "관심 공고 마감 언제야?"
    harness = Harness(
        classify=[{**empty_classification, "intent": "ACCOUNT_STATE", "accountTopic": "SAVED_PROGRAMS"}],
        agent=[
            tool_call_message(("list_saved_programs", {})), READY,
            {"answer": "관심 공고 두 건 중 서울 AI 실증 지원사업이 9월 30일에 마감돼요.",
             "cards": [{"kind": "PROGRAM", "id": "BIZINFO:PBLN_000000000000001", "reason": "가장 빨리 마감됩니다."}], "navigation": "SAVED_PROGRAMS"},
        ],
    )
    response = await harness.run(request_data)
    harness.assert_complete()
    assert response.intent == "ACCOUNT_STATE" and response.account_topic == "SAVED_PROGRAMS"
    assert response.cards[0].to == "/app/support-programs/detail?sourceCode=BIZINFO&sourceProgramId=PBLN_000000000000001"
    assert response.cards[0].subtitle == "서울경제진흥원 · 2026-09-30"
    assert response.navigation.to == "/app/saved-programs"


@pytest.mark.anyio
async def test_tool_failure_is_reported_and_the_answer_is_degraded_without_cards(request_data, empty_classification, caplog):
    fake = FakeCoreTools()
    fake.fail_with = 401
    harness = Harness(
        classify=[{**empty_classification, "intent": "PARTNER_MATCH"}],
        agent=[tool_call_message(PROFILE_CALL), {"answer": "지금은 기업 정보를 확인하지 못했어요.", "cards": [], "navigation": "PARTNERS"}],
        fake=fake,
    )
    with caplog.at_level(logging.WARNING, logger="app.assistant_agent"):
        response = await harness.run(request_data)
    harness.assert_complete()
    assert [(call.name, call.ok) for call in response.tool_calls] == [("get_my_company_profile", False)]
    assert response.answer == "지금은 기업 정보를 확인하지 못했어요." and response.cards == []
    # 실패한 도구 뒤에는 다시 계획하지 않고 바로 답했다.
    assert len(harness.agent_model.calls) == 2
    assert json.loads(harness.agent_model.calls[1][1].content)["data"]["errors"] == ["get_my_company_profile"]
    warnings = [record.getMessage() for record in caplog.records if record.levelno == logging.WARNING]
    assert warnings == ["assistant_agent_tool_failed name=get_my_company_profile error_type=ToolCallError"]


@pytest.mark.anyio
async def test_unknown_card_id_triggers_one_regeneration_then_degrades(request_data, empty_classification):
    harness = Harness(
        classify=[{**empty_classification, "intent": "PARTNER_MATCH"}],
        agent=[tool_call_message(PROFILE_CALL, SEARCH_CALL), READY, partner_answer("999"), partner_answer("999", "21")],
    )
    response = await harness.run(request_data)
    harness.assert_complete()
    assert response.answer.startswith("지역과 역할이 맞는") and response.cards == []
    assert response.navigation.to == "/app/partners"
    assert len(harness.agent_model.calls) == 4


@pytest.mark.anyio
async def test_regeneration_succeeds_when_the_second_answer_is_valid(request_data, empty_classification):
    harness = Harness(
        classify=[{**empty_classification, "intent": "PARTNER_MATCH"}],
        agent=[tool_call_message(PROFILE_CALL, SEARCH_CALL), READY, {"answer": "답", "cards": [], "navigation": "NOWHERE"}, partner_answer("21")],
    )
    response = await harness.run(request_data)
    harness.assert_complete()
    assert [card.id for card in response.cards] == ["21"]
    assert len(harness.agent_model.calls) == 4


@pytest.mark.anyio
async def test_unparsable_answer_twice_falls_back_to_the_failure_text(request_data, empty_classification):
    harness = Harness(
        classify=[{**empty_classification, "intent": "PARTNER_MATCH"}],
        agent=[tool_call_message(PROFILE_CALL, SEARCH_CALL), READY, {"answer": "", "cards": [], "navigation": "NONE"}, {"nope": True}],
    )
    response = await harness.run(request_data)
    harness.assert_complete()
    assert response.answer == TOOL_FAILURE_ANSWER and response.cards == []
    assert response.navigation.to == "/app/partners"


@pytest.mark.anyio
async def test_duplicate_and_unknown_tool_calls_are_dropped(request_data, empty_classification):
    harness = Harness(
        classify=[{**empty_classification, "intent": "PARTNER_MATCH"}],
        agent=[
            # 같은 호출 반복·모르는 도구는 잘린다: 2건만 실행된다.
            tool_call_message(PROFILE_CALL, PROFILE_CALL, ("delete_everything", {}), SEARCH_CALL),
            # 이미 부른 것만 또 부르면 실행할 게 없어 바로 답으로 간다.
            tool_call_message(SEARCH_CALL),
            partner_answer("21"),
        ],
    )
    response = await harness.run(request_data)
    harness.assert_complete()
    assert [call.name for call in response.tool_calls] == ["get_my_company_profile", "search_partner_recruitments"]
    assert len(harness.fake.requests) == 2
    assert len(harness.agent_model.calls) == 3
    # 대화에는 실제로 실행한 호출만 남아 ToolMessage와 짝이 맞는다.
    third_plan = harness.agent_model.calls[1]
    assert [call["name"] for call in third_plan[2].tool_calls] == ["get_my_company_profile", "search_partner_recruitments"]
    assert [type(message) for message in third_plan[3:]] == [ToolMessage, ToolMessage]


@pytest.mark.anyio
async def test_tool_call_budget_stops_planning_and_answers_with_what_was_collected(request_data, empty_classification):
    harness = Harness(
        classify=[{**empty_classification, "intent": "PARTNER_MATCH"}],
        agent=[tool_call_message(PROFILE_CALL, SEARCH_CALL), {"answer": "기업 정보만 확인했어요. 파트너 모집 화면에서 직접 찾아보세요.", "cards": [], "navigation": "PARTNERS"}],
        max_tool_calls=1,
    )
    response = await harness.run(request_data)
    harness.assert_complete()
    assert [call.name for call in response.tool_calls] == ["get_my_company_profile"]
    assert len(harness.fake.requests) == 1
    # 상한에 닿으면 다시 계획하지 않고 바로 답한다.
    assert len(harness.agent_model.calls) == 2


@pytest.mark.anyio
async def test_classification_citing_an_unknown_help_entry_is_an_error(request_data, empty_classification):
    harness = Harness(classify=[{**empty_classification, "intent": "PRODUCT_HELP", "answer": "답", "citations": ["private-entry"]}], agent=[])
    with pytest.raises(AssistantAgentError):
        await harness.run(request_data)


@pytest.mark.anyio
async def test_unparsable_classification_is_an_error(request_data):
    harness = Harness(classify=[{"intent": "PARTNER_MATCH"}], agent=[])
    with pytest.raises(AssistantAgentError):
        await harness.run(request_data)


@pytest.mark.anyio
async def test_overall_deadline_is_a_timeout_error(request_data, empty_classification):
    harness = Harness(classify=[{**empty_classification, "intent": "PARTNER_MATCH"}], agent=[HANG], timeout=0.05)
    with pytest.raises(AssistantAgentTimeoutError):
        await harness.run(request_data)


@pytest.mark.anyio
async def test_model_transport_errors_become_agent_errors(request_data):
    harness = Harness(classify=[RuntimeError("private upstream detail")], agent=[])
    with pytest.raises(AssistantAgentError) as info:
        await harness.run(request_data)
    assert "private" not in str(info.value)
