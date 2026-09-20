#!/usr/bin/env python3
"""Compare frozen v1/v2 lexical definitions locally; no application or model API calls."""

import argparse
import hashlib
import importlib.util
import json
import math
import statistics
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

from metric_comparison import metrics_match

ROOT = Path(__file__).resolve().parent
PROJECT = ROOT.parent.parent
RUN = ROOT / "runs/lexical-v2-20260913-v1"
ADDED = RUN / "questions-added.json"
BUDGET = ROOT / "runs/candidate-budget-300-20260913-v1"
spec = importlib.util.spec_from_file_location("budget300", BUDGET / "compare.py")
budget = importlib.util.module_from_spec(spec)
spec.loader.exec_module(budget)
base = budget.base
CONFIGS = {name: PROJECT / f"backend/core-service/src/main/resources/elasticsearch/support-program-lexical-{name}.json"
           for name in ("v1", "v2")}
SCHEMA = "govbiz-lexical-v2-comparison-v1"
PASSES = 2  # First pass and one warm repeat; not a load or end-to-end latency test.
# The saved capture predates tolerant metric verification. Accept this exact
# verifier revision as well as the current one, without relaxing other hashes.
CAPTURE_COMPARISON_SHA256 = "a0bb8927617845a6567d878a811383168c5c1ce13e1932f5854814b69d16c900"


def load_inputs():
    fixture, _, cases = budget.load_inputs()
    added = json.loads(ADDED.read_text(encoding="utf-8"))
    if (added.get("schemaVersion") != "govbiz-lexical-v2-new-questions-v1"
            or added.get("fixtureSha256") != base.sha256(base.FIXTURE)
            or added.get("provenance", {}).get("author") != "ai"
            or added["provenance"].get("humanReviewed") is not False
            or len(added["cases"]) != 16):
        raise ValueError("Require 16 source-grounded AI-only additional questions")
    docs = {doc["id"]: doc for doc in fixture["docs"]}
    original = json.loads(base.QUESTIONS.read_text(encoding="utf-8"))
    excluded = {group["targetId"] for group in json.loads(base.PREVIOUS.read_text(encoding="utf-8"))["groups"]}
    selected = sorted((key for key in docs if key not in excluded), key=lambda key:
        hashlib.sha256((original["provenance"]["selectionSeed"] + key).encode()).hexdigest())[300:316]
    if [case["targetId"] for case in added["cases"]] != selected:
        raise ValueError("Additional targets must follow the same predeclared hash order")
    additional = [{"id": f"N{i:03}", **case} for i, case in enumerate(added["cases"], 1)]
    for case in additional:
        query, quote = case["query"], case["evidenceQuote"]
        if (set(case) != {"id", "targetId", "query", "evidenceQuote"}
                or not isinstance(query, str) or not query.strip() or query != query.strip() or len(query) > 500
                or not isinstance(quote, str) or len(quote.strip()) < 10 or quote not in docs[case["targetId"]]["text"]
                or case["targetId"].split(":", 1)[1] in query):
            raise ValueError("Invalid additional query/evidence")
    combined = cases + additional
    if len({case["query"] for case in combined}) != 316:
        raise ValueError("Additional queries must be distinct")
    return fixture, combined, added["provenance"]


