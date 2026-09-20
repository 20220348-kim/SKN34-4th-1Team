#!/usr/bin/env python3
"""Run-local Nori candidate budget diagnostic; never calls a model or application API."""

import argparse
import hashlib
import json
import math
import statistics
import sys
import uuid
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

RUN = Path(__file__).resolve().parent
ROOT = RUN.parent.parent
PROJECT = ROOT.parent.parent
sys.path.insert(0, str(ROOT))
import compare_elasticsearch as lexical

FIXTURE = ROOT / "runs/support-program-catalog-20260906-v1/review-final-v1/fixture-labeled.json"
PREVIOUS = ROOT / "runs/elasticsearch-korean-queries-20260912-v1/questions.json"
CONFIG = PROJECT / "backend/core-api/src/main/resources/elasticsearch/support-program-lexical-v1.json"
QUESTIONS = RUN / "questions.json"
CUTOFFS = (15, 20)
PASSES = 4  # First pass kept separate from three warm repetitions.
SCHEMA = "govbiz-known-item-100-budget-report-v1"


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def restrict_network(event, args):
    # Defense in depth: imported scripts also cannot contact external hosts/proxies.
    if event == "socket.connect" and args[1] != ("127.0.0.1", 19200):
        raise RuntimeError("Only the isolated local Elasticsearch port is allowed")
    if event == "socket.getaddrinfo" and args[:2] != ("127.0.0.1", 19200):
        raise RuntimeError("External DNS is forbidden")


def load_inputs():
    fixture = lexical.load_snapshot(FIXTURE)
    specification = json.loads(QUESTIONS.read_text(encoding="utf-8"))
    provenance = specification["provenance"]
    if (specification.get("schemaVersion") != "govbiz-known-item-100-questions-v1"
            or specification.get("fixtureSha256") != sha256(FIXTURE)
            or provenance.get("author") != "ai" or provenance.get("humanReviewed") is not False
            or provenance.get("purpose") != "known_item_retrieval_not_exhaustive_relevance_or_eligibility"):
        raise ValueError("Require fixed snapshot and explicit AI-only known-item provenance")
    docs = {doc["id"]: doc for doc in fixture["docs"]}
    cases = [{"id": f"Q{i:03}", **case} for i, case in enumerate(specification["cases"], 1)]
    if (len(cases) != 100 or len({case["targetId"] for case in cases}) != 100
            or len({case["query"] for case in cases}) != 100):
        raise ValueError("Require exactly 100 unique targets and queries")
    previous = json.loads(PREVIOUS.read_text(encoding="utf-8"))
    excluded = {group["targetId"] for group in previous["groups"]}
    selected = sorted((identifier for identifier in docs if identifier not in excluded), key=lambda identifier:
        hashlib.sha256((provenance["selectionSeed"] + identifier).encode("utf-8")).hexdigest())[:100]
    if selected != [case["targetId"] for case in cases]:
        raise ValueError("Targets differ from predeclared hash sampling")
    old_queries = {query for group in previous["groups"] for query in group["queries"].values()}
    old_queries.update(case["query"] for case in fixture["cases"])
    for case in cases:
        query, quote = case["query"], case["evidenceQuote"]
        doc = docs[case["targetId"]]
        if (not isinstance(query, str) or not query.strip() or query != query.strip() or len(query) > 500
                or query in old_queries or case["targetId"].split(":", 1)[1] in query
                or not isinstance(quote, str) or len(quote.strip()) < 10 or quote not in doc["text"]):
            raise ValueError(f"Invalid query or ungrounded evidence: {case['id']}")
    return fixture, specification, cases


