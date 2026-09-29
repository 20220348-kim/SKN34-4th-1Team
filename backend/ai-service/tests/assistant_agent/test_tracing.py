import asyncio
import json
from dataclasses import replace
from hashlib import sha256
from uuid import uuid4

import pytest
from app import bootstrap
from app import tracing as tracing_module
from app.assistant_agent.errors import AssistantAgentError, AssistantAgentTimeoutError
from app.assistant_agent.models import AssistantAgentRequest
from app.assistant_agent.prompts import MAP_INSTRUCTIONS
from app.config import LangfuseSettings
from app.main import create_app
from fastapi.testclient import TestClient
from langfuse import Langfuse
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from tests.assistant_agent.fakes import (
    HANG,
    FakeCoreTools,
    FakeRetriever,
    ScriptedChatModel,
    tool_call_message,
)
from tests.assistant_agent.test_graph import (
    PROFILE_CALL,
    READY,
    Harness,
    partner_answer,
)
from tests.assistant_agent.test_saved_programs import (
    SEOUL,
    SEOUL_CHUNK,
    documents,
    finding,
    reduce_output,
)
from tests.assistant_agent.test_saved_programs import Harness as SavedHarness
from tests.test_bootstrap import OPENAI_SETTINGS


@pytest.fixture
def trace_environment(monkeypatch):
    exporter = InMemorySpanExporter()
    monkeypatch.setattr(tracing_module, "Langfuse", lambda **kwargs: Langfuse(**kwargs, span_exporter=exporter))
    settings = LangfuseSettings(
        enabled=True,
        base_url="http://localhost:13000",
        public_key="pk-lf-" + uuid4().hex,
        secret_key="private-tracing-secret",
    )
    tracing = tracing_module.LLMTracing(settings)
    try:
        yield tracing, exporter, settings
    finally:
        if not tracing._closed:
            asyncio.run(tracing.close())


def attribute(span, key):
    return span.attributes.get("langfuse.observation.metadata." + key)


def named(spans, name):
    return [span for span in spans if span.name == name]


def assert_private(spans, request):
    exported = json.dumps([span.to_json() for span in spans], ensure_ascii=False)
    for private in (
        request["message"],
        request["principal"]["toolToken"],
        "private-tracing-secret",
        "private upstream detail",
        "데이터브릿지 주식회사",
        SEOUL_CHUNK.text,
    ):
        assert private not in exported
    assert all(not span.events for span in spans)
    for span in spans:
        assert "langfuse.observation.input" not in span.attributes
        assert "langfuse.observation.output" not in span.attributes
    return exported


@pytest.mark.anyio
async def test_tool_flow_and_validation_retry_keep_parent_links_and_usage(
    trace_environment, request_data, empty_classification
):
    tracing, exporter, _ = trace_environment
    harness = Harness(
        tracing=tracing,
        classify=[{**empty_classification, "intent": "PARTNER_MATCH"}],
        agent=[tool_call_message(PROFILE_CALL), READY, partner_answer("999"), partner_answer()],
    )
    try:
        await harness.run(request_data)
        harness.assert_complete()
    finally:
        await tracing.close()
    spans = exporter.get_finished_spans()
    (root,) = named(spans, "assistant.agent")
    assert attribute(root, "model_calls") == 5
    assert attribute(root, "usage_input_tokens") == 750
    assert attribute(root, "usage_complete") is True
    assert attribute(root, "usage_unknown_calls") == 0
    (tool,) = named(spans, "assistant.tool")
    (tools,) = named(spans, "assistant.tools")
    assert tool.parent.span_id == tools.context.span_id
    assert attribute(tool, "tool") == "get_my_company_profile"
    for span in spans:
        assert span.context.trace_id == root.context.trace_id
        if span.name not in {"assistant.agent", "assistant.tool"}:
            assert span.parent.span_id == root.context.span_id
    verifications = named(spans, "assistant.verify")
    assert [attribute(span, "validation_passed") for span in verifications] == [False, True]
    assert verifications[0].attributes["langfuse.observation.level"] == "WARNING"
    assert attribute(verifications[0], "result_status") == "degraded"
    assert named(spans, "assistant.plan")[0].attributes["langfuse.trace.name"] == "assistant-agent"
    assert_private(spans, request_data)


