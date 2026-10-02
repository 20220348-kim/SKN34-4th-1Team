"""저장 RAG의 사람 검토와 측정 여부를 판정한다. 참조 자료 승인 전 합격은 금지한다."""

POLICY = {
    "version": "rag-review-quality-v1",
    "scope": "source-chunks-retrieval-answer",
    "dimensions": ["retrieval", "answer", "citation"],
    "semantic_measurement": "human-case-review",
    "reference_review_supported": False,
    "pass_enabled": False,
    "baseline_eligible": False,
}


def judge(inputs):
    # 현재 RAG 계약에는 원문/AI 참조 조건을 승인하는 별도 사람 검토가 없다.
    reasons = [{"code": "REFERENCE_REVIEW_REQUIRED", "case_id": None, "dimension": None}]
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
