#!/usr/bin/env python3
"""Offline retrieval comparison; no API calls, credentials, or production index writes."""

import argparse
import hashlib
import json
import re
import unicodedata
from datetime import date, datetime
from pathlib import Path


CAPTURE_SCHEMA_VERSION = "support-program-search-capture-v2"
FINAL_RESULT_LIMIT = 5
CATALOG_METADATA_FIELDS = {
    "presentProgramCount",
    "eligibleProgramCount",
    "eligibleCatalogFingerprint",
}
SOURCE_CODE_PATTERN = re.compile(r"[A-Z][A-Z0-9_]{0,63}")
REVIEW_DATA_TYPES = {
    "ai-only": "real_catalog_snapshot_labeled_pooled_ai_consensus",
    "hybrid": "real_catalog_snapshot_labeled_pooled_hybrid",
    "human": "real_catalog_snapshot_labeled_pooled_human",
    "legacy_unspecified": "real_catalog_snapshot_labeled_pooled_legacy_unspecified",
}


def _validate_fixture_identity(fixture, require_data_type=False):
    if not isinstance(fixture, dict):
        raise ValueError("Fixture must be an object")
    _require_trimmed_nonempty_string(fixture.get("name"), "Fixture name")
    data_type = fixture.get("dataType")
    if data_type is None and require_data_type:
        raise ValueError("Capture evaluation requires a nonempty fixture dataType")
    if data_type is not None:
        _require_trimmed_nonempty_string(data_type, "Fixture dataType")


def load_fixture(path):
    fixture = json.loads(Path(path).read_text(encoding="utf-8"))
    _validate_fixture_identity(fixture)
    docs, cases = fixture["docs"], fixture["cases"]
    doc_ids = [doc["id"] for doc in docs]
    case_ids = [case["id"] for case in cases]
    if len(set(doc_ids)) != len(doc_ids) or len(set(case_ids)) != len(case_ids):
        raise ValueError("Duplicate document or query ID in fixture")
    known_docs = set(doc_ids)
    for doc in docs:
        if not all(isinstance(doc.get(key), str) and doc[key] for key in ("id", "text", "sortTimestamp")):
            raise ValueError("Documents require nonempty id, text, sortTimestamp strings")
    for case in cases:
        _require_trimmed_nonempty_string(case.get("id"), "Fixture case id")
        _require_trimmed_nonempty_string(case.get("query"), f"Fixture query for {case['id']}")
        if case.get("split") not in ("dev", "heldout"):
            raise ValueError(f"Invalid split for {case['id']}")
        labels = case["relevantIds"]
        if labels is not None:
            if not isinstance(labels, list) or any(not isinstance(item, str) for item in labels):
                raise ValueError(f"relevantIds must be an ID list or null for {case['id']}")
            if len(set(labels)) != len(labels) or not set(labels) <= known_docs:
                raise ValueError(f"Duplicate or unknown relevant document for {case['id']}")
    label_reference_report(fixture, cases)
    return fixture