def metadata(fixture, specification):
    sources = [Path(__file__).resolve(), QUESTIONS, FIXTURE, PREVIOUS, CONFIG,
               ROOT / "compare_elasticsearch.py", ROOT / "evaluate.py",
               ROOT / "elasticsearch/compose.yaml", ROOT / "elasticsearch/Dockerfile"]
    return {
        "fixtureSha256": sha256(FIXTURE), "questionsSha256": sha256(QUESTIONS),
        "sourceSha256": {str(path.relative_to(PROJECT)): sha256(path) for path in sources},
        "referenceDate": fixture["referenceDate"], "catalog": fixture["catalog"],
        "provenance": specification["provenance"],
        "indexDefinition": json.loads(CONFIG.read_text(encoding="utf-8")),
        "search": {"field": "text", "cutoffs": list(CUTOFFS), "passes": PASSES,
                   "bodies": {str(k): lexical.search_body("text", "<query>", k) for k in CUTOFFS}},
        "externalApiCalls": 0, "modelApiCalls": 0, "embeddingApiCalls": 0,
        "localElasticsearchSearchCalls": len(specification["cases"]) * len(CUTOFFS) * PASSES,
    }


def summarize(cases, candidates, docs, timings):
    expected_ids = {case["id"] for case in cases}
    if set(candidates) != expected_ids:
        raise ValueError("Require a result for every question")
    rows = []
    for case in cases:
        pair = candidates[case["id"]]
        if set(pair) != {"15", "20"}:
            raise ValueError("Require both candidate cutoffs")
        for k in CUTOFFS:
            ids = pair[str(k)]
            if (not isinstance(ids, list) or len(ids) > k or any(not isinstance(item, str) for item in ids)
                    or len(set(ids)) != len(ids) or any(item not in docs for item in ids)):
                raise ValueError("Unknown, duplicate or excessive candidate IDs")
        if pair["15"] != pair["20"][:15]:
            raise ValueError("Actual size=15 results differ from size=20 prefix")
        rank = pair["20"].index(case["targetId"]) + 1 if case["targetId"] in pair["20"] else None
        doc = docs[case["targetId"]]
        rows.append({
            **case, "targetTitle": doc["text"].splitlines()[0].removeprefix("제목: "),
            "targetContentHash": doc["contentHash"], "targetRankAt20": rank,
            "lostByReducingTo15": rank is not None and rank > 15,
            "removedCandidateIds": pair["20"][15:],
        })
    # Timings must cover both sizes for every pass; no dropped slow queries.
    timing_keys = [(item["queryId"], item["k"], item["pass"]) for item in timings]
    expected_keys = {(case["id"], k, repeat) for case in cases for k in CUTOFFS for repeat in range(PASSES)}
    if len(timing_keys) != len(expected_keys) or set(timing_keys) != expected_keys:
        raise ValueError("Incomplete or duplicate timing observations")
    for item in timings:
        if any(type(item[key]) not in (int, float) or not math.isfinite(item[key]) or item[key] < 0
               for key in ("httpMs", "elasticsearchTookMs")):
            raise ValueError("Invalid timing")

    def timing_summary(k, first):
        samples = [item for item in timings if item["k"] == k and (item["pass"] == 0) == first]
        result = {"samples": len(samples)}
        for field in ("httpMs", "elasticsearchTookMs"):
            values = sorted(item[field] for item in samples)
            result[field] = {"median": statistics.median(values),
                             "p95NearestRank": values[math.ceil(len(values) * .95) - 1]}
        return result

    cutoffs = {}
    for k in CUTOFFS:
        ranks = [row["targetRankAt20"] for row in rows]
        hits = sum(rank is not None and rank <= k for rank in ranks)
        ids = [item for pair in candidates.values() for item in pair[str(k)]]
        cutoffs[str(k)] = {
            "targetHitCount": hits, "targetHitRate": hits / len(cases),
            "targetMrr": sum(1 / rank for rank in ranks if rank is not None and rank <= k) / len(cases),
            "candidateCount": len(ids), "retrievalDocumentCharacters": sum(len(docs[item]["text"]) for item in ids),
            "firstPass": timing_summary(k, True), "warmPasses": timing_summary(k, False),
        }
    return {
        "questionCount": len(cases), "distinctTargets": len({case["targetId"] for case in cases}),
        "cutoffs": cutoffs,
        "lostQueryIds": [row["id"] for row in rows if row["lostByReducingTo15"]],
        "missingAtBothQueryIds": [row["id"] for row in rows if row["targetRankAt20"] is None],
        "retrievalDocumentCharacterReductionRatio": 1 - cutoffs["15"]["retrievalDocumentCharacters"] / cutoffs["20"]["retrievalDocumentCharacters"],
        "perQuery": rows,
    }


