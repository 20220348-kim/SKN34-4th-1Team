#!/usr/bin/env python3
"""Extend the frozen 100-question local-only diagnostic to 300; keep prior artifacts immutable."""

import argparse
import hashlib
import importlib.util
import json
import sys
import uuid
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

RUN = Path(__file__).resolve().parent
BASE = RUN.parent / "candidate-budget-100-20260913-v1"
ADDED = RUN / "questions-added.json"
SCHEMA = "govbiz-known-item-300-budget-report-v1"
module_spec = importlib.util.spec_from_file_location("budget_100", BASE / "compare.py")
base = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(base)


def load_inputs():
    fixture, original, original_cases = base.load_inputs()
    extension = json.loads(ADDED.read_text(encoding="utf-8"))
    provenance = extension["provenance"]
    if (extension.get("schemaVersion") != "govbiz-known-item-200-extension-v1"
            or extension.get("fixtureSha256") != base.sha256(base.FIXTURE)
            or extension.get("baseQuestionsSha256") != base.sha256(base.QUESTIONS)
            or provenance.get("author") != "ai" or provenance.get("humanReviewed") is not False
            or provenance.get("purpose") != original["provenance"]["purpose"]):
        raise ValueError("Extension must bind the fixed fixture/base questions and retain AI-only provenance")
    if len(extension["cases"]) != 200:
        raise ValueError("Require exactly 200 additional cases")
    if any(set(case) != {"targetId", "query", "evidenceQuote"} for case in extension["cases"]):
        raise ValueError("Unexpected added question fields")
    cases = original_cases + [{"id": f"Q{i:03}", **case} for i, case in enumerate(extension["cases"], 101)]
    docs = {doc["id"]: doc for doc in fixture["docs"]}
    previous = json.loads(base.PREVIOUS.read_text(encoding="utf-8"))
    excluded = {group["targetId"] for group in previous["groups"]}
    seed = original["provenance"]["selectionSeed"]
    selected = sorted((identifier for identifier in docs if identifier not in excluded), key=lambda identifier:
        hashlib.sha256((seed + identifier).encode("utf-8")).hexdigest())[:300]
    if [case["targetId"] for case in cases] != selected:
        raise ValueError("Targets differ from the original seed's first 300 notices")
    old_queries = {query for group in previous["groups"] for query in group["queries"].values()}
    old_queries.update(case["query"] for case in fixture["cases"])
    if len({case["query"] for case in cases}) != 300:
        raise ValueError("Require 300 distinct questions")
    for case in cases:
        query, quote = case["query"], case["evidenceQuote"]
        if (not isinstance(query, str) or not query.strip() or query != query.strip() or len(query) > 500
                or query in old_queries or case["targetId"].split(":", 1)[1] in query
                or not isinstance(quote, str) or len(quote.strip()) < 10 or quote not in docs[case["targetId"]]["text"]):
            raise ValueError(f"Invalid or ungrounded question {case['id']}")
    return fixture, {"base": original["provenance"], "extension": provenance}, cases


