#!/usr/bin/env python3
"""Compare two saved captures against one frozen reviewed fixture, without model calls."""

import argparse
import csv
import hashlib
import json
from pathlib import Path

from evaluate import (
    evaluate_final_results,
    evaluate_results,
    label_reference_report,
    load_fixture,
    validate_capture,
)


DECISIONS = {"relevant", "irrelevant", "unclear", ""}
METRICS = ("candidateRecallAt20", "finalRecallAt5", "mrrAt5")


def sha256_path(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load_reviews(path, fixture):
    """Keep unresolved and absent judgments distinct from explicit negative judgments."""
    cases = {case["id"]: case for case in fixture["cases"]}
    known_docs = {doc["id"] for doc in fixture["docs"]}
    decisions = {query_id: {} for query_id in cases}
    with Path(path).open(encoding="utf-8-sig", newline="") as file:
        reader = csv.DictReader(file)
        columns = reader.fieldnames or []
        required = {"query_id", "split", "query", "program_id", "decision"}
        if len(set(columns)) != len(columns) or not required <= set(columns):
            raise ValueError("Reviewed CSV requires unique query_id, split, query, program_id, decision columns")
        row_count = 0
        for row in reader:
            row_count += 1
            if None in row or any(value is None for value in row.values()):
                raise ValueError("Reviewed CSV row does not match its columns")
            query_id, program_id = row["query_id"], row["program_id"]
            case = cases.get(query_id)
            if case is None or row["query"] != case["query"] or row["split"] != case["split"]:
                raise ValueError("Reviewed CSV query identity or split does not match the fixture")
            if program_id not in known_docs:
                raise ValueError(f"Reviewed CSV has an unknown program ID: {program_id}")
            if program_id in decisions[query_id]:
                raise ValueError(f"Duplicate reviewed query/program pair: {query_id}/{program_id}")
            decision = row["decision"].strip()
            if decision not in DECISIONS:
                raise ValueError(f"Invalid reviewed decision for {query_id}/{program_id}")
            decisions[query_id][program_id] = decision

    review = fixture.get("labelReview") or {}
    # apply-labels.py records the selected reviewed.csv as reviewPoolSha256.
    expected_hash = review.get("sourceHashes", {}).get("reviewPoolSha256")
    if review.get("schemaVersion") is not None and expected_hash is None:
        raise ValueError("Explicit label review requires a linked CSV reviewPoolSha256")
    if expected_hash is not None and sha256_path(path) != expected_hash:
        raise ValueError("Reviewed CSV SHA-256 does not match fixture labelReview.sourceHashes.reviewPoolSha256")
    expected_count = review.get("counts", {}).get("reviewRowCount")
    if expected_count is not None and row_count != expected_count:
        raise ValueError("Reviewed CSV row count does not match the fixture label review")
    for query_id, case in cases.items():
        if case["relevantIds"] is None:
            continue
        reviewed = decisions[query_id]
        positive_ids = {program_id for program_id, decision in reviewed.items() if decision == "relevant"}
        if not reviewed or positive_ids != set(case["relevantIds"]):
            raise ValueError(f"Reviewed relevantIds do not match the frozen fixture for {query_id}")
    return decisions, {"rowCount": row_count, "fixtureHashField": "reviewPoolSha256" if expected_hash else None,
                       "fixtureHashVerified": expected_hash is not None}


def unjudged(ids, decisions):
    return [
        {"programId": program_id, "decision": decisions.get(program_id, "missing") or "blank"}
        for program_id in ids
        if decisions.get(program_id) not in {"relevant", "irrelevant"}
    ]


def query_result(case, stages, decisions):
    query_id = case["id"]
    if query_id not in stages["candidate"]:
        # The existing evaluator allows missing observations only for excluded queries.
        return {"observed": False}
    candidates, final = stages["candidate"][query_id], stages["final"][query_id]
    relevant = case["relevantIds"]
    result = {
        "observed": True,
        "candidateIds": candidates,
        "finalProgramIds": final,
        "candidateUnjudged": unjudged(candidates, decisions),
        "finalUnjudged": unjudged(final, decisions),
        "candidateRecallAt20": None,
        "finalRecallAt5": None,
        "mrrAt5": None,
        "noMatchStatus": None,
    }
    if relevant:
        candidate_report = evaluate_results([case], {query_id: candidates}, 20)
        final_report = evaluate_final_results([case], {query_id: final})
        result.update(candidateRecallAt20=candidate_report["macroRecallAtK"],
                      finalRecallAt5=final_report["macroRecallAt5"], mrrAt5=final_report["mrrAt5"])
    elif relevant == []:
        result["noMatchStatus"] = (
            "empty_result" if not final else "unjudged_final_returned" if result["finalUnjudged"]
            else "reviewed_irrelevant_returned"
        )
    return result


def split_report(cases, stages, decisions):
    positive = [case for case in cases if case["relevantIds"]]
    no_match = [case for case in cases if case["relevantIds"] == []]
    report = {
        "positiveQueryIds": [case["id"] for case in positive],
        "positiveQueryCount": len(positive),
        "relevantDocumentCount": sum(len(case["relevantIds"]) for case in positive),
        "noMatchQueryIds": [case["id"] for case in no_match],
        "noMatchQueryCount": len(no_match),
        "excludedQueryIds": [case["id"] for case in cases if case["relevantIds"] is None],
        "before": {}, "after": {}, "delta": {},
    }
    for name, results in stages.items():
        candidate = evaluate_results(positive, results["candidate"], 20)
        final = evaluate_final_results(positive, results["final"])
        returned = [case["id"] for case in no_match if results["final"][case["id"]]]
        unresolved = [case["id"] for case in no_match
                      if unjudged(results["final"][case["id"]], decisions[case["id"]])]
        known_irrelevant = [case["id"] for case in no_match if any(
            decisions[case["id"]].get(program_id) == "irrelevant"
            for program_id in results["final"][case["id"]]
        )]
        nonempty_rate = len(returned) / len(no_match) if no_match else None
        report[name] = {
            "candidateRecallAt20": candidate["macroRecallAtK"],
            "finalRecallAt5": final["macroRecallAt5"],
            "mrrAt5": final["mrrAt5"],
            "noMatch": {
                "returnedQueryIds": returned,
                "knownIrrelevantFinalQueryIds": known_irrelevant,
                "unjudgedFinalQueryIds": unresolved,
                "pooledNonemptyResultRate": nonempty_rate,
                "noMatchFalsePositiveRate": None if unresolved else nonempty_rate,
            },
        }
    for metric in METRICS:
        before, after = report["before"][metric], report["after"][metric]
        report["delta"][metric] = None if before is None or after is None else after - before
    return report


def compare(fixture_path, before_path, after_path, reviewed_path):
    fixture = load_fixture(fixture_path)
    captures = {"before": json.loads(Path(before_path).read_text(encoding="utf-8")),
                "after": json.loads(Path(after_path).read_text(encoding="utf-8"))}
    stages = {name: validate_capture(capture, fixture, fixture["cases"])
              for name, capture in captures.items()}
    before, after = captures["before"], captures["after"]
    for field in ("catalog", "referenceDate", "querySet", "acceptingOnly"):
        if before[field] != after[field]:
            raise ValueError(f"Before and after {field} must match")
    for field in ("candidateLimit", "finalResultLimit"):
        if before["search"][field] != after["search"][field]:
            raise ValueError(f"Before and after search.{field} must match")
    if before["search"]["candidateLimit"] < 20:
        raise ValueError("Candidate Recall@20 requires candidateLimit >= 20")
    decisions, review_summary = load_reviews(reviewed_path, fixture)
    return {
        "schemaVersion": "support-program-search-comparison-v1",
        "fixture": fixture["name"],
        "dataType": fixture["dataType"],
        "referenceDate": before["referenceDate"],
        "catalog": before["catalog"],
        "querySet": before["querySet"],
        "acceptingOnly": before["acceptingOnly"],
        "captures": {name: {"capturedAt": capture["capturedAt"], "search": capture["search"]}
                     for name, capture in captures.items()},
        "sourceHashes": {
            "fixtureSha256": sha256_path(fixture_path),
            "beforeCaptureSha256": sha256_path(before_path),
            "afterCaptureSha256": sha256_path(after_path),
            "reviewedCsvSha256": sha256_path(reviewed_path),
            "comparisonScriptSha256": sha256_path(__file__),
            "evaluatorScriptSha256": sha256_path(Path(__file__).with_name("evaluate.py")),
        },
        "labelReference": label_reference_report(fixture, fixture["cases"]),
        "reviewedCsv": review_summary,
        "limitations": [
            "Recall@20, Recall@5 and MRR@5 use the same frozen positive cases and pooled relevantIds in both captures.",
            "Blank, unclear and missing judgments remain unjudged, never negative. New results do not alter labels or exclusions.",
            "MRR uses original result positions, including unjudged results; it measures ranking of the frozen known positives.",
            "No-match nonempty-result rate is descriptive against the pool. False-positive rate is null if any no-match final result is unjudged.",
            "A repeated heldout comparison is a regression check, not evidence of fresh independent generalization.",
        ],
        "splits": {split: split_report(
            [case for case in fixture["cases"] if split == "all" or case["split"] == split], stages, decisions,
        ) for split in ("dev", "heldout", "all")},
        "perQuery": [
            {"queryId": case["id"], "query": case["query"], "split": case["split"],
             "status": "excluded" if case["relevantIds"] is None else "positive" if case["relevantIds"] else "no_match",
             "relevantIds": case["relevantIds"],
             **{name: query_result(case, results, decisions[case["id"]]) for name, results in stages.items()}}
            for case in fixture["cases"]
        ],
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ("fixture", "before", "after", "reviewed-csv", "output"):
        parser.add_argument(f"--{option}", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        if args.output.exists() or args.output.is_symlink():
            raise FileExistsError(f"Comparison output already exists: {args.output}")
        report = compare(args.fixture, args.before, args.after, args.reviewed_csv)
        encoded = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("x", encoding="utf-8") as file:
            file.write(encoded)
    except (OSError, ValueError, KeyError, TypeError, csv.Error) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
