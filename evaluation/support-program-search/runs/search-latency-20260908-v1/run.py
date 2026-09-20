"""Fixed 20-candidate latency comparison: explicit execution, 18 attempts, no retries."""
import argparse
import asyncio
import copy
from dataclasses import replace
from datetime import datetime, timezone
import fcntl
import hashlib
import importlib.util
import json
import logging
import os
from pathlib import Path
import re
import sys
import time
from unittest.mock import patch


ROOT = Path(__file__).resolve().parent
REPOSITORY = ROOT.parents[3]
REQUEST_FILE = ROOT.parent / "search-precision-v5-20260907-v1/request.json"
BASELINE_FILE = ROOT / "baseline_agent.py"
COMPACT_FILE = ROOT / "compact_agent.py"
PROMPT_FILE = ROOT / "prompt_at_execution.py"
MODEL = "gpt-5.6-sol"
PHASES = ("baseline", "compact", "fast")
CASES = [
    ("FUNDS", "사업화 지원금", "SW", "지원금"),
    ("FUNDS_PARAPHRASE", "소프트웨어 제품 사업화 비용 지원", "SW", "사업화 비용 지원"),
    ("CONSULTING", "사업화 컨설팅", "SW", "컨설팅"),
    ("FILM", "영화 후반작업비 지원", "영화제작", "후반작업비 지원"),
    ("BROAD", "사업화 지원", "SW", "사업화"),
]
PLAN = [(case[0], 1) for case in CASES] + [("FUNDS", 2)]


class GuardRejected(RuntimeError):
    """Contains only a fixed diagnostic code, never source data or credentials."""


def sha(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":")).encode()).hexdigest()


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def requests_for_cases():
    frozen = json.loads(REQUEST_FILE.read_text(encoding="utf-8"))
    if len(frozen["candidates"]) != 20 or frozen["scoringVersion"] != "govbiz-support-program-ranking-v5":
        raise GuardRejected("FIXTURE_CHANGED")
    requests = {}
    for name, query, industry, purpose in CASES:
        request = copy.deepcopy(frozen)
        request["originalQuery"] = query
        request["companyConditions"].update(industry=industry, supportPurpose=purpose)
        requests[name] = request
    return requests


def read_api_key(key_file):
    value = os.environ.get("OPENAI_API_KEY", "")
    if not value and key_file is not None:
        matches = []
        for line in Path(key_file).read_text(encoding="utf-8").splitlines():
            match = re.fullmatch(r"\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*(.*?)\s*", line)
            if match:
                raw = match[1]
                if raw.startswith(("'", '"')):
                    quoted = re.fullmatch(r"(['\"])([^'\"]*)\1\s*(?:#.*)?", raw)
                    if quoted is None:
                        raise GuardRejected("INVALID_KEY_FILE")
                    raw = quoted[2]
                else:
                    raw = raw.split("#", 1)[0].strip()
                matches.append(raw)
        if len(matches) != 1:
            raise GuardRejected("MISSING_OR_DUPLICATE_API_KEY")
        value = matches[0]
    if not value or re.fullmatch(r"[A-Za-z0-9_.-]+", value) is None:
        raise GuardRejected("MISSING_OR_INVALID_API_KEY")
    return value


def ledger_event(path, event):
    # The shared, append-only ledger survives partial runs and rejects concurrent phase reruns.
    with path.open("a+", encoding="utf-8") as ledger:
        fcntl.flock(ledger.fileno(), fcntl.LOCK_EX)
        ledger.seek(0)
        existing = [json.loads(line) for line in ledger if line.strip()]
        phase = event["phase"]
        reservations = [item for item in existing if item["event"] == "phase_reserved"]
        attempts = [item for item in existing if item["event"] == "attempt"]
        if event["event"] == "phase_reserved":
            if phase not in PHASES or any(item["phase"] == phase for item in reservations):
                raise GuardRejected("PHASE_ALREADY_RESERVED")
        elif event["event"] == "attempt":
            identity = (event["caseId"], event["repetition"])
            prior = [item for item in attempts if item["phase"] == phase]
            if (not any(item["phase"] == phase for item in reservations) or identity not in PLAN
                    or len(attempts) >= 18 or len(prior) >= 6
                    or any((item["caseId"], item["repetition"]) == identity for item in prior)):
                raise GuardRejected("ATTEMPT_BUDGET_OR_DUPLICATE")
        else:
            raise GuardRejected("UNKNOWN_LEDGER_EVENT")
        ledger.seek(0, os.SEEK_END)
        ledger.write(json.dumps({**event, "recordedAt": datetime.now(timezone.utc).isoformat()}) + "\n")
        ledger.flush()
        os.fsync(ledger.fileno())


