#!/usr/bin/env python3
"""도우미 자유 질문 의도 분류·도구 에이전트 회귀 평가. 기본 실행은 모델 호출 없는 입력 검증이고 `--live`만 OpenAI를 호출한다.

`--agent`는 LangGraph 에이전트 경로(`/internal/v1/assistant/agent`)를 가짜 Core 도구 서버·가짜 근거 검색과 함께 돌린다.
회원 자료와 공고 원문은 `agent_fixtures.py`의 고정값이고 모델만 실제로 부른다.
"""

import argparse
import asyncio
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import sys
from time import perf_counter


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "backend/ai-service"))

from app.assistant.models import AssistantAnswerRequest, SCHEMA_VERSION  # noqa: E402
from app.assistant_agent.models import SCHEMA_VERSION as AGENT_SCHEMA_VERSION, AssistantAgentRequest  # noqa: E402

HELP_CONTENT = ROOT / "frontend/web/src/presentation/shared/help/helpContent.ts"
APP_PATHS = ROOT / "frontend/web/src/presentation/shared/routes/appPaths.ts"
QUESTIONS = HERE / "questions.json"
ABSTAIN_INTENTS = {"OUT_OF_SCOPE", "UNCLEAR"}
INTENTS = ["PRODUCT_HELP", "ACCOUNT_STATE", "SEARCH", "PROGRAM_QUESTION", "OUT_OF_SCOPE", "UNCLEAR"]
# 도구 에이전트 경로에서만 나오는 의도. `mode: "agent"` 문항만 이 의도를 기대할 수 있다.
AGENT_ONLY_INTENTS = ["PARTNER_MATCH", "SAVED_PROGRAMS_QUESTION"]
TOOL_NAMES = {"get_my_company_profile", "search_partner_recruitments", "list_saved_programs"}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def _unquote(value: str) -> str:
    return value.replace("\\'", "'")


def load_app_paths(path: Path = APP_PATHS) -> dict[str, str]:
    """`appPaths`의 `key: \\`${APP_PREFIX}/...\\`` 항목을 실제 경로로 바꾼다."""
    text = path.read_text(encoding="utf-8")
    prefix = re.search(r"export const APP_PREFIX = '([^']+)'", text)
    require(prefix is not None, "APP_PREFIX not found")
    block = re.search(r"export const appPaths = \{(.*?)\} as const", text, re.S)
    require(block is not None, "appPaths not found")
    paths = {}
    for key, rest in re.findall(r"(\w+): `\$\{APP_PREFIX\}([^`]*)`", block.group(1)):
        paths[key] = prefix.group(1) + rest
    return paths


def load_help_entries(path: Path = HELP_CONTENT, surface: str = "chatbot") -> list[dict]:
    """`helpContent.ts`의 항목 중 [surface]에 노출되는 것을 AI Service 요청 형식으로 읽는다. 프런트가 보내는 것과 같은 모양이다."""
    text = path.read_text(encoding="utf-8")
    app_paths = load_app_paths()
    entries = []
    for block in re.findall(r"\{\s*id: '.*?updatedOn: '[^']*',\s*\}", text, re.S):
        def field(name: str) -> str:
            match = re.search(rf"\n\s*{name}: '((?:[^'\\]|\\.)*)',", block)
            require(match is not None, f"help entry field {name} not found")
            return _unquote(match.group(1))

        surfaces = re.findall(r"'([a-z]+)'", re.search(r"surfaces: \[(.*?)\]", block, re.S).group(1))
        if surface not in surfaces:
            continue
        body_block = re.search(r"body: \[(.*?)\],\n", block, re.S).group(1)
        body = [_unquote(item) for item in re.findall(r"'((?:[^'\\]|\\.)*)'", body_block)]
        limitation_match = re.search(r"\n\s*limitation: (null|'(?:[^'\\]|\\.)*'),", block)
        limitation = None if limitation_match.group(1) == "null" else _unquote(limitation_match.group(1)[1:-1])
        action_match = re.search(r"\n\s*action: (null|\{ label: '((?:[^'\\]|\\.)*)', to: ([^\n]*?) \}),\n", block)
        require(action_match is not None, "help entry action not found")
        if action_match.group(1) == "null":
            action = None
        else:
            target = action_match.group(3).strip()
            ref = re.search(r"appPaths\.(\w+)", target)
            require(ref is not None and ref.group(1) in app_paths, f"unknown action route {target}")
            # 서버 계약은 경로만 받으므로 프런트처럼 `?mode=filter` 같은 질의를 뗀다.
            action = {"label": _unquote(action_match.group(2)), "to": app_paths[ref.group(1)]}
        entries.append({
            "id": field("id"), "title": field("title"), "question": field("question"), "summary": field("summary"),
            "body": body, "limitation": limitation, "audience": field("audience"), "status": field("status"), "action": action,
        })
    require(len(entries) > 0, "no help entries for the chatbot surface")
    require(len({entry["id"] for entry in entries}) == len(entries), "duplicate help entry ids")
    return entries


