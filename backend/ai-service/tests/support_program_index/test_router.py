from hashlib import sha256
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.support_program_index.service import SupportProgramIndexError


@pytest.fixture
def client():
    application = create_app(settings=Settings(
        openai_api_key="test-key", openai_model="test-model",
        llm_model_timeout_seconds=1, llm_run_timeout_seconds=1,
    ))
    with TestClient(application) as client:
        yield client


def valid_document():
    text = "서울 AI 기업 지원"
    return {"id": "BIZINFO:A", "text": text, "contentHash": sha256(text.encode()).hexdigest()}


@pytest.mark.parametrize("mutation", [
    lambda body: body.update(documents=[]),
    lambda body: body.update(documents=body["documents"] * 51),
    lambda body: body["documents"].append(body["documents"][0]),
    lambda body: body["documents"][0].update(id="BIZINFO:"),
    lambda body: body["documents"][0].update(id="BIZINFO: "),
    lambda body: body["documents"][0].update(id="BIZINFO: PBLN_001"),
    lambda body: body["documents"][0].update(id="BIZINFO:PBLN_001 "),
    lambda body: body["documents"][0].update(id="BIZINFO:A\n"),
    lambda body: body["documents"][0].update(id="BIZINFO:PBLN\u200b_001"),
    lambda body: body["documents"][0].update(id=f"BIZINFO:{'P' * 256}"),
    lambda body: body["documents"][0].update(contentHash="0" * 64),
    lambda body: body["documents"][0].update(text=" " * 10),
    lambda body: body["documents"][0].update(text="x" * 12_001),
    lambda body: body.update(extra="unexpected"),
])
def test_invalid_batches_are_rejected_before_external_calls(client, monkeypatch, mutation):
    method = AsyncMock()
    monkeypatch.setattr(client.app.state.container.support_program_index_service, "index_batch", method)
    body = {"documents": [valid_document()]}
    mutation(body)
    assert client.put("/internal/v1/support-program-index/batch", json=body).status_code == 422
    method.assert_not_called()


@pytest.mark.parametrize("mutation", [
    lambda body: body.update(query="   "),
    lambda body: body.update(query="x" * 1_001),
    lambda body: body.update(limit=0),
    lambda body: body.update(limit=21),
    lambda body: body.update(limit=True),
    lambda body: body.update(eligibleDocuments=body["eligibleDocuments"] * 2),
])
def test_invalid_search_contract_is_rejected(client, mutation):
    item = valid_document()
    item.pop("text")
    body = {"query": "서울 AI", "eligibleDocuments": [item], "limit": 20}
    mutation(body)
    assert client.post("/internal/v1/support-program-index/search", json=body).status_code == 422


def test_prune_rejects_wrong_source_document(client):
    item = valid_document()
    item.pop("text")
    response = client.post("/internal/v1/support-program-index/prune", json={"sourceCode": "OTHER", "documents": [item]})
    assert response.status_code == 422


@pytest.mark.parametrize("path,method,payload", [
    ("/batch", "index_batch", {"documents": [valid_document()]}),
    ("/prune", "prune", {"sourceCode": "BIZINFO", "documents": []}),
    ("/search", "search", {"query": "서울 AI", "eligibleDocuments": [], "limit": 20}),
])
def test_index_failures_are_safe_503(client, monkeypatch, path, method, payload):
    monkeypatch.setattr(client.app.state.container.support_program_index_service, method, AsyncMock(side_effect=SupportProgramIndexError()))
    request = client.put if path == "/batch" else client.post
    response = request("/internal/v1/support-program-index" + path, json=payload)
    assert response.status_code == 503
    assert response.json() == {"detail": {"code": "INDEX_UNAVAILABLE"}}


def test_not_ready_is_distinct_from_external_failure(client, monkeypatch):
    monkeypatch.setattr(client.app.state.container.support_program_index_service, "search", AsyncMock(side_effect=SupportProgramIndexError("INDEX_NOT_READY")))
    response = client.post("/internal/v1/support-program-index/search", json={"query": "서울 AI", "eligibleDocuments": [], "limit": 20})
    assert response.status_code == 503
    assert response.json() == {"detail": {"code": "INDEX_NOT_READY"}}


def test_empty_search_returns_contract_without_network(client):
    response = client.post("/internal/v1/support-program-index/search", json={"query": " 서울 AI ", "eligibleDocuments": [], "limit": 20})
    assert response.status_code == 200
    assert response.json() == {"query": "서울 AI", "matches": []}


@pytest.mark.parametrize("length", [501, 1_000])
def test_internal_query_accepts_company_condition_context_without_network(client, length):
    query = "가" * length
    response = client.post(
        "/internal/v1/support-program-index/search",
        json={"query": query, "eligibleDocuments": [], "limit": 20},
    )
    assert response.status_code == 200
    assert response.json() == {"query": query, "matches": []}


@pytest.mark.parametrize("path,method,http_status,payload", [
    ("/search", "search", 504, {"query": "서울 AI", "eligibleDocuments": [], "limit": 20}),
    ("/batch", "index_batch", 503, {"documents": [valid_document()]}),
    ("/prune", "prune", 503, {"sourceCode": "BIZINFO", "documents": []}),
])
def test_only_search_exposes_the_timeout_as_504(client, monkeypatch, path, method, http_status, payload):
    monkeypatch.setattr(
        client.app.state.container.support_program_index_service, method,
        AsyncMock(side_effect=SupportProgramIndexError("INDEX_TIMEOUT")),
    )
    request = client.put if path == "/batch" else client.post
    response = request("/internal/v1/support-program-index" + path, json=payload)
    assert response.status_code == http_status
    assert response.json() == {"detail": {"code": "INDEX_TIMEOUT"}}