def metadata(fixture, cases, provenance):
    sources = [Path(__file__).resolve(), ROOT / "metric_comparison.py", ADDED, *CONFIGS.values(), base.FIXTURE, base.QUESTIONS,
               budget.ADDED, BUDGET / "compare.py", BUDGET / "report.json", base.RUN / "compare.py",
               ROOT / "compare_elasticsearch.py", ROOT / "evaluate.py",
               PROJECT / "backend/core-service/src/main/kotlin/ai/govbiz/core/supportprogram/client/elasticsearch/ElasticsearchSupportProgramClient.kt"]
    return {
        "sourceSha256": {path.relative_to(PROJECT).as_posix(): base.sha256(path) for path in sources},
        "catalog": fixture["catalog"], "referenceDate": fixture["referenceDate"],
        "additionalProvenance": provenance,
        "casesSha256": hashlib.sha256(json.dumps(cases, ensure_ascii=False, sort_keys=True).encode()).hexdigest(),
        "indexDefinitions": {name: json.loads(path.read_text(encoding="utf-8")) for name, path in CONFIGS.items()},
        "search": {"k": 20, "derivedCutoffs": [1, 5, 15, 20], "passes": PASSES,
                   "body": base.lexical.search_body("text", "<query>", 20)},
        "externalApiCalls": 0, "modelApiCalls": 0, "embeddingApiCalls": 0,
        "localElasticsearchSearchCalls": len(cases) * len(CONFIGS) * PASSES,
    }


def summarize(fixture, cases, candidates, timings):
    known_ids = {doc["id"] for doc in fixture["docs"]}
    case_ids = {case["id"] for case in cases}
    if set(candidates) != set(CONFIGS) or any(set(results) != case_ids for results in candidates.values()):
        raise ValueError("Capture both variants for every question")
    for results in candidates.values():
        for ids in results.values():
            if not isinstance(ids, list) or len(ids) > 20 or len(ids) != len(set(ids)) or not set(ids) <= known_ids:
                raise ValueError("Invalid candidate IDs")
    expected_timings = {(variant, case_id, repeat) for variant in CONFIGS for case_id in case_ids for repeat in range(PASSES)}
    if (len(timings) != len(expected_timings)
            or {(item["variant"], item["queryId"], item["pass"]) for item in timings} != expected_timings):
        raise ValueError("Require exactly one timing per variant/question/pass")
    for item in timings:
        for field in ("httpMs", "elasticsearchTookMs"):
            value = item[field]
            if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
                raise ValueError("Invalid timing")
    groups = {"existing300": cases[:300], "additional16": cases[300:]}
    summaries = {}
    for group, subset in groups.items():
        rows = []
        for case in subset:
            row = {"id": case["id"], "query": case["query"], "targetId": case["targetId"]}
            for variant in CONFIGS:
                ids = candidates[variant][case["id"]]
                row[variant] = ids.index(case["targetId"]) + 1 if case["targetId"] in ids else None
            rows.append(row)
        summaries[group] = {variant: {
            "hitCounts": {str(k): sum(row[variant] is not None and row[variant] <= k for row in rows) for k in (1, 5, 15, 20)},
            "mrr20": sum(1/row[variant] if row[variant] else 0 for row in rows)/len(rows),
        } for variant in CONFIGS}
        summaries[group].update({
            "questionCount": len(rows), "perQuery": rows,
            "recoveredAt20": [row["id"] for row in rows if row["v1"] is None and row["v2"] is not None],
            "lostAt20": [row["id"] for row in rows if row["v1"] is not None and row["v2"] is None],
            "rankRegressions": [row["id"] for row in rows if row["v1"] is not None and (row["v2"] is None or row["v2"] > row["v1"])],
        })
    summaries["timing"] = {variant: {
        str(repeat): statistics.median(item["httpMs"] for item in timings if item["variant"] == variant and item["pass"] == repeat)
        for repeat in range(PASSES)
    } for variant in CONFIGS}
    return summaries