def label_reference_report(fixture, selected_cases):
    """Expose label provenance without equating AI agreement or human review with truth."""
    review = fixture.get("labelReview")
    if review is not None and not isinstance(review, dict):
        raise ValueError("Fixture labelReview must be an object")
    review = review or {}
    schema = review.get("schemaVersion")
    if schema is not None and schema != "support-program-label-review-v1":
        raise ValueError("Unsupported fixture labelReview schema")
    mode = review.get("mode", "legacy_unspecified")
    if not isinstance(mode, str) or mode not in REVIEW_DATA_TYPES:
        raise ValueError("Unknown fixture labelReview mode")
    if schema is None and ("mode" in review or fixture.get("dataType") in REVIEW_DATA_TYPES.values()):
        raise ValueError("Explicit review provenance requires a labelReview schema")
    if schema is not None:
        if fixture.get("dataType") != REVIEW_DATA_TYPES[mode]:
            raise ValueError("Fixture dataType does not match its labelReview mode")
        source_hashes = review.get("sourceHashes")
        if not isinstance(source_hashes, dict) or not source_hashes:
            raise ValueError("Fixture labelReview requires source hashes")
        for value in source_hashes.values():
            if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
                raise ValueError("Fixture labelReview source hashes must be lowercase SHA-256 strings")
        if mode != "legacy_unspecified" and "selectionSha256" not in source_hashes:
            raise ValueError("Selected labelReview requires a selection source hash")
        counts = review.get("counts")
        _require_exact_keys(counts, {"reviewRowCount", "labeledQueryCount", "excludedQueryCount"}, "Label review counts")
        if any(not _is_integer(value) or value < 0 for value in counts.values()):
            raise ValueError("Label review counts must be nonnegative integers")
        cases = fixture["cases"]
        excluded_ids = {case["id"] for case in cases if case["relevantIds"] is None}
        if counts["labeledQueryCount"] != len(cases) - len(excluded_ids) or counts["excludedQueryCount"] != len(excluded_ids):
            raise ValueError("Label review query counts do not match fixture cases")
        exclusions = review.get("excludedQueries")
        if not isinstance(exclusions, list):
            raise ValueError("Label review excludedQueries must be a list")
        seen_excluded = set()
        for exclusion in exclusions:
            _require_exact_keys(exclusion, {"id", "reason"}, "Label review exclusion")
            _require_trimmed_nonempty_string(exclusion["id"], "Excluded query id")
            _require_trimmed_nonempty_string(exclusion["reason"], "Excluded query reason")
            if exclusion["id"] in seen_excluded:
                raise ValueError("Duplicate label review exclusion")
            seen_excluded.add(exclusion["id"])
        if seen_excluded != excluded_ids:
            raise ValueError("Label review exclusions do not match fixture cases")
        if mode != "legacy_unspecified":
            source_counts = review.get("sourceCounts")
            _require_exact_keys(source_counts, {"ai", "human", "unresolved"}, "Label source counts")
            if any(not _is_integer(value) or value < 0 for value in source_counts.values()):
                raise ValueError("Label source counts must be nonnegative integers")
            if sum(source_counts.values()) != counts["reviewRowCount"]:
                raise ValueError("Label source counts do not match reviewRowCount")
            required = review.get("requiredHumanReviewCount")
            pending = review.get("pendingHumanReviewCount")
            if not _is_integer(required) or not 0 <= required <= counts["reviewRowCount"]:
                raise ValueError("Invalid requiredHumanReviewCount")
            if not _is_integer(pending) or pending != 0:
                raise ValueError("Evaluation labels cannot contain pending required human review")
            if required > source_counts["human"]:
                raise ValueError("Required human checks exceed recorded completed human labels")
            if mode == "ai-only" and (source_counts["human"] != 0 or required != 0):
                raise ValueError("AI-only labels cannot claim human review")
            if mode == "human" and (source_counts["ai"] != 0 or source_counts["unresolved"] != 0):
                raise ValueError("Human-only labels must all have human provenance")
            if mode == "human" and required != counts["reviewRowCount"]:
                raise ValueError("Human-only mode requires human checks for all review rows")
            if mode == "hybrid" and source_counts["unresolved"] != 0:
                raise ValueError("Hybrid labels cannot contain unresolved human checks")
            if mode in {"ai-only", "hybrid"} and "aiReviewSha256" not in source_hashes:
                raise ValueError("AI-assisted labels require an AI review source hash")
            if source_counts["human"] and not any(field in source_hashes for field in ("humanReviewSha256", "conversationJudgmentsSha256")):
                raise ValueError("Human labels require a human review or conversation source hash")

    interpretations = {
        "ai-only": "Recall and MRR measure agreement with an AI-consensus reference, not independently human-validated relevance.",
        "hybrid": "Recall and MRR use AI labels with selected human checks; unreviewed AI labels are not human-validated.",
        "human": "Recall and MRR use human review labels; this alone does not establish expert or independently replicated judgments.",
        "legacy_unspecified": "Label provenance is unspecified; these metrics must not be described as human-validated.",
    }
    limitations = [interpretations[mode]]
    if schema is not None or "pooled" in (fixture.get("dataType") or ""):
        limitations.append("Labels cover a review pool, not an exhaustive relevance check of the entire catalog; Recall is pooled-reference Recall.")
    if mode in {"ai-only", "hybrid"}:
        limitations.append("AI judges can share errors with each other and the ranking model. Vote agreement is not a calibrated correctness probability.")
    if any(case["relevantIds"] is None for case in fixture["cases"]):
        limitations.append("Excluded queries reduce coverage and may bias aggregate scores; inspect exclusions and evaluated query counts.")
    return {
        "mode": mode,
        "metricInterpretation": interpretations[mode],
        "sourceHashes": review.get("sourceHashes", {}),
        "sourceCounts": review.get("sourceCounts"),
        "requiredHumanReviewCount": review.get("requiredHumanReviewCount"),
        "pendingHumanReviewCount": review.get("pendingHumanReviewCount"),
        "poolCounts": review.get("counts"),
        "selectedQueryCounts": {
            "total": len(selected_cases),
            "evaluated": sum(case["relevantIds"] is not None for case in selected_cases),
            "excluded": sum(case["relevantIds"] is None for case in selected_cases),
        },
        "excludedQueries": review.get("excludedQueries", []),
        "limitations": limitations,
    }


