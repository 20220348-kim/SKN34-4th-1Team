import asyncio
import json
from unittest.mock import AsyncMock, Mock

import httpx2
import pytest
from openai import AsyncOpenAI

from app.support_program_evidence.service import SupportProgramEvidenceService
from budget_client import BudgetUnavailable
from embedding_budget import EmbeddingBudget, embedding_operations


MODEL = "text-embedding-3-small"


def plan(texts, label="doc", kind="document_embedding"):
    return embedding_operations(
        texts, kind=kind, label=label, model=MODEL, dimensions=2, request_token_limit=2
    )


@pytest.mark.parametrize(
    "fault", [None, "unknown", "over", "settle", "approval", "timeout", "vectors"]
)
def test_real_embedding_service_batches_use_budget_and_stop_on_failure(fault):
    texts = ["hello", "world", "another"]
    operations = plan(texts)
    budget = Mock(authorize=AsyncMock(), settle=AsyncMock())
    if fault == "approval":
        budget.authorize.side_effect = BudgetUnavailable("denied")
    if fault == "settle":
        budget.settle.side_effect = BudgetUnavailable("lost response")
    guard = EmbeddingBudget(budget, operations)
    sent = []

    def respond(request):
        body = json.loads(request.content)
        sent.append(body)
        if fault == "timeout":
            raise httpx2.ReadTimeout("private-provider-error", request=request)
        tokens = len(body["input"])
        usage = (
            None
            if fault == "unknown"
            else {
                "prompt_tokens": tokens + (1 if fault == "over" else 0),
                "total_tokens": tokens + (1 if fault == "over" else 0),
            }
        )
        return httpx2.Response(
            200,
            json={
                "model": MODEL,
                "usage": usage,
                "data": [
                    {"index": i, "embedding": [0.0, 0.0] if fault == "vectors" else [1.0, 0.0]}
                    for i in range(tokens)
                ],
            },
        )

    async def run():
        async with AsyncOpenAI(
            api_key="fake",
            max_retries=0,
            base_url="https://api.openai.com/v1",
            http_client=httpx2.AsyncClient(
                transport=httpx2.MockTransport(respond),
                event_hooks={"request": [guard.before_request], "response": [guard.after_response]},
            ),
        ) as client:
            service = SupportProgramEvidenceService(
                client,
                Mock(),
                embedding_model=MODEL,
                embedding_dimensions=2,
                embedding_timeout_seconds=15,
                embedding_request_token_limit=2,
            )
            if fault:
                with pytest.raises(Exception):
                    await service._embed_chunks(texts)
                assert not service._chunk_embedding_cache
            else:
                first, hits = await service._embed_chunks(texts)
                second, hits = await service._embed_chunks(texts)
                assert first == second and hits == 3
                assert len(sent) == len(operations) == 2  # cache hits cause no authorization

    asyncio.run(run())
    if fault:
        assert len(sent) == (0 if fault == "approval" else 1)
    else:
        assert budget.authorize.await_count == budget.settle.await_count == 2
        assert budget.authorize.await_args_list[0].kwargs == {
            "operation_id": operations[0]["id"],
            "input_token_count": 2,
            "input_sha256": operations[0]["input_sha256"],
            "dimensions": 2,
        }
    if fault in {"unknown", "over"}:
        assert budget.settle.await_args.args[1] is None
    if fault == "vectors":
        assert budget.settle.await_args.args[1] == {
            "input_tokens": 2,
            "output_tokens": 0,
            "total_tokens": 2,
        }


@pytest.mark.parametrize("change", ["text", "model", "dimensions", "endpoint", "extra"])
def test_unapproved_payload_never_reaches_budget_or_provider(change):
    operations = plan(["hello"])
    budget = Mock(authorize=AsyncMock(), settle=AsyncMock())
    guard = EmbeddingBudget(budget, operations)
    body = {"model": MODEL, "input": ["hello"], "dimensions": 2, "encoding_format": "float"}
    url = "https://api.openai.com/v1/embeddings"
    if change == "text":
        body["input"] = ["secret-different"]
    if change == "model":
        body["model"] = "other"
    if change == "dimensions":
        body["dimensions"] = 3
    if change == "extra":
        body["user"] = "unexpected"
    if change == "endpoint":
        url = "https://not-openai.invalid/embeddings"
    with pytest.raises(BudgetUnavailable):
        asyncio.run(guard.before_request(httpx2.Request("POST", url, json=body)))
    budget.authorize.assert_not_called()
    assert guard.stopped


