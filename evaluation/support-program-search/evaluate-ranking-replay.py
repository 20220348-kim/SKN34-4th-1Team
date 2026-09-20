#!/usr/bin/env python3
"""Diagnose saved ranking replays on fixed candidates and frozen reviewed pairs, offline."""

import argparse
import csv
import hashlib
import importlib.util
import json
import re
from pathlib import Path


SPEC = importlib.util.spec_from_file_location(
    "ranking_replay_comparison", Path(__file__).with_name("compare-captures.py"),
)
comparison = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(comparison)

INPUT_SCHEMA_VERSION = "support-program-ranking-replay-input-v1"
REPORT_SCHEMA_VERSION = "support-program-ranking-replay-diagnostic-v1"
VARIANTS = ("before", "after")
METRICS = ("knownPositiveCandidateRetention", "knownNegativeSelectionRate")


def canonical_sha256(value):
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def require_hash(value, description):
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise ValueError(f"{description} must be a lowercase SHA-256 string")


def require_object(value, description):
    if not isinstance(value, dict):
        raise ValueError(f"{description} must be an object")


def reject_nonfinite(value):
    raise ValueError(f"Nonfinite JSON number: {value}")


def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"), parse_constant=reject_nonfinite)


def validate_requests(envelope, fixture, source_capture_path):
    """Verify replay identity and candidate order against the original capture."""
    require_object(envelope, "Replay requests")
    if envelope.get("schemaVersion") != INPUT_SCHEMA_VERSION:
        raise ValueError("Unsupported ranking replay input schema")
    require_hash(envelope.get("sourceCaptureSha256"), "sourceCaptureSha256")
    if envelope["sourceCaptureSha256"] != comparison.sha256_path(source_capture_path):
        raise ValueError("sourceCaptureSha256 does not match the source capture")
    capture = load_json(source_capture_path)
    stages = comparison.validate_capture(capture, fixture, fixture["cases"])
    for field in ("referenceDate", "catalog"):
        if envelope.get(field) != capture[field]:
            raise ValueError(f"Replay {field} does not match source capture and fixture")
    observations = {item["id"]: item for item in capture["observations"]}
    cases = {case["id"]: case for case in fixture["cases"]}
    queries = envelope.get("queries")
    if not isinstance(queries, list) or not queries:
        raise ValueError("Replay queries must be a nonempty list")
    requests = {}
    for query in queries:
        require_object(query, "Replay query")
        query_id = query.get("id")
        if not isinstance(query_id, str) or query_id not in cases:
            raise ValueError("Replay has an unknown query ID")
        if query_id in requests:
            raise ValueError(f"Duplicate replay query: {query_id}")
        case, observation = cases[query_id], observations.get(query_id)
        if observation is None or query.get("split") != case["split"]:
            raise ValueError(f"Replay query split or source observation mismatch: {query_id}")
        request = query.get("request")
        require_object(request, f"Request for {query_id}")
        if request.get("originalQuery") != case["query"]:
            raise ValueError(f"Replay originalQuery does not match fixture: {query_id}")
        if request.get("scoringVersion") != capture["search"]["scoringVersion"]:
            raise ValueError(f"Replay scoringVersion does not match source capture: {query_id}")
        limit = request.get("resultLimit")
        if type(limit) is not int or limit != capture["search"]["finalResultLimit"]:
            raise ValueError(f"Replay resultLimit does not match source capture: {query_id}")
        candidates = request.get("candidates")
        if not isinstance(candidates, list) or not candidates:
            raise ValueError(f"Request candidates must be a nonempty list: {query_id}")
        for candidate in candidates:
            require_object(candidate, f"Candidate for {query_id}")
        ids = [candidate.get("id") for candidate in candidates]
        if ids != stages["candidate"][query_id]:
            raise ValueError(f"Request candidate IDs or order differ from source capture: {query_id}")
        # Hash the full original request, including candidate text and ordering.
        canonical_sha256(request)
        requests[query_id] = request
    return requests