def query_set_sha256(cases):
    """Return the stable v1 identity of a fixture's query text and split assignment."""
    query_set = [
        {"id": case["id"], "query": case["query"], "split": case["split"]}
        for case in cases
    ]
    encoded = json.dumps(query_set, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _is_integer(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _require_exact_keys(value, expected, description):
    if not isinstance(value, dict):
        raise ValueError(f"{description} must be an object")
    missing = sorted(expected - set(value))
    unexpected = sorted(set(value) - expected)
    if missing or unexpected:
        details = []
        if missing:
            details.append(f"missing {', '.join(missing)}")
        if unexpected:
            details.append(f"unexpected {', '.join(unexpected)}")
        raise ValueError(f"{description} has {'; '.join(details)}")


def _require_nonempty_string(value, description):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{description} must be a nonempty string")


def _require_trimmed_nonempty_string(value, description):
    _require_nonempty_string(value, description)
    if value != value.strip():
        raise ValueError(f"{description} must not have surrounding whitespace")


def _require_iso_date(value, description):
    _require_trimmed_nonempty_string(value, description)
    try:
        parsed = date.fromisoformat(value)
    except ValueError as error:
        raise ValueError(f"{description} must be an ISO-8601 date") from error
    if value != parsed.isoformat():
        raise ValueError(f"{description} must be an ISO-8601 date")


def _is_canonical_document_id(identifier):
    if not isinstance(identifier, str) or identifier != identifier.strip():
        return False
    if ":" not in identifier:
        return False
    source_code, source_program_id = identifier.split(":", 1)
    return bool(
        SOURCE_CODE_PATTERN.fullmatch(source_code)
        and source_program_id
        and source_code == source_code.strip()
        and source_program_id == source_program_id.strip()
    )


def _canonical_document_ids(docs):
    """Map canonical capture IDs to equally canonical fixture IDs."""
    canonical_to_fixture_id = {}
    for doc in docs:
        canonical_id = doc["id"]
        if not _is_canonical_document_id(canonical_id):
            raise ValueError(
                "Capture evaluation requires every fixture document id to use canonical "
                "sourceCode:sourceProgramId matching"
            )
        if canonical_id in canonical_to_fixture_id:
            raise ValueError("Duplicate canonical document ID in fixture")
        canonical_to_fixture_id[canonical_id] = canonical_id
    return canonical_to_fixture_id


def _validate_catalog_metadata(catalog, owner):
    _require_exact_keys(catalog, CATALOG_METADATA_FIELDS, f"{owner} catalog")
    for key in ("presentProgramCount", "eligibleProgramCount"):
        if not _is_integer(catalog[key]) or catalog[key] < 0:
            raise ValueError(f"{owner} catalog.{key} must be a nonnegative integer")
    if catalog["eligibleProgramCount"] > catalog["presentProgramCount"]:
        raise ValueError(f"{owner} eligibleProgramCount cannot exceed presentProgramCount")
    fingerprint = catalog["eligibleCatalogFingerprint"]
    if not isinstance(fingerprint, str) or re.fullmatch(r"[0-9a-f]{64}", fingerprint) is None:
        raise ValueError(f"{owner} catalog.eligibleCatalogFingerprint must be a lowercase SHA-256 string")
    return catalog


def eligible_catalog_fingerprint(docs):
    """Mirror the Core API's sorted UTF-8 `id:contentHash` snapshot fingerprint."""
    entries = []
    for doc in docs:
        content_hash = doc.get("contentHash")
        if not isinstance(content_hash, str) or re.fullmatch(r"[0-9a-f]{64}", content_hash) is None:
            raise ValueError("Capture evaluation requires every fixture document to have a lowercase SHA-256 contentHash")
        entries.append(f"{doc['id']}:{content_hash}")
    return hashlib.sha256("\n".join(sorted(entries)).encode("utf-8")).hexdigest()


def _validate_document_content_hashes(docs):
    """Ensure the persisted Core API content hash still represents each search document."""
    for doc in docs:
        text = doc.get("text")
        if not isinstance(text, str):
            raise ValueError(f"Capture evaluation requires document text for {doc['id']}")
        expected_content_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
        if doc.get("contentHash") != expected_content_hash:
            raise ValueError(
                f"Fixture document contentHash does not match its UTF-8 text for {doc['id']}",
            )


def _validate_capture_fixture(fixture, capture_catalog):
    _validate_fixture_identity(fixture, require_data_type=True)
    _require_iso_date(fixture.get("referenceDate"), "Fixture referenceDate")
    canonical_to_fixture_id = _canonical_document_ids(fixture["docs"])
    fixture_catalog = fixture.get("catalog")
    if fixture_catalog is None:
        raise ValueError("Capture evaluation requires fixture catalog metadata")
    _validate_catalog_metadata(fixture_catalog, "Fixture")
    if len(fixture["docs"]) != fixture_catalog["eligibleProgramCount"]:
        raise ValueError("Capture fixture docs must represent the entire eligible catalog")
    _validate_document_content_hashes(fixture["docs"])
    if eligible_catalog_fingerprint(fixture["docs"]) != fixture_catalog["eligibleCatalogFingerprint"]:
        raise ValueError("Fixture catalog eligibleCatalogFingerprint does not match its document contentHash values")
    if fixture_catalog != capture_catalog:
        raise ValueError("Capture catalog does not match the fixture catalog snapshot")
    return canonical_to_fixture_id


def _validate_canonical_ids(ids, description, canonical_to_fixture_id):
    if not isinstance(ids, list) or any(not isinstance(item, str) for item in ids):
        raise ValueError(f"{description} must be a canonical document ID list")
    if len(set(ids)) != len(ids):
        raise ValueError(f"Duplicate returned document for {description}")
    normalized = []
    for identifier in ids:
        if not _is_canonical_document_id(identifier):
            raise ValueError(f"{description} contains a noncanonical document ID")
        fixture_id = canonical_to_fixture_id.get(identifier)
        if fixture_id is None:
            raise ValueError(f"Unknown returned document for {description}")
        normalized.append(fixture_id)
    return normalized


def _validate_capture_metadata(capture, fixture):
    _require_exact_keys(
        capture,
        {
            "schemaVersion",
            "querySet",
            "capturedAt",
            "referenceDate",
            "acceptingOnly",
            "catalog",
            "search",
            "observations",
        },
        "Capture",
    )
    if capture["schemaVersion"] != CAPTURE_SCHEMA_VERSION:
        raise ValueError(f"Unsupported capture schema version: {capture['schemaVersion']!r}")

    query_set = capture["querySet"]
    _require_exact_keys(query_set, {"name", "sha256"}, "Capture querySet")
    _require_nonempty_string(query_set["name"], "Capture querySet.name")
    _require_nonempty_string(query_set["sha256"], "Capture querySet.sha256")
    if query_set["name"] != fixture["name"]:
        raise ValueError("Capture querySet.name does not match the fixture")
    if query_set["sha256"] != query_set_sha256(fixture["cases"]):
        raise ValueError("Capture querySet.sha256 does not match the fixture queries")

    captured_at = capture["capturedAt"]
    _require_nonempty_string(captured_at, "Capture capturedAt")
    try:
        parsed_captured_at = datetime.fromisoformat(
            f"{captured_at[:-1]}+00:00" if captured_at.endswith("Z") else captured_at,
        )
    except ValueError as error:
        raise ValueError("Capture capturedAt must be an ISO-8601 timestamp") from error
    if parsed_captured_at.tzinfo is None:
        raise ValueError("Capture capturedAt must include a timezone")

    _require_iso_date(capture["referenceDate"], "Capture referenceDate")

    if type(capture["acceptingOnly"]) is not bool:
        raise ValueError("Capture acceptingOnly must be a boolean")

    _validate_catalog_metadata(capture["catalog"], "Capture")

    search = capture["search"]
    _require_exact_keys(search, {"candidateLimit", "finalResultLimit", "scoringVersion"}, "Capture search")
    for key in ("candidateLimit", "finalResultLimit"):
        if not _is_integer(search[key]) or search[key] < 1:
            raise ValueError(f"Capture search.{key} must be a positive integer")
    if search["finalResultLimit"] != FINAL_RESULT_LIMIT:
        raise ValueError(f"Capture search.finalResultLimit must be {FINAL_RESULT_LIMIT} for final Recall@5 and MRR@5")
    _require_nonempty_string(search["scoringVersion"], "Capture search.scoringVersion")

    if not isinstance(capture["observations"], list):
        raise ValueError("Capture observations must be a list")


def validate_capture(capture, fixture, selected_cases):
    """Validate a v1 search capture and return fixture-ID results for both stages.

    Capture v1 deliberately uses canonical ``sourceCode:sourceProgramId`` identifiers.
    Legacy ``--semantic-results`` keeps accepting the fixture's historical bare IDs.
    """
    _validate_fixture_identity(fixture, require_data_type=True)
    _validate_capture_metadata(capture, fixture)
    canonical_to_fixture_id = _validate_capture_fixture(fixture, capture["catalog"])
    if capture["referenceDate"] != fixture["referenceDate"]:
        raise ValueError("Capture referenceDate does not match the fixture")
    cases_by_id = {case["id"]: case for case in fixture["cases"]}
    required = {case["id"] for case in selected_cases if case["relevantIds"] is not None}
    seen = set()
    candidates, final_programs = {}, {}

    for observation in capture["observations"]:
        _require_exact_keys(
            observation,
            {"id", "query", "split", "candidateIds", "finalProgramIds"},
            "Capture observation",
        )
        query_id = observation["id"]
        _require_nonempty_string(query_id, "Capture observation.id")
        expected_case = cases_by_id.get(query_id)
        if expected_case is None:
            raise ValueError("Capture observations contain an unknown query ID")
        if query_id in seen:
            raise ValueError(f"Duplicate capture observation for {query_id}")
        seen.add(query_id)
        if observation["query"] != expected_case["query"]:
            raise ValueError(f"Capture query does not match fixture for {query_id}")
        if observation["split"] != expected_case["split"]:
            raise ValueError(f"Capture split does not match fixture for {query_id}")

        candidate_ids = _validate_canonical_ids(
            observation["candidateIds"],
            f"candidateIds for {query_id}",
            canonical_to_fixture_id,
        )
        final_ids = _validate_canonical_ids(
            observation["finalProgramIds"],
            f"finalProgramIds for {query_id}",
            canonical_to_fixture_id,
        )
        if len(candidate_ids) > capture["search"]["candidateLimit"]:
            raise ValueError(f"Capture candidateIds exceed candidateLimit for {query_id}")
        if len(final_ids) > capture["search"]["finalResultLimit"]:
            raise ValueError(f"Capture finalProgramIds exceed finalResultLimit for {query_id}")
        if not set(final_ids) <= set(candidate_ids):
            raise ValueError(f"Capture finalProgramIds must be candidates for {query_id}")
        candidates[query_id] = candidate_ids
        final_programs[query_id] = final_ids

    if not required <= seen:
        raise ValueError(
            "Capture observations are incomplete; use [] for an observed empty result, not a missing observation",
        )
    return {"candidate": candidates, "final": final_programs}


def newest_first(docs):
    # Stable two-pass sorting matches timestamp DESC, ID ASC, including tied dates.
    return sorted(sorted(docs, key=lambda doc: doc["id"]), key=lambda doc: doc["sortTimestamp"], reverse=True)


def tokenize(text):
    return set(re.findall(r"[a-z0-9가-힣]+", unicodedata.normalize("NFC", text).casefold()))


def baseline_results(docs, cases, k):
    ordered = newest_first(docs)
    latest = [doc["id"] for doc in ordered[:k]]
    # A fixed corpus has the same tokens for every query. Keep this local to the
    # evaluation run so edited fixtures never reuse stale cross-run tokens.
    document_words = [(doc, tokenize(doc["text"])) for doc in ordered] if cases else []
    latest_results, keyword_results = {}, {}
    for case in cases:
        query_words = tokenize(case["query"])
        scored = [(doc, len(query_words & words)) for doc, words in document_words]
        scored.sort(key=lambda item: item[1], reverse=True)
        latest_results[case["id"]] = latest.copy()
        keyword_results[case["id"]] = [doc["id"] for doc, score in scored if score > 0][:k]
    return latest_results, keyword_results


def validate_results(results, docs, all_cases, selected_cases):
    if not isinstance(results, dict):
        raise ValueError("Search results must map query IDs to ordered document ID lists")
    known_queries = {case["id"] for case in all_cases}
    known_docs = {doc["id"] for doc in docs}
    if not set(results) <= known_queries:
        raise ValueError("Search results contain unknown query IDs")
    required = {case["id"] for case in selected_cases if case["relevantIds"] is not None}
    if not required <= set(results):
        raise ValueError("Search results are incomplete; use [] for an observed empty result, not a missing key")
    for query_id, ids in results.items():
        if not isinstance(ids, list) or any(not isinstance(item, str) for item in ids):
            raise ValueError(f"Expected document ID list for {query_id}")
        if len(set(ids)) != len(ids) or not set(ids) <= known_docs:
            raise ValueError(f"Duplicate or unknown returned document for {query_id}")


def evaluate_results(cases, results, k=20):
    if k < 1:
        raise ValueError("k must be positive")
    recalls, no_match_false_positives, details = [], [], []
    skipped = 0
    for case in cases:
        labels = case["relevantIds"]
        if labels is None:
            skipped += 1
            details.append({"queryId": case["id"], "status": "unlabeled_skipped"})
            continue
        returned = results[case["id"]][:k]
        if labels:
            hits = set(returned) & set(labels)
            recall = len(hits) / len(set(labels))
            recalls.append(recall)
            details.append({"queryId": case["id"], "recall": recall, "returnedIds": returned, "missingRelevantIds": sorted(set(labels) - hits)})
        else:
            false_positive = bool(returned)
            no_match_false_positives.append(false_positive)
            details.append({"queryId": case["id"], "noMatchFalsePositive": false_positive, "returnedIds": returned})
    return {
        "k": k,
        "answerableQueries": len(recalls),
        "macroRecallAtK": sum(recalls) / len(recalls) if recalls else None,
        "noMatchQueries": len(no_match_false_positives),
        "noMatchFalsePositiveRate": sum(no_match_false_positives) / len(no_match_false_positives) if no_match_false_positives else None,
        "unlabeledQueriesSkipped": skipped,
        "perQuery": details,
    }


def evaluate_final_results(cases, results):
    """Evaluate the user-visible ranking stage at the product's fixed top-five boundary."""
    report = evaluate_results(cases, results, FINAL_RESULT_LIMIT)
    details_by_query_id = {detail["queryId"]: detail for detail in report["perQuery"]}
    reciprocal_ranks = []
    for case in cases:
        labels = case["relevantIds"]
        if not labels:
            continue
        returned = results[case["id"]][:FINAL_RESULT_LIMIT]
        rank = next((index for index, program_id in enumerate(returned, start=1) if program_id in labels), None)
        reciprocal_rank = 0.0 if rank is None else 1.0 / rank
        reciprocal_ranks.append(reciprocal_rank)
        detail = details_by_query_id[case["id"]]
        detail["firstRelevantRankAt5"] = rank
        detail["reciprocalRankAt5"] = reciprocal_rank

    return {
        "k": FINAL_RESULT_LIMIT,
        "answerableQueries": report["answerableQueries"],
        "macroRecallAt5": report["macroRecallAtK"],
        "mrrAt5": sum(reciprocal_ranks) / len(reciprocal_ranks) if reciprocal_ranks else None,
        "noMatchQueries": report["noMatchQueries"],
        "noMatchFalsePositiveRate": report["noMatchFalsePositiveRate"],
        "unlabeledQueriesSkipped": report["unlabeledQueriesSkipped"],
        "perQuery": report["perQuery"],
    }


def evaluate_capture(capture, fixture, selected_cases, candidate_k):
    if candidate_k < 1:
        raise ValueError("candidate_k must be positive")
    stages = validate_capture(capture, fixture, selected_cases)
    if candidate_k > capture["search"]["candidateLimit"]:
        raise ValueError("candidate_k cannot exceed Capture search.candidateLimit")
    return {
        "schemaVersion": capture["schemaVersion"],
        "querySet": capture["querySet"],
        "capturedAt": capture["capturedAt"],
        "referenceDate": capture["referenceDate"],
        "acceptingOnly": capture["acceptingOnly"],
        "catalog": capture["catalog"],
        "search": capture["search"],
        "labelReference": label_reference_report(fixture, selected_cases),
        "candidate": evaluate_results(selected_cases, stages["candidate"], candidate_k),
        "final": evaluate_final_results(selected_cases, stages["final"]),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, default=Path(__file__).with_name("fixture.json"))
    parser.add_argument("--semantic-results", type=Path, help="Saved semantic candidate IDs by query ID, from this same corpus")
    parser.add_argument(
        "--capture",
        type=Path,
        help="Saved support-program-search-capture-v2 candidate and final program IDs",
    )
    parser.add_argument("--split", choices=("all", "dev", "heldout"), default="all")
    parser.add_argument("--k", type=int, default=20)
    args = parser.parse_args()
    if args.k < 1:
        parser.error("--k must be positive")
    try:
        fixture = load_fixture(args.fixture)
        cases = [case for case in fixture["cases"] if args.split == "all" or case["split"] == args.split]
        latest, keyword = baseline_results(fixture["docs"], cases, args.k)
        report = {
            "fixture": fixture["name"],
            "dataType": fixture.get("dataType", "unspecified"),
            "split": args.split,
            "documentCount": len(fixture["docs"]),
            "queryCount": len(cases),
            "labelReference": label_reference_report(fixture, cases),
            "latest": evaluate_results(cases, latest, args.k),
            "keyword": evaluate_results(cases, keyword, args.k),
            "semantic": None,
            "capture": None,
        }
        if args.semantic_results:
            saved = json.loads(args.semantic_results.read_text(encoding="utf-8"))
            validate_results(saved, fixture["docs"], fixture["cases"], cases)
            report["semantic"] = evaluate_results(cases, saved, args.k)
        if args.capture:
            capture = json.loads(args.capture.read_text(encoding="utf-8"))
            report["capture"] = evaluate_capture(capture, fixture, cases, args.k)
        print(json.dumps(report, ensure_ascii=False, indent=2))
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
