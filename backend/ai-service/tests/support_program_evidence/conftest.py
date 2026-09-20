import json
from hashlib import sha256
from os import environ
from uuid import uuid4

import httpx2
import pytest
from openai import AsyncOpenAI
from qdrant_client import AsyncQdrantClient

from app.support_program_evidence.models import (
    EvidenceChunkIdentity,
    SupportProgramEvidenceChunk,
)
from app.support_program_evidence.service import SupportProgramEvidenceService


@pytest.fixture
def anyio_backend():
    return "asyncio"


class EmbeddingHttpStub:
    def __init__(self) -> None:
        self.requests: list[dict] = []
        self.failure_status: int | None = None
        self.transform = lambda body: body

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        assert request.url.path == "/v1/embeddings"
        body = json.loads(request.content)
        self.requests.append(body)
        if self.failure_status:
            return httpx2.Response(
                self.failure_status,
                json={"error": {"message": "private failure detail", "type": "server_error"}},
            )
        embeddings = [
            {
                "object": "embedding",
                "index": index,
                "embedding": (
                    [1.0, 0.0, 0.0]
                    if "접수" in text or "서울 AI" in text
                    else [0.0, 1.0, 0.0]
                ),
            }
            for index, text in enumerate(body["input"])
        ]
        response = {
            "object": "list",
            "model": body["model"],
            "data": embeddings,
            "usage": {"prompt_tokens": 1, "total_tokens": 1},
        }
        return httpx2.Response(200, json=self.transform(response))


@pytest.fixture
async def evidence_environment():
    stub = EmbeddingHttpStub()
    openai = AsyncOpenAI(
        api_key="unit-test-not-a-real-key",
        base_url="https://embedding.test/v1",
        max_retries=0,
        http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(stub)),
    )
    url = environ.get("QDRANT_TEST_URL")
    qdrant = (
        AsyncQdrantClient(url=url, check_compatibility=False, timeout=5)
        if url
        else AsyncQdrantClient(location=":memory:")
    )
    service = SupportProgramEvidenceService(
        openai,
        qdrant,
        embedding_model="text-embedding-3-small",
        embedding_dimensions=3,
        embedding_timeout_seconds=10,
    )
    service.collection_name += "_test_" + uuid4().hex
    try:
        yield service, stub
    finally:
        if await qdrant.collection_exists(service.collection_name):
            await qdrant.delete_collection(service.collection_name)
        await qdrant.close()
        await openai.close()


def chunk(
    document_id: str,
    order: int,
    text: str,
    *,
    chunk_id: str | None = None,
) -> SupportProgramEvidenceChunk:
    return SupportProgramEvidenceChunk(
        id=chunk_id or sha256(f"{document_id}:{order}".encode()).hexdigest(),
        contentHash=sha256(text.encode("utf-8")).hexdigest(),
        documentId=document_id,
        order=order,
        text=text,
    )


def identity(chunk: SupportProgramEvidenceChunk) -> EvidenceChunkIdentity:
    return EvidenceChunkIdentity(
        id=chunk.id,
        contentHash=chunk.content_hash,
        documentId=chunk.document_id,
        order=chunk.order,
    )
