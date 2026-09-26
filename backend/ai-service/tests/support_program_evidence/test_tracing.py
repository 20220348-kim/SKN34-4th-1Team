import asyncio
from dataclasses import replace
import json
from uuid import uuid4

from fastapi.testclient import TestClient
from langfuse import Langfuse
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
import pytest

from app.config import LangfuseSettings, SettingsConfigurationError
from app.main import create_app
from app.support_program_evidence.agent import SupportProgramEvidenceAnswerAgent
from app.support_program_evidence.answer_service import SupportProgramEvidenceAnswerService
from app.support_program_evidence.errors import SupportProgramEvidenceError
from app.support_program_evidence import tracing as tracing_module
from tests.langchain_stub import ResponsesChatStub, response_message
from tests.support_program_evidence.test_agent import answer_request, valid_selection
from tests.test_bootstrap import OPENAI_SETTINGS


@pytest.fixture
def trace_environment(monkeypatch):
    exporter = InMemorySpanExporter()
    monkeypatch.setattr(tracing_module, "Langfuse", lambda **kwargs: Langfuse(**kwargs, span_exporter=exporter))
    settings = LangfuseSettings(enabled=True, base_url="http://localhost:13000",
                                public_key="pk-lf-" + uuid4().hex, secret_key="private-test-key")
    return settings, exporter


def make_service(settings, output=None):
    tracing = tracing_module.EvidenceTracing(settings)
    stub = ResponsesChatStub([[response_message(output or valid_selection().model_dump_json(by_alias=True))]])
    agent = SupportProgramEvidenceAnswerAgent(model=stub.model, model_timeout_seconds=10,
                                              run_timeout_seconds=15, tracing=tracing)
    return SupportProgramEvidenceAnswerService(agent, tracing), tracing, stub


@pytest.mark.anyio
async def test_parallel_traces_link_model_and_validation_without_bodies(trace_environment):
    settings, exporter = trace_environment
    service, tracing, stub = make_service(settings)
    stub.outputs.append([response_message(valid_selection().model_dump_json(by_alias=True))])
    await asyncio.gather(service.answer(answer_request()), service.answer(answer_request()))
    await tracing.close()
    spans = exporter.get_finished_spans()
    assert len(spans) == 4
    roots = [span for span in spans if span.name == "evidence.answer"]
    models = [span for span in spans if span.name == "evidence.model"]
    assert len({span.context.trace_id for span in roots}) == 2
    for root in roots:
        model = next(span for span in models if span.context.trace_id == root.context.trace_id)
        assert model.parent.span_id == root.context.span_id
        assert root.attributes["langfuse.observation.metadata.validation_passed"] is True
        assert root.attributes["langfuse.observation.metadata.prompt_sha256"] == tracing_module.PROMPT_HASH
    exported = json.dumps([span.to_json() for span in spans], ensure_ascii=False)
    for private in [answer_request().question, answer_request().chunks[0].text, valid_selection().answer, settings.secret_key]:
        assert private not in exported
    assert all(not span.events for span in spans)


@pytest.mark.anyio
@pytest.mark.parametrize("kind", ["invalid-citation", "timeout", "cancelled", "insufficient"])
async def test_failures_and_insufficient_evidence_remain_distinct(trace_environment, kind):
    settings, exporter = trace_environment
    output = valid_selection().model_dump(by_alias=True)
    if kind == "invalid-citation":
        output["citationChunkIndexes"] = [99]
    if kind == "insufficient":
        output.update(answerStatus="INSUFFICIENT_EVIDENCE", citationChunkIndexes=[])
    service, tracing, stub = make_service(settings, json.dumps(output))
    if kind in {"timeout", "cancelled"}:
        entered = asyncio.Event()
        async def fail(_):
            if kind == "timeout":
                raise TimeoutError("private upstream text")
            entered.set()
            await asyncio.Event().wait()
        stub.outputs = [fail]
    try:
        if kind == "insufficient":
            assert (await service.answer(answer_request())).answer_status.value == "INSUFFICIENT_EVIDENCE"
        else:
            with pytest.raises(asyncio.CancelledError if kind == "cancelled" else SupportProgramEvidenceError):
                if kind == "cancelled":
                    pending = asyncio.create_task(service.answer(answer_request()))
                    await entered.wait()
                    pending.cancel()
                    await pending
                else:
                    await service.answer(answer_request())
    finally:
        await tracing.close()
    spans = exporter.get_finished_spans()
    root = next(span for span in spans if span.name == "evidence.answer")
    if kind == "insufficient":
        assert root.attributes["langfuse.observation.metadata.outcome"] == "completed"
    else:
        expected = "failed" if kind == "invalid-citation" else kind
        assert root.attributes["langfuse.observation.status_message"] == expected
    assert len(stub.calls) == 1
    assert "private upstream" not in str([span.to_json() for span in spans])
    assert all(not span.events for span in spans)