def load_questions(path: Path = QUESTIONS) -> dict:
    fixture = json.loads(path.read_text(encoding="utf-8"))
    require(fixture.get("schemaVersion") == "assistant-intent-eval-v2", "unsupported questions schema")
    require(fixture.get("dataType") == "synthetic", "this fixture must be explicitly synthetic")
    require(fixture.get("referenceSource") == "ai-authored", "reference source must be disclosed")
    cases = fixture.get("cases")
    require(isinstance(cases, list) and len(cases) > 0, "cases must be a non-empty list")
    ids = [case["id"] for case in cases]
    require(len(set(ids)) == len(ids), "case ids must be unique")
    for case in cases:
        mode = case.get("mode", "classify")
        require(mode in ("classify", "agent"), f"{case['id']}: mode must be classify or agent")
        require(case.get("expectedIntent") in INTENTS + (AGENT_ONLY_INTENTS if mode == "agent" else []), f"{case['id']}: unknown expectedIntent")
        require(case.get("split") in ("dev", "heldout"), f"{case['id']}: split must be dev or heldout")
        if case["expectedIntent"] == "PRODUCT_HELP":
            require(isinstance(case.get("expectedCitation"), str), f"{case['id']}: PRODUCT_HELP needs expectedCitation")
        if case["expectedIntent"] == "ACCOUNT_STATE":
            require(case.get("expectedAccountTopic") in ("SAVED_PROGRAMS", "RECEIVED_PROPOSALS", "COMPANY_PROFILE"), f"{case['id']}: bad expectedAccountTopic")
        if mode == "agent":
            tools = case.get("expectedTools")
            require(isinstance(tools, list) and set(tools) <= TOOL_NAMES, f"{case['id']}: agent cases need expectedTools within {sorted(TOOL_NAMES)}")
            require(case.get("session", {}).get("authenticated") is True, f"{case['id']}: agent cases are asked with a logged-in session")
            cards = case.get("expectedCards", [])
            require(isinstance(cards, list) and all(isinstance(item, str) for item in cards), f"{case['id']}: expectedCards must be a list of ids")
    return fixture


def is_agent_case(case: dict) -> bool:
    return case.get("mode", "classify") == "agent"


def build_requests(fixture: dict, help_entries: list[dict]) -> list[tuple[dict, AssistantAnswerRequest]]:
    """질문마다 AI Service 계약으로 검증된 요청을 만든다. 도움말은 항상 전량을 싣는다."""
    help_ids = {entry["id"] for entry in help_entries}
    defaults = fixture.get("defaults", {})
    prepared = []
    for case in fixture["cases"]:
        if is_agent_case(case):
            # 분류 경로는 에이전트 전용 의도를 낼 수 없으므로 에이전트 문항은 --agent에서만 평가한다.
            continue
        citation = case.get("expectedCitation")
        require(citation is None or citation in help_ids, f"{case['id']}: expectedCitation {citation} is not a chatbot help entry")
        request = AssistantAnswerRequest.model_validate({
            "schemaVersion": SCHEMA_VERSION,
            "message": case["message"],
            "history": case.get("history", []),
            "session": case.get("session", defaults.get("session")),
            "context": case.get("context", defaults.get("context")),
            "helpEntries": help_entries,
        })
        prepared.append((case, request))
    return prepared


