#!/usr/bin/env python3
"""AI 대화 검색 조건 해석 평가 세트(cases.json)의 형식·일관성 검사.

모델을 호출하지 않는다. 기대 라벨은 AI가 작성한 기대 동작이며 사람이 검토한 정답이 아니다.
이 도구는 라벨이 현재 AI Service의 요청·출력 계약과 서비스 검증(인용·병합·READY 검색 의도)을
통과하는지, 여러 턴 상태가 Core·웹이 전달하는 방식과 같은지, 범주별 최소 문항 수를 채우는지만 확인한다.
라벨의 의미 판정과 채점 규칙(judge)도 여기서 정의하며 replay.py가 같은 규칙으로 채점한다.
"""

import argparse
import asyncio
from collections import Counter
from dataclasses import dataclass, field
from hashlib import sha256
import importlib.util
import json
from pathlib import Path
import re
import sys
from typing import get_args
import unicodedata

HERE = Path(__file__).resolve().parent
AI_SERVICE = HERE.parents[1] / "backend" / "ai-service"
sys.path.insert(0, str(AI_SERVICE))

from pydantic import ValidationError  # noqa: E402

from app.support_program_conversation.errors import SupportProgramConversationError  # noqa: E402
from app.support_program_conversation.models import (  # noqa: E402
    SCHEMA_VERSION,
    AnswerKind,
    ClarificationKind,
    ConversationContext,
    SupportProgramConversationOutput,
    SupportProgramConversationRequest,
    SupportProgramConversationResponse,
    UpdateField,
)
from app.support_program_conversation.service import SupportProgramConversationService  # noqa: E402

CASES_PATH = HERE / "cases.json"
CASES_SCHEMA_VERSION = "govbiz-support-program-conversation-eval-v1"
FIELDS = get_args(UpdateField)
STATUSES = get_args(SupportProgramConversationOutput.model_fields["status"].annotation)
ANSWER_KINDS = get_args(AnswerKind)
CLARIFICATION_KINDS = get_args(ClarificationKind)
TEXT_FIELDS = ("QUERY", "INDUSTRY", "SUPPORT_PURPOSE")

# 설계 문서(AI 대화 검색 고도화 설계)의 단일 턴 범주·최소 문항 수. 후속 수정 범주는 v2에서 추가했다.
CATEGORIES = {
    "region": ("지역", 12),
    "industry": ("업종", 8),
    "establishment": ("업력", 10),
    "target": ("대상·청년", 10),
    "scale_amount": ("규모·금액", 6),
    "support_field": ("지원 분야", 10),
    "deadline": ("마감·접수 상태", 6),
    "alias_typo_english": ("약어·오타·영어", 10),
    "exclusion_multi_intent": ("제외·여러 의도", 8),
    "ambiguous_company": ("모호·회사 기반", 6),
    "non_search_injection": ("비검색·주입·개인정보", 8),
    "result_reference": ("결과 참조", 4),
    "followup_edit": ("후속 수정", 6),
    "other": ("기타·표현 다양성", 10),
}
MINIMUM_SINGLE_TURN_CASES = 150
MINIMUM_SCENARIOS = 15
MINIMUM_SCENARIO_TURNS = 45
MINIMUM_RESULT_ROUTE_SCENARIOS = 8

# 해석 호출이 정하고 Core가 정해진 처리로 보내는 라우팅의 기대 경로다. 현재 출력에는 route가 없으므로
# 상태로부터 pipeline(READY)·clarify(CLARIFICATION_REQUIRED)·answer(ANSWERED)만 대응시킬 수 있다.
ROUTES = (
    "pipeline", "clarify", "answer", "result_question", "compare", "more_results", "multi_intent", "zero_result_help",
)
RESULT_ROUTES = frozenset({"result_question", "compare", "more_results"})
FUTURE_ROUTES = RESULT_ROUTES | {"multi_intent", "zero_result_help"}
CURRENT_ROUTE_BY_STATUS = {"READY": "pipeline", "CLARIFICATION_REQUIRED": "clarify", "ANSWERED": "answer"}
MINIMUM_ROUTE_ITEMS = {"result_question": 6, "compare": 5, "more_results": 4, "multi_intent": 4, "zero_result_help": 4}

TAG_PREFIXES = frozenset({"style", "region", "state", "risk", "input", "op", "known-weak", "v2-gap"})
REQUIRED_TAGS = {
    **{f"style:{name}": 3 for name in (
        "banmal", "jondaetmal", "keyword", "long", "typo", "no-spacing", "english-mix", "emoji", "numeric",
    )},
    "region:multi": 2, "region:area": 2, "region:district": 3, "region:conflict": 2,
    "risk:pii": 3, "risk:injection": 3, "input:nonsense": 3,
    # 설계 문서가 지목한 약점 문장은 각각 한 번 이상 포함한다.
    **{f"known-weak:{name}": 1 for name in (
        "program-region", "seoul-ai-startup", "deadline-week", "always-open", "broad-repeat", "preliminary-youth",
        "small-business-5", "edu-to-fund", "exclude-consulting", "seventh-year", "year-21", "dotted-date",
        "second-item", "show-more", "eligibility-followup", "agency-rnd", "kotra", "zero-why", "chit-chat",
        "service-howto", "injection", "personal-data",
    )},
}
TOP_LEVEL_KEYS = {
    "schemaVersion", "requestSchemaVersion", "dataType", "labelSource", "humanReviewed", "description",
    "referenceDate", "cases", "scenarios",
}
CASE_KEYS = {
    "id", "categories", "tags", "request", "lastResults", "route", "routeAlternatives", "targetIndexes", "intents",
    "expected", "alternatives", "mustNot", "rationale",
}
MAXIMUM_INTENTS = 2
SCENARIO_KEYS = {"id", "title", "tags", "userGoal", "turns"}
TURN_KEYS = (CASE_KEYS - {"id"}) | {"turn", "after"}
REQUEST_KEYS = {
    "schemaVersion", "referenceDate", "message", "context", "pendingClarification", "pendingProposal", "lastSearch",
}
EXPECTATION_KEYS = {"status", "updates", "match", "optional", "answerKind", "clarificationKind"}
MATCH_KEYS = {"includes", "excludes", "anyOf"}
OPTIONAL_KEYS = MATCH_KEYS | {"op", "value"}
PROGRAM_KEYS = {"rank", "id", "sourceCode", "sourceName", "title", "organization", "status", "applicationEndDate"}
MAXIMUM_SHOWN_RESULTS = 5
PROGRAM_STATUSES = ("OPEN", "UPCOMING", "CLOSED", "UNKNOWN")
USER_GOAL_KEYS = {"persona", "hiddenCompany", "seeking", "rejectProposals", "successWhen", "maxTurns"}
AFTER_ACTIONS = ("continue", "confirmAndSearch", "cancel")