def check_wire_request(request, payload, *, tier, active):
    url = request.url
    if (request.method != "POST" or url.scheme != "https" or url.host != "api.openai.com"
            or url.port not in (None, 443) or url.path != "/v1/responses" or url.query
            or url.username or url.password):
        raise GuardRejected("DESTINATION_REJECTED")
    if (not active.get("runnerVerified") or active.get("sent")
            or payload.get("model") != MODEL or payload.get("store") is not False
            or payload.get("max_output_tokens") != 10_000
            or payload.get("reasoning", {}).get("effort") != "low"
            or payload.get("service_tier") != tier or payload.get("tools", [])
            or payload.get("stream", False)):
        raise GuardRejected("WIRE_SETTINGS_OR_DUPLICATE")
    timeout = request.extensions.get("timeout", {})
    if not timeout or any(value != 45 for value in timeout.values()):
        raise GuardRejected("HTTP_TIMEOUT_CHANGED")
    schema = payload.get("text", {}).get("format", {})
    if (schema.get("type") != "json_schema" or schema.get("strict") is not True
            or sha(schema.get("schema")) != active["schemaSha256"]
            or sha(payload.get("input")) != active["modelInputSha256"]
            or sha(payload.get("instructions")) != active["promptSha256"]):
        raise GuardRejected("PROMPT_INPUT_OR_SCHEMA_CHANGED")


def load_snapshot(path, suffix):
    name = f"app.support_program_ranking._latency_{suffix}"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def safe_error(error):
    from app.support_program_ranking.errors import AgentFailureCode
    reason = getattr(error, "reason_code", None)
    return {"errorType": type(error).__name__, "reasonCode": (
        str(error) if isinstance(error, GuardRejected) else reason.value
        if isinstance(reason, AgentFailureCode) else "EXECUTION_FAILED"
    )}


