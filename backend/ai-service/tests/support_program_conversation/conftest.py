import pytest

from app.support_program_conversation.models import SCHEMA_VERSION


@pytest.fixture
def anyio_backend():
    return "asyncio"


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
        "clarificationQuestion": None,
        "answer": None,
    }
