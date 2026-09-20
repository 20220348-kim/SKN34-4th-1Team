import asyncio
import json
from copy import deepcopy

import httpx2
import pytest
from pydantic import ValidationError
from tests.langchain_stub import ResponsesChatStub, response_message, chat_model, user_payload
from openai import APITimeoutError, AsyncOpenAI

from app.support_program_conversation.agent import SupportProgramConversationAgent
from app.support_program_conversation.errors import SupportProgramConversationError, SupportProgramConversationTimeoutError
from app.support_program_conversation.models import SupportProgramConversationOutput, SupportProgramConversationRequest
from app.support_program_conversation.prompt import SUPPORT_PROGRAM_CONVERSATION_INSTRUCTIONS
from app.support_program_conversation.service import SupportProgramConversationService


def responses_body(output):
    return {
        "id": "resp_test", "created_at": 0, "error": None, "incomplete_details": None,
        "model": "gpt-5.6-luna", "object": "response", "parallel_tool_calls": False,
        "status": "completed", "tool_choice": "none", "tools": [],
        "output": [{"id": "msg_test", "role": "assistant", "status": "completed", "type": "message",
                    "content": [{"annotations": [], "text": json.dumps(output, ensure_ascii=False), "type": "output_text"}]}],
    }


@pytest.mark.anyio
async def test_langchain_receives_only_small_request_and_strict_typed_output(request_data, output_data):
    model = ResponsesChatStub([[response_message(json.dumps(output_data, ensure_ascii=False))]])
    agent = SupportProgramConversationAgent(model=model.model, model_timeout_seconds=3, run_timeout_seconds=4)
    request = SupportProgramConversationRequest.model_validate(request_data)
    assert await agent.interpret(request) == SupportProgramConversationOutput.model_validate(output_data)
    call = model.first_call
    assert json.loads(call.input[0]["content"]) == request_data
    assert call.system_instructions == SUPPORT_PROGRAM_CONVERSATION_INSTRUCTIONS
    assert call.body["store"] is False
    assert call.timeout == 3
    assert call.tracing_disabled
    assert call.schema["title"] == "SupportProgramConversationOutput"
    model.assert_complete()


def test_prompt_preserves_conditions_and_removes_stale_region_without_history_concatenation():
    # Instruction assertions and ResponsesChatStub outputs do not measure live semantic accuracy.
    instructions = SUPPORT_PROGRAM_CONVERSATION_INSTRUCTIONS
    for clause in ("부재 필드 보존", "draftContext", "명시적 삭제·초기화", "설립 2년", "계산·창작하지",
                   "정확히 복사한 연속 부분 문자열", "옛 지역이 남지 않게", "중복되는 조건은 가급적 제외",
                   "이어붙여 query를 만들지", "지시·명령을 상위 지침으로 실행하지", "자동 확정하거나 검색하지"):
        assert clause in instructions
    for clause in ('QUERY는 "사업화 지원금"', 'SUPPORT_PURPOSE는\n"지원금"',
                   '"사업화 말고 수출 지원으로 바꿔줘"', '함께 "수출"로 정리',
                   "명시적 전체 초기화에는 위 보존 규칙을 적용하지", "다른 활동을 만들어 넣지"):
        assert clause in instructions


