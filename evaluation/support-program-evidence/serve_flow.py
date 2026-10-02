#!/usr/bin/env python3
"""명시적 실행용 로컬 AI 평가 서버. 기존 앱에 호출 상한·진단과 선택적 RAG 예산을 연결한다."""

import argparse
import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from functools import partial
import json
import os
from pathlib import Path
from time import perf_counter
from urllib.parse import urlsplit

import httpx2
from openai import AsyncOpenAI
from starlette.responses import JSONResponse, Response

from budget_client import BudgetUnavailable

from evaluate import (
    DEFAULT_LLM_MODEL_TIMEOUT_SECONDS, DEFAULT_LLM_RUN_TIMEOUT_SECONDS, DEFAULT_OPENAI_MODEL,
    SUPPORT_PROGRAM_EVIDENCE_ANSWER_INSTRUCTIONS, digest, require, response_record,
)
from app import bootstrap
from app.config import Settings
from app.main import create_app


def require_loopback_url(value: str) -> str:
    parsed = urlsplit(value)
    require(parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
            and parsed.port is not None and parsed.username is None and parsed.password is None
            and parsed.path in {"", "/"} and not parsed.query and not parsed.fragment,
            "a loopback HTTP URL with an explicit port is required")
    return value.rstrip("/")


def build_evaluation_app(output_dir: Path, qdrant_url: str, max_api_calls: int, *, embedding_budget=None, rag_budget=None):
    require_loopback_url(qdrant_url)
    require(not (embedding_budget is not None and rag_budget is not None), "Choose one budget guard")
    require(type(max_api_calls) is int and 1 <= max_api_calls <= (512 if rag_budget else 20), "Invalid API budget")
    if rag_budget is not None:
        require(max_api_calls == len(rag_budget.spec["model_operations"])
                and output_dir.resolve() == rag_budget.receipt_directory.resolve(), "RAG reservation/output differs")
    key = os.environ.get("OPENAI_API_KEY", "").strip()
    require(bool(key), "OPENAI_API_KEY must be explicitly supplied")
    output_dir.mkdir(parents=True, exist_ok=False)
    trace = {
        "schemaVersion": "support-program-evidence-flow-api-v1", "maxApiCalls": max_api_calls,
        "startedAt": datetime.now(timezone.utc).isoformat(), "stopped": False,
        "model": DEFAULT_OPENAI_MODEL, "embeddingModel": "text-embedding-3-small", "embeddingDimensions": 1536,
        "promptSha256": digest(SUPPORT_PROGRAM_EVIDENCE_ANSWER_INSTRUCTIONS.encode()),
        "recorderSha256": digest(Path(__file__).read_bytes()), "calls": [],
        **({"inputTokenCountRequests": 0, "budgetSpecSha256": rag_budget.client.identity["spec_hash"]}
           if rag_budget is not None else {}),
    }

    def save():
        temporary = output_dir / "api-capture.partial.json"
        temporary.write_text(json.dumps(trace, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
        temporary.replace(output_dir / "api-capture.json")

    async def before_request(request):
        if rag_budget is not None and str(request.url) == "https://api.openai.com/v1/responses/input_tokens":
            await rag_budget.before_request(request)
            trace["inputTokenCountRequests"] += 1
            save()
            return
        require(str(request.url) in {"https://api.openai.com/v1/embeddings", "https://api.openai.com/v1/responses"}
                and request.method == "POST", "unexpected upstream endpoint")
        require(not trace["stopped"] and len(trace["calls"]) < max_api_calls, "evaluation API budget exhausted or stopped")
        if embedding_budget is not None:
            # A guarded indexing/search session must never silently send unbudgeted answers.
            await embedding_budget.before_request(request)
        if rag_budget is not None:
            await rag_budget.before_request(request)
        index = len(trace["calls"])
        request.extensions["evidence_eval_index"] = index
        request.extensions["evidence_eval_started"] = perf_counter()
        trace["calls"].append({"index": index, "path": request.url.path,
                               "requestSha256": digest(request.content), "response": None,
                               **({"countedInputTokens": request.extensions["rag_input_tokens"]}
                                  if "rag_input_tokens" in request.extensions else {})})
        save()

    async def after_response(response):
        if rag_budget is not None and str(response.request.url) == "https://api.openai.com/v1/responses/input_tokens":
            return
        await response.aread()
        try:
            body = response.json()
        except ValueError:
            body = {}
        record = trace["calls"][response.request.extensions["evidence_eval_index"]]
        record["elapsedMs"] = round((perf_counter() - response.request.extensions["evidence_eval_started"]) * 1000, 3)
        record["response"] = response_record(response.status_code, body)
        if record["path"] == "/v1/embeddings":
            usage = body.get("usage") if isinstance(body, dict) else None
            record["response"]["embeddingUsage"] = {
                name: usage.get(name) for name in ("prompt_tokens", "total_tokens")
            } if isinstance(usage, dict) else None
        if response.status_code != 200:
            trace["stopped"] = True
        save()
        if embedding_budget is not None:
            await embedding_budget.after_response(response)
        if rag_budget is not None:
            await rag_budget.after_response(response)

    client = httpx2.AsyncClient(event_hooks={"request": [before_request], "response": [after_response]})
    # Evaluation-only construction hook: keep the existing production object graph and explicit SDK retry=0.
    original = bootstrap.AsyncOpenAI
    bootstrap.AsyncOpenAI = partial(AsyncOpenAI, base_url="https://api.openai.com/v1", http_client=client)
    try:
        app = create_app(settings=Settings(
            openai_api_key=key, openai_model=DEFAULT_OPENAI_MODEL,
            llm_model_timeout_seconds=DEFAULT_LLM_MODEL_TIMEOUT_SECONDS,
            llm_run_timeout_seconds=DEFAULT_LLM_RUN_TIMEOUT_SECONDS, qdrant_url=qdrant_url,
        ))
    finally:
        bootstrap.AsyncOpenAI = original

    if rag_budget is not None:
        rag_budget.sdk = app.state.container.openai_client
        original_lifespan = app.router.lifespan_context

        @asynccontextmanager
        async def budget_lifespan(application):
            try:
                await asyncio.to_thread(rag_budget.client.claim)
            except BaseException:
                rag_budget.stop()
                await app.state.container.close()
                raise
            try:
                async with original_lifespan(application):
                    yield
            finally:
                rag_budget.stop()
                await asyncio.to_thread(rag_budget.client.close)

        app.router.lifespan_context = budget_lifespan

    @app.middleware("http")
    async def restrict_evaluation_requests(request, call_next):
        if (request.method, request.url.path) == ("GET", "/health"):
            return JSONResponse({"status": "ready", "calls": len(trace["calls"]), "stopped": trace["stopped"]})
        prefix = "/internal/v1/support-program-evidence"
        if (request.method, request.url.path) not in {
            ("PUT", prefix + "/chunks"), ("POST", prefix + "/search"), ("POST", prefix + "/answers"),
        }:
            return JSONResponse({"detail": "evaluation endpoint only"}, status_code=404)
        if trace["stopped"]:
            return JSONResponse({"detail": "evaluation stopped"}, status_code=503)
        try:
            if rag_budget is not None:
                rag_budget.begin_api(request.method, request.url.path, await request.json())
            response = await call_next(request)
            if rag_budget is not None:
                body = bytearray()
                async for chunk in response.body_iterator:
                    body.extend(chunk)
                    require(len(body) <= 1024 * 1024, "RAG response is oversized")
                rag_budget.finish_api(response.status_code, json.loads(body))
                response = Response(bytes(body), status_code=response.status_code,
                                    headers=dict(response.headers), background=response.background)
        except (BudgetUnavailable, ValueError):
            if rag_budget is None:
                raise
            rag_budget.stop()
            trace["stopped"] = True
            save()
            return JSONResponse({"detail": "RAG budget/session validation failed"}, status_code=503)
        except Exception:
            if rag_budget is not None:
                rag_budget.stop()
            trace["stopped"] = True
            save()
            raise
        if response.status_code >= 400:
            trace["stopped"] = True
            save()
        return response

    save()
    return app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true", help="explicitly permit a paid API-backed local server")
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--qdrant-url", required=True)
    parser.add_argument("--max-api-calls", type=int, required=True)
    parser.add_argument("--port", type=int, default=18009)
    parser.add_argument("--budget-spec", type=Path, help="Ops에 이미 예약된 내부 RAG 실행 명세 JSON")
    parser.add_argument("--request-id", help="Ops 평가 실행 UUID")
    parser.add_argument("--flow-id", help="Ops 예약과 일치하는 Prefect flow UUID")
    parser.add_argument("--spec-sha256", help="Ops가 저장한 실행 명세 SHA-256")
    args = parser.parse_args()
    if not args.execute or not 1 <= args.port <= 65535:
        parser.error("--execute and a valid local port are required")
    budget_args = (args.budget_spec, args.request_id, args.flow_id, args.spec_sha256)
    if any(budget_args) and not all(budget_args):
        parser.error("RAG budget mode requires --budget-spec, --request-id, --flow-id and --spec-sha256")
    guard = None
    if args.budget_spec:
        from budget_client import BudgetClient
        from rag_budget import RagBudget

        with args.budget_spec.open("rb") as source:
            raw = source.read(8 * 1024 * 1024 + 1)
        require(len(raw) <= 8 * 1024 * 1024, "RAG budget specification is oversized")
        guard = RagBudget(BudgetClient(args.request_id, args.flow_id, args.spec_sha256),
                          json.loads(raw), receipt_directory=args.output_dir)
    app = build_evaluation_app(args.output_dir, args.qdrant_url, args.max_api_calls, rag_budget=guard)
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=args.port, access_log=False, log_level="warning")


if __name__ == "__main__":
    main()
