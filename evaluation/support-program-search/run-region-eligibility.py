#!/usr/bin/env python3
"""Dry-run by default; explicitly execute at most three synthetic regional ranking calls."""

import argparse
import asyncio
import hashlib
import importlib.util
import json
import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "region_runner_evaluator", Path(__file__).with_name("evaluate-region-eligibility.py"),
)
evaluator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(evaluator)
canonical_sha256 = evaluator.replay.canonical_sha256
OFFICIAL_BASE_URL = "https://api.openai.com/v1"
MAX_CALLS = 3


def now():
    return datetime.now(timezone.utc).isoformat()


def write_json(path, value):
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")


def allowed_usage(value):
    """Persist token counts only, never arbitrary response fields or error text."""
    if not isinstance(value, dict):
        return None
    result = {name: value[name] for name in ("input_tokens", "output_tokens", "total_tokens")
              if type(value.get(name)) is int and value[name] >= 0}
    for name, child in (("input_tokens_details", "cached_tokens"),
                        ("output_tokens_details", "reasoning_tokens")):
        details = value.get(name)
        if isinstance(details, dict) and type(details.get(child)) is int and details[child] >= 0:
            result[name] = {child: details[child]}
    return result


async def execute(args, fixture, *, transport=None):
    """Use the production Agent/Service with frozen Luna/none, not bootstrap overrides.

    Transport is an offline-test-only hook. Ranking-specific model/reasoning
    environment overrides do not change this fixed experiment.
    """
    if not args.execute:
        raise ValueError("Explicit execution is required")
    requests = evaluator.build_requests(fixture)
    if not 1 <= len(requests) <= MAX_CALLS:
        raise ValueError("The ranking budget is one to three calls")
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=False)
    manifest = {
        "schemaVersion": "support-program-region-eligibility-execution-v1",
        "status": "failed", "startedAt": now(), "plannedCalls": len(requests),
        "actualCalls": 0, "completedRankings": 0, "embeddingCalls": 0,
        "sdkMaxRetries": 0, "agentMaxTurns": 1, "maxOutputTokens": 10000,
        "reasoningEffort": "none", "store": False, "tracing": False,
        "timeoutsSeconds": {"model": 45.0, "agent": 50.0},
        "fixtureSha256": canonical_sha256(fixture), "cleanupErrors": [],
        "limitation": evaluator.LIMITATION,
    }
    capture = {
        "schemaVersion": evaluator.CAPTURE_SCHEMA,
        "scoringVersion": evaluator.SCORING_VERSION,
        "fixtureSha256": manifest["fixtureSha256"],
        "provenance": {"kind": "mock" if transport is not None else "live_openai"},
        "observations": [],
    }
    usage = []
    current = {}
    called_cases = set()
    client = None
    http_client = None
    exit_code = 2
    previous_logging = logging.root.manager.disable
    # The SDK may otherwise print raw HTTP/error content when debug logging is enabled.
    logging.disable(logging.CRITICAL)

    def record(entry):
        usage.append({"caseId": current.get("caseId"), "time": now(), **entry})

    async def on_request(request):
        url = request.url
        if (request.method != "POST" or url.scheme != "https" or url.host != "api.openai.com"
                or url.port not in (None, 443) or url.path != "/v1/responses"
                or url.query or url.username or url.password
                or manifest["actualCalls"] >= min(MAX_CALLS, len(requests))
                or current.get("caseId") is None or current["caseId"] in called_cases):
            raise RuntimeError("Request destination or execution budget rejected")
        payload = json.loads(await request.aread())
        messages = payload.get("input") if isinstance(payload, dict) else None
        if not isinstance(messages, list):
            raise ValueError("Unexpected Responses messages")
        system_messages = [message for message in messages if message.get("role") == "system"]
        instructions = system_messages[0].get("content") if len(system_messages) == 1 else None
        if (not isinstance(payload, dict) or not isinstance(payload.get("input"), (list, str))
                or not isinstance(instructions, str)
                or not isinstance(payload.get("text", {}).get("format", {}).get("schema"), dict)
                or payload.get("model") != "gpt-5.6-luna"
                or payload.get("reasoning", {}).get("effort") != "none"
                or payload.get("max_output_tokens") != 10000 or payload.get("store") is not False):
            raise ValueError("Unexpected Responses input or model settings")
        hashes = {
            "modelInputSha256": canonical_sha256(payload["input"]),
            "promptSha256": hashlib.sha256(instructions.encode("utf-8")).hexdigest(),
            "outputSchemaSha256": canonical_sha256(payload["text"]["format"]["schema"]),
        }
        if hashes["promptSha256"] != capture["provenance"]["promptSha256"]:
            raise ValueError("The actual prompt changed")
        called_cases.add(current["caseId"])
        manifest["actualCalls"] += 1
        current.update(hashes)
        request.extensions["regionEvaluationStart"] = time.monotonic()
        request.extensions["regionEvaluationSequence"] = manifest["actualCalls"]
        record({"event": "request", "sequence": manifest["actualCalls"], **hashes})

    async def on_response(response):
        await response.aread()
        try:
            payload = response.json()
        except ValueError:
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        response_status = payload.get("status")
        if response_status not in {"completed", "failed", "in_progress", "cancelled", "queued", "incomplete"}:
            response_status = None
        entry = {
            "event": "response", "sequence": response.request.extensions["regionEvaluationSequence"],
            "status": response.status_code, "responseStatus": response_status,
            "usage": allowed_usage(payload.get("usage")),
            "elapsedSeconds": time.monotonic() - response.request.extensions["regionEvaluationStart"],
        }
        current["apiResponse"] = entry
        record(entry)

    try:
        sys.path.insert(0, str(ROOT / "backend/ai-service"))
        import httpx2 as httpx
        from langchain_openai import ChatOpenAI
        from openai import AsyncOpenAI
        from app.config import Settings
        from app.support_program_ranking.agent import SupportProgramRecommendationAgent
        from app.support_program_ranking.models import SupportProgramRankingRequest
        from app.support_program_ranking.prompt import (
            SUPPORT_PROGRAM_COMPANY_CONDITIONS_INSTRUCTIONS, SUPPORT_PROGRAM_RANKING_INSTRUCTIONS,
        )
        from app.support_program_ranking.service import SupportProgramRankingService

        if os.environ.get("OPENAI_BASE_URL", OFFICIAL_BASE_URL).rstrip("/") != OFFICIAL_BASE_URL:
            raise ValueError("Only the official OpenAI endpoint is permitted")
        settings = Settings.from_environment()
        if (settings.openai_model != "gpt-5.6-luna"
                or (settings.llm_ranking_model_timeout_seconds, settings.llm_ranking_run_timeout_seconds) != (45, 50)):
            raise ValueError("Preserve the current model and 45/50 second ranking timeouts")
        parsed = [SupportProgramRankingRequest.model_validate(row["request"]) for row in requests]
        prompt = f"{SUPPORT_PROGRAM_RANKING_INSTRUCTIONS}\n\n{SUPPORT_PROGRAM_COMPANY_CONDITIONS_INSTRUCTIONS}"
        capture["provenance"].update(model=settings.openai_model,
                                       promptSha256=hashlib.sha256(prompt.encode("utf-8")).hexdigest())
        manifest.update(model=settings.openai_model, promptSha256=capture["provenance"]["promptSha256"])
        sources = [
            "backend/ai-service/app/support_program_ranking/prompt.py",
            "backend/ai-service/app/support_program_ranking/agent.py",
            "backend/ai-service/app/support_program_llm.py",
            "backend/ai-service/app/support_program_ranking/service.py",
            "backend/ai-service/app/support_program_ranking/models.py",
            "backend/ai-service/app/config.py",
            "evaluation/support-program-search/run-region-eligibility.py",
            "evaluation/support-program-search/evaluate-region-eligibility.py",
        ]
        manifest["sourceSha256"] = {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in sources}
        http_client = httpx.AsyncClient(transport=transport, trust_env=False, follow_redirects=False,
                                       event_hooks={"request": [on_request], "response": [on_response]})
        client = AsyncOpenAI(api_key=settings.openai_api_key, base_url=OFFICIAL_BASE_URL,
                             max_retries=0, timeout=settings.llm_model_timeout_seconds, http_client=http_client)
        agent = SupportProgramRecommendationAgent(
            model=ChatOpenAI(
                model=settings.openai_model, api_key=settings.openai_api_key,
                use_responses_api=True, max_retries=0,
                root_async_client=client, async_client=client.chat.completions,
            ),
            model_timeout_seconds=45, run_timeout_seconds=50, reasoning_effort="none",
        )
        configured = agent._model.kwargs
        if configured["max_tokens"] != 10000 or configured["reasoning"]["effort"] != "none" or configured["store"] is not False:
            raise ValueError("Production ranking settings changed")

        class RecordingAgent:
            async def rank(self, request):
                output = await agent.rank(request)
                current["output"] = output.model_dump(mode="json", by_alias=True)
                return output

        service = SupportProgramRankingService(RecordingAgent())
        for row, request in zip(requests, parsed, strict=True):
            current.clear()
            current.update(caseId=row["caseId"], requestSha256=canonical_sha256(row["request"]))
            start = time.monotonic()
            response = await service.rank(request)
            api = current.get("apiResponse", {})
            counts = api.get("usage") or {}
            if (current["caseId"] not in called_cases or api.get("status") != 200
                    or api.get("responseStatus") != "completed"
                    or not all(type(counts.get(key)) is int for key in ("input_tokens", "output_tokens", "total_tokens"))):
                raise ValueError("Complete successful API usage and actual input are required")
            observation = {key: current[key] for key in (
                "caseId", "requestSha256", "modelInputSha256", "promptSha256", "outputSchemaSha256", "output",
            )}
            observation.update(response=response.model_dump(mode="json", by_alias=True),
                               elapsedSeconds=time.monotonic() - start)
            capture["observations"].append(observation)
            manifest["completedRankings"] += 1
            print(json.dumps({"caseId": row["caseId"], "completed": manifest["completedRankings"],
                              "planned": len(requests)}), flush=True)
        report = evaluator.evaluate(fixture, capture)
        write_json(output_dir / "report.json", report)
        manifest["status"] = "passed" if report["passed"] else "quality_failed"
        exit_code = 0 if report["passed"] else 1
    except Exception as error:
        manifest["errorType"] = type(error).__name__
        record({"event": "failed", "errorType": type(error).__name__})
        if current.get("output") is not None and not any(
                row["caseId"] == current["caseId"] for row in capture["observations"]):
            capture["observations"].append({key: value for key, value in current.items() if key != "apiResponse"})
    finally:
        try:
            if client is not None:
                await client.close()
            elif http_client is not None:
                await http_client.aclose()
        except Exception as error:
            manifest["cleanupErrors"].append(type(error).__name__)
            manifest["status"] = "failed"
            exit_code = 2
        manifest["finishedAt"] = now()
        manifest["captureSha256"] = canonical_sha256(capture)
        manifest["apiUsageSha256"] = canonical_sha256(usage)
        try:
            write_json(output_dir / "fixture.json", fixture)
            write_json(output_dir / "capture.json", capture)
            write_json(output_dir / "api-usage.json", usage)
            write_json(output_dir / "execution-manifest.json", manifest)
        finally:
            logging.disable(previous_logging)
    return exit_code


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, default=Path(__file__).with_name("region-eligibility-fixture.json"))
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--execute", action="store_true", help="Explicitly spend up to three ranking calls")
    args = parser.parse_args(argv)
    try:
        fixture = evaluator.replay.load_json(args.fixture)
        requests = evaluator.build_requests(fixture)
        if not args.execute:
            print(json.dumps({"execute": False, "actualApiCalls": 0, "maximumOpenaiCalls": len(requests),
                              "caseIds": [row["caseId"] for row in requests],
                              "fixtureSha256": canonical_sha256(fixture)}, ensure_ascii=False))
            return 0
        if args.output_dir is None:
            raise ValueError("An unused output directory is required")
        result = asyncio.run(execute(args, fixture))
        if result == 2:
            print("Regional execution failed; inspect the redacted manifest.", file=sys.stderr)
        return result
    except Exception as error:
        print(f"Regional execution failed ({type(error).__name__}).", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