def load_results(path, requests):
    """Validate identities and final membership; production validates score contracts."""
    results, prompts = {query_id: {} for query_id in requests}, {}
    with Path(path).open(encoding="utf-8") as file:
        for line_number, line in enumerate(file, 1):
            if not line.strip():
                continue
            row = json.loads(line, parse_constant=reject_nonfinite)
            require_object(row, f"Result line {line_number}")
            query_id, variant = row.get("queryId"), row.get("variant")
            if not isinstance(query_id, str) or query_id not in requests:
                raise ValueError(f"Unknown result queryId on line {line_number}")
            if variant not in VARIANTS:
                raise ValueError(f"Invalid result variant for {query_id}")
            if variant in results[query_id]:
                raise ValueError(f"Duplicate result for {query_id}/{variant}")
            request = requests[query_id]
            if row.get("requestSha256") != canonical_sha256(request):
                raise ValueError(f"Result requestSha256 mismatch for {query_id}/{variant}")
            prompt_hash = row.get("promptSha256")
            require_hash(prompt_hash, "promptSha256")
            if variant in prompts and prompts[variant] != prompt_hash:
                raise ValueError(f"Different promptSha256 values within {variant} variant")
            prompts[variant] = prompt_hash
            response = row.get("response")
            require_object(response, f"Response for {query_id}/{variant}")
            for field in ("originalQuery", "scoringVersion"):
                if response.get(field) != request[field]:
                    raise ValueError(f"Response {field} mismatch for {query_id}/{variant}")
            rankings = response.get("rankings")
            if not isinstance(rankings, list):
                raise ValueError(f"Response rankings must be a list: {query_id}/{variant}")
            if len(rankings) > request["resultLimit"]:
                raise ValueError(f"Response exceeds resultLimit: {query_id}/{variant}")
            candidate_ids = {candidate["id"] for candidate in request["candidates"]}
            final_ids = []
            for ranking in rankings:
                require_object(ranking, f"Ranking for {query_id}/{variant}")
                program_id = ranking.get("programId")
                if not isinstance(program_id, str) or program_id not in candidate_ids:
                    raise ValueError(f"Unknown final programId: {query_id}/{variant}")
                if program_id in final_ids:
                    raise ValueError(f"Duplicate final programId: {query_id}/{variant}")
                final_ids.append(program_id)
            results[query_id][variant] = final_ids
    for query_id, variants in results.items():
        if set(variants) != set(VARIANTS):
            raise ValueError(f"Missing before or after result for {query_id}")
    return results, prompts


def classify(ids, decisions):
    return {
        "programIds": ids,
        "count": len(ids),
        "knownRelevantIds": [pid for pid in ids if decisions.get(pid) == "relevant"],
        "knownIrrelevantIds": [pid for pid in ids if decisions.get(pid) == "irrelevant"],
        "unjudged": comparison.unjudged(ids, decisions),
        "knownRelevantCount": sum(decisions.get(pid) == "relevant" for pid in ids),
        "knownIrrelevantCount": sum(decisions.get(pid) == "irrelevant" for pid in ids),
        "unjudgedCount": sum(decisions.get(pid) not in {"relevant", "irrelevant"} for pid in ids),
    }


def ratios(final, candidates):
    return {
        metric: final[field] / candidates[field] if candidates[field] else None
        for metric, field in zip(METRICS, ("knownRelevantCount", "knownIrrelevantCount"))
    }


def split_report(queries):
    fields = ("count", "knownRelevantCount", "knownIrrelevantCount", "unjudgedCount")
    candidates = {field: sum(query["fixedCandidates"][field] for query in queries) for field in fields}
    report = {
        "queryIds": [query["queryId"] for query in queries],
        "queryCount": len(queries),
        "officialExcludedQueryIds": [query["queryId"] for query in queries if query["officialStatus"] == "excluded"],
        "fixedCandidateCounts": candidates,
    }
    for variant in VARIANTS:
        counts = {field: sum(query[variant]["final"][field] for query in queries) for field in fields}
        report[variant] = {"finalCounts": counts, **ratios(counts, candidates)}
    report["delta"] = {
        metric: report["after"][metric] - report["before"][metric]
        if report["before"][metric] is not None else None for metric in METRICS
    }
    return report