def build_agent_requests(fixture: dict, help_entries: list[dict]) -> list[tuple[dict, AssistantAgentRequest]]:
    """모든 문항을 에이전트 계약으로 만든다. 로그인 세션이면 가짜 도구 서버가 받는 고정 principal을 싣는다."""
    from agent_fixtures import ACCOUNT_ID, TOKEN

    help_ids = {entry["id"] for entry in help_entries}
    defaults = fixture.get("defaults", {})
    prepared = []
    for case in fixture["cases"]:
        citation = case.get("expectedCitation")
        require(citation is None or citation in help_ids, f"{case['id']}: expectedCitation {citation} is not a chatbot help entry")
        session = case.get("session", defaults.get("session"))
        principal = {"accountId": ACCOUNT_ID, "toolToken": TOKEN, "hasCompany": bool(session.get("hasCompany"))} if session.get("authenticated") else None
        request = AssistantAgentRequest.model_validate({
            "schemaVersion": AGENT_SCHEMA_VERSION,
            "message": case["message"],
            "history": case.get("history", []),
            "session": session,
            "context": case.get("context", defaults.get("context")),
            "helpEntries": help_entries,
            "principal": principal,
        })
        prepared.append((case, request))
    return prepared


def score(case: dict, output: dict | None) -> dict:
    """한 문항의 판정이다. `output`이 None이면 호출 실패다."""
    expected = case["expectedIntent"]
    result = {"id": case["id"], "split": case["split"], "expectedIntent": expected, "intent": None,
              "intentCorrect": False, "citationCorrect": None, "accountTopicCorrect": None, "abstained": None, "error": None}
    if output is None:
        result["error"] = "no output"
        return result
    intent = output.get("intent")
    result["intent"] = intent
    result["intentCorrect"] = intent == expected
    result["abstained"] = intent in ABSTAIN_INTENTS
    if expected == "PRODUCT_HELP":
        result["citationCorrect"] = case["expectedCitation"] in (output.get("citations") or [])
    if expected == "ACCOUNT_STATE":
        result["accountTopicCorrect"] = output.get("accountTopic") == case["expectedAccountTopic"]
    return result


def score_agent(case: dict, first: dict | None, final: dict | None, tool_calls: list[str], chunk_texts: dict[str, list[str]], valid_ids: set[str]) -> dict:
    """에이전트 문항의 판정. first는 첫 응답(의도), final은 답·카드가 담긴 마지막 응답이다."""
    result = score(case, first)
    result["mode"] = "agent"
    if final is None:
        return result
    expected_tools = set(case.get("expectedTools", []))
    result["tools"] = sorted(tool_calls)
    result["toolsCorrect"] = set(tool_calls) == expected_tools if is_agent_case(case) else None
    cards = final.get("cards") or []
    result["cardCount"] = len(cards)
    result["cardsValid"] = all(card.get("id") in valid_ids for card in cards)
    expected_cards = set(case.get("expectedCards", []))
    result["expectedCardsIncluded"] = expected_cards <= {card.get("id") for card in cards} if expected_cards else None
    quotes = [card.get("quote") for card in cards if card.get("quote")]
    result["quoteCount"] = len(quotes)
    result["quotesVerified"] = all(any(quote in text for text in chunk_texts.get(card.get("id"), [])) for card in cards for quote in [card.get("quote")] if quote)
    result["needsDocuments"] = bool(first and first.get("needsDocuments"))
    result["answered"] = bool(final.get("answer"))
    return result


