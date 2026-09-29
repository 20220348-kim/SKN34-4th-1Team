import asyncio
import json
import logging
from uuid import uuid4

import httpx2
import pytest
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult, LLMResult
from langchain_openai import ChatOpenAI

from app.assistant_agent.errors import AssistantAgentError, AssistantAgentTimeoutError
from app.assistant_agent.graph import build_assistant_agent_graph
from app.assistant_agent.models import AssistantAgentRequest
from app.assistant_agent.service import AssistantAgentService
from app.assistant_agent.usage import AssistantModelUsage
from tests.assistant_agent.fakes import HANG, ScriptedChatModel, tool_call_message
from tests.assistant_agent.test_graph import PROFILE_CALL, READY, Harness
from tests.assistant_agent.test_saved_programs import Harness as SavedHarness
from tests.assistant_agent.test_saved_programs import documents, finding, reduce_output


def run_log(caplog):
    records = [record for record in caplog.records if record.name == "app.assistant_agent.service"]
    assert len(records) == 1
    assert records[0].exc_info is None
    return dict(item.split("=", 1) for item in records[0].getMessage().split()[1:])


@pytest.mark.anyio
async def test_timeout_keeps_completed_classification_and_unknown_started_call(request_data, empty_classification, caplog):
    harness = Harness(
        classify=[{**empty_classification, "intent": "PARTNER_MATCH"}], agent=[HANG], timeout=0.1,
    )
    with caplog.at_level(logging.INFO, logger="app.assistant_agent.service"), pytest.raises(AssistantAgentTimeoutError):
        await harness.run(request_data)
    log = run_log(caplog)
    assert log["outcome"] == "timeout" and log["intent"] == "PARTNER_MATCH"
    assert log["model_calls"] == "2"
    assert log["input_tokens"] == log["output_tokens"] == "None"
    assert log["observed_input_tokens"] == "200" and log["observed_output_tokens"] == "20"
    assert log["usage_unknown_calls"] == "1"


@pytest.mark.anyio
async def test_answer_failure_preserves_completed_tools_and_all_observed_usage(request_data, empty_classification, caplog):
    harness = Harness(
        classify=[{**empty_classification, "intent": "PARTNER_MATCH"}],
        agent=[tool_call_message(PROFILE_CALL), READY, RuntimeError("private response detail")],
    )
    with caplog.at_level(logging.INFO, logger="app.assistant_agent"), pytest.raises(AssistantAgentError):
        await harness.run(request_data)
    log = run_log(caplog)
    assert log["model_calls"] == "4" and log["tool_calls"] == "1"
    assert log["observed_input_tokens"] == "350" and log["observed_output_tokens"] == "32"
    assert log["input_tokens"] == log["output_tokens"] == "None"
    assert log["usage_unknown_calls"] == "1"
    assert "private response detail" not in caplog.text
    assert request_data["message"] not in caplog.text
    assert request_data["principal"]["toolToken"] not in caplog.text


@pytest.mark.anyio
async def test_rejected_classification_still_records_received_usage(request_data, caplog):
    harness = Harness(classify=[{"intent": "PARTNER_MATCH"}], agent=[])
    with caplog.at_level(logging.INFO, logger="app.assistant_agent.service"), pytest.raises(AssistantAgentError):
        await harness.run(request_data)
    log = run_log(caplog)
    assert log["model_calls"] == "1" and log["usage_unknown_calls"] == "0"
    assert log["input_tokens"] == "200" and log["output_tokens"] == "20"