# Core SupportProgramRegionDictionary의 시·도 별칭만 옮긴 채점용 표기 정규화다. 시·군·구 동일성과 권역 해석은
# 하지 않는다. Core 전체 규칙의 적용 결과는 Core 재생 테스트(SupportProgramConversationEvaluationReplayTest)가 확인한다.
_PROVINCE_ALIASES = {
    alias: province
    for province, aliases in {
        "서울": ("서울", "서울시", "서울특별시"), "부산": ("부산", "부산시", "부산광역시"),
        "대구": ("대구", "대구시", "대구광역시"), "인천": ("인천", "인천시", "인천광역시"),
        "광주": ("광주", "광주광역시"), "대전": ("대전", "대전시", "대전광역시"),
        "울산": ("울산", "울산시", "울산광역시"), "세종": ("세종", "세종시", "세종특별자치시"),
        "경기": ("경기", "경기도"), "강원": ("강원", "강원도", "강원특별자치도"),
        "충북": ("충북", "충청북도"), "충남": ("충남", "충청남도"),
        "전북": ("전북", "전라북도", "전북특별자치도"), "전남": ("전남", "전라남도"),
        "경북": ("경북", "경상북도"), "경남": ("경남", "경상남도"),
        "제주": ("제주", "제주도", "제주특별자치도"),
    }.items()
    for alias in aliases
}
_GENERIC_REGION_TOKENS = frozenset({"지역", "소재", "소재지", "관내", "일대"})


class _FixedAgent:
    """평가용 고정 출력. 실제 Service의 검증·병합만 실행하며 모델을 부르지 않는다."""

    def __init__(self, output: SupportProgramConversationOutput) -> None:
        self._output = output

    async def interpret(self, request: SupportProgramConversationRequest) -> SupportProgramConversationOutput:
        return self._output


# _merge_context는 실제 Service의 초안 병합이다. 평가 도구는 같은 규칙을 다시 구현하지 않고 호출한다.
_MERGE_SERVICE = SupportProgramConversationService(agent=None)  # type: ignore[arg-type]


@dataclass(frozen=True)
class Item:
    """채점 단위. 단일 턴 문항은 turn=1, 여러 턴 시나리오는 턴마다 하나다."""

    case_id: str
    turn: int
    scenario_id: str | None
    request: dict
    last_results: tuple[dict, ...]
    route: str
    route_alternatives: tuple[str, ...]
    target_indexes: tuple[int, ...]
    intents: tuple[dict, ...]
    expectations: tuple[dict, ...]
    must_not: tuple[dict, ...]
    categories: tuple[str, ...]
    tags: tuple[str, ...]
    after: dict | None

    @property
    def key(self) -> str:
        return f"{self.case_id}#{self.turn}"

    @property
    def category(self) -> str:
        return self.categories[0]


@dataclass(frozen=True)
class Gold:
    """기대 출력 하나(기본 기대 또는 허용 대안)를 실제 Service로 통과시킨 결과."""

    expectation: dict
    output: dict
    response: SupportProgramConversationResponse
    state: dict
    changes: dict


@dataclass(frozen=True)
class Prepared:
    item: Item
    request_model: SupportProgramConversationRequest
    base_state: dict
    golds: tuple[Gold, ...]


@dataclass
class Verdict:
    key: str
    outcome: str
    expectation_index: int
    status: str | None
    status_ok: bool
    kind_ok: bool | None
    tp: list[str] = field(default_factory=list)
    fp: list[str] = field(default_factory=list)
    fn: list[str] = field(default_factory=list)
    must_not_checks: int = 0
    violations: list[str] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)
    passed: bool = False
    current_route: str | None = None
    route_ok: bool = False


def load_cases(path: Path = CASES_PATH) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def langchain_stub():
    """AI Service 테스트의 OpenAI 대역(실제 LangChain·OpenAI SDK 직렬화 후 HTTP 응답만 대체)을 불러온다."""
    name = "govbiz_ai_service_langchain_stub"
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, AI_SERVICE / "tests" / "langchain_stub.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules[name]


async def close_stub_clients(module, start: int) -> None:
    """이 도구가 만든 대역 OpenAI 클라이언트만 닫고 공유 목록에서 뺀다."""
    clients = module.ResponsesChatStub.clients[start:]
    del module.ResponsesChatStub.clients[start:]
    for client in clients:
        await client.close()


