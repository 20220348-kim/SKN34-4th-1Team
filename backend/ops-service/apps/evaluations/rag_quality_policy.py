"""저장 RAG의 사람 검토와 측정 여부를 판정한다. 합격 정책은 아직 활성화하지 않는다."""

POLICY = {
    "version": "rag-review-quality-v2",
    "scope": "source-chunks-retrieval-answer",
    "dimensions": ["retrieval", "answer", "citation"],
    "semantic_measurement": "human-case-review",
    "reference_review_supported": True,
    "pass_enabled": False,
    "baseline_eligible": False,
}


def judge(inputs):
    reference = inputs["reference_review"]
    current = next(
        (row for row in reference["history"] if row["id"] == reference["current_id"]), None
    )
    code = (
        "PASS_POLICY_PENDING"
        if reference["approved"]
        else "REFERENCE_REVOKED"
        if current and current["decision"] == "REVOKED"
        else "REFERENCE_CHANGES_REQUESTED"
        if current and current["decision"] == "CHANGES_REQUESTED"
        else "REFERENCE_REVIEW_REQUIRED"
    )
    reasons = [{"code": code, "case_id": None, "dimension": None}]
    if inputs["measurement_kind"] != "recorded-capture-replay":
        reasons.append({"code": "NON_MODEL_CAPTURE", "case_id": None, "dimension": None})
    failed = False
    for case in inputs["cases"]:
        case_id = case["case_id"]
        if case["failure"]:
            reasons.append(
                {"code": "SOURCE_EXECUTION_FAILED", "case_id": case_id, "dimension": None}
            )
        for dimension in POLICY["dimensions"]:
            value = case["dimensions"][dimension]
            if not value["measured"]:
                code = "NOT_MEASURED"
            elif value["decision"] == "UNSUITABLE":
                failed = True
                code = "HUMAN_UNSUITABLE"
            elif value["decision"] != "SUITABLE":
                code = "CASE_REVIEW_REQUIRED"
            else:
                continue
            reasons.append({"code": code, "case_id": case_id, "dimension": dimension})
    # FAIL은 측정된 항목의 현재 사람 검토로만 결정한다. AI 참조와의 불일치는 쓰지 않는다.
    return ("FAIL" if failed else "NEEDS_REVIEW"), reasons
