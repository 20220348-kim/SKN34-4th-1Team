import asyncio
import logging
from unittest.mock import AsyncMock

import httpx
import httpx2
import pytest
from openai import APIConnectionError, APITimeoutError
from qdrant_client import AsyncQdrantClient
from qdrant_client.http.exceptions import ResponseHandlingException

import app.support_program_index.service as service_module
from app.support_program_index.models import SupportProgramIndexBatchRequest, SupportProgramIndexSearchRequest
from app.support_program_index.service import SupportProgramIndexError
from .conftest import document, identity


async def prepared_search(service):
    item = document("BIZINFO:private-document", "서울 AI 비공개 원문")
    await service.index_batch(SupportProgramIndexBatchRequest(documents=[item]))
    return SupportProgramIndexSearchRequest(query="서울 AI 비공개 질문", eligibleDocuments=[identity(item)], limit=1)


def failure_records(caplog):
    return [record for record in caplog.records if record.name == service_module.__name__
            and record.getMessage().startswith("support_program_index_search_failed ")]


def assert_safe_failure(caplog, *, stage, code, outcome="failed"):
    records = failure_records(caplog)
    assert len(records) == 1
    record = records[0]
    message = record.getMessage()
    assert f"outcome={outcome} stage={stage} code={code} elapsed_ms=" in message
    assert int(message.rsplit("=", 1)[1]) >= 0
    assert "private" not in message and "비공개" not in message
    assert "embedding.test" not in message and "qdrant.test" not in message
    assert record.exc_info is None and record.stack_info is None


@pytest.mark.anyio
@pytest.mark.parametrize("stage", ["readiness", "embedding", "vector_search"])
async def test_search_timeout_is_explicit_at_each_stage_without_fallback(index_environment, monkeypatch, caplog, stage):
    service, _ = index_environment
    request = await prepared_search(service)
    if stage == "readiness":
        owner, name = service, "_require_all_indexed"
    elif stage == "embedding":
        owner, name = service.openai_client.embeddings.with_raw_response, "create"
    else:
        owner, name = service.qdrant_client, "query_points"
    failure = AsyncMock(side_effect=TimeoutError("private upstream response"))
    monkeypatch.setattr(owner, name, failure)

    with caplog.at_level(logging.INFO, logger=service_module.__name__):
        with pytest.raises(SupportProgramIndexError, match="^INDEX_TIMEOUT$"):
            await service.search(request)

    failure.assert_awaited_once()
    assert not service._query_embedding_locks
    if stage != "vector_search":
        assert not service._query_embedding_cache
    assert_safe_failure(caplog, stage=stage, code="INDEX_TIMEOUT")


@pytest.mark.anyio
@pytest.mark.parametrize("error", [
    APITimeoutError(httpx2.Request("POST", "https://embedding.test/private")),
    httpx.ReadTimeout("private HTTP read timeout"),
    httpx.ConnectTimeout("private HTTP connection timeout"),
    httpx.PoolTimeout("private HTTP pool timeout"),
    httpx.WriteTimeout("private HTTP write timeout"),
])
async def test_known_transport_timeouts_do_not_poison_query_cache(index_environment, monkeypatch, caplog, error):
    service, _ = index_environment
    request = await prepared_search(service)
    failed_create = AsyncMock(side_effect=error)
    with monkeypatch.context() as patch:
        patch.setattr(service.openai_client.embeddings.with_raw_response, "create", failed_create)
        with caplog.at_level(logging.INFO, logger=service_module.__name__):
            with pytest.raises(SupportProgramIndexError, match="^INDEX_TIMEOUT$"):
                await service.search(request)
    failed_create.assert_awaited_once()
    assert not service._query_embedding_cache and not service._query_embedding_locks
    assert_safe_failure(caplog, stage="embedding", code="INDEX_TIMEOUT")
    assert len((await service.search(request)).matches) == 1


