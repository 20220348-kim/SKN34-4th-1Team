#!/usr/bin/env python3
"""AI-authored known-item query diagnostics, not exhaustive relevance or eligibility evaluation."""

import argparse
import hashlib
import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

import compare_elasticsearch as lexical
from metric_comparison import metrics_match


SCHEMA = "support-program-known-item-comparison-v1"
QUESTION_SCHEMA = "support-program-known-item-questions-v1"
FORMS = ("keyword", "sentence", "spacing")
K = 20


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load_questions(fixture_path, questions_path):
    fixture = lexical.load_snapshot(fixture_path)
    specification = json.loads(Path(questions_path).read_text(encoding="utf-8"))
    if specification.get("schemaVersion") != QUESTION_SCHEMA or specification.get("fixtureSha256") != sha256(fixture_path):
        raise ValueError("Question set is not bound to this fixed snapshot")
    provenance = specification.get("provenance", {})
    if (provenance.get("author") != "ai" or provenance.get("humanReviewed") is not False
            or provenance.get("purpose") != "known_item_retrieval_not_exhaustive_relevance_or_eligibility"
            or not isinstance(provenance.get("selection"), str) or not provenance["selection"].strip()):
        raise ValueError("Require explicit AI-authored, non-human-reviewed known-item provenance")
    docs = {doc["id"]: doc for doc in fixture["docs"]}
    groups = specification.get("groups")
    if not isinstance(groups, list) or not groups:
        raise ValueError("Require nonempty question groups")
    group_ids, target_ids, query_texts, cases = set(), set(), set(), []
    for group in groups:
        identifier, target = group["id"], group["targetId"]
        if not isinstance(identifier, str) or not re.fullmatch(r"K[0-9]{2,3}", identifier) or identifier in group_ids:
            raise ValueError("Invalid or duplicate question group ID")
        if target not in docs or target in target_ids:
            raise ValueError("Each group needs a distinct known canonical target ID")
        group_ids.add(identifier)
        target_ids.add(target)
        doc = docs[target]
        if group.get("contentHash") != doc["contentHash"]:
            raise ValueError("Question target contentHash mismatch")
        quotes = group.get("evidenceQuotes")
        if not isinstance(quotes, list) or not quotes or any(
            not isinstance(quote, str) or len(quote.strip()) < 10 or quote not in doc["text"] for quote in quotes
        ):
            raise ValueError("Every evidence quote must occur verbatim in the fixed target document")
        # Quote inclusion checks provenance integrity, not the semantic validity of an AI-written question.
        if set(group["queries"]) != set(FORMS):
            raise ValueError("Every target must have keyword, sentence and spacing variants")
        for form in FORMS:
            query = group["queries"][form]
            if (not isinstance(query, str) or not query.strip() or query != query.strip()
                    or len(query) > 500 or query in query_texts or target in query or target.split(":", 1)[1] in query):
                raise ValueError("Require unique bounded query text without target IDs")
            query_texts.add(query)
            cases.append({"id": f"{identifier}-{form}", "groupId": identifier, "form": form, "query": query, "targetId": target})
    return fixture, specification, cases


def evaluate_known_items(cases, results, docs):
    if set(results) != {case["id"] for case in cases}:
        raise ValueError("Results must include every question exactly once")
    known = {doc["id"] for doc in docs}
    for ids in results.values():
        if (not isinstance(ids, list) or len(ids) > K or any(not isinstance(item, str) for item in ids)
                or len(set(ids)) != len(ids) or not set(ids) <= known):
            raise ValueError("Unknown, duplicate or excessive candidate IDs")
    rows = []
    for case in cases:
        ids = results[case["id"]]
        rank = ids.index(case["targetId"]) + 1 if case["targetId"] in ids else None
        rows.append({"queryId": case["id"], "groupId": case["groupId"], "form": case["form"], "targetRank": rank})

    def summarize(selected):
        size = len(selected)
        counts = {str(k): sum(row["targetRank"] is not None and row["targetRank"] <= k for row in selected) for k in (1, 5, K)}
        return {
            "questionCount": size, "hitCounts": counts,
            "hitRates": {k: count / size if size else None for k, count in counts.items()},
            "targetMrrAt20": sum(1 / row["targetRank"] if row["targetRank"] else 0 for row in selected) / size if size else None,
        }

    groups = sorted({row["groupId"] for row in rows})
    robust = sum(all(row["targetRank"] is not None for row in rows if row["groupId"] == group) for group in groups)
    return {
        "all": summarize(rows), "byForm": {form: summarize([row for row in rows if row["form"] == form]) for form in FORMS},
        "groupCount": len(groups), "groupsFoundInAllFormsAt20": robust, "perQuery": rows,
    }


