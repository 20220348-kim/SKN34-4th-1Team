"""실제 개발 서버에 무료 trace·점수·보고서를 저장하고 다시 조회한다."""

import argparse
import asyncio
import json
import os
from pathlib import Path
import sys
import time
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(Path(__file__).resolve().parent), str(ROOT / "backend/ai-service"), str(ROOT / "evaluation/support-program-evidence")]
os.environ["DO_NOT_TRACK"] = "1"
os.environ["PREFECT_SERVER_ANALYTICS_ENABLED"] = "false"
os.environ.setdefault("PREFECT_HOME", str(ROOT / "work/llmops/prefect-client"))

import httpx
from app.config import LangfuseSettings
from app.support_program_evidence.agent import SupportProgramEvidenceAnswerAgent
from app.support_program_evidence.answer_service import SupportProgramEvidenceAnswerService
from app.support_program_evidence.errors import SupportProgramEvidenceError
from app.tracing import LLMTracing
from tests.langchain_stub import ResponsesChatStub, response_message
from tests.support_program_evidence.test_agent import answer_request, valid_selection
from llmops import evaluate_capture, write_json
from assistant_trace_smoke import assistant_trace_examples, verify_assistant_observations
from evidence_trace_smoke import evidence_trace_examples, verify_evidence_observations


def wait_ready(base_url: str, path: str) -> None:
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline:
        try:
            response = httpx.get(base_url + path, timeout=5)
            if response.status_code == 200:
                return
        except httpx.HTTPError:
            pass
        time.sleep(2)
    raise RuntimeError("Local LLMOps server readiness timed out")


async def trace_examples(settings, tracing=None):
    owns_tracing = tracing is None
    tracing = tracing or LLMTracing(settings)
    records = []
    try:
        for failing in [False, True]:
            trace_id = uuid4().hex
            stub = ResponsesChatStub([[response_message("invalid-private-output" if failing else valid_selection().model_dump_json(by_alias=True))]])
            agent = SupportProgramEvidenceAnswerAgent(model=stub.model, model_timeout_seconds=10,
                                                       run_timeout_seconds=15, tracing=tracing)
            service = SupportProgramEvidenceAnswerService(agent, tracing)
            try:
                await service.answer(answer_request(), trace_id=trace_id)
                assert not failing
            except SupportProgramEvidenceError:
                assert failing
            assert len(stub.calls) == 1
            await stub.model.root_async_client.close()
            records.append({"trace_id": trace_id, "expected_failure": failing, "observation_count": 3 if failing else 4})
    finally:
        if owns_tracing:
            await tracing.close()
    return records


async def search_trace_examples(settings):
    """근거 답변과 검색을 같은 SDK 생애에서 검증한다. Core 부모 헤더만 합성한다."""
    from dataclasses import replace
    import httpx2
    from openai import AsyncOpenAI
    from qdrant_client import AsyncQdrantClient
    from app.main import create_app
    from app.support_program_index.models import SupportProgramIndexBatchRequest, SupportProgramIndexSearchRequest
    from app.support_program_index.service import SupportProgramIndexService
    from app.support_program_ranking.agent import SupportProgramRecommendationAgent
    from tests.support_program_index.conftest import EmbeddingHttpStub, document, identity
    from tests.support_program_ranking.test_agent import ranking_request, llm_output_json
    from tests.test_bootstrap import OPENAI_SETTINGS

    embeddings = EmbeddingHttpStub()
    openai = AsyncOpenAI(api_key="test-key-never-sent", base_url="https://embedding.test/v1", max_retries=0,
                         http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(embeddings)))
    qdrant = AsyncQdrantClient(location=":memory:")
    index = SupportProgramIndexService(openai, qdrant, embedding_model="text-embedding-3-small",
                                      embedding_dimensions=3, embedding_timeout_seconds=10)
    stub = ResponsesChatStub([[response_message(llm_output_json())]])
    agent = SupportProgramRecommendationAgent(model=stub.model, model_timeout_seconds=10, run_timeout_seconds=15)
    app = create_app(settings=replace(OPENAI_SETTINGS, langfuse=settings), support_program_recommendation_agent=agent)
    tracing = app.state.container.llm_tracing
    agent._tracing = index._tracing = tracing
    app.state.container.support_program_index_service = index
    try:
        records = await trace_examples(settings, tracing)
        records += await evidence_trace_examples(tracing)
        records += await assistant_trace_examples(tracing)
        item = document("BIZINFO:smoke", "서울 AI 합성 공고 PRIVATE-SMOKE")
        await index.index_batch(SupportProgramIndexBatchRequest(documents=[item]))
        search = SupportProgramIndexSearchRequest(query="서울 AI PRIVATE-SMOKE", eligibleDocuments=[identity(item)], limit=1)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            for cached in [False, True]:
                trace_id, parent_id = uuid4().hex, uuid4().hex[:16]
                for path, payload in [("support-program-index/search", search), ("support-program-rankings/rank", ranking_request())]:
                    response = await client.post("/internal/v1/" + path, json=payload.model_dump(mode="json", by_alias=True),
                                                 headers={"traceparent": f"00-{trace_id}-{parent_id}-01"})
                    response.raise_for_status()
                names = ["search.semantic.request", "search.semantic", "search.vector", "search.ranking.request", "search.ranking"]
                if not cached:
                    names += ["search.embedding", "search.ranking.model", "search.selection"]
                records.append({"trace_id": trace_id, "parent_id": parent_id, "names": names, "cached": cached})
        assert len(stub.calls) == 1 and len(embeddings.requests) == 2  # 색인 1회 + 질의 1회, 모두 HTTP 대역
    finally:
        await app.state.container.close()
        await qdrant.close()
        await openai.close()
        await stub.model.root_async_client.close()
    return records


