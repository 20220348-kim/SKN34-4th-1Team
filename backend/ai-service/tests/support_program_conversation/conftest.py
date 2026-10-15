import asyncio
from types import SimpleNamespace

import pytest

from app import support_program_llm
from app.support_program_conversation import agent as conversation_agent
from app.support_program_conversation.models import SCHEMA_VERSION


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def conversation_deadlines(monkeypatch):
    """HTTP 스텁 진입 뒤 실제 Timeout을 만료시켜 CI 스케줄링 속도와 분리한다."""
    deadlines = {}

    def timeout(seconds):
        name = {10: "model", 20: "run"}[seconds]
        assert name not in deadlines
        deadlines[name] = asyncio.timeout(None)
        return deadlines[name]

    controlled_asyncio = SimpleNamespace(timeout=timeout, CancelledError=asyncio.CancelledError)
    monkeypatch.setattr(conversation_agent, "asyncio", controlled_asyncio)
    monkeypatch.setattr(support_program_llm, "asyncio", controlled_asyncio)
    return deadlines


@pytest.fixture
def request_data():
    return {
        "schemaVersion": SCHEMA_VERSION,
        "message": "부산으로 변경",
        "context": {
            "query": "사업화 지원", "acceptingOnly": True,
            "companyConditions": {"region": "서울", "industry": "SW", "establishedOn": "2024-01-01", "supportPurpose": "사업화"},
        },
        "pendingClarification": None,
        "pendingProposal": None,
        "lastSearch": None,
        "referenceDate": "2026-09-07",
    }


@pytest.fixture
def output_data():
    return {
        "status": "READY",
        "updates": [{"field": "REGION", "operation": "SET", "value": "부산", "evidence": "부산"}],
        "answerKind": None,
        "clarificationKind": None,
    }
