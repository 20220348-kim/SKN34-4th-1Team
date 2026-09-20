#!/usr/bin/env python3
"""Check saved pre-filter regional assessments against synthetic labels, without API calls."""

import argparse
import copy
import importlib.util
import json
from pathlib import Path
from unicodedata import category


SPEC = importlib.util.spec_from_file_location(
    "region_ranking_replay", Path(__file__).with_name("evaluate-ranking-replay.py"),
)
replay = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(replay)

FIXTURE_SCHEMA = "support-program-region-eligibility-fixture-v1"
CAPTURE_SCHEMA = "support-program-region-eligibility-capture-v1"
REPORT_SCHEMA = "support-program-region-eligibility-report-v1"
SCORING_VERSION = "govbiz-support-program-ranking-v5"
LEGACY_SCORING_VERSION = "govbiz-support-program-ranking-v4"
ELIGIBILITIES = {"MATCH", "INCOMPATIBLE", "UNKNOWN"}
SOURCE_FIELDS = {"SUMMARY": "summary", "TARGET_DESCRIPTION": "targetDescription"}
LIMITATION = (
    "합성 개발 회귀 사례이며 실제 공고 정확도나 개선 전후 우열을 입증하지 않습니다. "
    "mock 결과는 평가기 동작만 검증합니다. live_openai 출처도 선언만으로 입증되지 않으며 "
    "별도 API 사용 기록과 실행 코드·프롬프트 해시를 대조해야 합니다."
)


def require_list(value, description):
    if not isinstance(value, list):
        raise ValueError(f"{description} must be an array")
    return value


def index_unique(values, key, description):
    indexed = {}
    for value in require_list(values, description):
        replay.require_object(value, description)
        identity = value.get(key)
        if not isinstance(identity, str) or not identity.strip() or identity in indexed:
            raise ValueError(f"{description} has a missing or duplicate {key}")
        indexed[identity] = value
    return indexed


def validate_fixture(fixture):
    replay.require_object(fixture, "Fixture")
    if fixture.get("schemaVersion") != FIXTURE_SCHEMA:
        raise ValueError("Unsupported regional fixture schema")
    if fixture.get("dataType") != "synthetic_development_regression_not_real_catalog":
        raise ValueError("Regional fixture must declare synthetic development data")
    candidates = index_unique(fixture.get("candidates"), "id", "Candidates")
    cases = index_unique(fixture.get("cases"), "id", "Cases")
    if not 1 <= len(candidates) <= 20 or not 1 <= len(cases) <= 3:
        raise ValueError("Fixture permits 1 to 20 candidates and 1 to 3 cases")
    for candidate in candidates.values():
        for source_field in SOURCE_FIELDS.values():
            if not isinstance(candidate.get(source_field), str) or not candidate[source_field].strip():
                raise ValueError("Candidate sources must be nonblank strings")
    for case in cases.values():
        if not isinstance(case.get("query"), str) or not case["query"].strip():
            raise ValueError("Case query must be nonblank")
        replay.require_object(case.get("companyConditions"), "Company conditions")
        if case["companyConditions"].get("referenceDate") != fixture.get("referenceDate"):
            raise ValueError("Company and fixture reference dates must agree")
        expected = case.get("expected")
        replay.require_object(expected, "Expected regional assessments")
        if set(expected) != set(candidates):
            raise ValueError("Every case must label every candidate exactly once")
        for identity, label in expected.items():
            replay.require_object(label, "Regional label")
            if label.get("eligibility") not in ELIGIBILITIES:
                raise ValueError("Invalid expected eligibility")
            evidence = label.get("requiredEvidence")
            if label["eligibility"] != "UNKNOWN" and evidence is None:
                raise ValueError("Known labels need a manually specified regional source clause")
            if evidence is not None:
                if not is_exact_evidence(evidence, candidates[identity]):
                    raise ValueError("Expected evidence must be an exact candidate source clause")
    return candidates, cases


def build_requests(fixture, scoring_version=SCORING_VERSION):
    """Return only production request fields; expected labels never enter model input."""
    if scoring_version not in {SCORING_VERSION, LEGACY_SCORING_VERSION}:
        raise ValueError("Unsupported regional scoring version")
    _, cases = validate_fixture(fixture)
    return [
        {"caseId": case["id"], "request": {
            "originalQuery": case["query"], "scoringVersion": scoring_version,
            "resultLimit": 5, "candidates": copy.deepcopy(fixture["candidates"]),
            "companyConditions": copy.deepcopy(case["companyConditions"]),
        }}
        for case in cases.values()
    ]


