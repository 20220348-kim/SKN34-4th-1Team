import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI

from app.support_program_evidence.errors import SupportProgramEvidenceError
from app.support_program_evidence.models import SupportProgramEvidenceBatchRequest, SupportProgramEvidenceSearchRequest
from app.support_program_evidence.router import router
from tests.langchain_stub import response_message
from tests.support_program_evidence.conftest import chunk, identity
from tests.support_program_evidence.test_agent import valid_selection
from tests.support_program_evidence.test_tracing import make_service, trace_environment as trace_environment


def metadata(span, key):
    return span.attributes.get("langfuse.observation.metadata." + key)


def assert_private(spans):
    exported = json.dumps([span.to_json() for span in spans], ensure_ascii=False)
    for private in ("PRIVATE", "private-test-key", "unit-test-not-a-real-key", valid_selection().answer):
        assert private not in exported
    assert all(not span.events for span in spans)


@pytest.mark.anyio
@pytest.mark.parametrize(
    "header",
    [None, "private-invalid", "00-" + "a" * 32 + "-" + "b" * 16 + "-00", "00-" + "a" * 32 + "-" + "b" * 16 + "-01"],
)
async def test_all_routes_validate_parent_and_keep_error_contract(header):
    service = SimpleNamespace(
        **{name: AsyncMock(side_effect=SupportProgramEvidenceError()) for name in ("index_chunks", "search", "answer")}
    )
    app = FastAPI()
    app.include_router(router)
    app.state.container = SimpleNamespace(
        support_program_evidence_service=service, support_program_evidence_answer_service=service
    )
    item = chunk("BIZINFO:PRIVATE", 0, "PRIVATE 원문")
    operations = [
        ("PUT", "chunks", "index_chunks", {"chunks": [item.model_dump(by_alias=True)]}),
        (
            "POST",
            "search",
            "search",
            {"question": "PRIVATE 질문", "eligibleChunks": [identity(item).model_dump(by_alias=True)], "limit": 1},
        ),
        (
            "POST",
            "answers",
            "answer",
            {"question": "PRIVATE 질문", "chunks": [item.model_dump(by_alias=True, exclude={"content_hash"})]},
        ),
    ]
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://internal") as client:
        for method, path, name, body in operations:
            response = await client.request(
                method,
                "/internal/v1/support-program-evidence/" + path,
                json=body,
                headers={"traceparent": header, "baggage": "PRIVATE"} if header else {},
            )
            assert response.status_code == 503
            assert response.json() == {"detail": {"code": "EVIDENCE_UNAVAILABLE"}}
            expected = {"trace_id": "a" * 32, "parent_span_id": "b" * 16} if header and header.endswith("-01") else {}
            assert getattr(service, name).await_args.kwargs == expected


@pytest.mark.anyio
async def test_three_http_routes_share_remote_trace_and_preserve_cache_hits(evidence_environment, trace_environment):
    service, embeddings = evidence_environment
    settings, exporter = trace_environment
    answer_service, tracing, model = make_service(settings)
    service._tracing = tracing
    model.outputs.append([response_message(valid_selection().model_dump_json(by_alias=True))])
    item = chunk("BIZINFO:PRIVATE-DOCUMENT", 0, "PRIVATE 접수 원문")
    app = FastAPI()
    app.include_router(router)
    app.state.container = SimpleNamespace(
        support_program_evidence_service=service, support_program_evidence_answer_service=answer_service
    )
    trace_id = uuid4().hex
    operations = [
        ("PUT", "chunks", {"chunks": [item.model_dump(by_alias=True)]}),
        (
            "POST",
            "search",
            {"question": "PRIVATE 접수 질문", "eligibleChunks": [identity(item).model_dump(by_alias=True)], "limit": 1},
        ),
        (
            "POST",
            "answers",
            {"question": "PRIVATE 접수 질문", "chunks": [item.model_dump(by_alias=True, exclude={"content_hash"})]},
        ),
    ]
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://internal") as client:
            for _ in range(2):
                for number, (method, path, body) in enumerate(operations, 1):
                    response = await client.request(
                        method,
                        "/internal/v1/support-program-evidence/" + path,
                        json=body,
                        headers={"traceparent": f"00-{trace_id}-{number:016x}-01", "baggage": "PRIVATE"},
                    )
                    assert response.status_code == 200
    finally:
        await tracing.close()
        await model.model.root_async_client.close()
    spans = exporter.get_finished_spans()
    assert len(spans) == 24
    assert all(span.context.trace_id == int(trace_id, 16) for span in spans)
    for name, parent in (("evidence.index", 1), ("evidence.search", 2), ("evidence.answer", 3)):
        roots = [span for span in spans if span.name == name]
        assert len(roots) == 2
        assert all(span.parent.span_id == parent for span in roots)
    by_id = {span.context.span_id: span for span in spans}
    for span in spans:
        if span.name not in {"evidence.index", "evidence.search", "evidence.answer"}:
            parent = by_id[span.parent.span_id]
            expected = (
                "evidence.index"
                if span.name.startswith("evidence.index.")
                else "evidence.search"
                if span.name.startswith("evidence.search.")
                else "evidence.answer"
            )
            assert parent.name == expected
    assert [metadata(span, "missing_count") for span in spans if span.name == "evidence.index"] == [1, 0]
    assert [metadata(span, "embedding_cache_state") for span in spans if span.name == "evidence.search"] == [
        "miss",
        "hit",
    ]
    assert len(embeddings.requests) == 2 and len(model.calls) == 2
    assert_private(spans)