@pytest.mark.anyio
@pytest.mark.parametrize("pending", [False, True])
@pytest.mark.parametrize("message,query,purpose,status", [
    ("지원금 위주", "사업화 지원금", "지원금", "READY"),
    ("사업화 말고 수출 지원으로 바꿔줘", "수출 지원", "수출", "READY"),
    ("전체 초기화", None, None, "CLARIFICATION_REQUIRED"),
])
async def test_scripted_refinement_transition_and_reset_preserve_distinct_intent(
    request_data, pending, message, query, purpose, status,
):
    # 고정 모델 응답의 전달·병합 회귀다. 실제 모델 의미 판정 정확도 측정이 아니다.
    request_data["message"] = message
    before = deepcopy(request_data["context"])
    if pending:
        request_data["pendingClarification"] = {
            "question": "지원 형태를 알려주세요.", "draftContext": deepcopy(before),
        }
    if query is None:
        updates = [{"field": field, "operation": "CLEAR", "value": None, "evidence": message}
                   for field in ("QUERY", "REGION", "INDUSTRY", "ESTABLISHED_ON", "SUPPORT_PURPOSE", "ACCEPTING_ONLY")]
    else:
        evidence = "지원금" if message == "지원금 위주" else "수출"
        updates = [
            {"field": "QUERY", "operation": "SET", "value": query, "evidence": evidence},
            {"field": "SUPPORT_PURPOSE", "operation": "SET", "value": purpose, "evidence": evidence},
        ]
    scripted = {"status": status, "updates": updates,
                "clarificationQuestion": "어떤 지원사업을 찾으시나요?" if query is None else None}
    model = ResponsesChatStub([[response_message(json.dumps(scripted, ensure_ascii=False))]])
    service = SupportProgramConversationService(SupportProgramConversationAgent(
        model=model.model, model_timeout_seconds=1, run_timeout_seconds=2,
    ))
    request = SupportProgramConversationRequest.model_validate(request_data)
    result = await service.interpret(request)
    merged = service._merge_context(request, result)
    assert merged.query == query
    assert merged.company_conditions.support_purpose == purpose
    assert merged.company_conditions.region == ("서울" if query else None)
    assert merged.company_conditions.industry == ("SW" if query else None)
    assert request_data["context"] == before
    assert json.loads(model.first_call.input[0]["content"])["context"] == before
    assert len(model.calls) == 1
    model.assert_complete()


@pytest.mark.anyio
async def test_scripted_region_change_also_removes_old_region_from_query(request_data):
    request_data["context"]["query"] = "서울 사업화 지원"
    scripted = {"status": "READY", "updates": [
        {"field": "REGION", "operation": "SET", "value": "부산", "evidence": "부산"},
        {"field": "QUERY", "operation": "SET", "value": "사업화 지원", "evidence": "부산으로 변경"},
    ], "clarificationQuestion": None}
    model = ResponsesChatStub([[response_message(json.dumps(scripted, ensure_ascii=False))]])
    service = SupportProgramConversationService(SupportProgramConversationAgent(model=model.model, model_timeout_seconds=1, run_timeout_seconds=2))
    result = await service.interpret(SupportProgramConversationRequest.model_validate(request_data))
    assert result.updates[1].value == "사업화 지원"
    assert "서울" not in result.updates[1].value


@pytest.mark.anyio
async def test_scripted_relative_age_asks_and_does_not_create_date(request_data):
    request_data["message"] = "설립 2년"
    scripted = {"status": "CLARIFICATION_REQUIRED", "updates": [], "clarificationQuestion": "정확한 설립일을 알려주세요."}
    model = ResponsesChatStub([[response_message(json.dumps(scripted, ensure_ascii=False))]])
    service = SupportProgramConversationService(SupportProgramConversationAgent(model=model.model, model_timeout_seconds=1, run_timeout_seconds=2))
    result = await service.interpret(SupportProgramConversationRequest.model_validate(request_data))
    assert result.status == "CLARIFICATION_REQUIRED" and result.updates == []


@pytest.mark.anyio
@pytest.mark.parametrize("bad_output", ["not-json", '{}', '{"status":"READY","updates":[]}'])
async def test_invalid_structured_output_is_an_error_without_retry(request_data, bad_output):
    model = ResponsesChatStub([[response_message(bad_output)]])
    agent = SupportProgramConversationAgent(model=model.model, model_timeout_seconds=1, run_timeout_seconds=2)
    with pytest.raises(SupportProgramConversationError):
        await agent.interpret(SupportProgramConversationRequest.model_validate(request_data))
    assert len(model.calls) == 1


@pytest.mark.anyio
async def test_one_model_turn_limit(request_data, output_data):
    model = ResponsesChatStub([[], [response_message(json.dumps(output_data))]])
    agent = SupportProgramConversationAgent(model=model.model, model_timeout_seconds=1, run_timeout_seconds=2)
    with pytest.raises(SupportProgramConversationError) as captured:
        await agent.interpret(SupportProgramConversationRequest.model_validate(request_data))
    assert isinstance(captured.value.__cause__, ValueError)
    assert len(model.calls) == 1