def test_cache_skips_cannot_reissue_a_previous_batch():
    operations = plan(["hello"]) + plan(["world"], label="query", kind="query_embedding")
    budget = Mock(authorize=AsyncMock(), settle=AsyncMock())
    guard = EmbeddingBudget(budget, operations)
    request = httpx2.Request(
        "POST",
        "https://api.openai.com/v1/embeddings",
        json={"model": MODEL, "input": ["world"], "dimensions": 2, "encoding_format": "float"},
    )

    async def run():
        await guard.before_request(request)
        assert budget.authorize.await_args.args[0] == 1
        await guard.after_response(
            httpx2.Response(
                200,
                request=request,
                json={"model": MODEL, "usage": {"prompt_tokens": 1, "total_tokens": 1}},
            )
        )
        with pytest.raises(BudgetUnavailable):
            await guard.before_request(request)

    asyncio.run(run())
    assert budget.authorize.await_count == 1


def test_settlement_failure_prevents_retry_and_later_batches():
    budget = Mock(authorize=AsyncMock(), settle=AsyncMock(side_effect=BudgetUnavailable("lost")))
    guard = EmbeddingBudget(budget, plan(["hello", "world", "another"]))
    request = httpx2.Request(
        "POST",
        "https://api.openai.com/v1/embeddings",
        json={
            "model": MODEL,
            "input": ["hello", "world"],
            "dimensions": 2,
            "encoding_format": "float",
        },
    )

    async def run():
        await guard.before_request(request)
        with pytest.raises(BudgetUnavailable):
            await guard.before_request(request)  # in flight approval cannot be reused
        with pytest.raises(BudgetUnavailable):
            await guard.after_response(
                httpx2.Response(
                    200,
                    request=request,
                    json={"model": MODEL, "usage": {"prompt_tokens": 2, "total_tokens": 2}},
                )
            )
        with pytest.raises(BudgetUnavailable):
            await guard.before_request(request)

    asyncio.run(run())
    assert budget.authorize.await_count == budget.settle.await_count == 1


def test_plan_copy_and_answer_barrier_prevent_implicit_skip():
    operations = [{"id": "answer:E01", "kind": "answer"}, *plan(["hello"])]
    budget = Mock(authorize=AsyncMock(), settle=AsyncMock())
    guard = EmbeddingBudget(budget, operations)
    operations[0]["kind"] = "document_embedding"
    request = httpx2.Request(
        "POST",
        "https://api.openai.com/v1/embeddings",
        json={"model": MODEL, "input": ["hello"], "dimensions": 2, "encoding_format": "float"},
    )
    with pytest.raises(BudgetUnavailable):
        asyncio.run(guard.before_request(request))
    budget.authorize.assert_not_called()


def test_later_batch_denial_preserves_first_settlement_without_more_transmission():
    budget = Mock(
        authorize=AsyncMock(side_effect=[None, BudgetUnavailable("cancelled")]), settle=AsyncMock()
    )
    guard = EmbeddingBudget(budget, plan(["hello", "world", "another"]))
    requests = [
        httpx2.Request(
            "POST",
            "https://api.openai.com/v1/embeddings",
            json={"model": MODEL, "input": inputs, "dimensions": 2, "encoding_format": "float"},
        )
        for inputs in (["hello", "world"], ["another"])
    ]

    async def run():
        await guard.before_request(requests[0])
        await guard.after_response(
            httpx2.Response(
                200,
                request=requests[0],
                json={"model": MODEL, "usage": {"prompt_tokens": 2, "total_tokens": 2}},
            )
        )
        with pytest.raises(BudgetUnavailable):
            await guard.before_request(requests[1])

    asyncio.run(run())
    assert budget.settle.await_count == 1 and guard.stopped
    assert budget.settle.await_args.args[1] == {
        "input_tokens": 2,
        "output_tokens": 0,
        "total_tokens": 2,
    }
