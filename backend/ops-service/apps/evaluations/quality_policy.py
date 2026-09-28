"""고정 근거 사례의 품질 정책. 자동 지표와 사람 검토를 구별한다."""

POLICY = {
    "version": "fixed-evidence-quality-v1",
    "scope": "fixed-answer-context-only",
    "require_fixture_review": True,
    "require_all_cases_suitable": True,
    "require_expected_status": True,
    "require_expected_citations": True,
    "semantic_measurement": "human-case-review",
}
FIXTURE_RUBRIC = "fixture-reference-review-v1"


def judge(inputs):
    """검증된 사실로 판정하고 미측정 값을 만들어 채우지 않는다."""
    reasons = []
    failed = False
    if not inputs["fixture_approved"]:
        reasons.append({"code": "FIXTURE_REVIEW_REQUIRED", "case_id": None})
    for case in inputs["cases"]:
        case_id = case["case_id"]
        if case["review"] == "UNSUITABLE":
            failed = True
            reasons.append({"code": "CASE_UNSUITABLE", "case_id": case_id})
        elif case["review"] != "SUITABLE":
            reasons.append({"code": "CASE_REVIEW_REQUIRED", "case_id": case_id})
        # 미검토 참조와의 불일치만으로 모델 품질을 불합격 처리하지 않는다.
        if inputs["fixture_approved"]:
            if not case["status_match"]:
                failed = True
                reasons.append({"code": "STATUS_MISMATCH", "case_id": case_id})
            if case["citation_recall"] is not None and case["citation_recall"] < 1:
                failed = True
                reasons.append({"code": "EXPECTED_CITATION_MISSING", "case_id": case_id})
    return ("FAIL" if failed else "NEEDS_REVIEW" if reasons else "PASS"), reasons
