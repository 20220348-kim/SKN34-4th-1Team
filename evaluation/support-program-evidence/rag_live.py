"""고정 원문·청크로 새 임베딩·검색·답변을 실행하고 검토 가능한 RAG 캡처를 남긴다."""

import argparse
import asyncio
import json
import os
from pathlib import Path
from uuid import uuid4

import rag_evaluate as rag
from rag_budget import RagBudget, make_rag_spec

ROOT = Path(__file__).resolve().parents[2]
PLANS = ROOT / "backend/ops-service/apps/evaluations/rag_live_plans.json"


def prepare(fixture_path, *, model):
    fixture, fingerprint = rag.read_json(fixture_path)
    documents, cases = rag.validate_fixture(fixture)
    plan = make_rag_spec(
        [
            {
                "case_id": case["id"],
                "chunks": documents[case["documentId"]]["chunks"],
                "question": case["question"],
                "limit": rag.search_request(case, documents[case["documentId"]])[
                    "limit"
                ],
            }
            for case in cases.values()
        ],
        model=model,
    )
    return fixture, fingerprint, plan


def catalog_plans():
    """빌드 시 토큰 배치만 고정한다. 원문·질문·청크는 Ops 이미지에 복제하지 않는다."""
    from evaluate import DEFAULT_OPENAI_MODEL

    catalog = json.loads((PLANS.parent / "capture_catalog.json").read_text())
    result = {}
    for dataset in catalog:
        if dataset.get("evaluation_scope") != rag.SCOPE:
            continue
        _, fingerprint, plan = prepare(
            ROOT / "evaluation/support-program-evidence" / dataset["fixture"],
            model=DEFAULT_OPENAI_MODEL,
        )
        rag.require(fingerprint == dataset["fixture_sha256"], "Catalog fixture changed")
        result[dataset["id"]] = {
            "fixture_sha256": fingerprint,
            "case_ids": [case["case_id"] for case in plan["rag_cases"]],
            "live_config": plan["live_config"],
            "model_operations": plan["model_operations"],
        }
    return result


