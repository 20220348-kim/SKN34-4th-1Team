import threading
from types import SimpleNamespace

import pytest
import tiktoken

from app.support_program_embedding import prepare_embedding_batches
from app.support_program_evidence.errors import SupportProgramEvidenceError
from app.support_program_index.service import SupportProgramIndexError

from app.support_program_evidence.service import SupportProgramEvidenceService
from app.support_program_index.service import SupportProgramIndexService


@pytest.mark.anyio
@pytest.mark.parametrize("service_type", [SupportProgramIndexService, SupportProgramEvidenceService])
async def test_embedding_tokenization_does_not_block_the_event_loop(service_type, monkeypatch):
    event_loop_thread = threading.get_ident()
    encoding = tiktoken.get_encoding("cl100k_base")
    tokenizer_threads = []
    requests = []

    class RecordingEncoding:
        def encode_ordinary(self, text):
            tokenizer_threads.append(threading.get_ident())
            return encoding.encode_ordinary(text)

        def decode(self, tokens):
            tokenizer_threads.append(threading.get_ident())
            return encoding.decode(tokens)

    monkeypatch.setattr(tiktoken, "get_encoding", lambda _: RecordingEncoding())

    async def create(**request):
        assert threading.get_ident() == event_loop_thread
        requests.append(request)
        return SimpleNamespace(http_response=SimpleNamespace(json=lambda: {
            "model": "text-embedding-3-small",
            "usage": {"prompt_tokens": 1, "total_tokens": 1},
            "data": [
                {"index": index, "embedding": [1.0, 0.0, 0.0]}
                for index in range(len(request["input"]))
            ],
        }))

    client = SimpleNamespace(embeddings=SimpleNamespace(with_raw_response=SimpleNamespace(create=create)))
    service = service_type(
        client, None, embedding_model="text-embedding-3-small",
        embedding_dimensions=3, embedding_timeout_seconds=1,
    )

    result = await service._embed(["서울 AI 지원", "힣" * 12_000])

    assert result == [[1.0, 0.0, 0.0], [1.0, 0.0, 0.0]]
    assert tokenizer_threads and all(thread != event_loop_thread for thread in tokenizer_threads)
    assert len(requests) == 1
    assert requests[0]["input"][0] == "서울 AI 지원"
    assert all(len(encoding.encode_ordinary(text)) <= 8191 for text in requests[0]["input"])
    assert requests[0]["dimensions"] == 3
    assert requests[0]["timeout"] == 1


def test_batches_respect_both_token_limit_and_item_limit_without_changing_text():
    texts = ["서울 지원", "부산 지원", "힣 특별", "line\nbreak"] * 20
    encoding = tiktoken.get_encoding("cl100k_base")
    for limit in (16, 262112):
        batches = prepare_embedding_batches(texts, limit)
        assert [text for batch, _ in batches for text in batch] == texts
        for batch, tokens in batches:
            assert len(batch) <= 32
            assert tokens == sum(len(encoding.encode_ordinary(text)) for text in batch)
            assert 0 < tokens <= limit
    assert [len(batch) for batch, _ in prepare_embedding_batches(["a"] * 33)] == [32, 1]
    assert prepare_embedding_batches(["a", "b", "c"], 2) == [(["a", "b"], 2), (["c"], 1)]


@pytest.fixture(params=[SupportProgramIndexService, SupportProgramEvidenceService])
def embedding_service(request):
    calls = []
    usage = {"prompt_tokens": 1, "total_tokens": 1}

    async def create(**body):
        calls.append(body)
        response = {"model": body["model"], "usage": usage.copy(), "data": [
            {"index": i, "embedding": [float(len(calls)), 0, 0]}
            for i in range(len(body["input"]))
        ]}
        return SimpleNamespace(http_response=SimpleNamespace(json=lambda: response))

    client = SimpleNamespace(embeddings=SimpleNamespace(with_raw_response=SimpleNamespace(create=create)))
    service = request.param(client, None, embedding_model="text-embedding-3-small",
                            embedding_dimensions=3, embedding_timeout_seconds=1,
                            embedding_request_token_limit=2)
    return service, calls, usage


@pytest.mark.anyio
async def test_services_send_token_bounded_batches_in_order(embedding_service):
    service, calls, _ = embedding_service
    assert await service._embed(["a", "b", "c"]) == [[1.0, 0, 0], [1.0, 0, 0], [2.0, 0, 0]]
    assert [call["input"] for call in calls] == [["a", "b"], ["c"]]


@pytest.mark.anyio
@pytest.mark.parametrize("texts", [["a", ""], ["a", "힣" * 10]])
async def test_preflight_rejects_invalid_late_input_before_any_http(embedding_service, texts):
    service, calls, _ = embedding_service
    with pytest.raises((SupportProgramEvidenceError, SupportProgramIndexError)):
        await service._embed(texts)
    assert not calls


@pytest.mark.anyio
@pytest.mark.parametrize("usage", [
    {}, {"prompt_tokens": None, "total_tokens": None},
    {"prompt_tokens": True, "total_tokens": True},
    {"prompt_tokens": -1, "total_tokens": -1},
    {"prompt_tokens": 1.5, "total_tokens": 1.5},
    {"prompt_tokens": "1", "total_tokens": "1"},
    {"prompt_tokens": 1, "total_tokens": 2},
    {"prompt_tokens": 1, "total_tokens": True},
    {"prompt_tokens": 3, "total_tokens": 3},
])
async def test_invalid_usage_stops_next_batch_and_never_populates_query_cache(embedding_service, usage):
    service, calls, response_usage = embedding_service
    response_usage.clear()
    response_usage.update(usage)
    with pytest.raises((SupportProgramEvidenceError, SupportProgramIndexError)):
        await service._embed(["a", "b", "c"])
    assert len(calls) == 1
    with pytest.raises((SupportProgramEvidenceError, SupportProgramIndexError)):
        await service._embed_query("a")
    assert not service._query_embedding_cache and not service._query_embedding_locks
    response_usage.update(prompt_tokens=1, total_tokens=1)
    assert (await service._embed_query("a"))[1] == "miss"
    assert len(calls) == 3


@pytest.mark.parametrize("limit", [True, 0, -1, 262113, 1.5, "100"])
def test_invalid_request_limits_are_not_silently_replaced(limit):
    with pytest.raises(ValueError):
        prepare_embedding_batches(["a"], limit)
