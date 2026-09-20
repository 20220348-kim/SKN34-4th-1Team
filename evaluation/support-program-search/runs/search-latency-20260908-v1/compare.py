"""Recalculate the fixed-candidate AI_DRAFT comparison without network access."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from statistics import median


ROOT = Path(__file__).resolve().parent
REFERENCE_FILE = ROOT.parent / "search-precision-v5-20260907-v1/ai-review.json"
PHASES = ("baseline", "compact", "fast")
PLAN = [("FUNDS", 1), ("FUNDS_PARAPHRASE", 1), ("CONSULTING", 1), ("FILM", 1), ("BROAD", 1), ("FUNDS", 2)]
REFERENCE_CASES = {"FUNDS": "FUNDS", "FUNDS_PARAPHRASE": "FUNDS", "CONSULTING": "CONSULTING", "FILM": "FILM", "BROAD": None}
LABELS = ("supported", "unsupported", "uncertain", "unlabeled")


class ReportInputError(ValueError):
    pass


def sha(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def stats(values):
    return {"count": len(values), "minimum": min(values) if values else None,
            "median": round(median(values), 3) if values else None, "maximum": max(values) if values else None}


def reference_for(reference, request, case):
    documents = {item["programId"]: item for item in reference["documents"]}
    candidates = {item["id"]: item for item in request["candidates"]}
    if len(documents) != 20 or set(documents) != set(candidates):
        raise ReportInputError("reference and candidate IDs differ")
    mapped = REFERENCE_CASES[case]
    for program_id, document in documents.items():
        for evidence in document["sourceQuotes"].values():
            if evidence["quote"] not in candidates[program_id][evidence["field"]]:
                raise ReportInputError("reference quote differs from fixed source")
    return {program_id: {
        "label": document["assessments"][mapped]["label"] if mapped else "unlabeled",
        "eligibility": document["eligibility"]["status"],
    } for program_id, document in documents.items()}


def validate_assessments(observation, request):
    values = observation.get("assessments", {}).get("rankings")
    if values is None:
        if observation["status"] == "completed":
            raise ReportInputError("successful observation lacks all-candidate assessments")
        return {}, []
    candidates = {candidate["id"]: candidate for candidate in request["candidates"]}
    assessments = {value["programId"]: value for value in values}
    errors = []
    if len(values) != 20 or set(assessments) != set(candidates):
        errors.append("CANDIDATE_SET_MISMATCH")
    for program_id, value in assessments.items():
        if program_id not in candidates:
            continue
        for name, maximum in (("semanticRelevance", 40), ("supportTypeFit", 10)):
            if type(value.get(name)) is not int or not 0 <= value[name] <= maximum:
                errors.append("INVALID_SCORE")
        candidate = candidates[program_id]
        for dimension in ("targetAssessment", "regionAssessment"):
            eligibility = value.get(dimension, {})
            state = eligibility.get("eligibility")
            if state not in {"MATCH", "UNKNOWN", "INCOMPATIBLE"}:
                errors.append("INVALID_ELIGIBILITY")
            evidence = eligibility.get("evidence", [])
            if state != "UNKNOWN" and not evidence:
                errors.append("MISSING_KNOWN_EVIDENCE")
            if candidate.get("sourceTextTruncated") and state != "UNKNOWN":
                errors.append("TRUNCATED_SOURCE_KNOWN_ELIGIBILITY")
            for quote in evidence:
                field = {"SUMMARY": "summary", "TARGET_DESCRIPTION": "targetDescription"}.get(quote.get("field"))
                if field is None or not quote.get("quote") or quote["quote"] not in candidate[field]:
                    errors.append("EXACT_QUOTE_MISMATCH")
    if observation["status"] == "completed":
        if errors:
            raise ReportInputError("successful observation contains invalid assessments")
        order = {candidate["id"]: index for index, candidate in enumerate(request["candidates"])}
        expected = sorted((value for value in values if value["semanticRelevance"] >= 20
                           and value["targetAssessment"]["eligibility"] != "INCOMPATIBLE"
                           and value["regionAssessment"]["eligibility"] != "INCOMPATIBLE"),
                          key=lambda value: (-2 * (value["semanticRelevance"] + value["supportTypeFit"]), order[value["programId"]]))
        response = observation["response"]
        if (response["originalQuery"] != request["originalQuery"] or response["scoringVersion"] != request["scoringVersion"]
                or [value["programId"] for value in response["rankings"]] != [value["programId"] for value in expected[:request["resultLimit"]]]):
            raise ReportInputError("final response differs from assessed filtering and order")
        for ranking in response["rankings"]:
            assessment = assessments[ranking["programId"]]
            if (ranking["semanticRelevance"] != assessment["semanticRelevance"]
                    or ranking["supportTypeFit"] != assessment["supportTypeFit"]
                    or ranking["totalScore"] != 2 * (assessment["semanticRelevance"] + assessment["supportTypeFit"])):
                raise ReportInputError("final response score differs from assessment")
            for prefix, dimension in (("target", "targetAssessment"), ("region", "regionAssessment")):
                for suffix, field in (("Eligibility", "eligibility"), ("Evidence", "evidence"), ("Explanation", "explanation")):
                    if ranking[prefix + suffix] != assessment[dimension][field]:
                        raise ReportInputError("final eligibility differs from assessment")
            if ranking["recommendationReasons"] != assessment["recommendationReasons"]:
                raise ReportInputError("final recommendation reasons differ from assessment")
    return assessments, sorted(set(errors))


def case_summary(observation, request, reference):
    case, phase, repetition = observation["identity"]
    if observation["requestSha256"] != sha(request) or observation["candidateSha256"] != sha(request["candidates"]):
        raise ReportInputError("observation request fingerprint differs")
    labels = reference_for(reference, request, case)
    assessments, errors = validate_assessments(observation, request)
    successful = observation["status"] == "completed"
    selected = [item["programId"] for item in observation["response"]["rankings"]] if successful else None
    result = {
        "caseId": case, "repetition": repetition, "status": observation["status"],
        "elapsedSeconds": observation["elapsedSeconds"], "finalIds": selected,
        "referenceCaseId": REFERENCE_CASES[case],
        "referenceMapping": "purpose_equivalent_proxy" if case == "FUNDS_PARAPHRASE" else "unlabeled" if case == "BROAD" else "same_case",
        "allAssessmentCount": len(assessments), "assessmentValidationErrors": errors,
        "candidateReferenceLabels": dict(Counter(value["label"] for value in labels.values())),
    }
    if not successful:
        result.update(errorType=observation.get("errorType"), reasonCode=observation.get("reasonCode"), quality=None)
        return result
    model_target_conflicts = [key for key, item in assessments.items() if item["targetAssessment"]["eligibility"] == "INCOMPATIBLE"]
    model_region_conflicts = [key for key, item in assessments.items() if item["regionAssessment"]["eligibility"] == "INCOMPATIBLE"]
    reference_conflicts = [key for key, item in labels.items() if item["eligibility"] == "explicit_conflict"]
    selected_by_label = {label: [key for key in selected if labels[key]["label"] == label] for label in LABELS}
    supported_without_conflict = [key for key, item in labels.items() if item["label"] == "supported" and key not in reference_conflicts]
    omissions = []
    for key in supported_without_conflict:
        if key in selected:
            continue
        value = assessments[key]
        reasons = []
        if value["semanticRelevance"] < 20:
            reasons.append("semantic_below_20")
        if key in model_target_conflicts:
            reasons.append("model_target_incompatible")
        if key in model_region_conflicts:
            reasons.append("model_region_incompatible")
        if not reasons:
            reasons.append("outside_result_limit")
        omissions.append({"programId": key, "exclusionReasons": reasons})
    result["quality"] = {
        "labelStatus": "AI_DRAFT_NOT_HUMAN_GROUND_TRUTH", "labeledCase": REFERENCE_CASES[case] is not None,
        "selectedByReferenceLabel": selected_by_label,
        "selectedReferenceLabelCounts": {label: len(ids) for label, ids in selected_by_label.items()},
        "supportedWithoutExplicitConflictAvailable": supported_without_conflict,
        "supportedWithoutExplicitConflictReturned": [key for key in supported_without_conflict if key in selected],
        "supportedWithoutExplicitConflictOmissions": omissions,
        "referenceCombinedExplicitConflictIds": reference_conflicts,
        "returnedReferenceExplicitConflictIds": [key for key in reference_conflicts if key in selected],
        "modelTargetConflictIds": model_target_conflicts, "modelRegionConflictIds": model_region_conflicts,
        "semanticAtLeast20ButTargetConflictIds": [key for key in model_target_conflicts if assessments[key]["semanticRelevance"] >= 20],
        "semanticAtLeast20ButRegionConflictIds": [key for key in model_region_conflicts if assessments[key]["semanticRelevance"] >= 20],
        "targetConflictAgainstReferenceUnknownIds": [key for key in model_target_conflicts if labels[key]["eligibility"] == "unknown"],
        "regionConflictAgainstReferenceUnknownIds": [key for key in model_region_conflicts if labels[key]["eligibility"] == "unknown"],
    }
    return result


def compare_pair(before, after):
    result = {"beforeStatus": before["status"] if before else "missing", "afterStatus": after["status"] if after else "missing",
              "comparedAssessmentCount": 0}
    if before is None or after is None or before["status"] != "completed" or after["status"] != "completed":
        return result
    if before["requestSha256"] != after["requestSha256"]:
        raise ReportInputError("paired request fingerprints differ")
    first = {item["programId"]: item for item in before["assessments"]["rankings"]}
    second = {item["programId"]: item for item in after["assessments"]["rankings"]}
    if set(first) != set(second) or len(first) != 20:
        raise ReportInputError("paired assessment IDs differ")
    first_ids = [item["programId"] for item in before["response"]["rankings"]]
    second_ids = [item["programId"] for item in after["response"]["rankings"]]
    differences = []
    for program_id, value in first.items():
        changes = {field: {"before": value.get(field), "after": second[program_id].get(field)}
                   for field in sorted(set(value) | set(second[program_id])) if value.get(field) != second[program_id].get(field)}
        differences.append({"programId": program_id, "changedFields": changes})
    result.update(comparedAssessmentCount=20, changedAssessmentCount=sum(bool(item["changedFields"]) for item in differences),
                  beforeElapsedSeconds=before["elapsedSeconds"], afterElapsedSeconds=after["elapsedSeconds"],
                  elapsedDifferenceSeconds=round(after["elapsedSeconds"] - before["elapsedSeconds"], 3),
                  beforeFinalIds=first_ids, afterFinalIds=second_ids, finalOrderIdentical=first_ids == second_ids,
                  addedFinalIds=[key for key in second_ids if key not in first_ids],
                  removedFinalIds=[key for key in first_ids if key not in second_ids], allCandidateDifferences=differences)
    return result


def summarize_phase(directory, phase, reference):
    if not directory.exists():
        return {"status": "not_started", "plannedCases": 6, "completedRankings": 0, "failedRankings": 0}, {}
    manifest = read(directory / "manifest.json")
    requests = read(directory / "requests.json")
    capture = read(directory / "capture.json") if (directory / "capture.json").exists() else {"observations": []}
    usage = read(directory / "usage.json") if (directory / "usage.json").exists() else []
    if manifest["phase"] != phase or manifest["requestSha256"] != sha(requests) or manifest["plan"] != [list(item) for item in PLAN]:
        raise ReportInputError("phase manifest or requests changed")
    observations = {}
    cases = []
    for observation in capture["observations"]:
        case, actual_phase, repetition = observation["identity"]
        identity = (case, repetition)
        if actual_phase != phase or identity not in PLAN or identity in observations or observation["status"] not in {"completed", "failed"}:
            raise ReportInputError("unknown or duplicate observation identity")
        observations[identity] = observation
        cases.append(case_summary(observation, requests[case], reference))
    receipts = [item for item in usage if item["event"] == "response"]
    seen_receipts = set()
    for receipt in receipts:
        case, actual_phase, repetition = receipt["identity"]
        identity = (case, repetition)
        if actual_phase != phase or identity not in PLAN or identity in seen_receipts or receipt["requestSha256"] != sha(requests[case]):
            raise ReportInputError("unknown, duplicate or changed receipt")
        seen_receipts.add(identity)
    successful = [item for item in cases if item["status"] == "completed"]
    failed = [item for item in cases if item["status"] == "failed"]
    if (not 0 <= len(cases) <= manifest["attempts"] <= 6 or not 0 <= len(receipts) <= manifest["actualCalls"] <= manifest["attempts"]
            or any((item["caseId"], item["repetition"]) not in seen_receipts for item in successful)):
        raise ReportInputError("attempt or receipt denominator is inconsistent")
    if manifest["status"] != "running" and (manifest["completedRankings"] != len(successful) or manifest["failedRankings"] != len(failed)):
        raise ReportInputError("finished manifest differs from captured outcomes")
    labeled = [item["quality"] for item in successful if item["quality"]["labeledCase"]]
    token_fields = {name: [receipt.get("usage", {}).get(name) for receipt in receipts]
                    for name in ("input_tokens", "output_tokens", "total_tokens")}
    token_fields.update(cachedInputTokens=[receipt.get("cachedInputTokens") for receipt in receipts],
                        reasoningTokens=[receipt.get("reasoningTokens") for receipt in receipts])
    tokens = {}
    for field, values in token_fields.items():
        known = [value for value in values if type(value) is int and value >= 0]
        tokens[field] = {"receiptCount": len(known), "total": sum(known) if known else None, "median": median(known) if known else None}
    return {
        "status": manifest["status"], "provenance": manifest["provenance"], "outputFormat": manifest["outputFormat"],
        "requestSha256": manifest["requestSha256"], "candidateSha256": manifest["candidateSha256"],
        "requestedServiceTier": manifest["requestedServiceTier"], "plannedCases": 6, "startedAttempts": manifest["attempts"],
        "actualCalls": manifest["actualCalls"], "capturedOutcomes": len(cases),
        "completedRankings": len(successful), "failedRankings": len(failed),
        "startedWithoutCapturedOutcome": manifest["attempts"] - len(cases), "unattemptedCases": 6 - manifest["attempts"],
        "successfulRankingLatencySeconds": stats([item["elapsedSeconds"] for item in successful]),
        "recordedAttemptLatencySecondsIncludingFailures": stats([item["elapsedSeconds"] for item in cases]),
        "failures": [{field: item[field] for field in ("caseId", "repetition", "errorType", "reasonCode", "elapsedSeconds")} for item in failed],
        "responseReceiptCount": len(receipts), "missingResponseReceiptCount": manifest["actualCalls"] - len(receipts),
        "returnedServiceTierCounts": dict(Counter(receipt.get("returnedServiceTier") or "unreported" for receipt in receipts)),
        "tokensFromReceivedReceiptsOnly": tokens, "cases": cases,
        "aiDraftAggregate": {
            "labeledSuccessfulCases": len(labeled), "plannedLabeledCases": 5,
            "unlabeledSuccessfulCases": len(successful) - len(labeled),
            "selectedReferenceLabels": {label: sum(item["selectedReferenceLabelCounts"][label] for item in labeled) for label in LABELS},
            "supportedWithoutExplicitConflictAvailable": sum(len(item["supportedWithoutExplicitConflictAvailable"]) for item in labeled),
            "supportedWithoutExplicitConflictReturned": sum(len(item["supportedWithoutExplicitConflictReturned"]) for item in labeled),
            "supportedWithoutExplicitConflictOmitted": sum(len(item["supportedWithoutExplicitConflictOmissions"]) for item in labeled),
            "returnedReferenceExplicitConflicts": sum(len(item["returnedReferenceExplicitConflictIds"]) for item in labeled),
            "modelTargetConflictAssessments": sum(len(item["modelTargetConflictIds"]) for item in labeled),
            "modelRegionConflictAssessments": sum(len(item["modelRegionConflictIds"]) for item in labeled),
        },
        "fundsRepeat": compare_pair(observations.get(("FUNDS", 1)), observations.get(("FUNDS", 2))),
    }, observations


def build_report(output_root, reference):
    if reference["provenance"]["humanReviewed"] is not False or reference["provenance"]["status"] != "AI_DRAFT_NOT_HUMAN_GROUND_TRUTH":
        raise ReportInputError("reference provenance changed")
    phases, observations = {}, {}
    for phase in PHASES:
        phases[phase], observations[phase] = summarize_phase(output_root / phase, phase, reference)
    provenances = {phase["provenance"] for phase in phases.values() if "provenance" in phase}
    if len(provenances) > 1:
        raise ReportInputError("mock and live phases cannot be mixed")
    if len({phase["requestSha256"] for phase in phases.values() if "requestSha256" in phase}) > 1:
        raise ReportInputError("fixed requests differ between phases")
    comparisons = {}
    for before_phase, after_phase in (("baseline", "compact"), ("baseline", "fast"), ("compact", "fast")):
        pairs = [{"caseId": case, "repetition": repetition,
                  **compare_pair(observations[before_phase].get((case, repetition)), observations[after_phase].get((case, repetition)))}
                 for case, repetition in PLAN]
        valid = [pair for pair in pairs if pair["comparedAssessmentCount"] == 20]
        comparisons[f"{before_phase}_to_{after_phase}"] = {
            "plannedPairs": 6, "bothSuccessfulPairs": len(valid), "pairs": pairs,
            "beforePairedSuccessLatencySeconds": stats([pair["beforeElapsedSeconds"] for pair in valid]),
            "afterPairedSuccessLatencySeconds": stats([pair["afterElapsedSeconds"] for pair in valid]),
            "pairedLatencyDifferenceSeconds": stats([pair["elapsedDifferenceSeconds"] for pair in valid]),
            "comparedAssessmentCount": 20 * len(valid), "changedAssessmentCount": sum(pair["changedAssessmentCount"] for pair in valid),
            "identicalFinalOrderPairs": sum(pair["finalOrderIdentical"] for pair in valid),
        }
    return {
        "schemaVersion": "govbiz-search-latency-comparison-v1", "generatedAt": datetime.now(timezone.utc).isoformat(),
        "status": "complete" if all(phase["status"] in {"completed", "failed"} for phase in phases.values()) else "partial",
        "provenance": next(iter(provenances), "not_started"), "externalApiCallsByThisTool": 0,
        "reference": {"status": "AI_DRAFT_NOT_HUMAN_GROUND_TRUTH", "humanReviewed": False, "sha256": sha(reference),
                      "eligibilityLabelGranularity": "combined; no separate target or region ground truth",
                      "paraphraseMapping": "FUNDS_PARAPHRASE reuses FUNDS by purpose; BROAD remains unlabeled"},
        "limitations": [
            "Five fixed questions and one repeat, using a previously selected 20-candidate pool; no full-search Recall/MRR or end-to-end latency.",
            "AI_DRAFT labels are not human truth. Uncertain and unlabeled entries are never counted as incorrect.",
            "Supported labels concern relevance; explicit eligibility conflicts and unknown eligibility are reported separately.",
            "Target/region conflicts against the reference's combined unknown are review flags, not independently labeled target/region errors.",
            "Latency medians over successes exclude failures and always include their denominator. Paired comparisons use only shared successful cases.",
            "Missing response receipts leave token usage unknown; token totals cover only received receipts and do not estimate failed-call charges.",
            "Sequential phases, input caching and a single repetition do not establish statistical superiority or production p95.",
        ],
        "phases": phases, "comparisons": comparisons,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    source = ROOT / ("offline-output" if args.offline else "output")
    target = args.output or ROOT / ("offline-report.json" if args.offline else "report.json")
    report = build_report(source, read(REFERENCE_FILE))
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": report["status"], "provenance": report["provenance"],
                      "externalApiCalls": 0, "output": str(target)}))