@pytest.mark.anyio
async def test_run_deadline(request_data):
    async def hang_forever(_):
        await asyncio.Event().wait()
        return []
    model = ResponsesChatStub([(hang_forever)])
    agent = SupportProgramConversationAgent(model=model.model, model_timeout_seconds=1, run_timeout_seconds=0.01)
    with pytest.raises(SupportProgramConversationTimeoutError) as captured:
        await agent.interpret(SupportProgramConversationRequest.model_validate(request_data))
    assert isinstance(captured.value.__cause__, TimeoutError)
    # The whole-run deadline can expire during LangChain setup, before a model call starts.
    assert len(model.calls) <= 1


@pytest.mark.anyio
async def test_model_deadline_is_classified_as_timeout_without_retry(request_data):
    async def hang_forever(_):
        await asyncio.Event().wait()
        return []
    model = ResponsesChatStub([(hang_forever)])
    agent = SupportProgramConversationAgent(model=model.model, model_timeout_seconds=0.1, run_timeout_seconds=1)
    with pytest.raises(SupportProgramConversationTimeoutError) as captured:
        await agent.interpret(SupportProgramConversationRequest.model_validate(request_data))
    assert isinstance(captured.value.__cause__, TimeoutError)
    assert len(model.calls) == 1


@pytest.mark.anyio
async def test_http_timeout_is_classified_and_uses_interpretation_deadline_without_retry(request_data):
    calls = []
    def handle(request):
        calls.append(request)
        raise httpx2.ReadTimeout("private transport details", request=request)
    client = AsyncOpenAI(api_key="test-key", timeout=25, max_retries=0,
                         http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(handle)))
    agent = SupportProgramConversationAgent(model=chat_model(model="test-model", openai_client=client),
                                           model_timeout_seconds=4, run_timeout_seconds=5)
    try:
        with pytest.raises(SupportProgramConversationTimeoutError) as captured:
            await agent.interpret(SupportProgramConversationRequest.model_validate(request_data))
    finally:
        await client.close()
    assert isinstance(captured.value.__cause__, APITimeoutError)
    assert len(calls) == 1
    assert calls[0].extensions["timeout"] == dict.fromkeys(("connect", "read", "write", "pool"), 4)
    assert client.timeout == 25


@pytest.mark.anyio
async def test_actual_openai_sdk_strict_schema_and_no_persisted_conversation(request_data, output_data):
    captured = []
    def handle(request):
        captured.append(json.loads(request.content))
        return httpx2.Response(200, json=responses_body(output_data))
    client = AsyncOpenAI(api_key="test-key-never-sent", base_url="https://openai.test/v1/", max_retries=0,
                         http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(handle)))
    agent = SupportProgramConversationAgent(model=chat_model(model="gpt-5.6-luna", openai_client=client),
                                             model_timeout_seconds=4, run_timeout_seconds=5)
    try:
        await agent.interpret(SupportProgramConversationRequest.model_validate(request_data))
    finally:
        await client.close()
    assert len(captured) == 1
    wire = captured[0]
    assert wire["model"] == "gpt-5.6-luna" and wire["store"] is False
    assert wire["max_output_tokens"] == 2000 and wire["reasoning"] == {"effort": "none"}
    assert "conversation" not in wire and "previous_response_id" not in wire
    assert not wire.get("tools")
    text_format = wire["text"]["format"]
    assert text_format["strict"] is True and text_format["type"] == "json_schema"
    schema = text_format["schema"]
    assert schema["required"] == ["status", "updates", "clarificationQuestion", "answer"]
    assert schema["additionalProperties"] is False
    update_schema = schema["$defs"]["ConversationUpdate"]
    assert update_schema["additionalProperties"] is False
    assert update_schema["required"] == ["field", "operation", "value", "evidence"]
    assert schema["properties"]["updates"]["maxItems"] == 7
    assert schema["properties"]["status"]["enum"] == ["READY", "CLARIFICATION_REQUIRED", "ANSWERED"]
    answer_schema = schema["properties"]["answer"]["anyOf"]
    assert {item["type"] for item in answer_schema} == {"string", "null"}
    assert next(item for item in answer_schema if item["type"] == "string")["maxLength"] == 1000
    assert {item["type"] for item in update_schema["properties"]["value"]["anyOf"]} == {"string", "null"}