async def run_phase(phase, requests, *, offline, fast_format, api_key):
    import httpx2
    from agents import OpenAIResponsesModel, Runner
    from agents.agent_output import AgentOutputSchema
    from openai import AsyncOpenAI
    from openai.types.shared import Reasoning
    from app.support_program_ranking.models import SupportProgramRankingRequest
    from app.support_program_ranking.service import SupportProgramRankingService

    compact = phase == "compact" or phase == "fast" and fast_format == "compact"
    module = load_snapshot(BASELINE_FILE, "baseline") if phase == "baseline" else load_snapshot(COMPACT_FILE, "compact")
    prompt = load_snapshot(PROMPT_FILE, "prompt")
    # Freeze the model-facing policy as well as the agent code; later production fixes must not alter this experiment.
    module.SUPPORT_PROGRAM_RANKING_INSTRUCTIONS = prompt.SUPPORT_PROGRAM_RANKING_INSTRUCTIONS
    module.SUPPORT_PROGRAM_COMPANY_CONDITIONS_INSTRUCTIONS = prompt.SUPPORT_PROGRAM_COMPANY_CONDITIONS_INSTRUCTIONS
    tier = "priority" if phase == "fast" else "default"
    mode = "offline" if offline else "live"
    output = ROOT / ("offline-output" if offline else "output") / phase
    output.parent.mkdir(exist_ok=True)
    output.mkdir(exist_ok=False)
    ledger = ROOT / f"ledger-{mode}.jsonl"
    ledger_event(ledger, {"event": "phase_reserved", "phase": phase, "outputFormat": "compact" if compact else "full"})
    parsed = {name: SupportProgramRankingRequest.model_validate(value) for name, value in requests.items()}
    manifest = {
        "status": "running", "provenance": "mock" if offline else "live_openai", "phase": phase,
        "startedAt": datetime.now(timezone.utc).isoformat(), "maximumPhaseAttempts": 6,
        "maximumTotalAttempts": 18, "attempts": 0, "actualCalls": 0, "completedRankings": 0,
        "failedRankings": 0, "embeddingCalls": 0, "sdkMaxRetries": 0, "agentMaxTurns": 1,
        "model": MODEL, "reasoning": "low", "maxOutputTokens": 10_000, "modelTimeoutSeconds": 45,
        "runTimeoutSeconds": 50, "requestedServiceTier": tier, "outputFormat": "compact" if compact else "full",
        "agentSourceSha256": hashlib.sha256(Path(module.__file__).read_bytes()).hexdigest(),
        "promptSourceSha256": hashlib.sha256(PROMPT_FILE.read_bytes()).hexdigest(),
        "requestSha256": sha(requests), "candidateSha256": sha(next(iter(requests.values()))["candidates"]),
        "scoringVersion": "govbiz-support-program-ranking-v5", "plan": PLAN,
        "limitations": "AI_DRAFT development diagnostic; fixed candidates; no human truth, full-search quality or statistical conclusion.",
    }
    write(output / "requests.json", requests)
    write(output / "manifest.json", manifest)
    active, receipts, observations = {}, [], []

    async def on_request(request):
        payload = json.loads(await request.aread())
        check_wire_request(request, payload, tier=tier, active=active)
        active["sent"] = True
        active["httpStarted"] = time.monotonic()
        manifest["actualCalls"] += 1
        receipts.append({"event": "request", **active["receipt"], "sequence": manifest["actualCalls"],
                         **{name: active[name] for name in ("schemaSha256", "modelInputSha256", "promptSha256")}})
        write(output / "usage.json", receipts)
        write(output / "manifest.json", manifest)

    async def on_response(response):
        await response.aread()
        try:
            body = response.json()
        except ValueError:
            body = {}
        body = body if isinstance(body, dict) else {}
        usage = body.get("usage") or {}
        usage = usage if isinstance(usage, dict) else {}
        counts = {key: value for key, value in usage.items()
                  if key in {"input_tokens", "output_tokens", "total_tokens"} and type(value) is int and value >= 0}
        def detail(name, field):
            nested = usage.get(name) or {}
            value = nested.get(field) if isinstance(nested, dict) else None
            return value if type(value) is int and value >= 0 else None
        status = body.get("status")
        returned_tier = body.get("service_tier")
        returned_model = body.get("model")
        receipt = {
            "event": "response", **active["receipt"], "httpStatus": response.status_code,
            "responseStatus": status if status in {"completed", "failed", "incomplete", "cancelled", "queued", "in_progress"} else None,
            "returnedServiceTier": returned_tier if returned_tier in {"auto", "default", "priority", "flex", "scale"} else None,
            "returnedModel": returned_model if isinstance(returned_model, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", returned_model) else None,
            "usage": counts, "cachedInputTokens": detail("input_tokens_details", "cached_tokens"),
            "reasoningTokens": detail("output_tokens_details", "reasoning_tokens"),
            "elapsedSeconds": round(time.monotonic() - active["httpStarted"], 3),
        }
        active["responseReceipt"] = receipt
        receipts.append(receipt)
        write(output / "usage.json", receipts)

    def mock_response(request):
        payload = json.loads(request.content)
        candidate_payload = json.loads(payload["input"][0]["content"])
        rankings = {}
        for candidate in candidate_payload["candidates"]:
            eligibility = {"v": "UNKNOWN", "e": [], "x": "오프라인 대역"} if compact else {
                "eligibility": "UNKNOWN", "evidence": [], "explanation": "오프라인 대역"}
            rankings[candidate["id"]] = ({"s": 0, "f": 0, "t": eligibility, "r": eligibility, "why": ["오프라인 대역"]}
                if compact else {"semanticRelevance": 0, "supportTypeFit": 0, "targetAssessment": eligibility,
                                 "regionAssessment": eligibility, "recommendationReasons": ["오프라인 대역"]})
        return httpx2.Response(200, json={
            "id": "resp_mock", "created_at": 0, "object": "response", "model": MODEL,
            "status": "completed", "service_tier": tier, "error": None, "incomplete_details": None,
            "output": [{"id": "msg_mock", "type": "message", "role": "assistant", "status": "completed",
                        "content": [{"type": "output_text", "text": json.dumps({"rankings": rankings}), "annotations": []}]}],
            "parallel_tool_calls": False, "tools": [], "tool_choice": "none",
            "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2,
                      "input_tokens_details": {"cached_tokens": 0}, "output_tokens_details": {"reasoning_tokens": 0}},
        })

    http = httpx2.AsyncClient(transport=httpx2.MockTransport(mock_response) if offline else None,
        trust_env=False, follow_redirects=False, timeout=45,
        event_hooks={"request": [on_request], "response": [on_response]})
    client = AsyncOpenAI(api_key=api_key, base_url="https://api.openai.com/v1", max_retries=0,
                         timeout=45, http_client=http)
    original_run = Runner.run

    async def guarded_run(agent, model_input, **kwargs):
        settings = agent.model_settings
        config = kwargs.get("run_config")
        if (kwargs.get("max_turns") != 1 or active.get("runnerVerified") or settings.max_tokens != 10_000
                or settings.timeout != 45 or settings.store is not False or settings.reasoning.effort != "low"
                or settings.extra_args != {"timeout": 45, "service_tier": tier}
                or config is None or not config.tracing_disabled or config.trace_include_sensitive_data
                or client.max_retries != 0):
            raise GuardRejected("RUNNER_SETTINGS_CHANGED")
        incoming = json.loads(model_input)
        restored = copy.deepcopy(incoming)
        expected = active["request"].model_dump(mode="json", by_alias=True)
        if len(restored.get("candidates", [])) != 20:
            raise GuardRejected("CANDIDATE_INPUT_CHANGED")
        for index, candidate in enumerate(restored["candidates"]):
            original_candidate = active["request"].candidates[index]
            options = [{"index": number, **option.model_dump()}
                       for number, option in enumerate(module.build_evidence_options(original_candidate))]
            expected_id = f"p{index}" if compact else original_candidate.id
            if candidate.get("id") != expected_id or candidate.pop("evidenceOptions", None) != options:
                raise GuardRejected("CANDIDATE_INPUT_CHANGED")
            candidate["id"] = original_candidate.id
        if restored != expected:
            raise GuardRejected("CANDIDATE_INPUT_CHANGED")
        active.update(runnerVerified=True, schemaSha256=sha(AgentOutputSchema(agent.output_type).json_schema()),
                      modelInputSha256=sha([{"role": "user", "content": model_input}]),
                      promptSha256=sha(agent.instructions))
        return await original_run(agent, model_input, **kwargs)

    try:
        with patch.object(Runner, "run", side_effect=guarded_run):
            for name, repetition in PLAN:
                active.clear()
                active["request"] = parsed[name]
                active["receipt"] = {"identity": [name, phase, repetition], "requestSha256": sha(requests[name]),
                                     "candidateSha256": sha(requests[name]["candidates"])}
                ledger_event(ledger, {"event": "attempt", "phase": phase, "caseId": name, "repetition": repetition,
                                      "requestSha256": sha(requests[name])})
                manifest["attempts"] += 1
                write(output / "manifest.json", manifest)
                start = time.monotonic()
                observation = dict(active["receipt"])
                try:
                    options = {"compact_output": compact} if phase != "baseline" else {}
                    delegate = module.SupportProgramRecommendationAgent(
                        model=OpenAIResponsesModel(model=MODEL, openai_client=client),
                        model_timeout_seconds=45, run_timeout_seconds=50, **options)
                    delegate._agent = delegate._agent.clone(model_settings=replace(
                        delegate._agent.model_settings, reasoning=Reasoning(effort="low"),
                        extra_args={"timeout": 45, "service_tier": tier}))
                    if delegate._run_timeout_seconds != 50:
                        raise GuardRejected("RUN_TIMEOUT_CHANGED")

                    class RecordingAgent:
                        async def rank(self, request):
                            result = await delegate.rank(request)
                            active["assessments"] = result.model_dump(mode="json", by_alias=True)
                            return result

                    # Both instances are new for every case, including FUNDS repetition 2.
                    response = await SupportProgramRankingService(RecordingAgent()).rank(parsed[name])
                    receipt = active.get("responseReceipt", {})
                    if (receipt.get("httpStatus") != 200 or receipt.get("responseStatus") != "completed"
                            or set(receipt.get("usage", {})) != {"input_tokens", "output_tokens", "total_tokens"}):
                        raise GuardRejected("MISSING_COMPLETE_RECEIPT")
                    observation.update(status="completed", response=response.model_dump(mode="json", by_alias=True))
                    manifest["completedRankings"] += 1
                except Exception as error:
                    observation.update(status="failed", **safe_error(error))
                    manifest["failedRankings"] += 1
                observation["elapsedSeconds"] = round(time.monotonic() - start, 3)
                observation.update({field: active[field] for field in ("assessments", "schemaSha256", "modelInputSha256", "promptSha256")
                                    if field in active})
                observations.append(observation)
                write(output / "capture.json", {"observations": observations})
                write(output / "manifest.json", manifest)
                print(json.dumps({"identity": observation["identity"], "status": observation["status"],
                                  "attempts": manifest["attempts"], "actualCalls": manifest["actualCalls"]}), flush=True)
    finally:
        await client.close()
        manifest["status"] = "completed" if manifest["completedRankings"] == 6 else "failed"
        manifest["finishedAt"] = datetime.now(timezone.utc).isoformat()
        write(output / "manifest.json", manifest)
    return 0 if manifest["status"] == "completed" else 2


