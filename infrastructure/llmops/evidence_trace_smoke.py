"""합성 Core 부모 아래 근거 색인·검색·답변의 Langfuse 저장·재조회를 검증한다."""

from types import SimpleNamespace
from uuid import uuid4

import httpx
import httpx2
from fastapi import FastAPI
from openai import AsyncOpenAI
from qdrant_client import AsyncQdrantClient

from app.support_program_evidence.agent import SupportProgramEvidenceAnswerAgent
from app.support_program_evidence.answer_service import SupportProgramEvidenceAnswerService
from app.support_program_evidence.router import router
from app.support_program_evidence.service import SupportProgramEvidenceService
from tests.langchain_stub import ResponsesChatStub, response_message
from tests.support_program_evidence.conftest import EmbeddingHttpStub, chunk, identity
from tests.support_program_evidence.test_agent import valid_selection


async def evidence_trace_examples(tracing):
    embeddings = EmbeddingHttpStub()
    openai = AsyncOpenAI(
        api_key="test-key-never-sent",
        base_url="https://embedding.test/v1",
        max_retries=0,
        http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(embeddings)),
    )
    qdrant = AsyncQdrantClient(location=":memory:")
    service = SupportProgramEvidenceService(
        openai,
        qdrant,
        embedding_model="text-embedding-3-small",
        embedding_dimensions=3,
        embedding_timeout_seconds=10,
        tracing=tracing,
    )
    model = ResponsesChatStub([[response_message(valid_selection().model_dump_json(by_alias=True))]] * 2)
    agent = SupportProgramEvidenceAnswerAgent(
        model=model.model,
        model_timeout_seconds=10,
        run_timeout_seconds=15,
        tracing=tracing,
    )
    app = FastAPI()
    app.include_router(router)
    app.state.container = SimpleNamespace(
        support_program_evidence_service=service,
        support_program_evidence_answer_service=SupportProgramEvidenceAnswerService(agent, tracing),
    )
    item = chunk("BIZINFO:PRIVATE-SMOKE", 0, "PRIVATE-SMOKE 접수 원문")
    question = "PRIVATE-SMOKE 접수 질문"
    search = {"question": question, "eligibleChunks": [identity(item).model_dump(by_alias=True)], "limit": 1}
    operations = [
        ("PUT", "chunks", "index", {"chunks": [item.model_dump(by_alias=True)]}),
        ("POST", "search", "search", search),
        (
            "POST",
            "answers",
            "answer",
            {
                "question": question,
                "chunks": [item.model_dump(by_alias=True, exclude={"content_hash"})],
            },
        ),
    ]
    records = []
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://internal") as client:
            for scenario in ("miss", "hit", "not-ready"):
                trace_id = uuid4().hex
                parents = {}
                selected = (
                    operations
                    if scenario != "not-ready"
                    else [
                        (
                            "POST",
                            "search",
                            "search",
                            {
                                **search,
                                "eligibleChunks": [{**search["eligibleChunks"][0], "contentHash": "0" * 64}],
                            },
                        ),
                    ]
                )
                for method, path, name, payload in selected:
                    parent_id = uuid4().hex[:16]
                    parents["evidence." + name] = parent_id
                    response = await client.request(
                        method,
                        "/internal/v1/support-program-evidence/" + path,
                        json=payload,
                        headers={"traceparent": f"00-{trace_id}-{parent_id}-01", "baggage": "PRIVATE-SMOKE"},
                    )
                    assert response.status_code == (503 if scenario == "not-ready" else 200)
                records.append(
                    {
                        "trace_id": trace_id,
                        "evidence_scenario": scenario,
                        "parents": parents,
                        "observation_count": {"miss": 15, "hit": 11, "not-ready": 2}[scenario],
                    }
                )
        assert len(embeddings.requests) == 2 and len(model.calls) == 2
    finally:
        await qdrant.close()
        await openai.close()
        await model.model.root_async_client.close()
    return records


def verify_evidence_observations(observations, record):
    scenario = record["evidence_scenario"]
    requests = [item for item in observations if item["name"] == "evidence.embedding.request"]
    by_name = {item["name"]: item for item in observations if item["name"] != "evidence.embedding.request"}
    expected = {"evidence.search": ["readiness"]}
    if scenario != "not-ready":
        expected = {
            "evidence.index": ["readiness"] + (["embedding", "upsert"] if scenario == "miss" else []),
            "evidence.search": ["readiness", "embedding", "vector", "validate"],
            "evidence.answer": ["model", "validate_selection", "validate_response"],
        }
    assert len(by_name) + len(requests) == len(observations) == record["observation_count"]
    assert len({item["id"] for item in observations}) == len(observations)
    assert len(requests) == (2 if scenario == "miss" else 0)
    if requests:
        assert {item["parentObservationId"] for item in requests} == {
            by_name["evidence.index.embedding"]["id"], by_name["evidence.search.embedding"]["id"],
        }
        for item in requests:
            assert item["metadata"]["usage_reported"] is True
            assert item["metadata"]["usage_state"] == "reported"
            assert 0 < item["metadata"]["estimated_tokens"] <= item["metadata"]["request_token_limit"]
            assert item["usageDetails"] == {"input": 1, "output": 0, "total": 1}
    names = set(expected)
    for root_name, children in expected.items():
        root = by_name[root_name]
        assert root["parentObservationId"] == record["parents"][root_name]
        for suffix in children:
            name = ("evidence." if root_name == "evidence.answer" else root_name + ".") + suffix
            names.add(name)
            assert by_name[name]["parentObservationId"] == root["id"]
    assert set(by_name) == names
    for item in observations:
        assert (item["level"] == "ERROR") == (scenario == "not-ready")
        assert item["metadata"]["outcome"] == ("failed" if scenario == "not-ready" else "completed")
    if scenario != "not-ready":
        assert by_name["evidence.index"]["metadata"]["missing_count"] == (1 if scenario == "miss" else 0)
        assert by_name["evidence.search"]["metadata"]["embedding_cache_state"] == scenario
        # 이 HTTP 대역은 사용량을 제공하지 않는다. 정상 응답이어도 0 토큰으로 확정하지 않는다.
        assert by_name["evidence.model"]["metadata"]["usage_reported"] is False