def run():
    fixture, specification, cases = load_inputs()
    inputs = metadata(fixture, specification)
    client = lexical.LocalElasticsearch("http://127.0.0.1:19200")
    engine = client.verify_cluster()
    index = "govbiz-lexical-" + uuid.uuid4().hex
    lexical.index_snapshot(client, index, fixture["docs"], inputs["indexDefinition"])
    docs = {doc["id"]: doc for doc in fixture["docs"]}
    known_hashes = {identifier: doc["contentHash"] for identifier, doc in docs.items()}
    candidates = {case["id"]: {} for case in cases}
    timings = []
    for repeat in range(PASSES):
        for number, case in enumerate(cases):
            for k in CUTOFFS if (number + repeat) % 2 == 0 else reversed(CUTOFFS):
                ids, timing = lexical.search(client, index, "text", case["query"], k, known_hashes)
                if repeat and ids != candidates[case["id"]][str(k)]:
                    raise ValueError("Candidate order changed across identical repeated searches")
                candidates[case["id"]][str(k)] = ids
                timings.append({"queryId": case["id"], "k": k, "pass": repeat, **timing})
        print(f"Completed pass {repeat + 1}/{PASSES}: {len(cases)} questions x 2 sizes", flush=True)
    summary = summarize(cases, candidates, docs, timings)
    return {
        "schemaVersion": SCHEMA, "status": "complete", "createdAt": datetime.now(timezone.utc).isoformat(),
        **inputs, "engine": engine, "index": index, "candidateIds": candidates, "timings": timings, "summary": summary,
        "targetCategoryCounts": dict(Counter(next(line.removeprefix("분야: ") for line in docs[case["targetId"]]["text"].splitlines() if line.startswith("분야: ")) for case in cases)),
        "limitations": [
            "AI-written source-conditioned known-item questions; no human review or exhaustive relevance labels.",
            "100 distinct notices, not 100 statistically independent user needs; related local programs remain correlated.",
            "One old BIZINFO snapshot; no fresh catalog, other providers, negative queries or eligibility evaluation.",
            "Nori lexical retrieval only. Qdrant, RRF, AI ranking and company-condition extraction were NOT run.",
            "Target Hit is not Recall/Precision or final recommendation accuracy. Non-target candidates are unjudged.",
            "Local sequential first/warm timings are not cold-start, load tests or end-to-end chat latency.",
            "Document characters are not ranking payload bytes, model tokens, cost or latency savings.",
        ],
    }


def verify(report):
    fixture, specification, cases = load_inputs()
    if (report.get("schemaVersion") != SCHEMA or report.get("status") != "complete"
            or any(report.get(key) != value for key, value in metadata(fixture, specification).items())):
        raise ValueError("Saved report does not match fixed inputs or source code")
    expected = summarize(cases, report["candidateIds"], {doc["id"]: doc for doc in fixture["docs"]}, report["timings"])
    if report["summary"] != expected:
        raise ValueError("Saved metrics do not match captured candidates/timings")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--output", type=Path)
    action.add_argument("--verify-report", type=Path)
    args = parser.parse_args()
    sys.addaudithook(restrict_network)
    if args.verify_report:
        verify(json.loads(args.verify_report.read_text(encoding="utf-8")))
        print("100-question inputs and metrics verified offline; not human-label or capture authenticity certification.")
    else:
        with args.output.open("x", encoding="utf-8") as target:
            try:
                report = run()
                verify(report)
            except Exception:
                json.dump({"schemaVersion": SCHEMA, "status": "failed"}, target)
                raise
            json.dump(report, target, ensure_ascii=False, indent=2)
            target.write("\n")
        print(json.dumps({key: value for key, value in report["summary"].items() if key != "perQuery"}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