def canonical_sha256(cases: dict) -> str:
    """줄바꿈·들여쓰기와 무관한 cases.json 내용 지문."""
    return sha256(json.dumps(cases, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def iter_items(cases: dict) -> list[Item]:
    """구조 검사를 통과한 cases.json을 채점 단위 목록으로 바꾼다."""
    items = []
    for case in cases["cases"]:
        items.append(_item(case, case["id"], 1, None, (), None))
    for scenario in cases["scenarios"]:
        for turn in scenario["turns"]:
            items.append(_item(turn, scenario["id"], turn["turn"], scenario["id"], scenario.get("tags", []), turn.get("after")))
    return items


def _item(data: dict, case_id: str, turn: int, scenario_id: str | None, inherited_tags, after) -> Item:
    return Item(
        case_id=case_id, turn=turn, scenario_id=scenario_id, request=data["request"],
        last_results=tuple(data.get("lastResults", ())), route=data["route"],
        route_alternatives=tuple(data.get("routeAlternatives", ())),
        target_indexes=tuple(data.get("targetIndexes", ())), intents=tuple(data.get("intents", ())),
        expectations=(data["expected"], *data.get("alternatives", ())), must_not=tuple(data.get("mustNot", ())),
        categories=tuple(data["categories"]), tags=tuple(dict.fromkeys([*inherited_tags, *data.get("tags", [])])),
        after=after,
    )


def normalize_text(value: str) -> str:
    return "".join(unicodedata.normalize("NFKC", value).casefold().split())


def normalize_region(value: str) -> str:
    tokens = re.split(r"[\s,·/]+", unicodedata.normalize("NFKC", value).casefold().strip())
    return " ".join(_PROVINCE_ALIASES.get(token, token) for token in tokens if token and token not in _GENERIC_REGION_TOKENS)


def state_of(context: ConversationContext) -> dict:
    conditions = context.company_conditions
    return {
        "QUERY": context.query, "REGION": conditions.region, "INDUSTRY": conditions.industry,
        "ESTABLISHED_ON": conditions.established_on, "FOUNDED_YEAR": conditions.founded_year,
        "SUPPORT_PURPOSE": conditions.support_purpose, "ACCEPTING_ONLY": context.accepting_only,
    }


def _comparable(field_name: str, value):
    if value is None or not isinstance(value, str):
        return value
    return normalize_region(value) if field_name == "REGION" else normalize_text(value) if field_name in TEXT_FIELDS else value


def changes_between(base: dict, merged: dict) -> dict:
    """병합 기준 대비 실제로 바뀐 필드. 시·도 표기만 다르거나 공백·대소문자만 다른 값은 변경으로 보지 않는다."""
    return {name: merged[name] for name in FIELDS if _comparable(name, base[name]) != _comparable(name, merged[name])}


def merge(request_model: SupportProgramConversationRequest, updates: list) -> ConversationContext:
    output = SupportProgramConversationOutput.model_validate({
        "status": "READY", "updates": updates, "answerKind": None, "clarificationKind": None,
    })
    return _MERGE_SERVICE._merge_context(request_model, output)


def _groups(spec: dict) -> list[list[str]]:
    return [group if isinstance(group, list) else [group] for group in spec.get("includes", [])]


def text_matches(field_name: str, value, spec: dict, target) -> bool:
    """기대 변경 하나와 실제 병합 값의 비교. 자유 문장은 포함·제외 낱말로, 나머지는 값으로 비교한다."""
    if target is None:
        return value is None
    if value is None:
        return False
    if field_name in ("ACCEPTING_ONLY", "FOUNDED_YEAR", "ESTABLISHED_ON"):
        return value == target
    normalize = normalize_region if field_name == "REGION" else normalize_text
    actual = normalize(value)
    if spec.get("anyOf"):
        if actual not in {normalize(option) for option in spec["anyOf"]}:
            return False
    elif spec.get("includes"):
        if not all(any(normalize_text(word) in normalize_text(value) for word in group) for group in _groups(spec)):
            return False
    elif actual != normalize(target):
        return False
    return not any(normalize_text(word) in normalize_text(value) for word in spec.get("excludes", []))


def optional_matches(field_name: str, value, spec: dict) -> bool:
    """기대하지 않았지만 허용하는 변경(optional)인지 확인한다. CLEAR는 해제(접수 상태는 기본값 true)를 뜻한다."""
    if spec.get("op", "SET") == "CLEAR":
        return value is True if field_name == "ACCEPTING_ONLY" else value is None
    if value is None:
        return False
    if "value" in spec:
        expected = spec["value"]
        if field_name == "ACCEPTING_ONLY":
            return value is (expected == "true")
        if field_name == "FOUNDED_YEAR":
            return str(value) == expected
        return _comparable(field_name, value) == _comparable(field_name, expected)
    # 검증 단계에서 SET 허용 규칙에는 includes·anyOf·value 중 하나를 요구한다.
    return text_matches(field_name, value, spec, value)


def describe(spec: dict, target) -> str:
    if target is None:
        return "해제"
    parts = []
    if spec.get("anyOf"):
        parts.append("다음 중 하나 " + "/".join(spec["anyOf"]))
    for group in _groups(spec):
        parts.append("포함 " + "|".join(group))
    if spec.get("excludes"):
        parts.append("제외 " + "|".join(spec["excludes"]))
    return ", ".join(parts) if parts else repr(target)


def must_not_violations(item: Item, base: dict, merged: dict, updates: list[dict]) -> tuple[int, list[str]]:
    violations = []
    for rule in item.must_not:
        kind = rule["type"]
        if kind == "unchanged" and rule["field"] in changes_between(base, merged):
            violations.append(f"보호 필드 {rule['field']} 변경: {base[rule['field']]!r} → {merged[rule['field']]!r}")
        elif kind == "notContains":
            value = merged[rule["field"]]
            found = [text for text in rule["texts"] if isinstance(value, str) and normalize_text(text) in normalize_text(value)]
            if found:
                violations.append(f"{rule['field']}에 금지 문구 {found} 포함: {value!r}")
        elif kind == "noEcho":
            echoed = sorted({
                text for update in updates for text in rule["texts"]
                for part in (update.get("value"), update.get("evidence")) if isinstance(part, str) and text in part
            })
            if echoed:
                violations.append(f"개인정보 {echoed}를 변경 값·근거에 복사")
    return len(item.must_not), violations


def judge(prepared: Prepared, predicted: dict | None, outcome: str) -> Verdict:
    """출력 하나를 기대 라벨과 비교한다. predicted는 AI Service가 수락한 출력과 병합 상태다."""
    item = prepared.item
    if predicted is None:
        primary = prepared.golds[0]
        status = primary.expectation["status"]
        return Verdict(
            key=item.key, outcome=outcome, expectation_index=0, status=None, status_ok=False,
            kind_ok=False if status != "READY" else None, fn=list(primary.changes),
            reasons=["출력 없음" if outcome == "MISSING" else "AI Service 검증 거부(503)"],
        )
    checks, violations = must_not_violations(item, prepared.base_state, predicted["state"], predicted["updates"])
    candidates = [_compare(prepared, index, gold, predicted, checks, violations) for index, gold in enumerate(prepared.golds)]
    passing = [verdict for verdict in candidates if verdict.passed]
    chosen = passing[0] if passing else min(candidates, key=lambda verdict: (
        not verdict.status_ok,
        len(verdict.fn) + len(verdict.fp) + len(verdict.violations) + (verdict.kind_ok is False),
        verdict.expectation_index,
    ))
    chosen.current_route = CURRENT_ROUTE_BY_STATUS[predicted["status"]]
    chosen.route_ok = chosen.current_route in (item.route, *item.route_alternatives)
    return chosen


def _compare(prepared: Prepared, index: int, gold: Gold, predicted: dict, checks: int, violations: list[str]) -> Verdict:
    expectation = gold.expectation
    reasons = []
    status_ok = predicted["status"] == expectation["status"]
    if not status_ok:
        reasons.append(f"상태 {predicted['status']} (기대 {expectation['status']})")
    kind_ok = None
    if expectation["status"] == "ANSWERED":
        kind_ok = status_ok and predicted["answerKind"] in expectation["answerKind"]
        if status_ok and not kind_ok:
            reasons.append(f"안내 종류 {predicted['answerKind']} (기대 {'/'.join(expectation['answerKind'])})")
    elif expectation["status"] == "CLARIFICATION_REQUIRED":
        kind_ok = status_ok and predicted["clarificationKind"] in expectation["clarificationKind"]
        if status_ok and not kind_ok:
            reasons.append(
                f"질문 종류 {predicted['clarificationKind']} (기대 {'/'.join(expectation['clarificationKind'])})",
            )
    actual = changes_between(prepared.base_state, predicted["state"])
    tp, fp, fn = [], [], []
    match = expectation.get("match", {})
    for name, target in gold.changes.items():
        spec = match.get(name, {})
        if name not in actual:
            fn.append(name)
            reasons.append(f"{name} 변경 누락 (기대 {describe(spec, target)})")
        elif text_matches(name, actual[name], spec, target):
            tp.append(name)
        else:
            fn.append(name)
            fp.append(name)
            reasons.append(f"{name} 값 {actual[name]!r} (기대 {describe(spec, target)})")
    optional = expectation.get("optional", {})
    for name, value in actual.items():
        if name in gold.changes or (name in optional and optional_matches(name, value, optional[name])):
            continue
        fp.append(name)
        reasons.append(f"{name} 불필요한 변경 {prepared.base_state[name]!r} → {value!r}")
    reasons.extend(violations)
    passed = status_ok and kind_ok is not False and not fn and not fp and not violations
    return Verdict(
        key=prepared.item.key, outcome="ACCEPTED", expectation_index=index, status=predicted["status"],
        status_ok=status_ok, kind_ok=kind_ok, tp=tp, fp=fp, fn=fn, must_not_checks=checks,
        violations=list(violations), reasons=reasons, passed=passed,
    )


def gold_output(expectation: dict) -> dict:
    return {
        "status": expectation["status"], "updates": expectation["updates"],
        "answerKind": (expectation.get("answerKind") or [None])[0],
        "clarificationKind": (expectation.get("clarificationKind") or [None])[0],
    }


def run_service(request_model: SupportProgramConversationRequest, output_json: str) -> SupportProgramConversationResponse:
    """운영 경로와 같이 strict JSON으로 출력을 읽고 실제 Service 검증을 실행한다."""
    output = SupportProgramConversationOutput.model_validate_json(output_json, strict=True)
    return asyncio.run(SupportProgramConversationService(_FixedAgent(output)).interpret(request_model))  # type: ignore[arg-type]


def prepare(item: Item) -> Prepared:
    """기대 출력이 실제 AI Service 검증을 통과하는지 확인하고 채점 기준 상태를 만든다. 실패하면 ValueError."""
    request_model = SupportProgramConversationRequest.model_validate(item.request)
    base_state = state_of(merge(request_model, []))
    golds = []
    for index, expectation in enumerate(item.expectations):
        label = "기대" if index == 0 else f"대안 {index}"
        output = gold_output(expectation)
        try:
            response = run_service(request_model, json.dumps(output, ensure_ascii=False))
        except (ValidationError, SupportProgramConversationError, ValueError) as error:
            raise ValueError(f"{label} 출력이 현재 AI Service 검증을 통과하지 못함: {type(error).__name__}") from error
        state = state_of(merge(request_model, expectation["updates"]))
        golds.append(Gold(expectation, output, response, state, changes_between(base_state, state)))
    return Prepared(item, request_model, base_state, tuple(golds))


def predicted_from_output(prepared: Prepared, output: SupportProgramConversationOutput) -> dict:
    merged = _MERGE_SERVICE._merge_context(prepared.request_model, output)
    return {
        "status": output.status, "answerKind": output.answer_kind, "clarificationKind": output.clarification_kind,
        "updates": [update.model_dump(by_alias=True) for update in output.updates], "state": state_of(merged),
    }


def known_questions() -> dict[str, str]:
    """Service가 정한 확인 질문 문구. 웹은 이 문구를 pendingClarification.question으로 되돌려 보낸다."""
    request = SupportProgramConversationRequest.model_validate({
        "schemaVersion": SCHEMA_VERSION, "referenceDate": "2026-01-01", "message": "질문 문구 확인",
        "context": {"query": None, "acceptingOnly": True, "companyConditions": {
            "region": None, "industry": None, "establishedOn": None, "supportPurpose": None,
        }},
    })
    questions = {}
    for kind in CLARIFICATION_KINDS:
        output = {"status": "CLARIFICATION_REQUIRED", "updates": [], "answerKind": None, "clarificationKind": kind}
        questions[kind] = run_service(request, json.dumps(output)).clarification_question
    return questions


def next_state(prepared: Prepared, after: dict) -> dict:
    """기대 출력(기본 기대)을 받은 웹이 다음 요청에 싣는 상태. 웹 chatSlice의 전이를 따른다."""
    request = prepared.item.request
    gold = prepared.golds[0]
    state = {
        "context": request["context"], "pendingClarification": request["pendingClarification"],
        "pendingProposal": request["pendingProposal"], "lastSearch": request["lastSearch"],
        "lastResults": list(prepared.item.last_results),
    }
    proposed = merge(prepared.request_model, gold.expectation["updates"]).model_dump(by_alias=True)
    if gold.response.status == "READY":
        state.update(pendingClarification=None, pendingProposal=proposed)
    elif gold.response.status == "CLARIFICATION_REQUIRED":
        state.update(pendingProposal=None, pendingClarification={
            "question": gold.response.clarification_question, "draftContext": proposed,
        })
    action = after["action"]
    if action == "confirmAndSearch":
        if state["pendingProposal"] is None:
            raise ValueError("확인 검색할 READY 제안이 없음")
        state.update(
            context=state["pendingProposal"], pendingProposal=None, pendingClarification=None,
            lastSearch={"context": state["pendingProposal"], "resultCount": after["resultCount"]},
            lastResults=list(after.get("results", [])),
        )
    elif action == "cancel":
        state.update(pendingProposal=None, pendingClarification=None)
    return state


def validate(cases: dict, *, design_minimums: bool = True) -> list[str]:
    """오류 목록을 돌려준다. design_minimums=False는 도구 테스트의 작은 자료에서만 쓴다."""
    errors: list[str] = []
    if not isinstance(cases, dict):
        return ["최상위는 객체여야 함"]
    if set(cases) != TOP_LEVEL_KEYS:
        errors.append(f"최상위 키 불일치: {sorted(set(cases) ^ TOP_LEVEL_KEYS)}")
    if cases.get("schemaVersion") != CASES_SCHEMA_VERSION:
        errors.append("schemaVersion 불일치")
    if cases.get("requestSchemaVersion") != SCHEMA_VERSION:
        errors.append("requestSchemaVersion이 현재 AI Service 계약과 다름")
    if cases.get("labelSource") != "ai-authored-expected-behaviour" or cases.get("humanReviewed") is not False:
        errors.append("라벨 출처(AI 작성)와 사람 미검토를 명시해야 함")
    if cases.get("dataType") != "synthetic":
        errors.append("dataType은 synthetic이어야 함")
    if not isinstance(cases.get("cases"), list) or not isinstance(cases.get("scenarios"), list):
        return errors + ["cases·scenarios는 배열이어야 함"]
    reference_date = cases.get("referenceDate")
    questions = known_questions()

    seen_ids: set[str] = set()
    structurally_valid: list[Item] = []
    for case in cases["cases"]:
        case_id = case.get("id") if isinstance(case, dict) else None
        if not isinstance(case_id, str) or not re.fullmatch(r"S[0-9]{3}", case_id) or case_id in seen_ids:
            errors.append(f"단일 턴 id 형식 오류 또는 중복: {case_id!r}")
            continue
        seen_ids.add(case_id)
        before = len(errors)
        _check_entry(case, case_id, CASE_KEYS, reference_date, questions, errors)
        if len(errors) == before:
            structurally_valid.append(_item(case, case_id, 1, None, (), None))

    scenario_items: dict[str, list[Item]] = {}
    for scenario in cases["scenarios"]:
        scenario_id = scenario.get("id") if isinstance(scenario, dict) else None
        if not isinstance(scenario_id, str) or not re.fullmatch(r"M[0-9]{2}", scenario_id) or scenario_id in seen_ids:
            errors.append(f"시나리오 id 형식 오류 또는 중복: {scenario_id!r}")
            continue
        seen_ids.add(scenario_id)
        before = len(errors)
        if set(scenario) - SCENARIO_KEYS or not {"id", "title", "userGoal", "turns"} <= set(scenario):
            errors.append(f"{scenario_id}: 시나리오 키 불일치")
            continue
        if not _nonblank(scenario["title"]):
            errors.append(f"{scenario_id}: title 필요")
        _check_tags(scenario.get("tags", []), scenario_id, errors)
        turns = scenario["turns"]
        if not isinstance(turns, list) or len(turns) < 2:
            errors.append(f"{scenario_id}: 여러 턴 시나리오는 2턴 이상")
            continue
        _check_user_goal(scenario["userGoal"], scenario_id, len(turns), errors)
        items = []
        for position, turn in enumerate(turns, 1):
            key = f"{scenario_id}#{position}"
            if not isinstance(turn, dict) or turn.get("turn") != position:
                errors.append(f"{key}: turn 번호는 1부터 연속이어야 함")
                continue
            turn_errors = len(errors)
            _check_entry(turn, key, TURN_KEYS, reference_date, questions, errors)
            _check_after(turn.get("after"), key, position == len(turns), errors)
            if len(errors) == turn_errors:
                items.append(_item(turn, scenario_id, position, scenario_id, scenario.get("tags", []), turn.get("after")))
        if len(errors) == before:
            scenario_items[scenario_id] = items
            structurally_valid.extend(items)

    prepared_by_key: dict[str, Prepared] = {}
    for item in structurally_valid:
        try:
            prepared = prepare(item)
        except (ValidationError, ValueError) as error:
            errors.append(f"{item.key}: {error}")
            continue
        before = len(errors)
        _check_labels(prepared, errors)
        if len(errors) == before:
            prepared_by_key[item.key] = prepared

    for scenario_id, items in scenario_items.items():
        for current, following in zip(items, items[1:]):
            prepared = prepared_by_key.get(current.key)
            if prepared is None or current.after is None:
                continue
            try:
                expected = next_state(prepared, current.after)
            except ValueError as error:
                errors.append(f"{current.key}: {error}")
                continue
            actual = {**{name: following.request[name] for name in ("context", "pendingClarification", "pendingProposal", "lastSearch")},
                      "lastResults": list(following.last_results)}
            for name, value in expected.items():
                if actual[name] != value:
                    errors.append(f"{following.key}: {name}이(가) 이전 턴의 기대 결과·화면 동작으로 전달되는 상태와 다름")
            if following.request["referenceDate"] != current.request["referenceDate"]:
                errors.append(f"{following.key}: referenceDate가 이전 턴과 다름")

    _check_coverage(cases, structurally_valid, scenario_items, design_minimums, errors)
    return errors


def _nonblank(value) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _check_tags(tags, key: str, errors: list[str]) -> None:
    if not isinstance(tags, list) or len(tags) != len(set(tags)):
        errors.append(f"{key}: tags는 중복 없는 배열")
        return
    for tag in tags:
        if not isinstance(tag, str) or not re.fullmatch(r"[a-z0-9-]+:[a-z0-9-]+", tag) or tag.split(":")[0] not in TAG_PREFIXES:
            errors.append(f"{key}: 알 수 없는 태그 {tag!r}")


def _check_entry(entry: dict, key: str, allowed: set[str], reference_date, questions: dict, errors: list[str]) -> None:
    if not isinstance(entry, dict) or set(entry) - allowed:
        errors.append(f"{key}: 허용되지 않은 키 {sorted(set(entry) - allowed) if isinstance(entry, dict) else entry!r}")
        return
    for required in ("categories", "request", "route", "expected", "rationale"):
        if required not in entry:
            errors.append(f"{key}: {required} 필요")
            return
    categories = entry["categories"]
    if not isinstance(categories, list) or not categories or any(name not in CATEGORIES for name in categories) \
            or len(categories) != len(set(categories)):
        errors.append(f"{key}: 범주는 정의된 이름의 중복 없는 배열")
    _check_tags(entry.get("tags", []), key, errors)
    if not _nonblank(entry["rationale"]):
        errors.append(f"{key}: rationale 필요")
    if entry["route"] not in ROUTES:
        errors.append(f"{key}: 알 수 없는 route {entry['route']!r}")
    alternatives = entry.get("routeAlternatives", [])
    if not isinstance(alternatives, list) or any(route not in ROUTES or route == entry["route"] for route in alternatives):
        errors.append(f"{key}: routeAlternatives 오류")
    tags = entry.get("tags", [])
    if entry["route"] in FUTURE_ROUTES and not any(isinstance(tag, str) and tag.startswith("v2-gap:") for tag in tags):
        errors.append(f"{key}: 현재 구조에 없는 경로 {entry['route']}에는 v2-gap 태그가 필요")
    _check_routing_labels(entry, key, errors)
    request = entry["request"]
    if not isinstance(request, dict) or set(request) != REQUEST_KEYS:
        errors.append(f"{key}: request는 Core가 보내는 키 {sorted(REQUEST_KEYS)}를 모두 가져야 함")
        return
    try:
        model = SupportProgramConversationRequest.model_validate(request)
    except ValidationError as error:
        errors.append(f"{key}: 현재 AI Service 요청 계약 위반 ({error.error_count()}건)")
        return
    if json.loads(json.dumps(model.model_dump(by_alias=True))) != request:
        errors.append(f"{key}: request가 Core 직렬화 모양과 다름(null 키·foundedYear 생략 규칙 확인)")
    if request["referenceDate"] != reference_date:
        errors.append(f"{key}: referenceDate는 {reference_date}")
    pending = request["pendingClarification"]
    if pending is not None and pending["question"] not in questions.values():
        errors.append(f"{key}: pendingClarification.question은 Service가 정한 질문 문구여야 함")
    if request["pendingProposal"] is not None and request["pendingProposal"]["query"] is None:
        errors.append(f"{key}: READY 제안인 pendingProposal에는 query가 있어야 함")
    _check_results(entry.get("lastResults"), request["lastSearch"], entry["route"], key, errors)
    expectations = [entry["expected"], *entry.get("alternatives", [])]
    if not isinstance(entry.get("alternatives", []), list):
        errors.append(f"{key}: alternatives는 배열")
    for index, expectation in enumerate(expectations):
        _check_expectation_shape(expectation, request["message"], f"{key} {'기대' if index == 0 else f'대안 {index}'}", errors)
    rules = entry.get("mustNot", [])
    if not isinstance(rules, list):
        errors.append(f"{key}: mustNot은 배열")
        return
    for rule in rules:
        _check_rule(rule, key, errors)


def _check_routing_labels(entry: dict, key: str, errors: list[str]) -> None:
    """대상 공고 번호(targetIndexes)와 감지 의도(intents)는 경로가 필요로 할 때만 둔다. 구현 순서·호출 횟수는 라벨이 아니다."""
    route = entry["route"]
    targets = entry.get("targetIndexes")
    shown = len(entry.get("lastResults") or [])
    if route in ("result_question", "compare"):
        minimum, maximum = (2, 3) if route == "compare" else (1, MAXIMUM_SHOWN_RESULTS)
        if not isinstance(targets, list) or not minimum <= len(targets) <= maximum or targets != sorted(set(targets)) \
                or not all(type(index) is int and 1 <= index <= shown for index in targets):
            errors.append(f"{key}: {route}의 targetIndexes는 화면 결과 번호의 오름차순 목록({minimum}~{maximum}개)")
    elif targets is not None:
        errors.append(f"{key}: targetIndexes는 result_question·compare에만 둠")
    intents = entry.get("intents")
    if route == "multi_intent":
        if not isinstance(intents, list) or len(intents) != MAXIMUM_INTENTS or not all(
            isinstance(intent, dict) and set(intent) == {"label", "keywords"} and _nonblank(intent["label"])
            and isinstance(intent["keywords"], list) and intent["label"] in intent["keywords"]
            and all(_nonblank(word) for word in intent["keywords"])
            for intent in intents
        ) or len({intent["label"] for intent in intents if isinstance(intent, dict)}) != len(intents):
            errors.append(f"{key}: multi_intent의 intents는 label·keywords를 가진 서로 다른 의도 {MAXIMUM_INTENTS}개")
    elif intents is not None:
        errors.append(f"{key}: intents는 multi_intent에만 둠")


def _check_results(results, last_search, route: str, key: str, errors: list[str]) -> None:
    count = last_search["resultCount"] if last_search else 0
    if results is None:
        if count > 0:
            errors.append(f"{key}: 결과가 있는 lastSearch에는 화면의 직전 결과 lastResults가 필요")
        if route in RESULT_ROUTES:
            errors.append(f"{key}: {route} 경로에는 직전 결과가 필요")
        if route == "zero_result_help" and (last_search is None or count != 0):
            errors.append(f"{key}: zero_result_help는 0건 lastSearch에서만 사용")
        return
    if last_search is None or not isinstance(results, list) or len(results) != min(MAXIMUM_SHOWN_RESULTS, count):
        errors.append(f"{key}: lastResults는 lastSearch.resultCount의 앞 {min(MAXIMUM_SHOWN_RESULTS, count)}건이어야 함")
        return
    if route == "compare" and len(results) < 2:
        errors.append(f"{key}: compare에는 직전 결과 2건 이상 필요")
    if route == "zero_result_help":
        errors.append(f"{key}: zero_result_help는 0건 lastSearch에서만 사용")
    accepting_only = last_search["context"]["acceptingOnly"]
    ids = set()
    for rank, program in enumerate(results, 1):
        if not isinstance(program, dict) or set(program) != PROGRAM_KEYS:
            errors.append(f"{key}: lastResults 항목 키는 {sorted(PROGRAM_KEYS)}")
            continue
        source, _, source_id = str(program["id"]).partition(":")
        if (program["rank"] != rank or program["sourceCode"] != source or not source_id or program["id"] in ids
                or not re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", source) or program["status"] not in PROGRAM_STATUSES
                or (accepting_only and program["status"] != "OPEN")
                or not all(_nonblank(program[name]) for name in ("sourceName", "title", "organization"))
                or (program["applicationEndDate"] is not None
                    and not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", program["applicationEndDate"]))):
            errors.append(f"{key}: lastResults {rank}번이 검색 응답 계약 모양과 다름")
        ids.add(program["id"])


def _check_expectation_shape(expectation, message: str, label: str, errors: list[str]) -> None:
    if not isinstance(expectation, dict) or set(expectation) - EXPECTATION_KEYS or not {"status", "updates"} <= set(expectation):
        errors.append(f"{label}: 기대 키 불일치")
        return
    status = expectation["status"]
    if status not in STATUSES:
        errors.append(f"{label}: 알 수 없는 status {status!r}")
        return
    for kind_key, allowed, owner in (("answerKind", ANSWER_KINDS, "ANSWERED"),
                                     ("clarificationKind", CLARIFICATION_KINDS, "CLARIFICATION_REQUIRED")):
        kinds = expectation.get(kind_key)
        if status == owner:
            if not isinstance(kinds, list) or not kinds or len(kinds) != len(set(kinds)) or any(k not in allowed for k in kinds):
                errors.append(f"{label}: {kind_key}는 허용 코드의 배열이어야 함")
        elif kinds is not None:
            errors.append(f"{label}: {status}에는 {kind_key}가 없어야 함")
    updates = expectation["updates"]
    if not isinstance(updates, list):
        errors.append(f"{label}: updates는 배열")
        return
    if status == "ANSWERED" and updates:
        errors.append(f"{label}: ANSWERED는 조건을 바꾸지 않음")
    for update in updates:
        if not isinstance(update, dict) or set(update) != {"field", "operation", "value", "evidence"}:
            errors.append(f"{label}: update 키 불일치")
            continue
        if update["field"] not in FIELDS or update["operation"] not in ("SET", "CLEAR"):
            errors.append(f"{label}: 현재 계약에 없는 field·operation {update['field']}/{update['operation']}")
        if not isinstance(update["evidence"], str) or update["evidence"] not in message:
            errors.append(f"{label}: {update['field']} 근거 {update['evidence']!r}가 message에 없음")
    for section in ("match", "optional"):
        specs = expectation.get(section, {})
        if not isinstance(specs, dict) or any(name not in FIELDS for name in specs):
            errors.append(f"{label}: {section}의 필드 이름 오류")
            continue
        for name, spec in specs.items():
            allowed = MATCH_KEYS if section == "match" else OPTIONAL_KEYS
            if not isinstance(spec, dict) or not spec or set(spec) - allowed:
                errors.append(f"{label}: {section}.{name} 규칙 키 오류")
                continue
            groups = spec.get("includes", [])
            if not isinstance(groups, list) or any(not isinstance(group, list) or not group or not all(_nonblank(word) for word in group) for group in groups):
                errors.append(f"{label}: {section}.{name}.includes는 낱말 묶음의 배열")
            for list_key in ("excludes", "anyOf"):
                values = spec.get(list_key, [])
                if not isinstance(values, list) or not all(_nonblank(value) for value in values):
                    errors.append(f"{label}: {section}.{name}.{list_key}는 문자열 배열")
            if spec.get("anyOf") and spec.get("includes"):
                errors.append(f"{label}: {section}.{name}는 anyOf와 includes를 함께 쓰지 않음")
            if section == "optional":
                op = spec.get("op", "SET")
                if op not in ("SET", "CLEAR") or (op == "SET" and not (spec.get("includes") or spec.get("anyOf") or "value" in spec)):
                    errors.append(f"{label}: optional.{name}의 SET에는 값 조건이 필요")


def _check_rule(rule, key: str, errors: list[str]) -> None:
    if not isinstance(rule, dict) or rule.get("type") not in ("unchanged", "notContains", "noEcho"):
        errors.append(f"{key}: mustNot 규칙 오류 {rule!r}")
        return
    expected_keys = {"unchanged": {"type", "field"}, "notContains": {"type", "field", "texts"}, "noEcho": {"type", "texts"}}[rule["type"]]
    if set(rule) != expected_keys or ("field" in rule and rule["field"] not in FIELDS) or (
        "texts" in rule and (not isinstance(rule["texts"], list) or not rule["texts"] or not all(_nonblank(t) for t in rule["texts"]))
    ):
        errors.append(f"{key}: mustNot 규칙 형식 오류 {rule!r}")


def _check_after(after, key: str, last: bool, errors: list[str]) -> None:
    if last:
        if after is not None:
            errors.append(f"{key}: 마지막 턴에는 after가 없음")
        return
    if not isinstance(after, dict) or after.get("action") not in AFTER_ACTIONS:
        errors.append(f"{key}: after.action은 {AFTER_ACTIONS} 중 하나")
        return
    if after["action"] == "confirmAndSearch":
        count = after.get("resultCount")
        if set(after) - {"action", "resultCount", "results"} or type(count) is not int or count < 0:
            errors.append(f"{key}: confirmAndSearch에는 0 이상의 resultCount가 필요")
        elif count > 0 and "results" not in after:
            errors.append(f"{key}: 결과가 있는 확인 검색에는 화면에 보인 results가 필요")
    elif set(after) != {"action"}:
        errors.append(f"{key}: {after['action']}에는 다른 키가 없음")


def _check_user_goal(goal, key: str, turn_count: int, errors: list[str]) -> None:
    if not isinstance(goal, dict) or set(goal) != USER_GOAL_KEYS:
        errors.append(f"{key}: userGoal 키는 {sorted(USER_GOAL_KEYS)}")
        return
    company = goal["hiddenCompany"]
    if not isinstance(company, dict) or not company or not all(
        isinstance(name, str) and (value is None or isinstance(value, (str, int, bool))
                                   or (isinstance(value, list) and all(_nonblank(v) for v in value)))
        for name, value in company.items()
    ):
        errors.append(f"{key}: userGoal.hiddenCompany는 숨은 회사 조건 객체")
    if not all(_nonblank(goal[name]) for name in ("persona", "seeking", "successWhen")):
        errors.append(f"{key}: userGoal의 persona·seeking·successWhen 필요")
    if not isinstance(goal["rejectProposals"], list) or not goal["rejectProposals"] or not all(
        _nonblank(value) for value in goal["rejectProposals"]
    ):
        errors.append(f"{key}: userGoal.rejectProposals는 거절할 제안의 배열")
    if type(goal["maxTurns"]) is not int or goal["maxTurns"] < turn_count:
        errors.append(f"{key}: userGoal.maxTurns는 대본 턴 수 이상")


def _check_labels(prepared: Prepared, errors: list[str]) -> None:
    item = prepared.item
    request = item.request
    base = prepared.base_state
    for index, gold in enumerate(prepared.golds):
        label = f"{item.key} {'기대' if index == 0 else f'대안 {index}'}"
        expectation = gold.expectation
        if gold.response.status != expectation["status"]:
            errors.append(f"{label}: Service 응답 상태가 기대와 다름")
        updates = expectation["updates"]
        for position, update in enumerate(updates):
            rest = updates[:position] + updates[position + 1:]
            if state_of(merge(prepared.request_model, rest)) == gold.state:
                errors.append(f"{label}: {update['field']} 변경이 병합 결과를 바꾸지 않음(불필요한 기대 변경)")
            if update["field"] == "REGION" and update["value"] is not None:
                for existing in (request["context"]["companyConditions"]["region"], base["REGION"]):
                    if existing and existing != update["value"] and normalize_region(existing) == normalize_region(update["value"]):
                        errors.append(f"{label}: 같은 지역은 기존 표기 {existing!r}를 써야 함(Core가 기존 표기를 유지)")
        match = expectation.get("match", {})
        for name in match:
            if name not in gold.changes:
                errors.append(f"{label}: match.{name}는 기대 변경에 없는 필드")
        for name, target in gold.changes.items():
            spec = match.get(name, {})
            if name in TEXT_FIELDS and target is not None and not (spec.get("includes") or spec.get("anyOf")):
                errors.append(f"{label}: 자유 문장 {name} 변경에는 includes 또는 anyOf가 필요")
            if not text_matches(name, target, spec, target):
                errors.append(f"{label}: 기대 값 {target!r}가 자신의 match 규칙을 만족하지 않음")
            if name in expectation.get("optional", {}):
                errors.append(f"{label}: {name}이(가) 기대 변경과 optional에 함께 있음")
        predicted = {"status": gold.output["status"], "answerKind": gold.output["answerKind"],
                     "clarificationKind": gold.output["clarificationKind"], "updates": updates, "state": gold.state}
        verdict = _compare(prepared, index, gold, predicted, *must_not_violations(item, base, gold.state, updates))
        if not verdict.passed:
            errors.append(f"{label}: 기대 출력이 자신의 채점 규칙을 통과하지 못함: {'; '.join(verdict.reasons)}")
    for index, gold in enumerate(prepared.golds[1:], 1):
        if gold.output == prepared.golds[0].output:
            errors.append(f"{item.key} 대안 {index}: 기본 기대와 같은 출력")


def _check_coverage(cases: dict, items: list[Item], scenarios: dict[str, list[Item]], design: bool, errors: list[str]) -> None:
    singles = [item for item in items if item.scenario_id is None]
    counts = Counter(item.category for item in singles)
    if design:
        if len(cases["cases"]) < MINIMUM_SINGLE_TURN_CASES:
            errors.append(f"단일 턴 문항 {len(cases['cases'])}개 < {MINIMUM_SINGLE_TURN_CASES}")
        if len(cases["scenarios"]) < MINIMUM_SCENARIOS:
            errors.append(f"여러 턴 시나리오 {len(cases['scenarios'])}개 < {MINIMUM_SCENARIOS}")
        turns = sum(len(scenario.get("turns", [])) for scenario in cases["scenarios"])
        if turns < MINIMUM_SCENARIO_TURNS:
            errors.append(f"여러 턴 턴 수 {turns} < {MINIMUM_SCENARIO_TURNS}")
        for name, (label, minimum) in CATEGORIES.items():
            if counts[name] < minimum:
                errors.append(f"범주 {label}({name}) 단일 턴 {counts[name]}개 < {minimum}")
        tag_counts = Counter(tag for item in items for tag in item.tags)
        for tag, minimum in REQUIRED_TAGS.items():
            if tag_counts[tag] < minimum:
                errors.append(f"태그 {tag} {tag_counts[tag]}개 < {minimum}")
        route_counts = Counter(item.route for item in items)
        for route, minimum in MINIMUM_ROUTE_ITEMS.items():
            if route_counts[route] < minimum:
                errors.append(f"경로 {route} {route_counts[route]}개 < {minimum}")
        result_scenarios = [scenario_id for scenario_id, turns in scenarios.items() if any(i.route in RESULT_ROUTES for i in turns)]
        if len(result_scenarios) < MINIMUM_RESULT_ROUTE_SCENARIOS:
            errors.append(f"결과 질문·비교·더 보기 시나리오 {len(result_scenarios)}개 < {MINIMUM_RESULT_ROUTE_SCENARIOS}")


def summary(cases: dict) -> str:
    items = iter_items(cases)
    singles = [item for item in items if item.scenario_id is None]
    counts = Counter(item.category for item in singles)
    routes = Counter(item.route for item in items)
    lines = [
        f"단일 턴 {len(singles)}문항, 여러 턴 {len(cases['scenarios'])}시나리오 {len(items) - len(singles)}턴",
        "범주: " + ", ".join(f"{label} {counts[name]}" for name, (label, _) in CATEGORIES.items()),
        "경로: " + ", ".join(f"{route} {routes[route]}" for route in ROUTES),
    ]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--cases", type=Path, default=CASES_PATH)
    args = parser.parse_args()
    cases = load_cases(args.cases)
    errors = validate(cases)
    if errors:
        print(f"cases.json 검증 실패 {len(errors)}건", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print("cases.json 검증 통과 (라벨은 AI 작성 기대 동작이며 사람 검토 정답이 아님)")
    print(summary(cases))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
