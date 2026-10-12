"""재생·채점 도구의 테스트. 모델 HTTP 응답만 고정하며 OpenAI를 부르지 않는다."""

import json
import shutil

import pytest

import replay
import validate_cases

EXAMPLE = replay.RUNS_DIR / "example" / "outputs.jsonl"


@pytest.fixture(scope="module")
def cases():
    return validate_cases.load_cases()


@pytest.fixture(scope="module")
def items(cases):
    return validate_cases.iter_items(cases)


def key_of(cases, message):
    (case,) = [case for case in cases["cases"] if case["request"]["message"] == message]
    return case["id"]


def ready(*updates):
    return {"status": "READY", "updates": list(updates), "answerKind": None, "clarificationKind": None}


def change(field, value, evidence):
    return {"field": field, "operation": "SET", "value": value, "evidence": evidence}


def write_outputs(run_dir, lines):
    run_dir.mkdir(parents=True, exist_ok=True)
    text = "".join(line if isinstance(line, str) else json.dumps(line, ensure_ascii=False) + "\n" for line in lines)
    (run_dir / "outputs.jsonl").write_text(text, encoding="utf-8")


def gold_line(item, index=0):
    return {"caseId": item.case_id, "turn": item.turn, "output": validate_cases.gold_output(item.expectations[index])}


def failures(metrics):
    return {failure["key"]: failure for failure in metrics["failures"]}


def test_example_run_goes_through_the_real_ai_service_and_records_what_core_receives(cases, items, tmp_path):
    run_dir = tmp_path / "example"
    run_dir.mkdir()
    shutil.copy(EXAMPLE, run_dir / "outputs.jsonl")
    fixture = tmp_path / "core.json"
    metrics = replay.replay(cases, run_dir, core_fixture=fixture)
    overall = metrics["overall"]
    assert (overall["outputs"], overall["accepted"], overall["rejected"], overall["missing"]) == (3, 2, 1, len(items) - 3)
    found = failures(metrics)
    assert "S002#1" not in found and "M14#1" not in found
    assert found["S032#1"]["outcome"] == "REJECTED"
    lines = (run_dir / "ai-responses.jsonl").read_text(encoding="utf-8").splitlines()
    records = {f"{record['caseId']}#{record['turn']}": record for record in map(json.loads, lines)}
    assert len(records) == len(items)
    assert records["S032#1"]["httpStatus"] == 503 and records["S001#1"]["httpStatus"] is None
    # AI Service는 표기만 다른 지역을 그대로 통과시키며, 표기 유지는 Core 재생 테스트가 확인한다.
    assert records["S002#1"]["response"]["updates"][1]["value"] == "서울"
    assert records["M14#1"]["response"]["clarificationKind"] == "REGION"
    report = (run_dir / "report.md").read_text(encoding="utf-8")
    assert "사람이 검토한 정답이 아니다" in report and "Claude 대리 검증" in report
    # 커밋된 Core 재생 테스트 자료는 이 예시 실행의 결과와 같아야 한다.
    assert json.loads(fixture.read_text(encoding="utf-8")) == json.loads(replay.CORE_FIXTURE_PATH.read_text(encoding="utf-8"))


def test_expected_outputs_pass_the_http_path_and_score_perfectly(cases, items, tmp_path):
    write_outputs(tmp_path, [gold_line(item) for item in items])
    metrics = replay.replay(cases, tmp_path)
    overall = metrics["overall"]
    assert metrics["failures"] == []
    assert overall["missing"] == overall["rejected"] == 0
    assert overall["casePassRate"] == overall["statusAccuracy"] == overall["readyExactRate"] == 1.0
    assert overall["fields"]["f1"] == 1.0 and overall["falseChangeRate"] == 0.0
    assert overall["clarificationKindAccuracy"] == overall["answerKindAccuracy"] == 1.0
    # 현재 출력에는 route가 없어 결과 질문·비교·더 보기·여러 의도·0건 도움 경로는 상태로 맞출 수 없다.
    agreeing = sum(
        validate_cases.CURRENT_ROUTE_BY_STATUS[item.expectations[0]["status"]] in (item.route, *item.route_alternatives)
        for item in items
    )
    assert overall["currentRouteAgreement"] == round(agreeing / len(items), 4) < 1.0
    assert metrics["scenarioAllTurnsPassRate"] == 1.0