@pytest.mark.anyio
async def test_saved_programs_parallel_map_has_nested_spans_and_versions(trace_environment, request_data):
    tracing, exporter, _ = trace_environment
    request_data.update(savedProgramDocuments=documents(), resumeIntent="SAVED_PROGRAMS_QUESTION")
    harness = SavedHarness(tracing=tracing, classify=[finding("YES"), finding("NO")], agent=[reduce_output(SEOUL)])
    try:
        await harness.run(request_data)
        harness.assert_complete()
    finally:
        await tracing.close()
    spans = exporter.get_finished_spans()
    (root,) = named(spans, "assistant.agent")
    (saved,) = named(spans, "assistant.saved_programs")
    (mapping,) = named(spans, "assistant.saved.map")
    (retrieval,) = named(spans, "assistant.saved.retrieve")
    assert len(spans) == 10
    assert saved.parent.span_id == root.context.span_id
    for name in ("retrieve", "map", "reduce", "verify"):
        assert named(spans, "assistant.saved." + name)[0].parent.span_id == saved.context.span_id
    judges = named(spans, "assistant.saved.judge")
    assert len(judges) == 2
    assert all(span.parent.span_id == mapping.context.span_id for span in judges)
    assert attribute(mapping, "prompt_sha256") == sha256(MAP_INSTRUCTIONS.encode()).hexdigest()
    assert attribute(mapping, "model") == "ScriptedChatModel"
    assert attribute(retrieval, "retrieved_documents") == 2
    assert attribute(retrieval, "retrieved_chunks") == 3
    assert attribute(root, "document_count") == 3
    assert len(attribute(root, "document_manifest_sha256")) == 64
    assert attribute(root, "model_calls") == 3
    assert attribute(root, "usage_input_tokens") == 600
    exported = assert_private(spans, request_data)
    assert SEOUL not in exported
    assert "서울 AI 실증 지원사업" not in exported


@pytest.mark.anyio
@pytest.mark.parametrize("failure", ["retrieval", "map", "tool"])
async def test_handled_failures_remain_visible_without_changing_response(
    trace_environment, request_data, empty_classification, failure
):
    tracing, exporter, _ = trace_environment
    if failure == "tool":
        fake = FakeCoreTools()
        fake.fail_with = 503
        harness = Harness(
            tracing=tracing,
            fake=fake,
            classify=[{**empty_classification, "intent": "PARTNER_MATCH"}],
            agent=[tool_call_message(PROFILE_CALL), partner_answer()],
        )
    else:
        request_data.update(savedProgramDocuments=documents(), resumeIntent="SAVED_PROGRAMS_QUESTION")
        harness = SavedHarness(
            tracing=tracing,
            agent=[reduce_output()],
            classify=[] if failure == "retrieval" else [RuntimeError("private upstream detail"), finding("NO")],
            retriever=FakeRetriever(raise_error=RuntimeError("private upstream detail"))
            if failure == "retrieval"
            else None,
        )
    try:
        response = await harness.run(request_data)
        assert response.answer
        harness.assert_complete()
    finally:
        await tracing.close()
    spans = exporter.get_finished_spans()
    (root,) = named(spans, "assistant.agent")
    assert attribute(root, "outcome") == "completed"
    step = {"retrieval": "assistant.saved.retrieve", "map": "assistant.saved.map", "tool": "assistant.tools"}[failure]
    assert attribute(named(spans, step)[0], "result_status") == "degraded"
    if failure == "map":
        assert attribute(root, "usage_complete") is False
        assert attribute(root, "usage_unknown_calls") == 1
        assert attribute(root, "usage_observed_input_tokens") == 400
        assert attribute(named(spans, step)[0], "map_failures") == 1
        assert any(
            span.attributes.get("langfuse.observation.level") == "ERROR"
            for span in named(spans, "assistant.saved.judge")
        )
    elif failure == "tool":
        assert named(spans, "assistant.tool")[0].attributes["langfuse.observation.level"] == "ERROR"
    else:
        assert not named(spans, "assistant.saved.judge")
        assert attribute(root, "model_calls") == 1
    assert_private(spans, request_data)


