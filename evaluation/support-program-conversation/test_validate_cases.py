"""평가 세트 검증 도구의 테스트. 모델·네트워크를 쓰지 않는다."""

from copy import deepcopy

import pytest

import validate_cases


@pytest.fixture(scope="module")
def cases():
    return validate_cases.load_cases()


@pytest.fixture
def small(cases):
    """도구 동작만 빠르게 보는 작은 자료. 설계 최소 문항 수는 적용하지 않는다."""
    data = deepcopy(cases)
    data["cases"] = [case for case in data["cases"] if case["id"] in ("S001", "S003", "S032", "S147", "S156")]
    data["scenarios"] = [scenario for scenario in data["scenarios"] if scenario["id"] in ("M01", "M14")]
    return data


def errors_of(data):
    return validate_cases.validate(data, design_minimums=False)


def test_committed_cases_pass_every_check_including_design_minimums(cases):
    assert validate_cases.validate(cases) == []
    items = validate_cases.iter_items(cases)
    assert len(cases["cases"]) >= validate_cases.MINIMUM_SINGLE_TURN_CASES
    assert len(cases["scenarios"]) >= validate_cases.MINIMUM_SCENARIOS
    assert len(items) - len(cases["cases"]) >= validate_cases.MINIMUM_SCENARIO_TURNS
    assert {item.category for item in items if item.scenario_id is None} == set(validate_cases.CATEGORIES)
    assert {item.route for item in items} == set(validate_cases.ROUTES)


def test_labels_disclose_ai_authorship_and_synthetic_results(cases):
    assert cases["labelSource"] == "ai-authored-expected-behaviour"
    assert cases["humanReviewed"] is False
    assert cases["dataType"] == "synthetic"


def test_every_scenario_carries_a_simulator_goal(cases):
    for scenario in cases["scenarios"]:
        goal = scenario["userGoal"]
        assert goal["hiddenCompany"] and goal["seeking"] and goal["rejectProposals"]
        assert goal["maxTurns"] >= len(scenario["turns"])


def test_small_subset_is_valid(small):
    assert errors_of(small) == []


@pytest.mark.parametrize("mutate,message", [
    (lambda d: d["cases"][1].update(id="S001"), "중복"),
    (lambda d: d["cases"][0]["expected"]["updates"][0].update(evidence="없는 근거"), "message에 없음"),
    (lambda d: d["cases"][0]["expected"]["updates"][0].update(field="PROGRAM_REGION"), "현재 계약에 없는"),
    (lambda d: d["cases"][0]["expected"].update(status="DONE"), "알 수 없는 status"),
    (lambda d: d["cases"][2]["expected"].update(clarificationKind=["WHEN"]), "허용 코드"),
    (lambda d: d["cases"][0]["expected"]["match"]["QUERY"].update(excludes=["AI"]), "자신의 match 규칙"),
    (lambda d: d["cases"][1]["mustNot"].append({"type": "unchanged", "field": "QUERY"}), "채점 규칙을 통과하지 못함"),
    (lambda d: d["cases"][0]["expected"]["updates"].append(
        {"field": "INDUSTRY", "operation": "CLEAR", "value": None, "evidence": "서울"}), "병합 결과를 바꾸지 않음"),
    (lambda d: d["cases"][0]["request"]["context"]["companyConditions"].update(foundedYear=None), "Core 직렬화"),
    (lambda d: d["cases"][0]["request"].pop("lastSearch"), "Core가 보내는 키"),
    (lambda d: d["cases"][4].update(targetIndexes=[3]), "targetIndexes"),
    (lambda d: d["cases"][3]["lastResults"].pop(), "lastResults"),
    (lambda d: d["cases"][0].update(route="teleport"), "알 수 없는 route"),
    (lambda d: d["cases"][3].update(tags=["state:last-search"]), "v2-gap 태그"),
    (lambda d: d["scenarios"][0]["turns"][1]["request"]["pendingClarification"].update(
        question="검색할 지역을 하나로 정해 알려 주세요."), "전달되는 상태와 다름"),
    (lambda d: d["scenarios"][0]["turns"][1].update(after={"action": "teleport"}), "after.action"),
    (lambda d: d["scenarios"][0]["userGoal"].update(rejectProposals=[]), "rejectProposals"),
    (lambda d: d.update(humanReviewed=True), "사람 미검토"),
])
def test_rejects_inconsistent_labels(small, mutate, message):
    mutate(small)
    errors = errors_of(small)
    assert any(message in error for error in errors), errors


def test_design_minimums_are_enforced_on_the_full_set(cases):
    data = deepcopy(cases)
    data["cases"] = [case for case in data["cases"] if case["categories"][0] != "deadline"]
    errors = validate_cases.validate(data)
    assert any("마감·접수 상태" in error for error in errors)
    assert any("known-weak:deadline-week" in error for error in errors)


def test_region_scoring_ignores_only_province_spelling():
    assert validate_cases.normalize_region("서울특별시") == validate_cases.normalize_region("서울")
    assert validate_cases.normalize_region("서울시 강남구") == validate_cases.normalize_region("서울 강남구")
    assert validate_cases.normalize_region("서울") != validate_cases.normalize_region("서울 강남구")
    assert validate_cases.normalize_region("부산 지역") == validate_cases.normalize_region("부산광역시")


def test_text_matching_uses_word_groups_and_exclusions():
    spec = {"includes": [["수출", "해외진출"], ["R&D", "연구개발"]], "excludes": ["서울"]}
    assert validate_cases.text_matches("QUERY", "해외 진출 r&d 지원", spec, "x")
    assert not validate_cases.text_matches("QUERY", "수출 지원", spec, "x")
    assert not validate_cases.text_matches("QUERY", "서울 수출 R&D", spec, "x")
    assert validate_cases.text_matches("REGION", "부산광역시", {}, "부산")
    assert validate_cases.text_matches("ACCEPTING_ONLY", False, {}, False)
    assert not validate_cases.text_matches("QUERY", None, spec, "x")