def metadata(fixture, provenance, cases):
    sources = [Path(__file__).resolve(), ADDED, BASE / "compare.py", base.QUESTIONS,
               base.FIXTURE, base.PREVIOUS, base.CONFIG, base.ROOT / "compare_elasticsearch.py",
               base.ROOT / "evaluate.py", base.ROOT / "elasticsearch/compose.yaml", base.ROOT / "elasticsearch/Dockerfile"]
    return {
        "sourceSha256": {str(path.relative_to(base.PROJECT)): base.sha256(path) for path in sources},
        "fixtureSha256": base.sha256(base.FIXTURE), "baseQuestionsSha256": base.sha256(base.QUESTIONS),
        "addedQuestionsSha256": base.sha256(ADDED),
        "combinedCasesSha256": hashlib.sha256(json.dumps(cases, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest(),
        "referenceDate": fixture["referenceDate"], "catalog": fixture["catalog"], "provenance": provenance,
        "baseQuestionCount": 100, "additionalQuestionCount": 200, "questionCount": 300,
        "indexDefinition": json.loads(base.CONFIG.read_text(encoding="utf-8")),
        "search": {"field": "text", "cutoffs": list(base.CUTOFFS), "passes": base.PASSES,
                   "bodies": {str(k): base.lexical.search_body("text", "<query>", k) for k in base.CUTOFFS}},
        "externalApiCalls": 0, "modelApiCalls": 0, "embeddingApiCalls": 0,
        "localElasticsearchSearchCalls": len(cases) * len(base.CUTOFFS) * base.PASSES,
    }


def summaries(fixture, cases, candidates, timings):
    docs = {doc["id"]: doc for doc in fixture["docs"]}
    groups = {"all300": cases, "previous100": cases[:100], "new200": cases[100:]}
    # Validate the full result first so unknown/extra question IDs cannot disappear during grouping.
    overall = base.summarize(cases, candidates, docs, timings)
    result = {"all300": overall}
    for name, subset in groups.items():
        if name == "all300":
            continue
        ids = {case["id"] for case in subset}
        result[name] = base.summarize(subset, {key: value for key, value in candidates.items() if key in ids},
                                      docs, [item for item in timings if item["queryId"] in ids])
    return result


def run():
    fixture, provenance, cases = load_inputs()
    inputs = metadata(fixture, provenance, cases)
    client = base.lexical.LocalElasticsearch("http://127.0.0.1:19200")
    engine = client.verify_cluster()
    index = "govbiz-lexical-" + uuid.uuid4().hex
    base.lexical.index_snapshot(client, index, fixture["docs"], inputs["indexDefinition"])
    docs = {doc["id"]: doc for doc in fixture["docs"]}
    hashes = {identifier: doc["contentHash"] for identifier, doc in docs.items()}
    candidates = {case["id"]: {} for case in cases}
    timings = []
    for repeat in range(base.PASSES):
        for number, case in enumerate(cases):
            for k in base.CUTOFFS if (number + repeat) % 2 == 0 else reversed(base.CUTOFFS):
                ids, timing = base.lexical.search(client, index, "text", case["query"], k, hashes)
                if repeat and ids != candidates[case["id"]][str(k)]:
                    raise ValueError("Candidate order changed across repeated searches")
                candidates[case["id"]][str(k)] = ids
                timings.append({"queryId": case["id"], "k": k, "pass": repeat, **timing})
            if (number + 1) % 100 == 0:
                print(f"Pass {repeat + 1}/{base.PASSES}: {number + 1}/300 questions x 2 sizes", flush=True)
    return {
        "schemaVersion": SCHEMA, "status": "complete", "createdAt": datetime.now(timezone.utc).isoformat(),
        **inputs, "engine": engine, "index": index, "candidateIds": candidates, "timings": timings,
        "summaries": summaries(fixture, cases, candidates, timings),
        "targetCategoryCounts": dict(Counter(next(line.removeprefix("분야: ") for line in docs[case["targetId"]]["text"].splitlines() if line.startswith("분야: ")) for case in cases)),
        "limitations": [
            "300 distinct notices includes the prior 100; only 200 questions are new. Related notices remain correlated.",
            "AI-authored source-conditioned known-item questions, not human-reviewed or exhaustive relevance judgments.",
            "Fixed historical BIZINFO snapshot; no fresh catalog, negative queries or eligibility evaluation.",
            "Only Nori lexical retrieval; no Qdrant/RRF/LLM ranking/company-condition extraction or production calls.",
            "Target Hit/MRR is not overall Recall/Precision or final recommendation accuracy.",
            "Sequential local first/warm timings exclude production filters/aggregations and are not end-to-end latency.",
            "Retrieval-document characters are not model tokens, payload bytes, cost or latency savings.",
        ],
    }


def verify(report):
    fixture, provenance, cases = load_inputs()
    if (report.get("schemaVersion") != SCHEMA or report.get("status") != "complete"
            or any(report.get(key) != value for key, value in metadata(fixture, provenance, cases).items())):
        raise ValueError("Report differs from frozen inputs or source code")
    if report["summaries"] != summaries(fixture, cases, report["candidateIds"], report["timings"]):
        raise ValueError("Report metrics cannot be reproduced")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--output", type=Path)
    action.add_argument("--verify-report", type=Path)
    args = parser.parse_args()
    sys.addaudithook(base.restrict_network)
    if args.verify_report:
        verify(json.loads(args.verify_report.read_text(encoding="utf-8")))
        print("300-question inputs, groups and metrics verified offline; not a relevance/authenticity certification.")
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
