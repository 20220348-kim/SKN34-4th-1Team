#!/usr/bin/env python3
"""Replay frozen ranking HTTP requests with two prompts; live API calls require --execute."""

import argparse
import asyncio
import hashlib
import importlib.util
import json
import os
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend/ai-service"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
spec = importlib.util.spec_from_file_location("ranking_replay_evaluator", Path(__file__).with_name("evaluate-ranking-replay.py"))
evaluator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluator)


def sha256_file(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


async def execute(args, envelope, prompts):
    import httpx
    from app.config import Settings
    from app.main import create_app
    from app.support_program_ranking.models import SupportProgramRankingRequest, SupportProgramRankingResponse
    from app.support_program_ranking.prompt import SUPPORT_PROGRAM_RANKING_INSTRUCTIONS

    # This experiment changes only instructions, not model, reasoning, limits or scoring contract.
    settings = Settings.from_environment()
    if os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/") != "https://api.openai.com/v1":
        raise ValueError("Replay permits only the official OpenAI endpoint")
    if settings.openai_model != "gpt-5.6-luna":
        raise ValueError("Replay preserves the measured gpt-5.6-luna model")
    if (settings.llm_model_timeout_seconds, settings.llm_run_timeout_seconds) != (25.0, 30.0):
        raise ValueError("Replay requires the frozen 25/30 second timeouts")
    if prompts["after"] != SUPPORT_PROGRAM_RANKING_INSTRUCTIONS:
        raise ValueError("After prompt must equal the current production instructions")
    requests = envelope["queries"]
    normalized = {
        row["id"]: SupportProgramRankingRequest.model_validate(row["request"])
        for row in requests
    }
    args.output_dir.mkdir(parents=True, exist_ok=False)
    apps = {}
    clients = {}
    observations = []
    usage = []
    current = {}
    call_count = 0
    max_calls = 2 * len(requests)
    started = datetime.now(timezone.utc).isoformat()
    succeeded = False
    sources = [
        "backend/ai-service/app/support_program_ranking/prompt.py",
        "backend/ai-service/app/support_program_ranking/agent.py",
        "backend/ai-service/app/support_program_ranking/service.py",
        "backend/ai-service/app/support_program_ranking/models.py",
        "backend/ai-service/app/config.py",
        "evaluation/support-program-search/replay-ranking.py",
    ]
    source_hashes = {path: sha256_file(ROOT / path) for path in sources}
    with (args.output_dir / "results.jsonl").open("x", encoding="utf-8", buffering=1) as results_file, \
            (args.output_dir / "api-usage.jsonl").open("x", encoding="utf-8", buffering=1) as usage_file:
        def record_usage(entry):
            entry = {**current, **entry, "time": datetime.now(timezone.utc).isoformat()}
            usage.append(entry)
            usage_file.write(json.dumps(entry, ensure_ascii=False) + "\n")

        async def on_request(request):
            nonlocal call_count
            if request.url.host != "api.openai.com" or request.url.path != "/v1/responses" or call_count >= max_calls:
                raise RuntimeError("Replay request destination or budget exceeded")
            call_count += 1
            request.extensions["replayStart"] = time.monotonic()
            request.extensions["replaySequence"] = call_count
            record_usage({"event": "request", "sequence": call_count})

        async def on_response(response):
            await response.aread()
            try:
                payload = response.json()
            except ValueError:
                payload = {}
            if not isinstance(payload, dict):
                payload = {}
            record_usage({"event": "response", "sequence": response.request.extensions["replaySequence"],
                          "status": response.status_code, "responseStatus": payload.get("status"),
                          "model": payload.get("model"), "usage": payload.get("usage"),
                          "elapsedSeconds": time.monotonic() - response.request.extensions["replayStart"]})

        try:
            for variant, prompt in prompts.items():
                app = create_app(settings=settings)
                apps[variant] = app
                agent = app.state.container.support_program_ranking_service._agent
                # Evaluation-only clone: same production agent and output contract, different instructions.
                agent._agent = agent._agent.clone(instructions=prompt)
                hooks = app.state.container.openai_client._client.event_hooks
                hooks["request"].append(on_request)
                hooks["response"].append(on_response)
                clients[variant] = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://replay.local")
            for index, row in enumerate(requests):
                # Counterbalance temporal effects; never feed one variant's answer into the other.
                order = ("before", "after") if index % 2 == 0 else ("after", "before")
                for variant in order:
                    current.clear()
                    current.update(queryId=row["id"], variant=variant)
                    start = time.monotonic()
                    response = await clients[variant].post("/internal/v1/support-program-rankings/rank", json=row["request"])
                    if response.status_code != 200:
                        raise RuntimeError(f"Ranking HTTP status {response.status_code}")
                    result = SupportProgramRankingResponse.model_validate(response.json())
                    body = result.model_dump(mode="json", by_alias=True)
                    if body["originalQuery"] != row["request"]["originalQuery"] or body["scoringVersion"] != row["request"]["scoringVersion"]:
                        raise ValueError("Ranking response identity mismatch")
                    item = {
                        **current, "requestSha256": evaluator.canonical_sha256(row["request"]),
                        "modelInputSha256": hashlib.sha256(normalized[row["id"]].model_dump_json(by_alias=True).encode()).hexdigest(),
                        "promptSha256": hashlib.sha256(prompts[variant].encode()).hexdigest(),
                        "elapsedSeconds": time.monotonic() - start, "response": body,
                    }
                    observations.append(item)
                    results_file.write(json.dumps(item, ensure_ascii=False) + "\n")
                    print(json.dumps({**current, "completed": len(observations), "planned": max_calls}), flush=True)
            if call_count != max_calls:
                raise ValueError("Expected exactly one OpenAI call per ranking")
            responses = [entry for entry in usage if entry["event"] == "response"]
            if len(responses) != max_calls or any(
                entry["status"] != 200 or entry["responseStatus"] != "completed"
                or not isinstance(entry.get("usage"), dict)
                or any(type(entry["usage"].get(key)) is not int for key in ("input_tokens", "output_tokens"))
                for entry in responses
            ):
                raise ValueError("Complete successful API usage records are required")
            succeeded = True
        except Exception as error:
            record_usage({"event": "failed", "errorType": type(error).__name__})
            raise
        finally:
            cleanup = await asyncio.gather(
                *(client.aclose() for client in clients.values()),
                *(app.state.container.close() for app in apps.values()),
                return_exceptions=True,
            )
            cleanup_errors = [type(error).__name__ for error in cleanup if isinstance(error, BaseException)]
            if cleanup_errors:
                succeeded = False
                record_usage({"event": "cleanup_failed", "errorTypes": cleanup_errors})
            completed_responses = [entry for entry in usage if entry["event"] == "response"]
            manifest = {
                "schemaVersion": "support-program-ranking-replay-execution-v1",
                "status": "succeeded" if succeeded else "failed", "startedAt": started,
                "cleanupErrors": cleanup_errors,
                "finishedAt": datetime.now(timezone.utc).isoformat(), "model": settings.openai_model,
                "sourceSha256": source_hashes, "sourceCaptureSha256": sha256_file(args.source_capture),
                "requestFileSha256": sha256_file(args.requests), "exportMetadataSha256": sha256_file(args.export_metadata),
                "promptSha256": {variant: hashlib.sha256(prompt.encode()).hexdigest() for variant, prompt in prompts.items()},
                "resultsSha256": sha256_file(args.output_dir / "results.jsonl"),
                "apiUsageSha256": sha256_file(args.output_dir / "api-usage.jsonl"),
                "queryCount": len(requests), "plannedCalls": max_calls, "actualCalls": call_count,
                "completedRankings": len(observations), "embeddingCalls": 0, "sdkMaxRetries": 0,
                "agentMaxTurns": 1, "maxOutputTokens": 4000, "reasoningEffort": "none", "store": False,
                "tracing": False, "timeoutsSeconds": {"model": 25, "agent": 30},
                "measurement": "Fixed candidate HTTP replay using in-process ASGI; not a new full search or browser latency measurement.",
                "variants": {},
            }
            for variant in prompts:
                entries = [entry for entry in completed_responses if entry["variant"] == variant]
                times = [entry["elapsedSeconds"] for entry in entries]
                manifest["variants"][variant] = {
                    "responses": len(entries), "httpFailures": sum(entry["status"] != 200 for entry in entries),
                    "inputTokens": sum((entry.get("usage") or {}).get("input_tokens", 0) for entry in entries),
                    "outputTokens": sum((entry.get("usage") or {}).get("output_tokens", 0) for entry in entries),
                    "cachedInputTokens": sum((entry.get("usage") or {}).get("input_tokens_details", {}).get("cached_tokens", 0) for entry in entries),
                    "meanApiSeconds": statistics.mean(times) if times else None,
                    "medianApiSeconds": statistics.median(times) if times else None,
                }
            with (args.output_dir / "execution-manifest.json").open("x", encoding="utf-8") as file:
                json.dump(manifest, file, ensure_ascii=False, indent=2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ("requests", "export-metadata", "source-capture", "fixture", "before-prompt", "after-prompt", "output-dir"):
        parser.add_argument(f"--{option}", required=True, type=Path)
    parser.add_argument("--execute", action="store_true", help="Explicitly permit up to two OpenAI ranking calls per frozen query")
    args = parser.parse_args()
    try:
        if args.output_dir.exists() or args.output_dir.is_symlink():
            raise ValueError("Replay output directory must be new")
        envelope = json.loads(args.requests.read_text())
        metadata = json.loads(args.export_metadata.read_text())
        if metadata["sourceHashes"]["requestFileSha256"] != sha256_file(args.requests):
            raise ValueError("Export metadata request file hash mismatch")
        fixture = evaluator.comparison.load_fixture(args.fixture)
        evaluator.validate_requests(envelope, fixture, args.source_capture)
        source_ids = [row["id"] for row in json.loads(args.source_capture.read_text())["observations"]]
        if len(source_ids) != 16 or [row["id"] for row in envelope["queries"]] != source_ids:
            raise ValueError("This experiment requires all 16 frozen queries in source order (maximum 32 calls)")
        prompts = {"before": args.before_prompt.read_text(), "after": args.after_prompt.read_text()}
        if not all(prompt.strip() for prompt in prompts.values()):
            raise ValueError("Both prompts must be nonempty")
        print(json.dumps({"queryCount": len(envelope["queries"]), "maximumOpenaiCalls": len(envelope["queries"]) * 2,
                          "embeddingCalls": 0, "execute": args.execute}), flush=True)
        if args.execute:
            asyncio.run(execute(args, envelope, prompts))
    except Exception as error:
        # API exceptions can contain upstream details; never print their original message or headers.
        parser.exit(1, f"Ranking replay failed ({type(error).__name__}); no automatic retry.\n")


if __name__ == "__main__":
    main()