@pytest.mark.anyio
@pytest.mark.parametrize("failure", ["refusal", "upstream"])
async def test_upstream_and_refusal_are_errors_not_missing_information(request_data, output_data, failure):
    calls = []
    def handle(request):
        calls.append(request)
        body = responses_body(output_data)
        if failure == "upstream":
            return httpx2.Response(503, json={"error": {"message": "private failure"}})
        body["output"][0]["content"] = [{"type": "refusal", "refusal": "cannot answer"}]
        return httpx2.Response(200, json=body)
    client = AsyncOpenAI(api_key="test-key", max_retries=0,
                         http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(handle)))
    agent = SupportProgramConversationAgent(model=chat_model(model="gpt-5.6-luna", openai_client=client),
                                             model_timeout_seconds=4, run_timeout_seconds=5)
    try:
        with pytest.raises(SupportProgramConversationError):
            await agent.interpret(SupportProgramConversationRequest.model_validate(request_data))
    finally:
        await client.close()
    assert len(calls) == 1


@pytest.mark.anyio
async def test_concurrent_requests_do_not_share_context_or_history(request_data, output_data):
    arrived = 0
    both = asyncio.Event()
    async def output_after_both(_):
        nonlocal arrived
        arrived += 1
        if arrived == 2:
            both.set()
        await both.wait()
        return [response_message(json.dumps(output_data, ensure_ascii=False))]
    model = ResponsesChatStub([(output_after_both), (output_after_both)])
    agent = SupportProgramConversationAgent(model=model.model, model_timeout_seconds=1, run_timeout_seconds=2)
    second = deepcopy(request_data)
    second["context"]["query"] = "수출 지원"
    await asyncio.gather(*(agent.interpret(SupportProgramConversationRequest.model_validate(data)) for data in (request_data, second)))
    inputs = [json.loads(call.input[0]["content"]) for call in model.calls]
    assert [item["context"]["query"] for item in inputs] == ["사업화 지원", "수출 지원"]
    assert all(len(call.input) == 1 for call in model.calls)


def test_prompt_distinguishes_followups_assent_and_grounded_search_explanations():
    # 프롬프트 계약 회귀이며 실제 OpenAI의 한국어 해석 성공률 측정은 아니다.
    instructions = SUPPORT_PROGRAM_CONVERSATION_INSTRUCTIONS
    for clause in (
        "pendingProposal", "lastSearch", "resultCount", 'evidence는 현재 message의 "설정해"',
        "같은 질문을 반복하지", "REGION만 변경", '"무역 관련 찾아봐"',
        "설립일 SET에는 아래의 현재 메시지 완전 날짜 규칙",
        "ANSWERED는 query가 없어도 가능", "updates는 빈 배열",
        "현재 조건은 자동 완화하지", "정확한 원인을 단정할 수 없다고",
        "미확정 제안을 실제 검색 조건으로 말하지", "실행이 완료되었다고 주장하지",
    ):
        assert clause in instructions


@pytest.mark.anyio
async def test_scripted_trade_region_explanation_and_assent_flow_carries_small_context(request_data):
    # 아래 응답은 고정한 모델 스텁이다. 전송·병합·상태 계약만 검증하며 의미 해석 품질 평가는 아니다.
    def ready(*updates):
        return {"status": "READY", "updates": list(updates), "clarificationQuestion": None, "answer": None}

    def change(field, value, evidence):
        return {"field": field, "operation": "SET", "value": value, "evidence": evidence}

    outputs = [
        ready(change("QUERY", "AI 창업지원", "AI 창업지원"), change("REGION", "서울", "서울")),
        ready(change("QUERY", "무역 지원", "무역 관련")),
        ready(),
        ready(change("REGION", "대구", "대구")),
        {"status": "ANSWERED", "updates": [], "clarificationQuestion": None,
         "answer": "직전 대구 소재지 조건의 무역 지원 검색에서 반환된 결과는 0건입니다. "
                   "정확한 원인은 요약만으로 단정할 수 없어요. 원하시면 지역 조건을 넓혀 보세요."},
        ready(),
        ready(),
    ]
    messages = ["서울 AI 창업지원 사업 찾아줘", "무역 관련 찾아봐", "서울", "대구", "왜 못 찾아?", "대구", "설정해"]
    request_data["context"]["query"] = None
    request_data["context"]["companyConditions"] = dict.fromkeys(request_data["context"]["companyConditions"])
    model = ResponsesChatStub([[response_message(json.dumps(output, ensure_ascii=False))] for output in outputs])
    service = SupportProgramConversationService(SupportProgramConversationAgent(
        model=model.model, model_timeout_seconds=1, run_timeout_seconds=2,
    ))
    for index, message in enumerate(messages):
        request_data["message"] = message
        request = SupportProgramConversationRequest.model_validate(request_data)
        response = await service.interpret(request)
        merged = service._merge_context(request, response)
        assert response.clarification_question is None
        assert json.loads(model.calls[index].input[0]["content"]) == request_data
        if index >= 1:
            assert merged.query == "무역 지원"
        if index >= 3:
            assert merged.company_conditions.region == "대구"
        if index == 3:
            # 이 단계의 검색 완료를 입력 요약으로 재현한다. 이 테스트가 실제 검색을 수행하지는 않는다.
            request_data["context"] = merged.model_dump(by_alias=True)
            request_data["pendingProposal"] = None
            request_data["lastSearch"] = {"context": merged.model_dump(by_alias=True), "resultCount": 0}
        elif response.status == "READY":
            request_data["pendingProposal"] = merged.model_dump(by_alias=True)
        else:
            assert response.status == "ANSWERED" and response.updates == []
            assert request_data["pendingProposal"] is None
            assert "0건" in response.answer
    assert len(model.calls) == len(messages)
    assert all(len(call.input) == 1 for call in model.calls)
    model.assert_complete()