@pytest.mark.anyio
async def test_real_qdrant_rest_sdk_timeout_wrapper_is_recognized(index_environment, monkeypatch, caplog):
    service, _ = index_environment
    request = await prepared_search(service)
    calls = []

    def fail_transport(http_request):
        calls.append(http_request)
        raise httpx.ReadTimeout("private Qdrant response", request=http_request)

    remote = AsyncQdrantClient(
        url="http://qdrant.test", check_compatibility=False,
        transport=httpx.MockTransport(fail_transport),
    )
    monkeypatch.setattr(service, "qdrant_client", remote)
    try:
        with caplog.at_level(logging.INFO, logger=service_module.__name__):
            with pytest.raises(SupportProgramIndexError, match="^INDEX_TIMEOUT$") as failure:
                await service.search(request)
        assert isinstance(failure.value.__cause__, ResponseHandlingException)
        assert isinstance(failure.value.__cause__.source, httpx.ReadTimeout)
        assert len(calls) == 1
        assert not service._query_embedding_cache
        assert_safe_failure(caplog, stage="readiness", code="INDEX_TIMEOUT")
    finally:
        await remote.close()


@pytest.mark.anyio
@pytest.mark.parametrize("error,expected_code", [
    (SupportProgramIndexError("INDEX_NOT_READY"), "INDEX_NOT_READY"),
    (ResponseHandlingException(ValueError("private malformed Qdrant response")), "INDEX_UNAVAILABLE"),
    (ResponseHandlingException(httpx.ConnectError("private refused connection")), "INDEX_UNAVAILABLE"),
    (APIConnectionError(request=httpx2.Request("POST", "https://embedding.test/private")), "INDEX_UNAVAILABLE"),
    (ValueError("timeout word in private non-timeout error"), "INDEX_UNAVAILABLE"),
])
async def test_other_failures_keep_their_existing_code(index_environment, monkeypatch, caplog, error, expected_code):
    service, _ = index_environment
    request = await prepared_search(service)
    monkeypatch.setattr(service, "_require_all_indexed", AsyncMock(side_effect=error))
    with caplog.at_level(logging.INFO, logger=service_module.__name__):
        with pytest.raises(SupportProgramIndexError, match=f"^{expected_code}$"):
            await service.search(request)
    assert_safe_failure(caplog, stage="readiness", code=expected_code)


@pytest.mark.anyio
async def test_expired_asyncio_search_deadline_is_not_reported_as_generic_unavailability(index_environment, monkeypatch, caplog):
    service, _ = index_environment
    request = await prepared_search(service)
    original_timeout = asyncio.timeout
    monkeypatch.setattr(service_module.asyncio, "timeout", lambda delay: original_timeout(0.01 if delay == 25 else delay))

    async def blocked_readiness(_point_ids):
        await asyncio.Event().wait()

    monkeypatch.setattr(service, "_require_all_indexed", blocked_readiness)
    with caplog.at_level(logging.INFO, logger=service_module.__name__):
        with pytest.raises(SupportProgramIndexError, match="^INDEX_TIMEOUT$"):
            await service.search(request)
    assert_safe_failure(caplog, stage="readiness", code="INDEX_TIMEOUT")


@pytest.mark.anyio
async def test_caller_cancellation_propagates_and_logs_without_becoming_timeout(index_environment, monkeypatch, caplog):
    service, _ = index_environment
    request = await prepared_search(service)
    started = asyncio.Event()

    async def blocked_embedding(**_kwargs):
        started.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(service.openai_client.embeddings.with_raw_response, "create", blocked_embedding)
    with caplog.at_level(logging.INFO, logger=service_module.__name__):
        task = asyncio.create_task(service.search(request))
        try:
            await asyncio.wait_for(started.wait(), timeout=1)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
    assert not service._query_embedding_cache and not service._query_embedding_locks
    assert_safe_failure(caplog, stage="embedding", code="INDEX_CANCELLED", outcome="cancelled")