def summarize_agent(results: list[dict]) -> dict:
    scored = [item for item in results if item.get("error") is None]
    agent_cases = [item for item in scored if item.get("toolsCorrect") is not None]
    with_expected_cards = [item for item in agent_cases if item.get("expectedCardsIncluded") is not None]
    with_quotes = [item for item in agent_cases if item.get("quoteCount", 0) > 0]
    return {
        "cases": len(results), "scored": len(scored), "errors": len(results) - len(scored),
        "intentAccuracy": _rate([item["intentCorrect"] for item in scored]),
        "agentCases": len(agent_cases),
        "toolSelectionAccuracy": _rate([item["toolsCorrect"] for item in agent_cases]),
        "cardValidityRate": _rate([item["cardsValid"] for item in agent_cases]),
        "expectedCardsIncludedRate": _rate([item["expectedCardsIncluded"] for item in with_expected_cards]),
        "quoteVerificationRate": _rate([item["quotesVerified"] for item in with_quotes]),
        "answeredRate": _rate([item["answered"] for item in agent_cases]),
    }


def _rate(values: list) -> float | None:
    return round(sum(1 for value in values if value) / len(values), 4) if values else None


def summarize(results: list[dict]) -> dict:
    """의도 정확도, 사용법 인용 정확도, 기권율(답 불가 문항)과 오기권율(답 가능 문항)을 센다."""
    def ratio(hits: int, total: int) -> float | None:
        return None if total == 0 else round(hits / total, 4)

    scored = [item for item in results if item["error"] is None]
    unanswerable = [item for item in scored if item["expectedIntent"] in ABSTAIN_INTENTS]
    answerable = [item for item in scored if item["expectedIntent"] not in ABSTAIN_INTENTS]
    help_cases = [item for item in scored if item["expectedIntent"] == "PRODUCT_HELP"]
    account_cases = [item for item in scored if item["expectedIntent"] == "ACCOUNT_STATE"]
    per_intent = {}
    for intent in INTENTS:
        items = [item for item in scored if item["expectedIntent"] == intent]
        per_intent[intent] = {"total": len(items), "correct": sum(item["intentCorrect"] for item in items)}
    per_split = {}
    for split in ("dev", "heldout"):
        items = [item for item in scored if item["split"] == split]
        per_split[split] = {"total": len(items), "intentAccuracy": ratio(sum(item["intentCorrect"] for item in items), len(items))}
    return {
        "cases": len(results),
        "scored": len(scored),
        "errors": len(results) - len(scored),
        "intentAccuracy": ratio(sum(item["intentCorrect"] for item in scored), len(scored)),
        "helpCitationAccuracy": ratio(sum(bool(item["citationCorrect"]) for item in help_cases), len(help_cases)),
        "accountTopicAccuracy": ratio(sum(bool(item["accountTopicCorrect"]) for item in account_cases), len(account_cases)),
        "abstainRateOnUnanswerable": ratio(sum(bool(item["abstained"]) for item in unanswerable), len(unanswerable)),
        "falseAbstainRateOnAnswerable": ratio(sum(bool(item["abstained"]) for item in answerable), len(answerable)),
        "perIntent": per_intent,
        "perSplit": per_split,
    }


def confusion(results: list[dict]) -> dict:
    table: dict[str, dict[str, int]] = {}
    for item in results:
        if item["error"] is not None:
            continue
        table.setdefault(item["expectedIntent"], {})
        table[item["expectedIntent"]][item["intent"]] = table[item["expectedIntent"]].get(item["intent"], 0) + 1
    return table