def input_metadata(fixture_path, questions_path, fixture, specification, cases):
    return {
        "fixtureSha256": sha256(fixture_path), "questionsSha256": sha256(questions_path),
        "referenceDate": fixture["referenceDate"], "catalog": fixture["catalog"],
        "questionCount": len(cases), "groupCount": len(specification["groups"]),
        "provenance": specification["provenance"], "k": K, "actualModelApiCalls": 0,
        "indexDefinition": json.loads(lexical.CONFIG.read_text(encoding="utf-8")),
    }


def run(fixture_path, questions_path, endpoint):
    fixture, specification, cases = load_questions(fixture_path, questions_path)
    metadata = input_metadata(fixture_path, questions_path, fixture, specification, cases)
    client = lexical.LocalElasticsearch(endpoint)
    engine = client.verify_cluster()
    index = "govbiz-lexical-" + uuid.uuid4().hex
    lexical.index_snapshot(client, index, fixture["docs"], metadata["indexDefinition"])
    _, keyword = lexical.baseline_results(fixture["docs"], cases, K)
    variants = {"keyword": {"candidateIds": keyword}}
    hashes = {doc["id"]: doc["contentHash"] for doc in fixture["docs"]}
    for name in lexical.FIELDS:
        variants[name] = {"candidateIds": {}, "observations": []}
    for number, case in enumerate(cases):
        names = list(lexical.FIELDS) if number % 2 == 0 else list(reversed(lexical.FIELDS))
        for name in names:
            # Only text goes into the match query. Target IDs/evidence never narrow the search.
            ids, timing = lexical.search(client, index, lexical.FIELDS[name], case["query"], K, hashes)
            variants[name]["candidateIds"][case["id"]] = ids
            variants[name]["observations"].append({"queryId": case["id"], **timing})
    for variant in variants.values():
        variant["metrics"] = evaluate_known_items(cases, variant["candidateIds"], fixture["docs"])
    sources = [Path(__file__).resolve(), lexical.ROOT / "metric_comparison.py",
               lexical.ROOT / "compare_elasticsearch.py", lexical.ROOT / "evaluate.py",
               lexical.CONFIG, lexical.ROOT / "elasticsearch/Dockerfile", lexical.ROOT / "elasticsearch/compose.yaml"]
    return {
        "schemaVersion": SCHEMA, "status": "complete", "createdAt": datetime.now(timezone.utc).isoformat(),
        **metadata, "engine": engine, "index": index, "variants": variants,
        "sourceSha256": {str(path.relative_to(lexical.ROOT)): sha256(path) for path in sources},
        "limitations": [
            "AI-authored known-item queries from source documents, not human-reviewed or exhaustive relevance labels.",
            f"{len(cases)} surface forms represent {len(specification['groups'])} target groups, not independent information needs; no fresh heldout set.",
            "Target Hit/MRR measures one specified item, not Recall/Precision or final recommendation MRR.",
            "Purposively selected positive targets and source vocabulary can bias results; no negative or eligibility evaluation.",
            "No Qdrant/RRF/LLM calls, production changes or end-to-end latency measurement.",
        ],
    }


def verify(fixture_path, questions_path, report):
    fixture, specification, cases = load_questions(fixture_path, questions_path)
    expected = input_metadata(fixture_path, questions_path, fixture, specification, cases)
    if report.get("schemaVersion") != SCHEMA or report.get("status") != "complete" or any(report.get(key) != value for key, value in expected.items()):
        raise ValueError("Saved known-item report does not match its questions, source or configuration")
    if set(report["variants"]) != {"keyword", *lexical.FIELDS}:
        raise ValueError("Expected all three lexical variants")
    _, keyword = lexical.baseline_results(fixture["docs"], cases, K)
    if report["variants"]["keyword"]["candidateIds"] != keyword:
        raise ValueError("Saved keyword results cannot be reproduced")
    for variant in report["variants"].values():
        if not metrics_match(variant["metrics"], evaluate_known_items(cases, variant["candidateIds"], fixture["docs"])):
            raise ValueError("Saved known-item metrics cannot be reproduced")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--questions", type=Path, required=True)
    parser.add_argument("--endpoint", default="http://127.0.0.1:19200")
    output = parser.add_mutually_exclusive_group(required=True)
    output.add_argument("--output", type=Path)
    output.add_argument("--verify-report", type=Path)
    args = parser.parse_args()
    try:
        if args.verify_report:
            verify(args.fixture, args.questions, json.loads(args.verify_report.read_text(encoding="utf-8")))
            print("Known-item inputs and metrics verified offline; not an authenticity or relevance certification.")
            return
        with args.output.open("x", encoding="utf-8") as target:
            try:
                report = run(args.fixture, args.questions, args.endpoint)
            except Exception:
                json.dump({"schemaVersion": SCHEMA, "status": "failed"}, target)
                raise
            json.dump(report, target, ensure_ascii=False, indent=2)
            target.write("\n")
        print(f"Saved known-item diagnostics: {args.output}")
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