@pytest.mark.anyio
@pytest.mark.parametrize("failure", ["timeout", "cancelled", "error"])
async def test_failed_requests_keep_usage_and_sanitized_outcomes(
    trace_environment, request_data, empty_classification, failure, monkeypatch
):
    tracing, exporter, _ = trace_environment
    entered = asyncio.Event()
    original = ScriptedChatModel._agenerate

    async def observed(self, *args, **kwargs):
        if self.responses and self.responses[0] is HANG:
            entered.set()
        return await original(self, *args, **kwargs)

    monkeypatch.setattr(ScriptedChatModel, "_agenerate", observed)
    harness = Harness(
        tracing=tracing,
        classify=[{**empty_classification, "intent": "PARTNER_MATCH"}],
        agent=[RuntimeError("private upstream detail") if failure == "error" else HANG],
        timeout=0.2 if failure == "timeout" else 5,
    )
    expected = {
        "timeout": AssistantAgentTimeoutError,
        "cancelled": asyncio.CancelledError,
        "error": AssistantAgentError,
    }[failure]
    try:
        with pytest.raises(expected):
            if failure == "cancelled":
                task = asyncio.create_task(harness.run(request_data))
                await asyncio.wait_for(entered.wait(), 2)
                task.cancel()
                await task
            else:
                await harness.run(request_data)
    finally:
        await tracing.close()
    spans = exporter.get_finished_spans()
    (root,) = named(spans, "assistant.agent")
    assert attribute(root, "outcome") == ("failed" if failure == "error" else failure)
    assert root.attributes["langfuse.observation.level"] == "ERROR"
    assert attribute(root, "model_calls") == 2
    assert attribute(root, "usage_unknown_calls") == 1
    assert attribute(root, "usage_complete") is False
    assert attribute(root, "usage_input_tokens") is None
    assert attribute(root, "usage_observed_input_tokens") == 200
    assert_private(spans, request_data)


@pytest.mark.anyio
async def test_concurrent_requests_have_separate_roots_and_usage(trace_environment, request_data, empty_classification):
    tracing, exporter, _ = trace_environment
    answer = {**empty_classification, "intent": "PROGRAM_QUESTION"}
    harness = Harness(tracing=tracing, classify=[answer, answer], agent=[])
    request = AssistantAgentRequest.model_validate(request_data)
    try:
        await asyncio.gather(harness.service.answer(request), harness.service.answer(request))
    finally:
        await harness.client.aclose()
        await tracing.close()
    spans = exporter.get_finished_spans()
    roots = named(spans, "assistant.agent")
    assert len({root.context.trace_id for root in roots}) == 2
    for root in roots:
        children = [span for span in spans if span.parent and span.parent.span_id == root.context.span_id]
        assert {span.name for span in children} == {"assistant.classify", "assistant.finalize"}
        assert attribute(root, "model_calls") == 1
        assert attribute(root, "usage_input_tokens") == 200


@pytest.mark.anyio
@pytest.mark.parametrize("method", ["start_as_current_observation", "update"])
async def test_telemetry_failure_never_repeats_model_calls(
    trace_environment, request_data, empty_classification, monkeypatch, caplog, method
):
    tracing, _, _ = trace_environment
    answer = {**empty_classification, "intent": "PROGRAM_QUESTION"}
    harness = Harness(tracing=tracing, classify=[answer], agent=[])

    def broken(*args, **kwargs):
        raise RuntimeError("private instrumentation detail")

    if method == "update":
        from langfuse._client.span import LangfuseSpan

        monkeypatch.setattr(LangfuseSpan, "update", broken)
    else:
        monkeypatch.setattr(tracing.client, method, broken)
    try:
        assert (await harness.run(request_data)).intent == "PROGRAM_QUESTION"
        harness.assert_complete()
        assert len(harness.classify_model.calls) == 1
    finally:
        await tracing.close()
    assert "private instrumentation detail" not in caplog.text


