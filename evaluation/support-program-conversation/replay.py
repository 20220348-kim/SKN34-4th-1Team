#!/usr/bin/env python3
"""대리 모델 출력(runs/<run>/outputs.jsonl)을 실제 AI Service HTTP 경로로 재생하고 기대 동작과 비교한다.

모델의 HTTP 응답만 고정 응답으로 바꾼다(OpenAI 호출 없음). FastAPI 라우터 → Service → Agent → LangChain·OpenAI SDK의
strict JSON 파싱과 출력·인용·병합·READY 검증을 그대로 통과한 응답만 Core가 받는다. 기대 라벨은 AI가 작성한 기대
동작이며 사람이 검토한 정답이 아니다. Claude가 만든 출력이면 결과는 Claude 대리 검증이지 OpenAI 측정이 아니다.
"""

import argparse
import asyncio
from collections import Counter, defaultdict
from hashlib import sha256
import json
import logging
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import validate_cases as cases_module  # noqa: E402  (AI Service 경로도 등록한다)

from fastapi.testclient import TestClient  # noqa: E402

from app.config import DEFAULT_LLM_MODEL_TIMEOUT_SECONDS, DEFAULT_LLM_RUN_TIMEOUT_SECONDS, Settings  # noqa: E402
from app.main import create_app  # noqa: E402
from app.support_program_conversation.agent import SupportProgramConversationAgent  # noqa: E402
from app.support_program_conversation.models import SupportProgramConversationOutput  # noqa: E402
from app.support_program_conversation.prompt import SUPPORT_PROGRAM_CONVERSATION_INSTRUCTIONS  # noqa: E402

RUNS_DIR = HERE / "runs"
PROXY_MANIFEST = HERE / "proxy" / "manifest.json"
INTERPRET_PATH = "/internal/v1/support-program-conversation/interpret"
CORE_FIXTURE_PATH = (
    HERE.parents[1] / "backend" / "core-service" / "src" / "test" / "resources"
    / "support-program-conversation" / "example-ai-responses.json"
)
OUTPUT_LINE_KEYS = {"caseId", "turn", "output"}
OPTIONAL_LINE_KEYS = {"note"}


def read_outputs(path: Path, items: list) -> tuple[dict, dict]:
    """outputs.jsonl을 읽는다. 무효 줄·중복·모르는 id는 버리고 그 문항은 출력 없음으로 채점한다."""
    known = {item.key for item in items}
    found: dict[str, object] = {}
    duplicates: set[str] = set()
    issues = {"invalidLines": [], "unknownKeys": [], "duplicateKeys": []}
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            issues["invalidLines"].append(number)
            continue
        if (not isinstance(record, dict) or not OUTPUT_LINE_KEYS <= set(record)
                or set(record) - OUTPUT_LINE_KEYS - OPTIONAL_LINE_KEYS
                or not isinstance(record["caseId"], str) or type(record["turn"]) is not int):
            issues["invalidLines"].append(number)
            continue
        key = f"{record['caseId']}#{record['turn']}"
        if key not in known:
            issues["unknownKeys"].append(key)
        elif key in found or key in duplicates:
            duplicates.add(key)
            found.pop(key, None)
        else:
            found[key] = record["output"]
    issues["duplicateKeys"] = sorted(duplicates)
    return found, issues


def output_text(raw) -> str:
    """모델 응답 본문. 문자열이면 원문 그대로, 그 밖에는 JSON으로 직렬화해 strict 파싱에 맡긴다."""
    return raw if isinstance(raw, str) else json.dumps(raw, ensure_ascii=False)


