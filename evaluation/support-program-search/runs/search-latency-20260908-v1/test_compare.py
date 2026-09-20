import copy
import importlib.util
import json
from pathlib import Path

import pytest


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("latency_compare", HERE / "compare.py")
compare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compare)


@pytest.fixture
def inputs():
    reference = compare.read(compare.REFERENCE_FILE)
    original = compare.read(HERE.parent / "search-precision-v5-20260907-v1/request.json")
    requests = {case: {**copy.deepcopy(original), "originalQuery": case} for case, _ in compare.PLAN}
    return reference, requests


def observation(request, case="FUNDS", phase="baseline", repetition=1, elapsed=10, selected=()):
    rankings = [{"programId": candidate["id"], "semanticRelevance": 35 if candidate["id"] in selected else 0,
                 "supportTypeFit": 8,
                 "targetAssessment": {"eligibility": "UNKNOWN", "evidence": [], "explanation": "대상 확인 필요"},
                 "regionAssessment": {"eligibility": "UNKNOWN", "evidence": [], "explanation": "지역 확인 필요"},
                 "recommendationReasons": ["대역 검증"]} for candidate in request["candidates"]]
    final = []
    for value in rankings:
        if value["programId"] not in selected:
            continue
        result = {key: value[key] for key in ("programId", "semanticRelevance", "supportTypeFit", "recommendationReasons")}
        result["totalScore"] = 2 * (value["semanticRelevance"] + value["supportTypeFit"])
        for prefix, dimension in (("target", "targetAssessment"), ("region", "regionAssessment")):
            for suffix, field in (("Eligibility", "eligibility"), ("Evidence", "evidence"), ("Explanation", "explanation")):
                result[prefix + suffix] = copy.deepcopy(value[dimension][field])
        final.append(result)
    return {"identity": [case, phase, repetition], "requestSha256": compare.sha(request),
            "candidateSha256": compare.sha(request["candidates"]), "status": "completed", "elapsedSeconds": elapsed,
            "assessments": {"rankings": rankings}, "response": {
                "originalQuery": request["originalQuery"], "scoringVersion": request["scoringVersion"], "rankings": final}}


def save_phase(root, phase, requests, observations, *, provenance="mock", receipt_count=None):
    path = root / phase
    path.mkdir()
    succeeded = [value for value in observations if value["status"] == "completed"]
    receipts = [{"event": "response", "identity": item["identity"], "requestSha256": item["requestSha256"],
                 "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15},
                 "cachedInputTokens": 3, "reasoningTokens": 2,
                 "returnedServiceTier": "priority" if phase == "fast" else "default"} for item in succeeded]
    if receipt_count is not None:
        receipts = receipts[:receipt_count]
    manifest = {"phase": phase, "status": "failed" if len(succeeded) != len(observations) else "completed", "provenance": provenance,
                "requestSha256": compare.sha(requests), "candidateSha256": compare.sha(requests["FUNDS"]["candidates"]),
                "plan": compare.PLAN, "attempts": len(observations), "actualCalls": len(observations),
                "completedRankings": len(succeeded), "failedRankings": len(observations) - len(succeeded),
                "outputFormat": "compact" if phase == "compact" else "full", "requestedServiceTier": "priority" if phase == "fast" else "default"}
    for name, value in (("manifest", manifest), ("capture", {"observations": observations}), ("requests", requests), ("usage", receipts)):
        (path / f"{name}.json").write_text(json.dumps(value, ensure_ascii=False))


def test_success_median_failure_denominator_and_missing_receipt_usage_are_separate(inputs, tmp_path):
    reference, requests = inputs
    first = observation(requests["FUNDS"], elapsed=10)
    second = observation(requests["CONSULTING"], "CONSULTING", elapsed=30)
    failed = observation(requests["FILM"], "FILM", elapsed=45)
    failed.update(status="failed", errorType="AgentTimeoutError", reasonCode="EXECUTION_FAILED")
    failed.pop("response")
    failed.pop("assessments")
    save_phase(tmp_path, "baseline", requests, [first, second, failed])
    report = compare.build_report(tmp_path, reference)
    phase = report["phases"]["baseline"]
    assert phase["plannedCases"] == 6
    assert phase["completedRankings"] == 2
    assert phase["failedRankings"] == 1
    assert phase["successfulRankingLatencySeconds"]["median"] == 20
    assert phase["recordedAttemptLatencySecondsIncludingFailures"]["median"] == 30
    assert phase["missingResponseReceiptCount"] == 1
    assert phase["tokensFromReceivedReceiptsOnly"]["input_tokens"] == {"receiptCount": 2, "total": 20, "median": 10}
    assert phase["cases"][2]["finalIds"] is None
    assert phase["cases"][2]["quality"] is None
    assert report["status"] == "partial"


def test_reference_uncertain_is_not_unsupported_and_broad_is_unlabeled(inputs):
    reference, requests = inputs
    selected = ("BIZINFO:PBLN_000000000125611", "BIZINFO:PBLN_000000000124940", "BIZINFO:PBLN_000000000126004")
    result = compare.case_summary(observation(requests["FUNDS"], selected=selected), requests["FUNDS"], reference)
    assert result["quality"]["selectedReferenceLabelCounts"] == {"supported": 1, "unsupported": 1, "uncertain": 1, "unlabeled": 0}
    broad = compare.case_summary(observation(requests["BROAD"], "BROAD", selected=selected), requests["BROAD"], reference)
    assert broad["referenceCaseId"] is None
    assert not broad["quality"]["labeledCase"]
    assert broad["quality"]["selectedReferenceLabelCounts"]["unlabeled"] == 3