def verify(report):
    fixture, cases, provenance = load_inputs()
    expected = metadata(fixture, cases, provenance)
    verifier_path = Path(__file__).resolve().relative_to(PROJECT).as_posix()
    if report.get("sourceSha256", {}).get(verifier_path) == CAPTURE_COMPARISON_SHA256:
        expected["sourceSha256"][verifier_path] = CAPTURE_COMPARISON_SHA256
        # The captured revision had no shared metric comparator.
        del expected["sourceSha256"][(ROOT / "metric_comparison.py").relative_to(PROJECT).as_posix()]
        # Keep the frozen capture's original path labels, but verify the hashes
        # against the files in today's source folder. Do not rewrite the report.
        expected["sourceSha256"] = {
            ("backend/core-api/" + path[len("backend/core-service/"):]
             if path.startswith("backend/core-service/") else path): digest
            for path, digest in expected["sourceSha256"].items()
        }
    if (report.get("schemaVersion") != SCHEMA or report.get("status") != "complete"
            or any(report.get(key) != value for key, value in expected.items())):
        raise ValueError("Report inputs/configuration/provenance changed")
    if not metrics_match(report["summaries"], summarize(fixture, cases, report["candidateIds"], report["timings"])):
        raise ValueError("Saved metrics cannot be reproduced")
    original = json.loads((BUDGET / "report.json").read_text(encoding="utf-8"))
    if any(report["candidateIds"]["v1"][case["id"]] != original["candidateIds"][case["id"]]["20"] for case in cases[:300]):
        raise ValueError("The fresh baseline differs from the original 300-question capture")


def run():
    fixture, cases, provenance = load_inputs()
    inputs = metadata(fixture, cases, provenance)
    client = base.lexical.LocalElasticsearch("http://127.0.0.1:19200")
    engine = client.verify_cluster()
    indices = {name: "govbiz-lexical-" + uuid.uuid4().hex for name in CONFIGS}
    for name in CONFIGS:
        base.lexical.index_snapshot(client, indices[name], fixture["docs"], inputs["indexDefinitions"][name])
    hashes = {doc["id"]: doc["contentHash"] for doc in fixture["docs"]}
    candidates = {name: {} for name in CONFIGS}
    timings = []
    for repeat in range(PASSES):
        for number, case in enumerate(cases):
            for name in CONFIGS if (number + repeat) % 2 == 0 else reversed(CONFIGS):
                ids, timing = base.lexical.search(client, indices[name], "text", case["query"], 20, hashes)
                if repeat and ids != candidates[name][case["id"]]:
                    raise ValueError("Repeated candidate order changed")
                candidates[name][case["id"]] = ids
                timings.append({"variant": name, "queryId": case["id"], "pass": repeat, **timing})
        print(f"Pass {repeat + 1}/{PASSES}: {len(cases)} questions x 2 variants", flush=True)
    return {"schemaVersion": SCHEMA, "status": "complete", "createdAt": datetime.now(timezone.utc).isoformat(),
            **inputs, "engine": engine, "indices": indices, "candidateIds": candidates, "timings": timings,
            "summaries": summarize(fixture, cases, candidates, timings),
            "limitations": [
                "AI-authored source-conditioned known-item diagnostic; no human or exhaustive relevance labels.",
                "The 300 cases were inspected during tuning. The additional 16 were authored after prototype selection, not a blind independent benchmark.",
                "Single fixed historical BIZINFO snapshot; no whole-catalog Recall/Precision or application eligibility claim.",
                "No Qdrant/RRF/LLM, production version-filter/aggregation overhead or final recommendation evaluation.",
                "Cutoffs below 20 are prefixes of an actual K=20 search, not separately measured K=15 latency.",
            ]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--output", type=Path)
    action.add_argument("--verify-report", type=Path)
    args = parser.parse_args()
    sys.addaudithook(base.restrict_network)
    if args.verify_report:
        verify(json.loads(args.verify_report.read_text(encoding="utf-8")))
        print("Frozen inputs and metrics verified offline; not a relevance or capture-authenticity certification.")
        return
    with args.output.open("x", encoding="utf-8") as target:
        try:
            report = run()
            verify(report)
        except Exception:
            json.dump({"schemaVersion": SCHEMA, "status": "failed"}, target)
            raise
        json.dump(report, target, ensure_ascii=False, indent=2)
        target.write("\n")
    print(json.dumps({group: {key: value for key, value in summary.items() if key != "perQuery"}
                      for group, summary in report["summaries"].items()}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
