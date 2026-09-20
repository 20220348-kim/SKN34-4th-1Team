#!/usr/bin/env python3
"""명시적 실행용 로컬 AI 평가 서버. 기존 앱을 재사용하고 OpenAI 호출 상한·진단만 기록한다."""

import argparse
from datetime import datetime, timezone
from functools import partial
import json
import os
from pathlib import Path
from time import perf_counter
from urllib.parse import urlsplit

import httpx2
from openai import AsyncOpenAI
from starlette.responses import JSONResponse

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


def build_evaluation_app(output_dir: Path, qdrant_url: str, max_api_calls: int):
    require_loopback_url(qdrant_url)
    require(type(max_api_calls) is int and 1 <= max_api_calls <= 20, "API budget must be between 1 and 20")
    key = os.environ.get("OPENAI_API_KEY", "").strip()
    require(bool(key), "OPENAI_API_KEY must be explicitly supplied")
    output_dir.mkdir(parents=True, exist_ok=False)
    trace = {
        "schemaVersion": "support-program-evidence-flow-api-v1", "maxApiCalls": max_api_calls,
        "startedAt": datetime.now(timezone.utc).isoformat(), "stopped": False,
        "model": DEFAULT_OPENAI_MODEL, "embeddingModel": "text-embedding-3-small", "embeddingDimensions": 1536,
        "promptSha256": digest(SUPPORT_PROGRAM_EVIDENCE_ANSWER_INSTRUCTIONS.encode()),
        "recorderSha256": digest(Path(__file__).read_bytes()), "calls": [],
    }

    def save():
        temporary = output_dir / "api-capture.partial.json"
        temporary.write_text(json.dumps(trace, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
        temporary.replace(output_dir / "api-capture.json")

    async def before_request(request):
        require(str(request.url) in {"https://api.openai.com/v1/embeddings", "https://api.openai.com/v1/responses"}
                and request.method == "POST", "unexpected upstream endpoint")
        require(not trace["stopped"] and len(trace["calls"]) < max_api_calls, "evaluation API budget exhausted or stopped")
        index = len(trace["calls"])
        request.extensions["evidence_eval_index"] = index
        request.extensions["evidence_eval_started"] = perf_counter()
        trace["calls"].append({"index": index, "path": request.url.path,
                               "requestSha256": digest(request.content), "response": None})
        save()

    async def after_response(response):
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
            response = await call_next(request)
        except Exception:
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
    args = parser.parse_args()
    if not args.execute or not 1 <= args.port <= 65535:
        parser.error("--execute and a valid local port are required")
    app = build_evaluation_app(args.output_dir, args.qdrant_url, args.max_api_calls)
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=args.port, access_log=False, log_level="warning")


if __name__ == "__main__":
    main()