def verify_traces(settings, records):
    with httpx.Client(base_url=settings.base_url, auth=(settings.public_key, settings.secret_key), timeout=10) as client:
        for record in records:
            deadline = time.monotonic() + 60
            while True:
                response = client.get("/api/public/v2/observations", params={
                    "traceId": record["trace_id"], "fields": "basic,io,metadata,model,usage", "limit": 100,
                })
                response.raise_for_status()
                observations = response.json()["data"]
                if len(observations) == record.get("observation_count", len(record.get("names", ["evidence.answer", "evidence.model"]))):
                    break
                if time.monotonic() >= deadline:
                    raise RuntimeError("Trace readback timed out")
                time.sleep(1)
            if "assistant_scenario" in record:
                verify_assistant_observations(observations, record)
            elif "evidence_scenario" in record:
                verify_evidence_observations(observations, record)
            elif "names" in record:
                assert sorted(item["name"] for item in observations) == sorted(record["names"])
                ids = {item["id"] for item in observations}
                for item in observations:
                    assert item["level"] != "ERROR"
                    expected_parent = record["parent_id"] if item["name"].endswith(".request") else None
                    if expected_parent:
                        assert item["parentObservationId"] == expected_parent
                    else:
                        assert item["parentObservationId"] in ids
                ranking = next(item for item in observations if item["name"] == "search.ranking")
                assert ranking["metadata"]["cache_state"] == ("hit" if record["cached"] else "miss")
            else:
                root = next(item for item in observations if item["name"] == "evidence.answer")
                model = next(item for item in observations if item["name"] == "evidence.model")
                assert model["parentObservationId"] == root["id"]
                selection = next(item for item in observations if item["name"] == "evidence.validate_selection")
                assert selection["parentObservationId"] == root["id"]
                assert (selection["level"] == "ERROR") == record["expected_failure"]
                if not record["expected_failure"]:
                    validation = next(item for item in observations if item["name"] == "evidence.validate_response")
                    assert validation["parentObservationId"] == root["id"]
                assert (root["level"] == "ERROR") == record["expected_failure"]
            for item in observations:
                assert item.get("input") in (None, "", "null") and item.get("output") in (None, "", "null")
            serialized = json.dumps(observations, ensure_ascii=False)
            for private in [answer_request().question, valid_selection().answer, "invalid-private-output", "PRIVATE-SMOKE", settings.secret_key]:
                assert private not in serialized


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    settings = LangfuseSettings.from_environment()
    if not settings.enabled or not os.environ.get("PREFECT_API_URL"):
        parser.error("explicit local Langfuse and Prefect settings required")
    # 이 검증 도구는 오직 로컬 개발 서버에만 합성 데이터를 보낸다.
    from urllib.parse import urlsplit
    for url in [settings.base_url, os.environ["PREFECT_API_URL"]]:
        if urlsplit(url).hostname not in {"localhost", "127.0.0.1"}:
            parser.error("smoke test requires loopback endpoints")
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=False)
    wait_ready(settings.base_url, "/api/public/health")
    wait_ready(os.environ["PREFECT_API_URL"], "/health")
    traces = asyncio.run(search_trace_examples(settings))
    verify_traces(settings, traces)
    fixture = str(ROOT / "evaluation/support-program-evidence/target-coverage-fixture.json")
    capture = str(ROOT / "evaluation/support-program-evidence/runs/target-coverage-20260907-v1/capture.json")
    first = evaluate_capture(fixture, capture, capture, str(output / "first"))
    second = evaluate_capture(fixture, capture, capture, str(output / "replay"))
    assert first["evaluation_run_id"] == second["evaluation_run_id"]
    assert first["score_ids"] == second["score_ids"]
    bad = output / "invalid-capture.json"
    bad.write_text("{}")
    try:
        evaluate_capture(fixture, str(bad), capture, str(output / "failed"))
    except ValueError:
        pass
    else:
        raise AssertionError("Invalid input must fail the flow")
    failed = json.loads((output / "failed/manifest.json").read_text())
    with httpx.Client(base_url=os.environ["PREFECT_API_URL"], timeout=10) as client:
        for run, expected in [(first, "COMPLETED"), (second, "COMPLETED"), (failed, "FAILED")]:
            response = client.get(f'/flow_runs/{run["prefect_flow_run_id"]}')
            response.raise_for_status()
            assert response.json()["state_type"] == expected
    summary = {"python_version": sys.version.split()[0],
               "trace_checks": traces, "evaluation_run_id": first["evaluation_run_id"],
               "score_count": len(first["score_ids"]), "prefect_states": ["COMPLETED", "COMPLETED", "FAILED"],
               "model_api_calls": 0, "report": "first/report.html"}
    write_json(output / "verification.json", summary)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