async def execute(fixture_path, output_dir, *, budget, execution_spec):
    """실행마다 격리된 메모리 색인을 사용한다. 외부 Core 원문 수집·재청킹은 수행하지 않는다."""
    import httpx2
    from langchain_openai import ChatOpenAI
    from openai import AsyncOpenAI
    from qdrant_client import AsyncQdrantClient
    from app.config import LangfuseSettings
    from app.tracing import LLMTracing
    from app.support_program_evidence.agent import SupportProgramEvidenceAnswerAgent
    from app.support_program_evidence.answer_service import (
        SupportProgramEvidenceAnswerService,
    )
    from app.support_program_evidence.service import SupportProgramEvidenceService
    from app.support_program_evidence.models import (
        SupportProgramEvidenceBatchRequest,
        SupportProgramEvidenceSearchRequest,
        SupportProgramEvidenceAnswerRequest,
    )
    from evaluate import (
        DEFAULT_LLM_MODEL_TIMEOUT_SECONDS,
        DEFAULT_LLM_RUN_TIMEOUT_SECONDS,
        SUPPORT_PROGRAM_EVIDENCE_ANSWER_INSTRUCTIONS,
    )
    from llmops import write_json

    config = execution_spec["live_config"]
    fixture, fingerprint, plan = prepare(fixture_path, model=config["model"])
    rag.require(fingerprint == config["fixture_sha256"], "Approved fixture changed")
    rag.require(
        plan["model_operations"] == execution_spec["model_operations"],
        "Approved token batches changed",
    )
    rag.require(
        all(config[key] == value for key, value in plan["live_config"].items()),
        "Approved RAG configuration changed",
    )
    key = os.environ.get("OPENAI_API_KEY", "").strip()
    rag.require(bool(key), "OpenAI key is required")
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=False)
    guard = RagBudget(
        budget, plan, receipt_directory=output_dir, execution_spec=execution_spec
    )
    documents = {doc["documentId"]: doc for doc in fixture["documents"]}
    capture = {
        "schemaVersion": "support-program-rag-capture-v1",
        "scope": rag.SCOPE,
        "fixtureSha256": fingerprint,
        "execution": {
            "kind": "recorded",
            "model": config["model"],
            "embeddingModel": config["embedding_model"],
            "promptSha256": rag.digest(SUPPORT_PROGRAM_EVIDENCE_ANSWER_INSTRUCTIONS),
            "recorderSha256": rag.digest(Path(__file__).read_bytes()),
        },
        "cases": [
            {
                "caseId": c["id"],
                "traceId": None,
                "sourceContentHash": None,
                "chunksSha256": None,
                "indexedCount": None,
                "search": None,
                "answer": None,
                "failure": {"stage": "not_started", "code": "NOT_STARTED"},
            }
            for c in fixture["cases"]
        ],
    }
    usage = {
        "schema_version": 1,
        "execution_spec_sha256": budget.identity["spec_hash"],
        "model_api_calls": 0,
        "input_token_count_requests": 0,
        "operations": [],
        "completed": False,
    }

    def save():
        write_json(output_dir / "capture.json", capture)
        write_json(output_dir / "usage-summary.json", usage)

    async def before_request(request):
        await guard.before_request(request)
        if str(request.url).endswith("/responses/input_tokens"):
            usage["input_token_count_requests"] += 1
        else:
            sequence, operation = (
                request.extensions.get("embedding_budget")
                or request.extensions["rag_answer_budget"]
            )
            usage["operations"].append(
                {"sequence": sequence, "operation_id": operation["id"]}
            )
            usage["model_api_calls"] += 1
        save()

    client = AsyncOpenAI(
        api_key=key,
        base_url="https://api.openai.com/v1",
        max_retries=0,
        http_client=httpx2.AsyncClient(
            event_hooks={
                "request": [before_request],
                "response": [guard.after_response],
            }
        ),
    )
    guard.sdk = client
    tracing = None
    try:
        save()
        tracing = LLMTracing(LangfuseSettings.from_environment())
        answer_service = SupportProgramEvidenceAnswerService(
            SupportProgramEvidenceAnswerAgent(
                tracing=tracing,
                model=ChatOpenAI(
                    model=config["model"],
                    api_key=key,
                    use_responses_api=True,
                    max_retries=0,
                    root_async_client=client,
                    async_client=client.chat.completions,
                ),
                model_timeout_seconds=DEFAULT_LLM_MODEL_TIMEOUT_SECONDS,
                run_timeout_seconds=DEFAULT_LLM_RUN_TIMEOUT_SECONDS,
            ),
            tracing,
        )
        for case, record in zip(fixture["cases"], capture["cases"], strict=True):
            document = documents[case["documentId"]]
            record.update(
                sourceContentHash=document["contentHash"],
                chunksSha256=rag.json_digest(document["chunks"]),
            )
            record["traceId"] = uuid4().hex if tracing.client is not None else None
            stage = "index"
            qdrant = AsyncQdrantClient(":memory:")
            try:
                service = SupportProgramEvidenceService(
                    client,
                    qdrant,
                    tracing=tracing,
                    embedding_model=config["embedding_model"],
                    embedding_dimensions=config["embedding_dimensions"],
                    embedding_timeout_seconds=DEFAULT_LLM_MODEL_TIMEOUT_SECONDS,
                )
                async with asyncio.timeout(DEFAULT_LLM_RUN_TIMEOUT_SECONDS + 60):
                    payload = {"chunks": document["chunks"]}
                    guard.begin_api(
                        "PUT", "/internal/v1/support-program-evidence/chunks", payload
                    )
                    indexed = await service.index_chunks(
                        SupportProgramEvidenceBatchRequest.model_validate(payload),
                        trace_id=record["traceId"],
                    )
                    guard.finish_api(
                        200, indexed.model_dump(mode="json", by_alias=True)
                    )
                    record["indexedCount"] = indexed.indexed_count
                    stage = "search"
                    request = rag.search_request(case, document)
                    record["search"] = {"request": request, "response": None}
                    save()
                    guard.begin_api(
                        "POST", "/internal/v1/support-program-evidence/search", request
                    )
                    found = await service.search(
                        SupportProgramEvidenceSearchRequest.model_validate(request),
                        trace_id=record["traceId"],
                    )
                    response = found.model_dump(mode="json", by_alias=True)
                    guard.finish_api(200, response)
                    record["search"]["response"] = response
                    stage = "answer"
                    request = guard.answer
                    record["answer"] = {"request": request, "response": None}
                    save()
                    guard.begin_api(
                        "POST", "/internal/v1/support-program-evidence/answers", request
                    )
                    answer = await answer_service.answer(
                        SupportProgramEvidenceAnswerRequest.model_validate(request),
                        trace_id=record["traceId"],
                    )
                    response = answer.model_dump(mode="json", by_alias=True)
                    guard.finish_api(200, response)
                    record["answer"]["response"] = response
                    record["failure"] = None
            except BaseException as error:
                guard.stop()
                record["failure"] = {"stage": stage, "code": "RAG_EXECUTION_FAILED"}
                save()
                if not isinstance(error, Exception):
                    raise
                break
            finally:
                await qdrant.close()
                save()
        usage["completed"] = all(case["failure"] is None for case in capture["cases"])
    finally:
        guard.stop()
        try:
            save()
        finally:
            try:
                await client.close()
            finally:
                if tracing is not None:
                    await tracing.close()
    return capture, usage


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="RAG 호출 계획 생성·검증. 모델 호출 없음."
    )
    parser.add_argument("--write-plans", action="store_true")
    args = parser.parse_args()
    plans = catalog_plans()
    if args.write_plans:
        PLANS.write_text(json.dumps(plans, ensure_ascii=False, indent=2) + "\n")
    else:
        rag.require(plans == json.loads(PLANS.read_text()), "RAG call plans are stale")
    print("RAG call plans verified; model calls: 0")