@pytest.mark.anyio
@pytest.mark.parametrize("failure", [False, True])
async def test_interpretation_logs_stage_duration_without_conversation_content(request_data, output_data, caplog, failure):
    import logging

    text = "private invalid output" if failure else json.dumps(output_data, ensure_ascii=False)
    model = ResponsesChatStub([[response_message(text)]])
    agent = SupportProgramConversationAgent(model=model.model, model_timeout_seconds=3, run_timeout_seconds=4)
    with caplog.at_level(logging.INFO, logger="app.support_program_conversation.agent"):
        if failure:
            with pytest.raises(SupportProgramConversationError):
                await agent.interpret(SupportProgramConversationRequest.model_validate(request_data))
        else:
            await agent.interpret(SupportProgramConversationRequest.model_validate(request_data))
    messages = [record.getMessage() for record in caplog.records if record.name == "app.support_program_conversation.agent"]
    assert len(messages) == 1
    assert f"outcome={'failed' if failure else 'completed'}" in messages[0]
    for metric in ("model_ms=", "validation_ms=", "elapsed_ms="):
        assert metric in messages[0]
    for private in (request_data["message"], request_data["context"]["query"], "private invalid output", "2024-01-01"):
        assert private not in messages[0]


@pytest.mark.anyio
@pytest.mark.parametrize("service_tier", [None, "default", "priority", "flex"])
@pytest.mark.parametrize("with_usage", [True, False])
async def test_actual_sdk_usage_is_logged_and_missing_usage_stays_unknown(request_data, output_data, caplog, with_usage, service_tier):
    import logging

    def handler(request):
        body = responses_body(output_data)
        if service_tier is not None:
            body["service_tier"] = service_tier
        if with_usage:
            body["usage"] = {
                "input_tokens": 800, "output_tokens": 120, "total_tokens": 920,
                "input_tokens_details": {"cached_tokens": 600},
                "output_tokens_details": {"reasoning_tokens": 20},
            }
        return httpx2.Response(200, json=body)

    client = AsyncOpenAI(api_key="secret-test-key", max_retries=0,
                         http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)))
    agent = SupportProgramConversationAgent(
        model=chat_model(model="test-model", openai_client=client),
        model_timeout_seconds=3, run_timeout_seconds=4,
    )
    try:
        with caplog.at_level(logging.INFO, logger="app.support_program_conversation.agent"):
            await agent.interpret(SupportProgramConversationRequest.model_validate(request_data))
    finally:
        await client.close()
    messages = [record.getMessage() for record in caplog.records if record.name == "app.support_program_conversation.agent"]
    assert len(messages) == 1 and "outcome=completed" in messages[0]
    if with_usage:
        for metric in ("usage_reported=True", "input_tokens=800", "output_tokens=120", "cached_input_tokens=600", "reasoning_tokens=20"):
            assert metric in messages[0]
    else:
        assert "usage_reported=False" in messages[0]
        assert "input_tokens=None" in messages[0] and "output_tokens=None" in messages[0]
        assert "cached_input_tokens=None" in messages[0] and "reasoning_tokens=None" in messages[0]
    assert "secret-test-key" not in caplog.text
