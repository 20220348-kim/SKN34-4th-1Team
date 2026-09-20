from hashlib import sha256
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.support_program_evidence.agent import SupportProgramEvidenceAnswerAgent
from app.support_program_evidence.errors import SupportProgramEvidenceError
from app.support_program_evidence.models import (
    SupportProgramEvidenceAnswerOutput,
    SupportProgramEvidenceAnswerRequest,
    SupportProgramEvidenceAnswerStatus,
)


TEST_SETTINGS = Settings(
    openai_api_key="test-key",
    openai_model="unused-model",
    llm_model_timeout_seconds=2.0,
    llm_run_timeout_seconds=2.5,
)


class FixedAnswerAgent(SupportProgramEvidenceAnswerAgent):
    def __init__(self, output: SupportProgramEvidenceAnswerOutput) -> None:
        self.output = output
        self.requests: list[SupportProgramEvidenceAnswerRequest] = []

    async def answer(
        self,
        request: SupportProgramEvidenceAnswerRequest,
    ) -> SupportProgramEvidenceAnswerOutput:
        self.requests.append(request)
        return self.output


def valid_chunk(
    *,
    document_id: str = "BIZINFO:PBLN:100",
    order: int = 0,
    text: str = "신청 접수 기간은 2026년 3월입니다.",
) -> dict[str, object]:
    return {
        "id": sha256(f"{document_id}:{order}".encode()).hexdigest(),
        "contentHash": sha256(text.encode("utf-8")).hexdigest(),
        "documentId": document_id,
        "order": order,
        "text": text,
    }


def valid_answer_body() -> dict[str, object]:
    item = valid_chunk()
    item.pop("contentHash")
    return {"question": "접수 기간이 언제인가요?", "chunks": [item]}


@pytest.fixture
def client():
    chunk_id = valid_chunk()["id"]
    assert isinstance(chunk_id, str)
    application = create_app(
        settings=TEST_SETTINGS,
        support_program_evidence_answer_agent=FixedAnswerAgent(
            SupportProgramEvidenceAnswerOutput(
                answer="접수 기간은 2026년 3월입니다.",
                answerStatus=SupportProgramEvidenceAnswerStatus.ANSWERED,
                citationChunkIds=[chunk_id],
            )
        ),
    )
    with TestClient(application) as test_client:
        yield test_client


@pytest.mark.parametrize(
    "mutation",
    [
        lambda body: body.update(chunks=[]),
        lambda body: body.update(chunks=body["chunks"] * 51),
        lambda body: body["chunks"].append(body["chunks"][0]),
        lambda body: body["chunks"][0].update(id="A" * 64),
        lambda body: body["chunks"][0].update(contentHash="0" * 64),
        lambda body: body["chunks"][0].update(documentId="bizinfo:PBLN:100"),
        lambda body: body["chunks"][0].update(documentId="BIZINFO:PBLN\n100"),
        lambda body: body["chunks"][0].update(documentId="BIZINFO:PBLN\u200b100"),
        lambda body: body["chunks"][0].update(documentId=f"BIZINFO:{'P' * 256}"),
        lambda body: body["chunks"][0].update(order=True),
        lambda body: body["chunks"][0].update(text=" " * 10),
        lambda body: body.update(extra="unexpected"),
    ],
)
def test_invalid_chunk_batches_are_rejected_before_external_calls(
    client,
    monkeypatch,
    mutation,
):
    method = AsyncMock()
    monkeypatch.setattr(
        client.app.state.container.support_program_evidence_service,
        "index_chunks",
        method,
    )
    body = {"chunks": [valid_chunk()]}
    mutation(body)
    response = client.put("/internal/v1/support-program-evidence/chunks", json=body)
    assert response.status_code == 422
    method.assert_not_called()


@pytest.mark.parametrize(
    "mutation",
    [
        lambda body: body.update(question="   "),
        lambda body: body.update(question="x" * 501),
        lambda body: body.update(eligibleChunks=[]),
        lambda body: body.update(eligibleChunks=body["eligibleChunks"] * 51),
        lambda body: body.update(limit=0),
        lambda body: body.update(limit=6),
        lambda body: body.update(limit=True),
        lambda body: body["eligibleChunks"][0].update(documentId="OTHER:"),
        lambda body: body["eligibleChunks"][0].update(id="0" * 63),
    ],
)
def test_invalid_evidence_search_contract_is_rejected(client, mutation):
    item = valid_chunk()
    item.pop("text")
    body = {"question": "접수 기간", "eligibleChunks": [item], "limit": 1}
    mutation(body)
    response = client.post("/internal/v1/support-program-evidence/search", json=body)
    assert response.status_code == 422