def is_exact_evidence(evidence, candidate):
    if not isinstance(evidence, dict) or set(evidence) != {"field", "quote"}:
        return False
    quote = evidence["quote"]
    return (
        isinstance(evidence["field"], str) and evidence["field"] in SOURCE_FIELDS
        and isinstance(quote, str) and bool(quote.strip()) and len(quote) <= 240
        and not any(category(character).startswith("C") for character in quote)
        and quote in candidate[SOURCE_FIELDS[evidence["field"]]]
    )


def evaluate(fixture, capture):
    candidates, cases = validate_fixture(fixture)
    replay.require_object(capture, "Capture")
    if capture.get("schemaVersion") != CAPTURE_SCHEMA:
        raise ValueError("Unsupported regional capture schema")
    fixture_hash = replay.canonical_sha256(fixture)
    if capture.get("fixtureSha256") != fixture_hash:
        raise ValueError("Capture fixture hash mismatch")
    provenance = capture.get("provenance")
    replay.require_object(provenance, "Capture provenance")
    if provenance.get("kind") not in {"mock", "live_openai"}:
        raise ValueError("Capture must explicitly declare mock or live_openai provenance")
    if provenance["kind"] == "live_openai":
        if not isinstance(provenance.get("model"), str) or not provenance["model"].strip():
            raise ValueError("Live capture must identify its model")
        replay.require_hash(provenance.get("promptSha256"), "Live promptSha256")
    observations = index_unique(capture.get("observations"), "caseId", "Observations")
    if set(observations) != set(cases):
        raise ValueError("Capture must contain every fixture case exactly once")
    # v4 captures predate the explicit field; preserve their original request hashes.
    scoring_version = capture.get("scoringVersion", LEGACY_SCORING_VERSION)
    requests = {row["caseId"]: row["request"] for row in build_requests(fixture, scoring_version)}
    rows = []
    for identity, case in cases.items():
        observation = observations[identity]
        if observation.get("requestSha256") != replay.canonical_sha256(requests[identity]):
            raise ValueError("Captured request identity, source, conditions or order changed")
        replay.require_object(observation.get("output"), "Pre-filter Agent output")
        assessments = index_unique(observation["output"].get("rankings"), "programId", "Rankings")
        if set(assessments) != set(candidates):
            raise ValueError("Capture must contain all pre-filter candidates, not final recommendations")
        for program_id, candidate in candidates.items():
            assessment = assessments[program_id].get("regionAssessment")
            replay.require_object(assessment, "Regional assessment")
            actual = assessment.get("eligibility")
            if actual not in ELIGIBILITIES:
                raise ValueError("Invalid observed eligibility")
            evidence = require_list(assessment.get("evidence"), "Regional evidence")
            expected = case["expected"][program_id]
            exact = len(evidence) <= 1 and all(is_exact_evidence(item, candidate) for item in evidence)
            if actual != "UNKNOWN" and not evidence:
                exact = False
            clause = expected.get("requiredEvidence")
            supported = clause is None or any(
                is_exact_evidence(item, candidate)
                and item["field"] == clause["field"] and clause["quote"] in item["quote"]
                for item in evidence
            )
            failures = []
            if actual != expected["eligibility"]:
                failures.append("ELIGIBILITY_MISMATCH")
            if not exact:
                failures.append("INVALID_EXACT_EVIDENCE")
            if not supported:
                failures.append("MISSING_REGIONAL_SOURCE_CLAUSE")
            rows.append({
                "caseId": identity, "programId": program_id,
                "expectedEligibility": expected["eligibility"], "actualEligibility": actual,
                "exactEvidence": exact, "regionalClauseSupported": supported,
                "passed": not failures, "failures": failures,
            })
    return {
        "schemaVersion": REPORT_SCHEMA, "fixtureSha256": fixture_hash,
        "scoringVersion": scoring_version,
        "provenance": copy.deepcopy(provenance), "provenanceVerified": False,
        "limitation": LIMITATION, "caseCount": len(cases), "assessmentCount": len(rows),
        "passedAssessments": sum(row["passed"] for row in rows),
        "passed": all(row["passed"] for row in rows), "perAssessment": rows,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, default=Path(__file__).with_name("region-eligibility-fixture.json"))
    parser.add_argument("--capture", type=Path, help="Saved restored Agent output for every candidate")
    args = parser.parse_args()
    try:
        fixture = replay.load_json(args.fixture)
        if args.capture is None:
            requests = build_requests(fixture)
            result = {"fixtureSha256": replay.canonical_sha256(fixture), "requests": requests,
                      "maximumPlannedRankingCalls": len(requests), "actualApiCalls": 0,
                      "limitation": LIMITATION}
        else:
            result = evaluate(fixture, replay.load_json(args.capture))
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if args.capture is not None and not result["passed"]:
            parser.exit(1)
    except (ValueError, TypeError, KeyError, OSError) as error:
        parser.exit(2, f"Regional evaluation failed ({type(error).__name__}); no API was called.\n")


if __name__ == "__main__":
    main()