def replay_http(pairs: list[tuple[dict, str]]) -> list[tuple[int, object]]:
    """요청마다 고정 모델 응답 하나로 실제 HTTP 경로를 실행한다. 예상 밖 서버 오류도 실패로 기록한다."""
    stub_module = cases_module.langchain_stub()
    start = len(stub_module.ResponsesChatStub.clients)
    stub = stub_module.ResponsesChatStub([])
    agent = SupportProgramConversationAgent(
        model=stub.model, model_timeout_seconds=DEFAULT_LLM_MODEL_TIMEOUT_SECONDS,
        run_timeout_seconds=DEFAULT_LLM_RUN_TIMEOUT_SECONDS,
    )
    settings = Settings(
        openai_api_key="replay-key-never-sent", openai_model="replay-model",
        llm_model_timeout_seconds=DEFAULT_LLM_MODEL_TIMEOUT_SECONDS, llm_run_timeout_seconds=DEFAULT_LLM_RUN_TIMEOUT_SECONDS,
    )
    app_logger = logging.getLogger("app")
    level = app_logger.level
    results = []
    try:
        app = create_app(settings=settings, support_program_conversation_agent=agent)
        with TestClient(app, raise_server_exceptions=False) as client:
            # 거부 로그는 실패 종류만 남지만 수백 건을 재생하므로 오류 수준만 출력한다.
            app_logger.setLevel(logging.ERROR)
            for request, text in pairs:
                stub.outputs.append([stub_module.response_message(text)])
                calls = len(stub.calls)
                response = client.post(INTERPRET_PATH, json=request)
                if response.status_code == 422 or len(stub.calls) != calls + 1:
                    raise RuntimeError("평가 요청이 AI Service 요청 검증을 통과하지 못했거나 모델 호출이 1회가 아님")
                try:
                    body = response.json()
                except ValueError:
                    body = None
                results.append((response.status_code, body))
        stub.assert_complete()
    finally:
        app_logger.setLevel(level)
        asyncio.run(cases_module.close_stub_clients(stub_module, start))
    return results


def _ratio(numerator: int, denominator: int):
    return round(numerator / denominator, 4) if denominator else None


def _f1(tp: int, fp: int, fn: int) -> dict:
    return {"tp": tp, "fp": fp, "fn": fn, "precision": _ratio(tp, tp + fp), "recall": _ratio(tp, tp + fn),
            "f1": _ratio(2 * tp, 2 * tp + fp + fn)}


def summarize(pairs: list) -> dict:
    """채점 단위 묶음의 지표. pairs는 (Item, Verdict) 목록이다."""
    verdicts = [verdict for _, verdict in pairs]
    present = [verdict for verdict in verdicts if verdict.outcome != "MISSING"]
    accepted = [verdict for verdict in verdicts if verdict.outcome == "ACCEPTED"]
    rejected = [verdict for verdict in verdicts if verdict.outcome == "REJECTED"]
    chosen = [(item, verdict, item.expectations[verdict.expectation_index]) for item, verdict in pairs]
    clarifications = [verdict for _, verdict, expected in chosen if expected["status"] == "CLARIFICATION_REQUIRED"]
    answers = [verdict for _, verdict, expected in chosen if expected["status"] == "ANSWERED"]
    ready = [verdict for item, verdict in pairs if item.expectations[0]["status"] == "READY"]
    checks = sum(verdict.must_not_checks for verdict in accepted)
    violations = sum(len(verdict.violations) for verdict in accepted)
    return {
        "items": len(verdicts), "outputs": len(present), "missing": len(verdicts) - len(present),
        "accepted": len(accepted), "rejected": len(rejected),
        "validatorRejectionRate": _ratio(len(rejected), len(present)),
        "statusAccuracy": _ratio(sum(verdict.status_ok for verdict in verdicts), len(verdicts)),
        "casePassRate": _ratio(sum(verdict.passed for verdict in verdicts), len(verdicts)),
        "readyExactRate": _ratio(sum(verdict.passed for verdict in ready), len(ready)),
        "fields": _f1(sum(len(v.tp) for v in verdicts), sum(len(v.fp) for v in verdicts), sum(len(v.fn) for v in verdicts)),
        "clarificationKindAccuracy": _ratio(sum(bool(v.kind_ok) for v in clarifications), len(clarifications)),
        "answerKindAccuracy": _ratio(sum(bool(v.kind_ok) for v in answers), len(answers)),
        "mustNotChecks": checks, "mustNotViolations": violations, "falseChangeRate": _ratio(violations, checks),
        "protectedRegionViolations": sum(
            1 for verdict in accepted for violation in verdict.violations if violation.startswith("보호 필드 REGION")
        ),
        "unexpectedChangeRate": _ratio(sum(bool(verdict.fp) for verdict in accepted), len(accepted)),
        "alternativeMatches": sum(1 for verdict in verdicts if verdict.passed and verdict.expectation_index > 0),
        "currentRouteAgreement": _ratio(sum(verdict.route_ok for verdict in verdicts), len(verdicts)),
    }


def field_table(pairs: list) -> dict:
    counts = {name: Counter() for name in cases_module.FIELDS}
    for _, verdict in pairs:
        for kind in ("tp", "fp", "fn"):
            for name in getattr(verdict, kind):
                counts[name][kind] += 1
    return {name: _f1(counter["tp"], counter["fp"], counter["fn"]) for name, counter in counts.items()}


def grouped(pairs: list, key) -> dict:
    groups = defaultdict(list)
    for item, verdict in pairs:
        for name in key(item):
            groups[name].append((item, verdict))
    return {name: summarize(group) for name, group in sorted(groups.items())}


