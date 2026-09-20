import asyncio

import pytest

from tests.langchain_stub import ResponsesChatStub


@pytest.fixture(autouse=True)
def close_langchain_stub_clients():
    yield
    clients, ResponsesChatStub.clients = ResponsesChatStub.clients, []
    async def close():
        for client in clients:
            await client.close()
    if clients:
        asyncio.run(close())