@pytest.mark.anyio
@pytest.mark.parametrize("fault", ["timeout", "cancelled", "foreign-result", "not-ready"])
async def test_retrieval_failure_stage_and_parent_survive(evidence_environment, trace_environment, monkeypatch, fault):
    service, _ = evidence_environment
    settings, exporter = trace_environment
    _, tracing, model = make_service(settings)
    item = chunk("BIZINFO:PRIVATE-DOCUMENT", 0, "PRIVATE 접수 원문")
    await service.index_chunks(SupportProgramEvidenceBatchRequest(chunks=[item]))
    service._tracing = tracing
    query = SupportProgramEvidenceSearchRequest(question="PRIVATE 질문", eligibleChunks=[identity(item)], limit=1)
    entered = asyncio.Event()

    async def hanging(_):
        entered.set()
        await asyncio.Event().wait()

    if fault == "not-ready":
        monkeypatch.setattr(service.qdrant_client, "collection_exists", AsyncMock(return_value=False))
    elif fault == "foreign-result":
        monkeypatch.setattr(service.qdrant_client, "query_points", AsyncMock(return_value=SimpleNamespace(points=[])))
    else:
        monkeypatch.setattr(
            service,
            "_embed_query",
            hanging if fault == "cancelled" else AsyncMock(side_effect=TimeoutError("PRIVATE error")),
        )
    try:
        with pytest.raises(asyncio.CancelledError if fault == "cancelled" else SupportProgramEvidenceError):
            task = asyncio.create_task(service.search(query, trace_id="c" * 32, parent_span_id="d" * 16))
            if fault == "cancelled":
                await entered.wait()
                task.cancel()
            await task
    finally:
        await tracing.close()
        await model.model.root_async_client.close()
    spans = exporter.get_finished_spans()
    root = next(span for span in spans if span.name == "evidence.search")
    assert root.parent.span_id == int("d" * 16, 16)
    failed_stage = {
        "timeout": "embedding",
        "cancelled": "embedding",
        "foreign-result": "validate",
        "not-ready": "readiness",
    }[fault]
    failures = [span for span in spans if span.attributes.get("langfuse.observation.level") == "ERROR"]
    assert {span.name for span in failures} == {"evidence.search", "evidence.search." + failed_stage}
    assert all(
        metadata(span, "outcome") == (fault if fault in {"timeout", "cancelled"} else "failed") for span in failures
    )
    assert_private(spans)


@pytest.mark.anyio
async def test_index_exporter_failure_never_repeats_embedding_or_upsert(
    evidence_environment, trace_environment, monkeypatch
):
    service, embeddings = evidence_environment
    settings, _ = trace_environment
    _, tracing, model = make_service(settings)
    service._tracing = tracing
    calls = AsyncMock(wraps=service.qdrant_client.upsert)
    monkeypatch.setattr(service.qdrant_client, "upsert", calls)
    monkeypatch.setattr(
        tracing.client, "start_as_current_observation", lambda **kwargs: (_ for _ in ()).throw(RuntimeError("PRIVATE"))
    )
    try:
        result = await service.index_chunks(
            SupportProgramEvidenceBatchRequest(chunks=[chunk("BIZINFO:PRIVATE-DOC", 0, "PRIVATE 원문")])
        )
        assert result.indexed_count == 1 and calls.await_count == 1 and len(embeddings.requests) == 1
    finally:
        await tracing.close()
        await model.model.root_async_client.close()