@pytest.mark.parametrize(
    "mutation",
    [
        lambda body: body.update(question="   "),
        lambda body: body.update(chunks=[]),
        lambda body: body.update(chunks=body["chunks"] * 6),
        lambda body: body["chunks"][0].update(id="not-a-hash"),
        lambda body: body["chunks"][0].update(documentId="BIZINFO: "),
        lambda body: body["chunks"][0].update(text="\u0000"),
    ],
)
def test_invalid_answer_contract_is_rejected_before_calling_the_agent(
    client,
    monkeypatch,
    mutation,
):
    method = AsyncMock()
    monkeypatch.setattr(
        client.app.state.container.support_program_evidence_answer_service,
        "answer",
        method,
    )
    body = valid_answer_body()
    mutation(body)
    response = client.post("/internal/v1/support-program-evidence/answers", json=body)
    assert response.status_code == 422
    method.assert_not_called()


def test_answers_with_only_the_agent_cited_chunk_ids(client):
    response = client.post(
        "/internal/v1/support-program-evidence/answers",
        json=valid_answer_body(),
    )

    assert response.status_code == 200
    assert response.json() == {
        "answer": "접수 기간은 2026년 3월입니다.",
        "answerStatus": "ANSWERED",
        "citationChunkIds": [valid_chunk()["id"]],
    }


def test_returns_insufficient_evidence_without_citations():
    application = create_app(
        settings=TEST_SETTINGS,
        support_program_evidence_answer_agent=FixedAnswerAgent(
            SupportProgramEvidenceAnswerOutput(
                answer="제공된 근거만으로는 확인하기 어렵습니다.",
                answerStatus=SupportProgramEvidenceAnswerStatus.INSUFFICIENT_EVIDENCE,
                citationChunkIds=[],
            )
        ),
    )
    with TestClient(application) as client:
        response = client.post(
            "/internal/v1/support-program-evidence/answers",
            json=valid_answer_body(),
        )

    assert response.status_code == 200
    assert response.json()["answerStatus"] == "INSUFFICIENT_EVIDENCE"
    assert response.json()["citationChunkIds"] == []


def test_rejects_an_agent_citation_that_was_not_in_the_request():
    outsider_id = sha256(b"outsider").hexdigest()
    application = create_app(
        settings=TEST_SETTINGS,
        support_program_evidence_answer_agent=FixedAnswerAgent(
            SupportProgramEvidenceAnswerOutput(
                answer="외부 근거를 인용했습니다.",
                answerStatus="ANSWERED",
                citationChunkIds=[outsider_id],
            )
        ),
    )
    with TestClient(application) as client:
        response = client.post(
            "/internal/v1/support-program-evidence/answers",
            json=valid_answer_body(),
        )

    assert response.status_code == 503
    assert response.json() == {"detail": {"code": "EVIDENCE_UNAVAILABLE"}}


def test_revalidates_answer_status_and_citation_invariants_after_agent_execution():
    invalid_output = SupportProgramEvidenceAnswerOutput.model_construct(
        answer="근거가 있다고 잘못 표시했습니다.",
        answer_status=SupportProgramEvidenceAnswerStatus.ANSWERED,
        citation_chunk_ids=[],
    )
    application = create_app(
        settings=TEST_SETTINGS,
        support_program_evidence_answer_agent=FixedAnswerAgent(invalid_output),
    )
    with TestClient(application) as client:
        response = client.post(
            "/internal/v1/support-program-evidence/answers",
            json=valid_answer_body(),
        )

    assert response.status_code == 503
    assert response.json() == {"detail": {"code": "EVIDENCE_UNAVAILABLE"}}


@pytest.mark.parametrize(
    "path,method,payload",
    [
        ("/chunks", "index_chunks", {"chunks": [valid_chunk()]}),
        (
            "/search",
            "search",
            {
                "question": "접수 기간",
                "eligibleChunks": [{key: value for key, value in valid_chunk().items() if key != "text"}],
                "limit": 1,
            },
        ),
        ("/answers", "answer", valid_answer_body()),
    ],
)
def test_evidence_failures_are_safe_503(client, monkeypatch, path, method, payload):
    target = (
        client.app.state.container.support_program_evidence_answer_service
        if method == "answer"
        else client.app.state.container.support_program_evidence_service
    )
    monkeypatch.setattr(
        target,
        method,
        AsyncMock(side_effect=SupportProgramEvidenceError()),
    )
    request = client.put if path == "/chunks" else client.post
    response = request("/internal/v1/support-program-evidence" + path, json=payload)
    assert response.status_code == 503
    assert response.json() == {"detail": {"code": "EVIDENCE_UNAVAILABLE"}}


def test_not_ready_is_distinct_from_external_failure(client, monkeypatch):
    monkeypatch.setattr(
        client.app.state.container.support_program_evidence_service,
        "search",
        AsyncMock(side_effect=SupportProgramEvidenceError("EVIDENCE_NOT_READY")),
    )
    item = valid_chunk()
    item.pop("text")
    response = client.post(
        "/internal/v1/support-program-evidence/search",
        json={"question": "접수 기간", "eligibleChunks": [item], "limit": 1},
    )
    assert response.status_code == 503
    assert response.json() == {"detail": {"code": "EVIDENCE_NOT_READY"}}
