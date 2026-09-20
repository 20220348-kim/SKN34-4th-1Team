import threading
from types import SimpleNamespace

import pytest
import tiktoken

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