async def run(execute=False, offline=False, phase="all", fast_format="full", key_file=None):
    requests = requests_for_cases()
    phases = PHASES if phase == "all" else (phase,)
    if phase not in (*PHASES, "all") or fast_format not in {"full", "compact"}:
        raise GuardRejected("INVALID_PHASE_OR_FORMAT")
    if not execute:
        print(json.dumps({"execute": False, "plannedRankingCalls": len(phases) * 6, "maximumTotalAttempts": 18,
                          "embeddingCalls": 0, "candidateCount": 20, "phases": phases, "planPerPhase": PLAN,
                          "fastFormat": fast_format, "offline": offline}))
        return 0
    if os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/") != "https://api.openai.com/v1":
        raise GuardRejected("BASE_URL_OVERRIDE_REJECTED")
    api_key = "offline-dummy" if offline else read_api_key(key_file)
    sys.path.insert(0, str(REPOSITORY / "backend/ai-service"))
    logging.disable(logging.CRITICAL)
    results = []
    for selected in phases:
        results.append(await run_phase(selected, requests, offline=offline, fast_format=fast_format, api_key=api_key))
    return max(results)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--phase", choices=(*PHASES, "all"), default="all")
    parser.add_argument("--fast-format", choices=("full", "compact"), default="full")
    parser.add_argument("--key-file", type=Path)
    args = parser.parse_args()
    try:
        result = asyncio.run(run(**vars(args)))
    except Exception as error:
        print(json.dumps({"status": "failed", "errorType": type(error).__name__,
                          "reasonCode": str(error) if isinstance(error, GuardRejected) else "EXECUTION_FAILED"}))
        result = 2
    raise SystemExit(result)