@pytest.mark.anyio
async def test_telemetry_failure_does_not_repeat_or_fail_model_call(trace_environment, monkeypatch, caplog):
    settings, _ = trace_environment
    service, tracing, stub = make_service(settings)
    def broken(**kwargs):
        raise RuntimeError("private instrumentation text")
    monkeypatch.setattr(tracing.client, "start_as_current_observation", broken)
    assert (await service.answer(answer_request())).answer_status.value == "ANSWERED"
    assert len(stub.calls) == 1
    assert "evidence_trace_start_failed" in caplog.text
    assert "private instrumentation text" not in caplog.text
    await tracing.close()


@pytest.mark.anyio
async def test_disabled_tracing_never_creates_client(monkeypatch):
    def forbidden(**kwargs):
        pytest.fail("Disabled tracing must not initialize an exporter")
    monkeypatch.setattr(tracing_module, "Langfuse", forbidden)
    service, tracing, stub = make_service(LangfuseSettings())
    await service.answer(answer_request())
    await tracing.close()
    assert len(stub.calls) == 1


@pytest.mark.anyio
async def test_export_mask_removes_body_and_filters_unrelated_spans(trace_environment):
    settings, exporter = trace_environment
    tracing = tracing_module.EvidenceTracing(settings)
    with tracing.observation("evidence.model", input="private input", output="private output"):
        pass
    with tracing.client.start_as_current_observation(name="unrelated", input="private other feature"):
        pass
    await tracing.close()
    # 종료가 두 번 호출되어도 SDK의 공용 queue에 종료 신호를 다시 넣지 않는다.
    await tracing.close()
    spans = exporter.get_finished_spans()
    assert len(spans) == 1
    assert "private" not in spans[0].to_json()


@pytest.mark.anyio
async def test_service_citation_validation_is_inside_trace(trace_environment, monkeypatch):
    from tests.support_program_evidence.test_agent import valid_output
    from unittest.mock import AsyncMock
    settings, exporter = trace_environment
    service, tracing, stub = make_service(settings)
    foreign = valid_output().model_copy(update={"citation_chunk_ids": ["a" * 64]})
    monkeypatch.setattr(service._agent, "answer", AsyncMock(return_value=foreign))
    with pytest.raises(SupportProgramEvidenceError):
        await service.answer(answer_request())
    await tracing.close()
    root, = exporter.get_finished_spans()
    assert root.attributes["langfuse.observation.status_message"] == "failed"
    assert not stub.calls


def test_http_bootstrap_uses_same_tracing_and_closes_it(trace_environment):
    settings, exporter = trace_environment
    stub = ResponsesChatStub([[response_message(valid_selection().model_dump_json(by_alias=True))]])
    app = create_app(settings=replace(OPENAI_SETTINGS, langfuse=settings))
    container = app.state.container
    agent = container.support_program_evidence_answer_service._agent
    agent._model = stub.model.bind(max_tokens=2000, store=False, reasoning={"effort": "none"})
    with TestClient(app) as client:
        response = client.post("/internal/v1/support-program-evidence/answers", json=answer_request().model_dump(by_alias=True))
        assert response.status_code == 200
    assert {span.name for span in exporter.get_finished_spans()} == {"evidence.answer", "evidence.model"}


@pytest.mark.parametrize("changes", [
    {"base_url": None}, {"base_url": "https://user:secret@example.test"},
    {"secret_key": None}, {"environment": "private body with spaces"}, {"release": "invalid-git-sha"},
])
def test_enabled_configuration_rejects_missing_or_unsafe_values(changes):
    fields = dict(enabled=True, base_url="http://localhost:13000", public_key="pk-test", secret_key="sk-test")
    fields.update(changes)
    with pytest.raises(SettingsConfigurationError):
        LangfuseSettings(**fields)


def test_explicit_environment_switch_and_secret_repr(monkeypatch):
    monkeypatch.setenv("LANGFUSE_ENABLED", "maybe")
    with pytest.raises(SettingsConfigurationError):
        LangfuseSettings.from_environment()
    assert "private-key" not in repr(LangfuseSettings(secret_key="private-key"))