async def run_live(prepared: list[tuple[dict, AssistantAnswerRequest]]) -> tuple[list[dict], dict]:
    """AI Service 모듈을 그대로 써서 순서대로 한 번씩 호출한다. 요청 본문·답변 문장은 보고서에 남기지 않는다."""
    from agents import OpenAIResponsesModel
    from openai import AsyncOpenAI

    from app.assistant.agent import AssistantAgent
    from app.assistant.errors import AssistantAnswerError
    from app.assistant.service import AssistantService
    from app.config import DEFAULT_LLM_MODEL_TIMEOUT_SECONDS, DEFAULT_LLM_RUN_TIMEOUT_SECONDS, DEFAULT_OPENAI_ASSISTANT_MODEL

    api_key = os.environ.get("OPENAI_API_KEY")
    require(bool(api_key), "OPENAI_API_KEY is required for --live")
    # 서비스와 같은 기준: 도우미 전용 모델 설정이 없으면 가장 싼 기본 모델을 쓴다.
    model_name = os.environ.get("OPENAI_ASSISTANT_MODEL") or DEFAULT_OPENAI_ASSISTANT_MODEL
    reasoning_effort = os.environ.get("OPENAI_ASSISTANT_REASONING_EFFORT") or "low"
    client = AsyncOpenAI(api_key=api_key, base_url=os.environ.get("OPENAI_BASE_URL") or None)
    service = AssistantService(AssistantAgent(
        model=OpenAIResponsesModel(model=model_name, openai_client=client),
        model_timeout_seconds=DEFAULT_LLM_MODEL_TIMEOUT_SECONDS,
        run_timeout_seconds=DEFAULT_LLM_RUN_TIMEOUT_SECONDS,
        reasoning_effort=reasoning_effort,
    ))
    results = []
    latencies = []
    for case, request in prepared:
        started = perf_counter()
        try:
            response = await service.answer(request)
            output = response.model_dump(by_alias=True)
        except AssistantAnswerError as error:
            output = None
            error_kind = type(error).__name__
        latencies.append(perf_counter() - started)
        result = score(case, output)
        if output is None:
            result["error"] = error_kind
        result["latencyMs"] = round(latencies[-1] * 1000)
        results.append(result)
    return results, {"model": model_name, "reasoningEffort": reasoning_effort, "meanLatencyMs": round(sum(latencies) / len(latencies) * 1000) if latencies else None}


