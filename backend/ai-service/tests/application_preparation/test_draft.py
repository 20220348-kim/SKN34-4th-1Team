import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from .model_fixture import make_model
from pydantic import ValidationError
from fastapi.testclient import TestClient

from app.application_preparation.agent import ApplicationPreparationAgent
from app.application_preparation.draft_prompt import DRAFT_PROMPT_VERSION
from app.application_preparation.models import DraftRequest, DraftSelection
from app.application_preparation.service import ApplicationPreparationError, ApplicationPreparationService
from .test_interpretation import FIXTURES
from app.config import Settings
from app.main import create_app


def request_data():
    return json.loads((FIXTURES / "draft-contract-request.json").read_text(encoding="utf-8"))


def test_langchain_produces_shared_contract_and_explicit_unknown():
    selection = {"content": "업체명은 새봄테크 & 연구소입니다.", "usedFieldKeys": ["company-name"]}
    model = make_model(selection)
    agent = ApplicationPreparationAgent(model=model, run_timeout_seconds=3)
    result = asyncio.run(ApplicationPreparationService(agent, "test-model").draft(DraftRequest.model_validate(request_data())))
    expected = json.loads((FIXTURES / "draft-contract-response.json").read_text(encoding="utf-8"))
    expected["promptVersion"] = DRAFT_PROMPT_VERSION
    assert result == expected
    assert len(model.calls) == 1


@pytest.mark.parametrize("keys", [[], ["invented"], ["company-name", "company-name"], ["company-name", "contact-person"]])
def test_rejects_missing_invented_duplicate_or_unknown_fact_references(keys):
    agent = SimpleNamespace(draft=AsyncMock(return_value=DraftSelection(content="문안", usedFieldKeys=keys)))
    with pytest.raises(ApplicationPreparationError, match="APPLICATION_PREPARATION_FAILED"):
        asyncio.run(ApplicationPreparationService(agent, "test-model").draft(DraftRequest.model_validate(request_data())))


@pytest.mark.parametrize("mutation", ["missing", "duplicate", "unsupported"])
def test_rejects_unconfirmed_required_facts_and_invalid_keys(mutation):
    data = request_data()
    if mutation == "missing":
        data["currentFacts"].pop()
    elif mutation == "duplicate":
        data["currentFacts"].append(data["currentFacts"][0])
    else:
        data["currentFacts"][0]["fieldKey"] = "invented"
    with pytest.raises(ValidationError):
        DraftRequest.model_validate(data)


@pytest.mark.parametrize(("error", "code"), [(TimeoutError(), "APPLICATION_PREPARATION_TIMEOUT"), (RuntimeError(), "APPLICATION_PREPARATION_FAILED")])
def test_failures_are_explicit_without_fallback(error, code):
    agent = SimpleNamespace(draft=AsyncMock(side_effect=error))
    with pytest.raises(ApplicationPreparationError, match=code):
        asyncio.run(ApplicationPreparationService(agent, "test-model").draft(DraftRequest.model_validate(request_data())))
    assert agent.draft.call_count == 1


@pytest.mark.parametrize(("error", "status"), [(None, 200), (TimeoutError(), 504), (RuntimeError(), 503)])
def test_internal_draft_route_exposes_metadata_and_explicit_errors(error, status):
    app = create_app(settings=Settings(openai_api_key="unused", openai_model="test-model", llm_model_timeout_seconds=2, llm_run_timeout_seconds=3))
    agent = SimpleNamespace(draft=AsyncMock(return_value=DraftSelection(content="새봄테크 & 연구소", usedFieldKeys=["company-name"]), side_effect=error))
    app.state.container.application_preparation_service = ApplicationPreparationService(agent, "test-model")
    with TestClient(app) as client:
        assert client.get("/internal/v1/application-preparations/draft/configuration").json()["promptVersion"] == DRAFT_PROMPT_VERSION
        response = client.post("/internal/v1/application-preparations/draft", json=request_data())
        assert response.status_code == status
        if status == 200:
            assert response.json()["sectionKey"] == "company-overview"
            assert response.json()["content"].endswith("담당자: 미정")
        data = request_data()
        data["currentFacts"] = []
        assert client.post("/internal/v1/application-preparations/draft", json=data).status_code == 422
    assert agent.draft.call_count == 1