def evaluate_ranking_replay(fixture_path, reviewed_path, requests_path, results_path, source_capture_path):
    fixture = comparison.load_fixture(fixture_path)
    decisions, review_summary = comparison.load_reviews(reviewed_path, fixture)
    envelope = load_json(requests_path)
    requests = validate_requests(envelope, fixture, source_capture_path)
    results, prompts = load_results(results_path, requests)
    per_query = []
    for case in fixture["cases"]:
        query_id = case["id"]
        if query_id not in requests:
            continue
        candidates = classify([candidate["id"] for candidate in requests[query_id]["candidates"]], decisions[query_id])
        query = {
            "queryId": query_id, "query": case["query"], "split": case["split"],
            "officialStatus": "excluded" if case["relevantIds"] is None else "positive" if case["relevantIds"] else "no_match",
            "relevantIds": case["relevantIds"],
            "requestSha256": canonical_sha256(requests[query_id]),
            "fixedCandidates": candidates,
        }
        for variant in VARIANTS:
            final = classify(results[query_id][variant], decisions[query_id])
            query[variant] = {"final": final, **ratios(final, candidates)}
        per_query.append(query)
    selected_cases = [case for case in fixture["cases"] if case["id"] in requests]
    return {
        "schemaVersion": REPORT_SCHEMA_VERSION,
        "diagnosticScope": "frozen reviewed query/program pairs within fixed replay candidates",
        "fixture": fixture["name"], "dataType": fixture["dataType"],
        "referenceDate": envelope["referenceDate"], "catalog": envelope["catalog"],
        "sourceHashes": {
            "fixtureSha256": comparison.sha256_path(fixture_path),
            "reviewedCsvSha256": comparison.sha256_path(reviewed_path),
            "requestsSha256": comparison.sha256_path(requests_path),
            "resultsSha256": comparison.sha256_path(results_path),
            "sourceCaptureSha256": comparison.sha256_path(source_capture_path),
            "diagnosticScriptSha256": comparison.sha256_path(__file__),
            "comparisonScriptSha256": comparison.sha256_path(Path(__file__).with_name("compare-captures.py")),
            "evaluatorScriptSha256": comparison.sha256_path(Path(__file__).with_name("evaluate.py")),
        },
        "promptSha256": prompts,
        "sourceCaptureVerified": True,
        "omittedQueryIds": [case["id"] for case in fixture["cases"] if case["id"] not in requests],
        "labelReference": comparison.label_reference_report(fixture, selected_cases),
        "reviewedCsv": review_summary,
        "metricDefinitions": {
            "knownPositiveCandidateRetention": "known relevant final pairs / known relevant fixed candidate pairs",
            "knownNegativeSelectionRate": "known irrelevant final pairs / known irrelevant fixed candidate pairs",
            "aggregation": "Ratio of summed pair counts within each split, with the same candidate denominator for before and after; zero denominators yield null.",
        },
        "limitations": [
            "These are diagnostics on already judged pairs, not population precision or official overall Recall.",
            "Blank, unclear and missing judgments remain unjudged, never negative; labels and official query exclusions are unchanged.",
            "Known-pair diagnostics include officially excluded queries when replayed; they do not reinstate those queries in official metrics.",
            "Input candidate identity and order match the saved source capture. Both variants use the same full request hash.",
            "Replay responses must already pass production Pydantic validation. This offline tool checks basic structure and identities, not every AI score rule.",
            "Repeated heldout comparisons are regression checks, not fresh independent generalization evidence.",
        ],
        "splits": {split: split_report([query for query in per_query if split == "all" or query["split"] == split])
                   for split in ("dev", "heldout", "all")},
        "perQuery": per_query,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ("fixture", "reviewed-csv", "requests", "results", "source-capture", "output"):
        parser.add_argument(f"--{option}", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        if args.output.exists() or args.output.is_symlink():
            raise FileExistsError(f"Diagnostic output already exists: {args.output}")
        report = evaluate_ranking_replay(args.fixture, args.reviewed_csv, args.requests, args.results, args.source_capture)
        encoded = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("x", encoding="utf-8") as file:
            file.write(encoded)
    except (OSError, ValueError, KeyError, TypeError, csv.Error) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
