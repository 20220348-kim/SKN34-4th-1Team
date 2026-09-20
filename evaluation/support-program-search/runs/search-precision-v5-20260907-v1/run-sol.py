"""Fixed-candidate diagnostic. Explicit execution, official endpoint, no retries, bounded calls."""
import argparse
import asyncio
import copy
import hashlib
import importlib.util
import json
import logging
import os
import time
from datetime import datetime, timezone
from dataclasses import replace
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CASES = [
    ("FUNDS", "사업화 지원금", "SW", "지원금"),
    ("FUNDS_PARAPHRASE", "소프트웨어 제품 사업화 비용 지원", "SW", "사업화 비용 지원"),
    ("CONSULTING", "사업화 컨설팅", "SW", "컨설팅"),
    ("FILM", "영화 후반작업비 지원", "영화제작", "후반작업비 지원"),
    ("BROAD", "사업화 지원", "SW", "사업화"),
]


def sha(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def prompt_file(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


async def run(execute, offline=False):
    frozen = json.loads((ROOT / "request.json").read_text(encoding="utf-8"))
    before, after = prompt_file("prompt_baseline"), prompt_file("prompt_candidate")
    assert before.SUPPORT_PROGRAM_COMPANY_CONDITIONS_INSTRUCTIONS == after.SUPPORT_PROGRAM_COMPANY_CONDITIONS_INSTRUCTIONS
    prompts = {"after_sol_low": after.SUPPORT_PROGRAM_RANKING_INSTRUCTIONS}
    requests = {}
    plan = []
    for index, (name, query, industry, purpose) in enumerate(CASES):
        item = copy.deepcopy(frozen)
        item["originalQuery"] = query
        item["companyConditions"].update(industry=industry, supportPurpose=purpose)
        requests[name] = item
        plan.append((name, "after_sol_low", 1))
    plan.append(("FUNDS", "after_sol_low", 2))
    assert len(plan) == 6
    if not execute:
        print(json.dumps({"execute": False, "plannedRankingCalls": len(plan), "embeddingCalls": 0,
                          "candidateCount": len(frozen["candidates"]), "caseIds": list(requests)}))
        return 0
    logging.disable(logging.CRITICAL)
    import httpx
    from openai import AsyncOpenAI
    from openai.types.shared import Reasoning
    from agents import OpenAIResponsesModel
    from app.support_program_ranking.agent import SupportProgramRecommendationAgent
    from app.support_program_ranking.models import SCORING_VERSION, SupportProgramRankingRequest
    from app.support_program_ranking.service import SupportProgramRankingService
    agent_module = __import__("importlib").import_module("app.support_program_ranking.agent")

    assert agent_module.SUPPORT_PROGRAM_COMPANY_CONDITIONS_INSTRUCTIONS == before.SUPPORT_PROGRAM_COMPANY_CONDITIONS_INSTRUCTIONS
    assert SCORING_VERSION == "govbiz-support-program-ranking-v5"
    parsed = {key: SupportProgramRankingRequest.model_validate(value) for key, value in requests.items()}
    assert os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/") == "https://api.openai.com/v1"
    assert os.getenv("OPENAI_MODEL", "gpt-5.6-sol") == "gpt-5.6-sol"
    output = ROOT / ("offline-output" if offline else "output")
    output.mkdir(exist_ok=False)
    manifest = {"status": "running", "provenance": "mock" if offline else "live_openai",
                "startedAt": datetime.now(timezone.utc).isoformat(), "maximumCalls": len(plan),
                "actualCalls": 0, "completedRankings": 0, "embeddingCalls": 0, "sdkMaxRetries": 0,
                "agentMaxTurns": 1, "model": "gpt-5.6-sol", "reasoning": "low", "maxOutputTokens": 10000,
                "scoringVersion": SCORING_VERSION, "agentSourcePath": agent_module.__file__,
                "requestSha256": sha(requests), "plan": plan,
                "limitations": "AI-authored targeted development checks; not human truth, full search Recall/MRR, or statistical confidence."}
    write(output / "requests.json", requests)
    write(output / "manifest.json", manifest)
    usage, observations, active, called = [], [], {}, set()

    async def on_request(request):
        url = request.url
        key = tuple(active["identity"])
        if (url.scheme != "https" or url.host != "api.openai.com" or url.port not in (None, 443)
                or url.path != "/v1/responses" or request.method != "POST" or url.query
                or url.username or url.password or manifest["actualCalls"] >= len(plan) or key in called):
            raise ValueError("Destination, duplicate request or budget rejected")
        payload = json.loads(await request.aread())
        if (payload.get("model") != "gpt-5.6-sol" or payload.get("store") is not False
                or payload.get("max_output_tokens") != 10000 or payload.get("reasoning", {}).get("effort") != "low"):
            raise ValueError("Execution settings changed")
        expected = prompts[key[1]] + "\n\n" + before.SUPPORT_PROGRAM_COMPANY_CONDITIONS_INSTRUCTIONS
        if payload.get("instructions") != expected:
            raise ValueError("Wire prompt changed")
        called.add(key)
        manifest["actualCalls"] += 1
        active["modelInputSha256"] = sha(payload["input"])
        active["promptSha256"] = hashlib.sha256(expected.encode()).hexdigest()
        usage.append({"event": "request", "identity": key, "sequence": manifest["actualCalls"],
                      "modelInputSha256": active["modelInputSha256"], "promptSha256": active["promptSha256"]})
        write(output / "usage.json", usage)
        write(output / "manifest.json", manifest)

    async def on_response(response):
        await response.aread()
        try:
            body = response.json()
        except ValueError:
            body = {}
        counts = body.get("usage", {}) if isinstance(body, dict) else {}
        safe_counts = {key: value for key, value in counts.items()
                       if key in {"input_tokens", "output_tokens", "total_tokens"} and type(value) is int}
        usage.append({"event": "response", "identity": active["identity"], "httpStatus": response.status_code,
                      "responseStatus": body.get("status"), "returnedModel": body.get("model"), "usage": safe_counts,
                      "reasoningTokens": counts.get("output_tokens_details", {}).get("reasoning_tokens"),
                      "cachedInputTokens": counts.get("input_tokens_details", {}).get("cached_tokens")})
        write(output / "usage.json", usage)

    def mock_response(request):
        payload = json.loads(request.content)
        candidate_payload = json.loads(payload["input"][-1]["content"])
        output_value = {"rankings": {item["id"]: {
            "semanticRelevance": 0, "supportTypeFit": 0,
            "targetAssessment": {"eligibility": "UNKNOWN", "evidence": [], "explanation": "오프라인 대역"},
            "regionAssessment": {"eligibility": "UNKNOWN", "evidence": [], "explanation": "오프라인 대역"},
            "recommendationReasons": ["오프라인 대역"]} for item in candidate_payload["candidates"]}}
        return httpx.Response(200, json={"id": "resp_mock", "created_at": 0, "object": "response",
            "model": "gpt-5.6-sol", "status": "completed", "error": None, "incomplete_details": None,
            "output": [{"id": "msg_mock", "type": "message", "role": "assistant", "status": "completed",
                        "content": [{"type": "output_text", "text": json.dumps(output_value), "annotations": []}]}],
            "parallel_tool_calls": False, "tools": [], "tool_choice": "none",
            "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}})

    transport = httpx.MockTransport(mock_response) if offline else None
    http = httpx.AsyncClient(transport=transport, trust_env=False, follow_redirects=False,
                            event_hooks={"request": [on_request], "response": [on_response]})
    client = AsyncOpenAI(api_key="offline-dummy" if offline else os.environ["OPENAI_API_KEY"],
                         base_url="https://api.openai.com/v1", max_retries=0, timeout=45, http_client=http)
    code = 2
    try:
        agent = SupportProgramRecommendationAgent(model=OpenAIResponsesModel(model="gpt-5.6-sol", openai_client=client),
                                                 model_timeout_seconds=45, run_timeout_seconds=50)
        agent._agent = agent._agent.clone(model_settings=replace(agent._agent.model_settings, reasoning=Reasoning(effort="low")))

        class RecordingAgent:
            async def rank(self, request):
                result = await agent.rank(request)
                active["assessments"] = result.model_dump(mode="json", by_alias=True)
                return result

        service = SupportProgramRankingService(RecordingAgent())
        for name, variant, repetition in plan:
            active.clear()
            active["identity"] = (name, variant, repetition)
            agent._agent = agent._agent.clone(instructions=prompts[variant])
            start = time.monotonic()
            response = await service.rank(parsed[name])
            observations.append({**active, "elapsedSeconds": round(time.monotonic() - start, 3),
                "requestSha256": sha(requests[name]), "response": response.model_dump(mode="json", by_alias=True)})
            manifest["completedRankings"] += 1
            write(output / "capture.json", {"observations": observations})
            write(output / "manifest.json", manifest)
            print(json.dumps({"identity": active["identity"], "completed": len(observations),
                              "planned": len(plan), "resultCount": len(response.rankings)}), flush=True)
        receipts = [item for item in usage if item["event"] == "response"]
        if len(receipts) != len(plan) or any(item["httpStatus"] != 200 or item["responseStatus"] != "completed"
                or set(item["usage"]) != {"input_tokens", "output_tokens", "total_tokens"} for item in receipts):
            raise ValueError("Missing complete API receipts")
        manifest["status"] = "completed"
        code = 0
    except Exception as error:
        manifest.update(status="failed", errorType=type(error).__name__)
        print(json.dumps({"status": "failed", "errorType": type(error).__name__}), flush=True)
    finally:
        await client.close()
        manifest["finishedAt"] = datetime.now(timezone.utc).isoformat()
        write(output / "manifest.json", manifest)
    return code


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--offline", action="store_true")
    args = parser.parse_args()
    raise SystemExit(asyncio.run(run(args.execute, args.offline)))