async def run_agent(prepared: list[tuple[dict, AssistantAgentRequest]]) -> tuple[list[dict], dict]:
    """에이전트 그래프를 실제 모델·가짜 도구 서버·가짜 근거 검색으로 돌린다. 관심 공고 질문은 Core처럼 두 번 부른다."""
    from app.assistant.errors import AssistantAnswerError
    from app.assistant_agent.graph import build_assistant_agent_graph
    from app.assistant_agent.service import AssistantAgentService
    from app.assistant_agent.tools import CoreToolClient
    from app.bootstrap import _chat_model
    from app.config import Settings
    from agent_fixtures import RECRUITMENT_IDS, SAVED_PROGRAM_IDS, SECRET, FakeCoreTools, FakeRetriever, chunk_texts, saved_program_documents

    require(bool(os.environ.get("OPENAI_API_KEY")), "OPENAI_API_KEY is required for --live")
    settings = Settings.from_environment()
    fake = FakeCoreTools()
    tool_client = CoreToolClient(base_url="http://core-service.eval", secret=SECRET, timeout_seconds=3, transport=fake.transport())
    graph = build_assistant_agent_graph(
        classify_model=_chat_model(settings, settings.openai_assistant_model, settings.openai_assistant_reasoning_effort),
        agent_model=_chat_model(settings, settings.openai_assistant_agent_model, settings.openai_assistant_agent_reasoning_effort),
        tool_client=tool_client, max_tool_calls=settings.assistant_agent_max_tool_calls, retriever=FakeRetriever(),
    )
    service = AssistantAgentService(graph=graph, timeout_seconds=30)
    valid_ids = RECRUITMENT_IDS | SAVED_PROGRAM_IDS
    results, latencies = [], []
    try:
        for case, request in prepared:
            started = perf_counter()
            first = final = None
            tool_calls: list[str] = []
            error_kind = None
            try:
                response = await service.answer(request)
                first = final = response.model_dump(by_alias=True)
                tool_calls = [call["name"] for call in first["toolCalls"]]
                if first["needsDocuments"]:
                    resumed = await service.answer(request.model_copy(update={
                        "saved_program_documents": request.model_validate({**request.model_dump(by_alias=True), "savedProgramDocuments": saved_program_documents(), "resumeIntent": "SAVED_PROGRAMS_QUESTION"}).saved_program_documents,
                        "resume_intent": "SAVED_PROGRAMS_QUESTION",
                    }))
                    final = resumed.model_dump(by_alias=True)
                    tool_calls += [call["name"] for call in final["toolCalls"]]
            except AssistantAnswerError as error:
                # 예외 이름과 계약 위반 사유만 남긴다. 질문·모델 문장은 담기지 않는다.
                cause = error.__cause__
                error_kind = type(error).__name__ + (f": {error}" if str(error) else "") + (f" <- {type(cause).__name__}: {str(cause)[:120]}" if cause is not None else "")
            latencies.append(perf_counter() - started)
            result = score_agent(case, first, final, tool_calls, chunk_texts(), valid_ids)
            if error_kind is not None:
                result["error"] = error_kind
            elif first is None:
                result["error"] = "no output"
            result["latencyMs"] = round(latencies[-1] * 1000)
            results.append(result)
    finally:
        await tool_client.aclose()
    return results, {
        "classifyModel": settings.openai_assistant_model, "classifyReasoningEffort": settings.openai_assistant_reasoning_effort,
        "agentModel": settings.openai_assistant_agent_model, "agentReasoningEffort": settings.openai_assistant_agent_reasoning_effort,
        "meanLatencyMs": round(sum(latencies) / len(latencies) * 1000) if latencies else None,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="OpenAI를 실제로 호출한다. OPENAI_API_KEY가 필요하다.")
    parser.add_argument("--agent", action="store_true", help="도구 에이전트 경로로 평가한다(가짜 Core 도구·가짜 근거 검색). 모든 문항을 돌린다.")
    parser.add_argument("--split", choices=["dev", "heldout"], help="한 분할만 평가한다.")
    parser.add_argument("--case", action="append", default=[], help="특정 문항 id만 평가한다(반복 가능).")
    parser.add_argument("--report", type=Path, help="결과 JSON을 이 경로에도 저장한다.")
    args = parser.parse_args()

    fixture = load_questions()
    help_entries = load_help_entries()
    prepared = build_agent_requests(fixture, help_entries) if args.agent else build_requests(fixture, help_entries)
    if args.split:
        prepared = [item for item in prepared if item[0]["split"] == args.split]
    if args.case:
        prepared = [item for item in prepared if item[0]["id"] in set(args.case)]
    require(len(prepared) > 0, "no cases selected")

    report = {
        "schemaVersion": "assistant-intent-eval-report-v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "dataType": fixture["dataType"],
        "referenceSource": fixture["referenceSource"],
        "questionsSha256": sha256(QUESTIONS.read_bytes()).hexdigest(),
        "helpContentSha256": sha256(HELP_CONTENT.read_bytes()).hexdigest(),
        "helpEntryCount": len(help_entries),
        "selectedCases": len(prepared),
        "mode": ("agent-" if args.agent else "") + ("live" if args.live else "dry-run"),
    }
    if args.live and args.agent:
        results, run_info = asyncio.run(run_agent(prepared))
        report.update(run_info)
        report["summary"] = {**summarize(results), **summarize_agent(results)}
        report["confusion"] = confusion(results)
        report["results"] = results
    elif args.live:
        results, run_info = asyncio.run(run_live(prepared))
        report.update(run_info)
        report["summary"] = summarize(results)
        report["confusion"] = confusion(results)
        report["results"] = results
    else:
        report["summary"] = None
        report["note"] = "dry-run: 질문·도움말·요청 계약만 검증했다. 의도 정확도는 --live로 측정한다."
    text = json.dumps(report, ensure_ascii=False, indent=2)
    # Windows 콘솔 기본 인코딩에서도 한글 문항 id·문구가 깨지지 않게 한다.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    print(text)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(text + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