def test_supported_omissions_separate_target_and_region_conflicts(inputs):
    reference, requests = inputs
    value = observation(requests["FUNDS"])
    by_id = {item["programId"]: item for item in value["assessments"]["rankings"]}
    candidates = {item["id"]: item for item in requests["FUNDS"]["candidates"]}
    for program_id, dimension in (("BIZINFO:PBLN_000000000125611", "targetAssessment"), ("BIZINFO:PBLN_000000000125748", "regionAssessment")):
        by_id[program_id]["semanticRelevance"] = 35
        by_id[program_id][dimension] = {"eligibility": "INCOMPATIBLE", "explanation": "대역 충돌 판정",
                                       "evidence": [{"field": "SUMMARY", "quote": candidates[program_id]["summary"][:30]}]}
    summary = compare.case_summary(value, requests["FUNDS"], reference)["quality"]
    omissions = {item["programId"]: item["exclusionReasons"] for item in summary["supportedWithoutExplicitConflictOmissions"]}
    assert omissions["BIZINFO:PBLN_000000000125611"] == ["model_target_incompatible"]
    assert omissions["BIZINFO:PBLN_000000000125748"] == ["model_region_incompatible"]
    assert len(summary["modelTargetConflictIds"]) == len(summary["modelRegionConflictIds"]) == 1


def test_pair_compares_all_20_candidates_even_when_final_ids_do_not_change(inputs):
    _, requests = inputs
    first = observation(requests["FUNDS"])
    second = copy.deepcopy(first)
    second["identity"][1] = "compact"
    second["elapsedSeconds"] = 9
    second["assessments"]["rankings"][19]["semanticRelevance"] = 19
    second["assessments"]["rankings"][19]["regionAssessment"]["explanation"] = "변경된 설명"
    pair = compare.compare_pair(first, second)
    assert pair["comparedAssessmentCount"] == 20
    assert len(pair["allCandidateDifferences"]) == 20
    assert pair["changedAssessmentCount"] == 1
    assert set(pair["allCandidateDifferences"][19]["changedFields"]) == {"semanticRelevance", "regionAssessment"}
    assert pair["finalOrderIdentical"]
    assert pair["elapsedDifferenceSeconds"] == -1


def test_failed_pair_is_not_given_zero_quality_or_zero_latency(inputs):
    _, requests = inputs
    first = observation(requests["FUNDS"])
    failed = {**first, "status": "failed"}
    result = compare.compare_pair(first, failed)
    assert result == {"beforeStatus": "completed", "afterStatus": "failed", "comparedAssessmentCount": 0}


@pytest.mark.parametrize("mutation", ["missing_assessment", "bad_quote", "altered_final_eligibility", "altered_final_score"])
def test_corrupted_success_is_rejected(inputs, mutation):
    reference, requests = inputs
    value = observation(requests["FUNDS"], selected=("BIZINFO:PBLN_000000000125611",))
    if mutation == "missing_assessment":
        value["assessments"]["rankings"].pop()
    elif mutation == "bad_quote":
        value["assessments"]["rankings"][0]["targetAssessment"]["evidence"] = [{"field": "SUMMARY", "quote": "후보에 없는 변조된 문장"}]
    elif mutation == "altered_final_eligibility":
        value["response"]["rankings"][0]["targetEligibility"] = "MATCH"
    else:
        value["response"]["rankings"][0]["totalScore"] = 100
    with pytest.raises(compare.ReportInputError):
        compare.case_summary(value, requests["FUNDS"], reference)


def test_missing_receipt_on_success_and_mixed_mock_live_phases_are_rejected(inputs, tmp_path):
    reference, requests = inputs
    save_phase(tmp_path, "baseline", requests, [observation(requests["FUNDS"])], receipt_count=0)
    with pytest.raises(compare.ReportInputError, match="denominator"):
        compare.build_report(tmp_path, reference)


def test_mixed_mock_and_live_phases_are_rejected(inputs, tmp_path):
    reference, requests = inputs
    save_phase(tmp_path, "baseline", requests, [observation(requests["FUNDS"])])
    save_phase(tmp_path, "compact", requests, [observation(requests["FUNDS"], phase="compact")], provenance="live_openai")
    with pytest.raises(compare.ReportInputError, match="mock and live"):
        compare.build_report(tmp_path, reference)


def test_comparisons_use_only_shared_successful_cases(inputs, tmp_path):
    reference, requests = inputs
    before = [observation(requests["FUNDS"], elapsed=30), observation(requests["FILM"], "FILM", elapsed=10)]
    after = [observation(requests["FUNDS"], phase="compact", elapsed=20)]
    save_phase(tmp_path, "baseline", requests, before)
    save_phase(tmp_path, "compact", requests, after)
    pair = compare.build_report(tmp_path, reference)["comparisons"]["baseline_to_compact"]
    assert pair["bothSuccessfulPairs"] == 1
    assert pair["beforePairedSuccessLatencySeconds"]["median"] == 30
    assert pair["afterPairedSuccessLatencySeconds"]["median"] == 20
    assert pair["comparedAssessmentCount"] == 20