def test_allowed_alternatives_pass_and_are_counted(cases, items, tmp_path):
    with_alternatives = [item for item in items if len(item.expectations) > 1]
    write_outputs(tmp_path, [gold_line(item, 1) for item in with_alternatives])
    metrics = replay.replay(cases, tmp_path)
    found = failures(metrics)
    assert not [item.key for item in with_alternatives if item.key in found]
    assert metrics["overall"]["alternativeMatches"] == len(with_alternatives)


def test_invalid_missing_and_duplicate_outputs_count_as_failures(cases, items, tmp_path):
    by_key = {item.key: item for item in items}
    good = gold_line(by_key["S004#1"])
    extra_key = {**validate_cases.gold_output(by_key["S008#1"].expectations[0]), "answer": "자유 문장"}
    write_outputs(tmp_path, [
        "not json\n",
        {"caseId": "S005", "turn": 1},
        {"caseId": "S999", "turn": 1, "output": {}},
        {"caseId": "S006", "turn": "1", "output": {}},
        good,
        good,
        {"caseId": "S007", "turn": 1, "output": "READY"},
        {"caseId": "S008", "turn": 1, "output": extra_key},
    ])
    metrics = replay.replay(cases, tmp_path)
    issues = metrics["outputIssues"]
    assert issues == {"invalidLines": [1, 2, 4], "unknownKeys": ["S999#1"], "duplicateKeys": ["S004#1"]}
    found = failures(metrics)
    assert found["S004#1"]["outcome"] == found["S005#1"]["outcome"] == "MISSING"
    assert found["S007#1"]["outcome"] == found["S008#1"]["outcome"] == "REJECTED"
    assert (metrics["overall"]["outputs"], metrics["overall"]["rejected"]) == (2, 2)


def test_company_region_overwrite_is_a_false_change_but_province_spelling_is_not(cases, tmp_path):
    conflict = key_of(cases, "부산에서 하는 수출 지원사업 찾아줘")
    alias = key_of(cases, "서울 AI 창업지원")
    write_outputs(tmp_path, [
        {"caseId": conflict, "turn": 1, "output": ready(
            change("REGION", "부산", "부산"), change("QUERY", "수출 지원", "수출 지원사업"))},
        {"caseId": alias, "turn": 1, "output": ready(
            change("QUERY", "AI 창업지원", "AI 창업지원"), change("REGION", "서울", "서울"))},
    ])
    metrics = replay.replay(cases, tmp_path)
    found = failures(metrics)
    assert any("보호 필드 REGION" in reason for reason in found[f"{conflict}#1"]["reasons"])
    assert f"{alias}#1" not in found
    overall = metrics["overall"]
    assert (overall["protectedRegionViolations"], overall["mustNotViolations"], overall["fields"]["fp"]) == (1, 1, 1)
    assert overall["falseChangeRate"] == 0.25


def test_missing_purpose_switch_lowers_recall_and_old_activity_is_a_mismatch(cases, tmp_path):
    switch = key_of(cases, "사업화 말고 수출 지원으로 바꿔줘")
    refine = key_of(cases, "지원금 위주")
    write_outputs(tmp_path, [
        {"caseId": switch, "turn": 1, "output": ready(change("QUERY", "수출 지원", "수출"))},
        {"caseId": refine, "turn": 1, "output": ready(
            change("QUERY", "지원금", "지원금"), change("SUPPORT_PURPOSE", "지원금", "지원금"))},
    ])
    metrics = replay.replay(cases, tmp_path)
    found = failures(metrics)
    assert any("SUPPORT_PURPOSE 변경 누락" in reason for reason in found[f"{switch}#1"]["reasons"])
    # 프롬프트 예시처럼 사업화 활동을 지우면 QUERY 값 불일치(재현율과 정밀도 모두 감소)다.
    assert any(reason.startswith("QUERY 값") for reason in found[f"{refine}#1"]["reasons"])
    fields = metrics["fieldsOverall"]
    assert (fields["QUERY"]["tp"], fields["QUERY"]["fp"]) == (1, 1)
    assert (fields["SUPPORT_PURPOSE"]["tp"], fields["SUPPORT_PURPOSE"]["fp"]) == (1, 0)