@pytest.mark.anyio
async def test_disabled_tracing_does_not_construct_exporter(request_data, empty_classification, monkeypatch):
    def forbidden(**kwargs):
        pytest.fail("disabled tracing created an exporter")

    monkeypatch.setattr(tracing_module, "Langfuse", forbidden)
    harness = Harness(classify=[{**empty_classification, "intent": "PROGRAM_QUESTION"}], agent=[])
    assert (await harness.run(request_data)).intent == "PROGRAM_QUESTION"
    harness.assert_complete()


@pytest.mark.parametrize("header", [
    None,
    "00-" + "1" * 32 + "-" + "2" * 16 + "-01",
    "00-" + "1" * 32 + "-" + "2" * 16 + "-00",
    "00-" + "0" * 32 + "-" + "2" * 16 + "-01",
    "00-" + "1" * 32 + "-" + "0" * 16 + "-01",
    "01-" + "1" * 32 + "-" + "2" * 16 + "-01",
    "00-" + "A" * 32 + "-" + "2" * 16 + "-01",
    "private-invalid-header",
])
def test_http_bootstrap_traces_actual_graph_and_closes_exporter(
    trace_environment, request_data, empty_classification, monkeypatch, header
):
    _, exporter, settings = trace_environment
    model = ScriptedChatModel(responses=[{**empty_classification, "intent": "PROGRAM_QUESTION"}])
    monkeypatch.setattr(bootstrap, "_chat_model", lambda *args: model)
    # Each Langfuse client needs its own public key to avoid the SDK's shared resource cache.
    settings = replace(settings, public_key="pk-lf-" + uuid4().hex)
    app = create_app(settings=replace(OPENAI_SETTINGS, langfuse=settings))
    assert app.state.container.assistant_agent_service._tracing is app.state.container.llm_tracing
    with TestClient(app) as client:
        response = client.post(
            "/internal/v1/assistant/agent", json=request_data,
            headers={"traceparent": header, "baggage": "private-baggage"} if header else {},
        )
        assert response.status_code == 200
    model.assert_complete()
    assert {span.name for span in exporter.get_finished_spans()} == {
        "assistant.agent",
        "assistant.classify",
        "assistant.finalize",
    }
    spans = exporter.get_finished_spans()
    (root,) = named(spans, "assistant.agent")
    if header == "00-" + "1" * 32 + "-" + "2" * 16 + "-01":
        assert root.context.trace_id == int("1" * 32, 16)
        assert root.parent.span_id == int("2" * 16, 16)
    else:
        assert root.context.trace_id != int("1" * 32, 16)
    assert all(span.context.trace_id == root.context.trace_id for span in spans)
    assert all(span.parent.span_id == root.context.span_id for span in spans if span != root)
    assert "private-baggage" not in assert_private(spans, request_data)


@pytest.mark.parametrize("outcome,status", [(RuntimeError("private upstream detail"), 503), (HANG, 504)])
def test_http_failure_keeps_core_parent_and_unknown_usage(
    trace_environment, request_data, monkeypatch, outcome, status
):
    _, exporter, settings = trace_environment
    model = ScriptedChatModel(responses=[outcome])
    monkeypatch.setattr(bootstrap, "_chat_model", lambda *args: model)
    settings = replace(settings, public_key="pk-lf-" + uuid4().hex)
    app = create_app(settings=replace(
        OPENAI_SETTINGS, langfuse=settings, llm_model_timeout_seconds=0.05, llm_run_timeout_seconds=0.1,
    ))
    with TestClient(app) as client:
        response = client.post(
            "/internal/v1/assistant/agent", json=request_data,
            headers={"traceparent": "00-" + "3" * 32 + "-" + "4" * 16 + "-01"},
        )
        assert response.status_code == status
    model.assert_complete()
    spans = exporter.get_finished_spans()
    (root,) = named(spans, "assistant.agent")
    assert root.context.trace_id == int("3" * 32, 16)
    assert root.parent.span_id == int("4" * 16, 16)
    assert attribute(root, "usage_unknown_calls") == 1
    assert attribute(root, "usage_complete") is False
    assert attribute(root, "usage_input_tokens") is None
    assert root.attributes["langfuse.observation.level"] == "ERROR"
    assert_private(spans, request_data)
