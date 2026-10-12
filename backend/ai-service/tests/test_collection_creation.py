import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from qdrant_client import models
from qdrant_client.http.exceptions import UnexpectedResponse

from app.support_program_evidence.errors import SupportProgramEvidenceError
from app.support_program_evidence.service import SupportProgramEvidenceService
from app.support_program_index.service import SupportProgramIndexError, SupportProgramIndexService


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(params=[
    (SupportProgramIndexService, SupportProgramIndexError),
    (SupportProgramEvidenceService, SupportProgramEvidenceError),
])
def collection_service(request):
    service_type, error_type = request.param
    vectors = models.VectorParams(size=3, distance=models.Distance.COSINE)
    qdrant = SimpleNamespace(
        collection_exists=AsyncMock(return_value=False),
        create_collection=AsyncMock(),
        get_collection=AsyncMock(return_value=SimpleNamespace(config=SimpleNamespace(params=SimpleNamespace(vectors=vectors)))),
    )

    def new_replica():
        return service_type(None, qdrant, embedding_model="text-embedding-3-small",
                            embedding_dimensions=3, embedding_timeout_seconds=10)

    return new_replica, qdrant, error_type


def response_error(status):
    return UnexpectedResponse(status, "error", b"{}", httpx.Headers())


@pytest.mark.anyio
async def test_replicas_share_concurrently_created_collection(collection_service):
    new_replica, qdrant, _ = collection_service
    both_checked = asyncio.Event()
    checked = 0
    created = False

    async def absent(_):
        nonlocal checked
        checked += 1
        if checked == 2:
            both_checked.set()
        await both_checked.wait()
        return False

    async def create(**_):
        nonlocal created
        if created:
            raise response_error(409)
        created = True
        return True

    qdrant.collection_exists.side_effect = absent
    qdrant.create_collection.side_effect = create
    await asyncio.gather(new_replica()._ensure_collection(), new_replica()._ensure_collection())

    assert qdrant.create_collection.await_count == 2
    assert qdrant.get_collection.await_count == 2


@pytest.mark.anyio
async def test_conflicting_collection_still_requires_matching_schema(collection_service):
    new_replica, qdrant, error_type = collection_service
    qdrant.create_collection.side_effect = response_error(409)
    qdrant.get_collection.return_value.config.params.vectors = models.VectorParams(size=4, distance=models.Distance.COSINE)

    with pytest.raises(error_type):
        await new_replica()._ensure_collection()


@pytest.mark.anyio
@pytest.mark.parametrize("failure", [response_error(401), response_error(500), TimeoutError()])
async def test_other_creation_failures_are_not_hidden(collection_service, failure):
    new_replica, qdrant, _ = collection_service
    qdrant.create_collection.side_effect = failure

    with pytest.raises(type(failure)) as result:
        await new_replica()._ensure_collection()

    assert result.value is failure
    qdrant.get_collection.assert_not_awaited()