def score(cases: dict, results: list) -> dict:
    singles = [(item, verdict) for item, verdict in results if item.scenario_id is None]
    turns = [(item, verdict) for item, verdict in results if item.scenario_id is not None]
    scenarios = defaultdict(list)
    for item, verdict in turns:
        scenarios[item.scenario_id].append(verdict.passed)
    titles = {scenario["id"]: scenario["title"] for scenario in cases["scenarios"]}
    return {
        "singleTurn": summarize(singles), "scenarioTurns": summarize(turns), "overall": summarize(results),
        "fieldsOverall": field_table(results),
        "categories": grouped(singles, lambda item: [item.category]),
        "routes": grouped(results, lambda item: [item.route]),
        "tags": grouped(results, lambda item: [tag for tag in item.tags if tag.startswith(("v2-gap:", "known-weak:", "style:"))]),
        "scenarios": {
            scenario_id: {"title": titles[scenario_id], "turns": len(passed), "passedTurns": sum(passed), "allPassed": all(passed)}
            for scenario_id, passed in scenarios.items()
        },
        "scenarioAllTurnsPassRate": _ratio(sum(all(passed) for passed in scenarios.values()), len(scenarios)),
    }


def replay(cases: dict, run_dir: Path, out_dir: Path | None = None, core_fixture: Path | None = None) -> dict:
    out_dir = out_dir or run_dir
    items = cases_module.iter_items(cases)
    prepared = {item.key: cases_module.prepare(item) for item in items}
    outputs, issues = read_outputs(run_dir / "outputs.jsonl", items)
    present = [item for item in items if item.key in outputs]
    texts = {item.key: output_text(outputs[item.key]) for item in present}
    responses = dict(zip([item.key for item in present], replay_http([(item.request, texts[item.key]) for item in present])))
    results, records = [], []
    for item in items:
        status_code, body = responses.get(item.key, (None, None))
        if status_code is None:
            verdict = cases_module.judge(prepared[item.key], None, "MISSING")
        elif status_code == 200:
            output = SupportProgramConversationOutput.model_validate_json(texts[item.key], strict=True)
            verdict = cases_module.judge(prepared[item.key], cases_module.predicted_from_output(prepared[item.key], output), "ACCEPTED")
        else:
            verdict = cases_module.judge(prepared[item.key], None, "REJECTED")
            if status_code != 503:
                verdict.reasons = [f"AI Service 예상 밖 HTTP {status_code}"]
        results.append((item, verdict))
        records.append({"caseId": item.case_id, "turn": item.turn, "httpStatus": status_code, "response": body,
                        "request": item.request})
    metrics = {
        "schemaVersion": "govbiz-support-program-conversation-replay-v1",
        "run": run_dir.name,
        "casesCanonicalSha256": cases_module.canonical_sha256(cases),
        "systemInstructionsSha256": sha256(SUPPORT_PROGRAM_CONVERSATION_INSTRUCTIONS.encode()).hexdigest(),
        "inputFingerprint": input_fingerprint(cases, run_dir),
        "outputIssues": issues,
        "unexpectedHttpStatuses": dict(Counter(code for code, _ in responses.values() if code not in (200, 503))),
        **score(cases, results),
        "failures": [
            {"key": item.key, "categories": list(item.categories), "route": item.route, "outcome": verdict.outcome,
             "message": item.request["message"], "reasons": verdict.reasons}
            for item, verdict in results if not verdict.passed
        ],
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "ai-responses.jsonl").write_text(
        "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in records), encoding="utf-8", newline="\n",
    )
    (out_dir / "metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    (out_dir / "report.md").write_text(report(metrics), encoding="utf-8", newline="\n")
    if core_fixture is not None:
        write_core_fixture(records, run_dir, core_fixture)
    return metrics


def input_fingerprint(cases: dict, run_dir: Path) -> str:
    """출력을 만든 입력(실행 폴더의 inputs-manifest.json)이 현재 cases·프롬프트와 같은지 기록한다."""
    path = run_dir / "inputs-manifest.json"
    if not path.exists():
        return "실행 폴더에 inputs-manifest.json 없음(입력 일치 미확인)"
    manifest = json.loads(path.read_text(encoding="utf-8"))
    same = (manifest.get("casesCanonicalSha256") == cases_module.canonical_sha256(cases)
            and manifest.get("systemInstructionsSha256") == sha256(SUPPORT_PROGRAM_CONVERSATION_INSTRUCTIONS.encode()).hexdigest())
    return "현재 cases.json·시스템 지침과 일치" if same else "불일치: 출력 생성 뒤 cases.json 또는 프롬프트가 바뀜"


def write_core_fixture(records: list, run_dir: Path, path: Path) -> None:
    """Core 재생 테스트용 고정 자료. AI Service까지 도달한 기록(HTTP 상태가 있는 것)만 담는다."""
    fixture = {
        "description": (
            f"evaluation/support-program-conversation/runs/{run_dir.name}의 출력을 replay.py로 AI Service에 통과시킨 응답이다. "
            "Core가 받는 HTTP 상태·본문과 그때의 요청이며 모델 품질 측정 결과가 아니다."
        ),
        "records": [record for record in records if record["httpStatus"] is not None],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


def _pct(value) -> str:
    return "–" if value is None else f"{value * 100:.1f}%"


def _row(label: str, block: dict) -> str:
    fields = block["fields"]
    return (f"| {label} | {block['items']} | {block['outputs']} | {_pct(block['statusAccuracy'])} | {_pct(block['casePassRate'])} | "
            f"{_pct(fields['f1'])} | {block['rejected']} | {block['mustNotViolations']} |")


def report(metrics: dict) -> str:
    single, turns, overall = metrics["singleTurn"], metrics["scenarioTurns"], metrics["overall"]
    issues = metrics["outputIssues"]
    lines = [
        f"# 대화 조건 해석 재생 보고서 — `{metrics['run']}`",
        "",
        "> 기대 라벨은 AI가 작성한 기대 동작이며 사람이 검토한 정답이 아니다. 이 보고서는 `outputs.jsonl`의 모델 출력을",
        "> 실제 AI Service HTTP 경로(모델 응답만 고정)로 재생해 채점한 결과다. Claude가 만든 출력이면 **Claude 대리 검증**이며",
        "> OpenAI 운영 모델의 측정이 아니다. 여러 턴은 이전 턴의 기대 상태를 다음 입력으로 쓰는 턴 단위 채점이다.",
        "",
        f"- cases.json 지문: `{metrics['casesCanonicalSha256']}`",
        f"- 시스템 지침 SHA-256: `{metrics['systemInstructionsSha256']}`",
        f"- 입력 지문: {metrics['inputFingerprint']}",
        f"- 출력 처리: 출력 {overall['outputs']}건 / 누락 {overall['missing']}건 / 무효 줄 {len(issues['invalidLines'])}건 / "
        f"중복 id {len(issues['duplicateKeys'])}건 / 모르는 id {len(issues['unknownKeys'])}건",
        f"- AI Service 검증 거부: {overall['rejected']}건 (예상 밖 HTTP {metrics['unexpectedHttpStatuses'] or '없음'})",
        "",
        "## 요약",
        "",
        "| 지표 | 단일 턴 | 여러 턴(턴 단위) | 전체 |",
        "|---|---:|---:|---:|",
    ]
    for label, key in (
        ("상태 정확도", "statusAccuracy"), ("사례 통과율(상태·종류·필드·금지 규칙 모두)", "casePassRate"),
        ("READY 기대 문항의 정확한 제안 일치율", "readyExactRate"), ("확인 질문 종류 정확도", "clarificationKindAccuracy"),
        ("안내 종류 정확도", "answerKindAccuracy"), ("검증기 거부율(출력 대비)", "validatorRejectionRate"),
        ("잘못된 변경률(금지 규칙 위반/검사)", "falseChangeRate"), ("기대하지 않은 변경 포함률", "unexpectedChangeRate"),
        ("현재 구조 경로 일치율(READY→pipeline 등)", "currentRouteAgreement"),
    ):
        lines.append(f"| {label} | {_pct(single[key])} | {_pct(turns[key])} | {_pct(overall[key])} |")
    for label, key in (("필드 정밀도", "precision"), ("필드 재현율", "recall"), ("필드 F1", "f1")):
        lines.append(f"| {label} | {_pct(single['fields'][key])} | {_pct(turns['fields'][key])} | {_pct(overall['fields'][key])} |")
    lines += [
        f"| 회사 소재지(REGION) 보호 위반 | {single['protectedRegionViolations']} | {turns['protectedRegionViolations']} | "
        f"{overall['protectedRegionViolations']} |",
        f"| 허용 대안으로 통과 | {single['alternativeMatches']} | {turns['alternativeMatches']} | {overall['alternativeMatches']} |",
        "",
        f"여러 턴 시나리오 전체 턴 통과율: {_pct(metrics['scenarioAllTurnsPassRate'])}",
        "",
        "## 필드별",
        "",
        "| 필드 | TP | FP | FN | 정밀도 | 재현율 | F1 |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for name, block in metrics["fieldsOverall"].items():
        lines.append(f"| {name} | {block['tp']} | {block['fp']} | {block['fn']} | {_pct(block['precision'])} | "
                     f"{_pct(block['recall'])} | {_pct(block['f1'])} |")
    header = ["| 묶음 | 문항 | 출력 | 상태 | 통과 | 필드 F1 | 거부 | 금지 위반 |", "|---|---:|---:|---:|---:|---:|---:|---:|"]
    labels = {name: label for name, (label, _) in cases_module.CATEGORIES.items()}
    lines += ["", "## 범주별(단일 턴)", "", *header]
    lines += [_row(f"{labels[name]} (`{name}`)", metrics["categories"][name])
              for name in cases_module.CATEGORIES if name in metrics["categories"]]
    lines += ["", "## 기대 경로(route)별", "",
              "현재 출력에는 route가 없다. 결과 질문·비교·더 보기·여러 의도·0건 도움 경로는 현재 구조로 표현할 수 없어 "
              "가장 가까운 현재 동작으로 채점하며, 경로 일치율은 상태에서 추정한 값이다.", "",
              "| 경로 | 문항 | 출력 | 상태 | 통과 | 필드 F1 | 거부 | 금지 위반 | 현재 구조 경로 일치 |",
              "|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
    lines += [f"{_row(f'`{name}`', metrics['routes'][name])} {_pct(metrics['routes'][name]['currentRouteAgreement'])} |"
              for name in cases_module.ROUTES if name in metrics["routes"]]
    for prefix, title in (("v2-gap:", "v2-gap 주제별(현재 스키마로 표현 못 하는 의도)"), ("known-weak:", "설계 문서 약점 문장"),
                          ("style:", "표현 방식")):
        lines += ["", f"## {title}", "", *header]
        lines += [_row(f"`{name}`", block) for name, block in metrics["tags"].items() if name.startswith(prefix)]
    lines += ["", "## 여러 턴 시나리오", "", "| 시나리오 | 제목 | 통과 턴 | 전체 통과 |", "|---|---|---:|---|"]
    for scenario_id, block in metrics["scenarios"].items():
        lines.append(f"| {scenario_id} | {block['title']} | {block['passedTurns']}/{block['turns']} | "
                     f"{'예' if block['allPassed'] else '아니요'} |")
    lines += ["", f"## 실패 목록 ({len(metrics['failures'])}건)", "", "| id | 범주 | 경로 | 결과 | 메시지 | 이유 |", "|---|---|---|---|---|---|"]
    for failure in metrics["failures"]:
        message = failure["message"].replace("|", "\\|").replace("\n", " ")
        message = message if len(message) <= 40 else message[:39] + "…"
        reasons = "; ".join(failure["reasons"]).replace("|", "\\|").replace("\n", " ")
        lines.append(f"| {failure['key']} | {', '.join(failure['categories'])} | {failure['route']} | {failure['outcome']} | "
                     f"{message} | {reasons} |")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--run", help="runs/ 아래 실행 이름")
    target.add_argument("--run-dir", type=Path)
    parser.add_argument("--cases", type=Path, default=cases_module.CASES_PATH)
    parser.add_argument("--out-dir", type=Path, help="보고서를 쓸 폴더(기본: 실행 폴더)")
    parser.add_argument("--core-fixture", type=Path, help="Core 재생 테스트 고정 자료를 이 경로에 쓴다")
    args = parser.parse_args()
    run_dir = args.run_dir or RUNS_DIR / args.run
    if not (run_dir / "outputs.jsonl").exists():
        print(f"{run_dir / 'outputs.jsonl'} 없음", file=sys.stderr)
        return 1
    cases = cases_module.load_cases(args.cases)
    errors = cases_module.validate(cases)
    if errors:
        print(f"cases.json 검증 실패 {len(errors)}건: validate_cases.py로 확인", file=sys.stderr)
        return 1
    metrics = replay(cases, run_dir, args.out_dir, core_fixture=args.core_fixture)
    overall = metrics["overall"]
    print(f"{args.out_dir or run_dir}에 report.md·metrics.json·ai-responses.jsonl을 썼다.")
    print(f"출력 {overall['outputs']}/{overall['items']}, 상태 {_pct(overall['statusAccuracy'])}, "
          f"통과 {_pct(overall['casePassRate'])}, 필드 F1 {_pct(overall['fields']['f1'])}, "
          f"거부 {overall['rejected']}, 금지 위반 {overall['mustNotViolations']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