@pytest.mark.anyio
@pytest.mark.parametrize("usage,expected_input,expected_output,unknown", [
    (None, "None", "None", "1"),
    ({"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}, "0", "0", "0"),
    ({"input_tokens": 40, "output_tokens": 7, "total_tokens": 47}, "40", "7", "0"),
])
async def test_missing_usage_is_distinct_from_confirmed_zero(request_data, empty_classification, caplog, usage, expected_input, expected_output, unknown):
    raw = AIMessage(content=json.dumps({**empty_classification, "intent": "PROGRAM_QUESTION"}), usage_metadata=usage)
    harness = Harness(classify=[raw], agent=[])
    with caplog.at_level(logging.INFO, logger="app.assistant_agent.service"):
        await harness.run(request_data)
    log = run_log(caplog)
    assert log["outcome"] == "completed" and log["model_calls"] == "1"
    assert (log["input_tokens"], log["output_tokens"], log["usage_unknown_calls"]) == (expected_input, expected_output, unknown)


@pytest.mark.anyio
async def test_parallel_subgraph_failure_preserves_successful_map_usage(request_data, caplog):
    request_data.update(savedProgramDocuments=documents(), resumeIntent="SAVED_PROGRAMS_QUESTION")
    harness = SavedHarness(classify=[finding("NO"), HANG], agent=[], timeout=0.1)
    with caplog.at_level(logging.INFO, logger="app.assistant_agent.service"), pytest.raises(AssistantAgentTimeoutError):
        await harness.run(request_data)
    log = run_log(caplog)
    assert log["intent"] == "SAVED_PROGRAMS_QUESTION" and log["model_calls"] == "2"
    assert log["observed_input_tokens"] == "200" and log["observed_output_tokens"] == "20"
    assert log["input_tokens"] == log["output_tokens"] == "None"
    assert log["usage_unknown_calls"] == "1"


@pytest.mark.anyio
async def test_handled_map_error_keeps_unknown_usage_even_when_graph_completes(request_data, caplog):
    request_data.update(savedProgramDocuments=documents(), resumeIntent="SAVED_PROGRAMS_QUESTION")
    harness = SavedHarness(classify=[RuntimeError("private map response"), finding("NO")], agent=[reduce_output()])
    with caplog.at_level(logging.INFO, logger="app.assistant_agent.service"):
        await harness.run(request_data)
    log = run_log(caplog)
    assert log["outcome"] == "completed" and log["model_calls"] == "3"
    assert log["observed_input_tokens"] == "400" and log["observed_output_tokens"] == "40"
    assert log["input_tokens"] == log["output_tokens"] == "None"
    assert log["usage_unknown_calls"] == "1"


@pytest.mark.anyio
async def test_external_cancellation_preserves_observed_usage(request_data, empty_classification, caplog, monkeypatch):
    started = asyncio.Event()
    original = ScriptedChatModel._agenerate

    async def observed_generate(self, *args, **kwargs):
        if self.responses and self.responses[0] is HANG:
            started.set()
        return await original(self, *args, **kwargs)

    monkeypatch.setattr(ScriptedChatModel, "_agenerate", observed_generate)
    harness = Harness(classify=[{**empty_classification, "intent": "PARTNER_MATCH"}], agent=[HANG])
    with caplog.at_level(logging.INFO, logger="app.assistant_agent.service"):
        task = asyncio.create_task(harness.run(request_data))
        await asyncio.wait_for(started.wait(), timeout=2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    log = run_log(caplog)
    assert log["outcome"] == "cancelled" and log["model_calls"] == "2"
    assert log["observed_input_tokens"] == "200" and log["observed_output_tokens"] == "20"
    assert log["usage_unknown_calls"] == "1"


@pytest.mark.anyio
async def test_concurrent_requests_on_shared_graph_keep_separate_usage(request_data, empty_classification, caplog, monkeypatch):
    both_started = asyncio.Event()
    started = 0

    async def generate(self, messages, **kwargs):
        nonlocal started
        started += 1
        if started == 2:
            both_started.set()
        await asyncio.wait_for(both_started.wait(), timeout=2)
        usage = {"input_tokens": 11, "output_tokens": 3, "total_tokens": 14} if "private-first" in messages[1].content else None
        return ChatResult(generations=[ChatGeneration(message=AIMessage(
            content=json.dumps({**empty_classification, "intent": "PROGRAM_QUESTION"}), usage_metadata=usage,
        ))])

    monkeypatch.setattr(ScriptedChatModel, "_agenerate", generate)
    harness = Harness(classify=[], agent=[])
    try:
        with caplog.at_level(logging.INFO, logger="app.assistant_agent.service"):
            responses = await asyncio.gather(*(
                harness.service.answer(AssistantAgentRequest.model_validate({**request_data, "message": question}))
                for question in ["private-first", "private-second"]
            ))
    finally:
        await harness.client.aclose()
    assert [response.intent for response in responses] == ["PROGRAM_QUESTION"] * 2
    logs = [dict(item.split("=", 1) for item in record.getMessage().split()[1:])
            for record in caplog.records if record.name == "app.assistant_agent.service"]
    assert len(logs) == 2
    assert {(log["model_calls"], log["input_tokens"], log["output_tokens"], log["usage_unknown_calls"])
            for log in logs} == {("1", "11", "3", "0"), ("1", "None", "None", "1")}
    assert "private-first" not in caplog.text and "private-second" not in caplog.text


@pytest.mark.anyio
@pytest.mark.parametrize("scenario", ["next_call_timeout", "invalid_classification", "invalid_json", "missing_usage"])
async def test_responses_sdk_preserves_usage_through_graph(request_data, empty_classification, caplog, scenario):
    calls = []
    classification = {**empty_classification, "intent": "PARTNER_MATCH" if scenario == "next_call_timeout" else "PROGRAM_QUESTION"}
    if scenario == "invalid_classification":
        classification = {"intent": "PARTNER_MATCH"}

    async def handle(request):
        calls.append(request)
        if len(calls) == 2:
            raise httpx2.ReadTimeout("private upstream timeout", request=request)
        body = {
            "id": "resp_usage_test", "object": "response", "created_at": 0, "model": "test-model",
            "status": "completed", "error": None, "incomplete_details": None,
            "output": [{"id": "msg_usage_test", "type": "message", "role": "assistant", "status": "completed",
                        "content": [{"type": "output_text", "text": "not JSON" if scenario == "invalid_json" else json.dumps(classification), "annotations": []}]}],
        }
        if scenario != "missing_usage":
            body["usage"] = {"input_tokens": 83, "output_tokens": 12, "total_tokens": 95,
                             "input_tokens_details": {"cached_tokens": 0}, "output_tokens_details": {"reasoning_tokens": 0}}
        return httpx2.Response(200, json=body)

    harness = Harness(classify=[], agent=[])
    try:
        async with httpx2.AsyncClient(transport=httpx2.MockTransport(handle)) as client:
            model = ChatOpenAI(
                model="test-model", api_key="test-key", base_url="https://openai.test/v1/",
                use_responses_api=True, store=False, max_retries=0, http_async_client=client,
            )
            graph = build_assistant_agent_graph(
                classify_model=model, agent_model=model, tool_client=harness.client,
                max_tool_calls=3, retriever=harness.retriever,
            )
            service = AssistantAgentService(graph=graph, timeout_seconds=5)
            with caplog.at_level(logging.INFO, logger="app.assistant_agent.service"):
                if scenario == "missing_usage":
                    await service.answer(AssistantAgentRequest.model_validate(request_data))
                else:
                    error = AssistantAgentTimeoutError if scenario == "next_call_timeout" else AssistantAgentError
                    with pytest.raises(error):
                        await service.answer(AssistantAgentRequest.model_validate(request_data))
    finally:
        await harness.client.aclose()

    log = run_log(caplog)
    assert len(calls) == (2 if scenario == "next_call_timeout" else 1)
    assert all(request.url.path == "/v1/responses" for request in calls)
    assert log["model_calls"] == str(len(calls))
    assert log["observed_input_tokens"] == ("0" if scenario == "missing_usage" else "83")
    assert log["observed_output_tokens"] == ("0" if scenario == "missing_usage" else "12")
    assert log["usage_unknown_calls"] == ("0" if scenario in {"invalid_classification", "invalid_json"} else "1")
    assert log["input_tokens"] == ("83" if scenario in {"invalid_classification", "invalid_json"} else "None")
    assert "private upstream timeout" not in caplog.text and "test-key" not in caplog.text


@pytest.mark.anyio
async def test_completed_nested_graph_counts_each_model_once(request_data, caplog):
    request_data.update(savedProgramDocuments=documents(), resumeIntent="SAVED_PROGRAMS_QUESTION")
    harness = SavedHarness(classify=[finding("NO"), finding("NO")], agent=[reduce_output()])
    with caplog.at_level(logging.INFO, logger="app.assistant_agent.service"):
        await harness.run(request_data)
    log = run_log(caplog)
    assert log["outcome"] == "completed" and log["model_calls"] == "3"
    assert log["input_tokens"] == log["observed_input_tokens"] == "600"
    assert log["output_tokens"] == log["observed_output_tokens"] == "60"
    assert log["usage_unknown_calls"] == "0"


@pytest.mark.anyio
async def test_failure_before_model_start_reports_zero_invocations(request_data, caplog, monkeypatch):
    def reject_schema(*args, **kwargs):
        raise ValueError("unsupported schema")

    monkeypatch.setattr(ScriptedChatModel, "with_structured_output", reject_schema)
    harness = Harness(classify=[], agent=[])
    with caplog.at_level(logging.INFO, logger="app.assistant_agent.service"), pytest.raises(AssistantAgentError):
        await harness.run(request_data)
    log = run_log(caplog)
    assert log["model_calls"] == log["input_tokens"] == log["output_tokens"] == log["usage_unknown_calls"] == "0"


@pytest.mark.anyio
@pytest.mark.parametrize("invalid_input", [None, "4", True, -1])
async def test_error_response_with_partial_usage_preserves_known_dimension(invalid_input):
    usage = AssistantModelUsage()
    completed, failed = uuid4(), uuid4()
    await usage.on_chat_model_start({}, [], run_id=completed)
    await usage.on_llm_end(LLMResult(generations=[[ChatGeneration(message=AIMessage(
        content="private answer", usage_metadata={"input_tokens": 20, "output_tokens": 5, "total_tokens": 25},
    ))]]), run_id=completed)
    await usage.on_chat_model_start({}, [], run_id=failed)
    error = ValueError("private validation detail")
    error.response = httpx2.Response(200, json={
        "object": "response", "usage": {"input_tokens": invalid_input, "output_tokens": 0},
    })
    await usage.on_llm_error(error, run_id=failed)
    assert usage.snapshot() == {
        "model_calls": 2, "input_tokens": None, "output_tokens": 5,
        "observed_input_tokens": 20, "observed_output_tokens": 5, "usage_unknown_calls": 1,
    }
