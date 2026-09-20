#!/usr/bin/env python3
"""Convert a complete final review pool into a labeled evaluation fixture."""

import argparse
import csv
import hashlib
import importlib.util
import json
import re
import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from evaluate import validate_capture as validate_search_capture


ALLOWED_DECISIONS = {"relevant", "irrelevant", "unclear"}
REVIEW_FIELDS = [
    "query_id",
    "split",
    "query",
    "decision",
    "reason",
    "reviewer",
    "title",
    "summary",
    "target_description",
    "regions",
    "categories",
    "application_period",
    "organization",
    "program_id",
]
MUTABLE_REVIEW_FIELDS = {"decision", "reason", "reviewer"}
IMMUTABLE_REVIEW_FIELDS = [
    field for field in REVIEW_FIELDS if field not in MUTABLE_REVIEW_FIELDS
]


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", required=True)
    parser.add_argument("--query-set", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--capture", required=True)
    parser.add_argument("--pool-manifest", required=True)
    parser.add_argument("--review-pool", required=True)
    parser.add_argument("--selection", help="Audited ai-only, hybrid, or human review-mode selection JSON")
    parser.add_argument("--exclude-query", action="append", default=[], metavar="QUERY_ID=REASON")
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def sha256_path(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def query_set_sha256(queries):
    identity = [
        {"id": query["id"], "query": query["query"], "split": query["split"]}
        for query in queries
    ]
    encoded = json.dumps(identity, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def review_structure_sha256(rows):
    immutable_rows = [
        {field: row[field] for field in IMMUTABLE_REVIEW_FIELDS}
        for row in sorted(rows, key=lambda row: (row["query_id"], row["program_id"]))
    ]
    encoded = json.dumps(
        immutable_rows,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def pool_key_sha256(rows):
    keys = sorted(f"{row['query_id']}\t{row['program_id']}" for row in rows)
    return hashlib.sha256("\n".join(keys).encode("utf-8")).hexdigest()


def validate_new_output_path(output_path, input_paths):
    raw_output = Path(output_path)
    resolved_output = raw_output.resolve(strict=False)
    if raw_output.exists() or raw_output.is_symlink():
        raise FileExistsError(f"Labeled fixture already exists: {raw_output}")
    for description, path in input_paths:
        if path and resolved_output == Path(path).resolve(strict=False):
            raise ValueError(f"Labeled fixture output aliases {description}: {raw_output}")


def parse_exclusions(values, query_ids):
    exclusions = {}
    for value in values:
        query_id, separator, reason = value.partition("=")
        query_id = query_id.strip()
        reason = reason.strip()
        if not separator or not query_id or not reason:
            raise ValueError("Each --exclude-query must use QUERY_ID=nonempty reason")
        if query_id not in query_ids:
            raise ValueError(f"Unknown excluded query ID: {query_id}")
        if query_id in exclusions:
            raise ValueError(f"Duplicate excluded query ID: {query_id}")
        exclusions[query_id] = reason
    if exclusions and len(exclusions) == len(query_ids):
        raise ValueError("At least one query must remain labeled")
    return exclusions


def validate_identity(fixture, query_set, config, manifest, config_path, capture_path):
    if manifest.get("schemaVersion") != "support-program-review-pool-manifest-v1":
        raise ValueError("Unsupported review-pool manifest schema")
    if manifest.get("captureIncluded") is not True:
        raise ValueError("Labels can only be applied to a final pool containing the real search capture")
    if fixture.get("name") != query_set.get("name") or config.get("querySetName") != query_set.get("name"):
        raise ValueError("Fixture, query set, and pool config names do not match")
    if manifest.get("name") != query_set.get("name"):
        raise ValueError("Review-pool manifest name does not match")
    if manifest.get("referenceDate") != fixture.get("referenceDate"):
        raise ValueError("Review-pool manifest reference date does not match")
    fingerprint = fixture.get("catalog", {}).get("eligibleCatalogFingerprint")
    if manifest.get("catalogFingerprint") != fingerprint:
        raise ValueError("Review-pool manifest catalog fingerprint does not match")
    if manifest.get("querySetSha256") != query_set_sha256(query_set["queries"]):
        raise ValueError("Review-pool manifest query set hash does not match")
    if manifest.get("configSha256") != sha256_path(config_path):
        raise ValueError("Review-pool manifest config hash does not match")
    capture_hash = manifest.get("captureFileSha256")
    if not isinstance(capture_hash, str) or re.fullmatch(r"[0-9a-f]{64}", capture_hash) is None:
        raise ValueError("Final review-pool manifest has no valid capture hash")
    if sha256_path(capture_path) != capture_hash:
        raise ValueError("Actual capture file hash does not match the review-pool manifest")


def validate_capture(capture, fixture, queries):
    validation_cases = [
        {
            "id": query["id"],
            "query": query["query"],
            "split": query["split"],
            "relevantIds": [],
        }
        for query in queries
    ]
    validation_fixture = dict(fixture)
    validation_fixture["cases"] = validation_cases
    validate_search_capture(capture, validation_fixture, validation_cases)
    if capture.get("acceptingOnly") is not True:
        raise ValueError("Capture must use acceptingOnly=true")
    search = capture.get("search", {})
    if search.get("candidateLimit") != 20 or search.get("finalResultLimit") != 5:
        raise ValueError("Capture must use candidateLimit=20 and finalResultLimit=5")


def warning(code, query_id, message, **details):
    return {"code": code, "queryId": query_id, "message": message, **details}


def expected_judgment_warnings(query_id, configuration, relevant_ids):
    warnings = []
    expected_outcome = configuration["expectedOutcome"]
    if expected_outcome == "match" and not relevant_ids:
        warnings.append(
            warning(
                "EXPECTED_MATCH_WITHOUT_RELEVANT",
                query_id,
                "The selected review found no relevant program although a match was expected.",
            )
        )
    if expected_outcome == "no_match" and relevant_ids:
        warnings.append(
            warning(
                "EXPECTED_NO_MATCH_WITH_RELEVANT",
                query_id,
                "The selected review found relevant programs although no match was expected.",
                relevantIds=relevant_ids,
            )
        )
    rejected_examples = [
        program_id
        for program_id in configuration["expectedExampleIds"]
        if program_id not in relevant_ids
    ]
    if rejected_examples:
        warnings.append(
            warning(
                "EXPECTED_EXAMPLES_NOT_RELEVANT",
                query_id,
                "The selected review did not mark one or more expected examples as relevant.",
                programIds=rejected_examples,
            )
        )
    return warnings


def write_json_new(path, value):
    with Path(path).open("x", encoding="utf-8") as file:
        json.dump(value, file, ensure_ascii=False, indent=2)
        file.write("\n")


def load_selection(path, rows, manifest, review_pool_path):
    """Verify the mode-selection audit against the exact reviewed CSV being applied."""
    if not path:
        return None
    spec = importlib.util.spec_from_file_location(
        "review_mode_selection", Path(__file__).with_name("select-review-mode.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    selection = module.PAGE.load_json(path)
    module.validate_selection(selection, rows, manifest)
    if selection["reviewedCsvSha256"] != sha256_path(review_pool_path):
        raise ValueError("Selection reviewed CSV hash does not match the actual review pool")
    if selection["status"] != "ready":
        raise ValueError(f"Review selection is not ready for evaluation: {selection['status']}")
    return selection


def main():
    args = parse_args()
    input_paths = [
        ("fixture", args.fixture),
        ("query set", args.query_set),
        ("pool config", args.config),
        ("capture", args.capture),
        ("pool manifest", args.pool_manifest),
        ("review pool", args.review_pool),
        ("review selection", getattr(args, "selection", None)),
    ]
    validate_new_output_path(args.output, input_paths)

    fixture = load_json(args.fixture)
    query_set = load_json(args.query_set)
    config = load_json(args.config)
    manifest = load_json(args.pool_manifest)
    validate_identity(
        fixture,
        query_set,
        config,
        manifest,
        args.config,
        args.capture,
    )

    queries = query_set.get("queries")
    configurations = config.get("queries")
    if not isinstance(queries, list) or not queries:
        raise ValueError("Query set must contain queries")
    if not isinstance(configurations, list):
        raise ValueError("Pool config must contain queries")
    queries_by_id = {query["id"]: query for query in queries}
    config_by_id = {item["id"]: item for item in configurations}
    if (
        len(queries_by_id) != len(queries)
        or len(config_by_id) != len(configurations)
        or list(queries_by_id) != list(config_by_id)
    ):
        raise ValueError("Query set and pool config IDs do not match")
    exclusions = parse_exclusions(getattr(args, "exclude_query", []), set(queries_by_id))
    known_docs = {doc["id"] for doc in fixture.get("docs", [])}

    capture = load_json(args.capture)
    validate_capture(capture, fixture, queries)

    rows_by_query = {query_id: [] for query_id in queries_by_id}
    rows = []
    seen = set()
    with Path(args.review_pool).open(encoding="utf-8-sig", newline="") as file:
        reader = csv.DictReader(file)
        if reader.fieldnames != REVIEW_FIELDS:
            raise ValueError("Review pool columns or column order changed")
        for line_number, row in enumerate(reader, start=2):
            query = queries_by_id.get(row["query_id"])
            if query is None:
                raise ValueError(f"Unknown query ID at line {line_number}")
            if row["split"] != query["split"] or row["query"] != query["query"]:
                raise ValueError(f"Query text or split changed at line {line_number}")
            if row["program_id"] not in known_docs:
                raise ValueError(f"Unknown program ID at line {line_number}")
            key = (row["query_id"], row["program_id"])
            if key in seen:
                raise ValueError(f"Duplicate query/program row at line {line_number}")
            seen.add(key)
            rows.append(row)
            rows_by_query[row["query_id"]].append(row)

    expected_counts = manifest.get("perQueryCounts")
    actual_counts = {query_id: len(items) for query_id, items in rows_by_query.items()}
    if len(rows) != manifest.get("reviewRowCount") or actual_counts != expected_counts:
        raise ValueError("Review-pool rows were added or deleted")
    if pool_key_sha256(rows) != manifest.get("poolKeySha256"):
        raise ValueError("Review-pool query/program keys changed")
    if review_structure_sha256(rows) != manifest.get("reviewStructureSha256"):
        raise ValueError("Immutable review-pool content changed")

    selection = load_selection(getattr(args, "selection", None), rows, manifest, args.review_pool)
    if selection:
        for query_id, reason in selection["excludedQueries"].items():
            if query_id not in queries_by_id:
                raise ValueError(f"Unknown selection-excluded query ID: {query_id}")
            if query_id in exclusions:
                exclusions[query_id] = f"{reason}; explicit exclusion: {exclusions[query_id]}"
            else:
                exclusions[query_id] = reason
    if len(exclusions) == len(queries_by_id):
        raise ValueError("At least one query must remain labeled")

    cases = []
    warnings = []
    for query in queries:
        query_id = query["id"]
        if query_id in exclusions:
            cases.append(
                {
                    "id": query_id,
                    "query": query["query"],
                    "split": query["split"],
                    "relevantIds": None,
                }
            )
            continue

        reviewed = []
        for row in rows_by_query[query_id]:
            decision = row["decision"].strip()
            reason = row["reason"].strip()
            reviewer = row["reviewer"].strip()
            if decision not in ALLOWED_DECISIONS:
                raise ValueError(f"Missing or invalid decision for {query_id}/{row['program_id']}")
            if decision in {"relevant", "unclear"} and not reason:
                raise ValueError(f"A reason is required for {query_id}/{row['program_id']}")
            if not reviewer:
                raise ValueError(f"A reviewer is required for {query_id}/{row['program_id']}")
            reviewed.append({"programId": row["program_id"], "decision": decision})

        if any(item["decision"] == "unclear" for item in reviewed):
            raise ValueError(f"Resolve or explicitly exclude every unclear query: {query_id}")
        relevant_ids = sorted(
            item["programId"] for item in reviewed if item["decision"] == "relevant"
        )
        warnings.extend(expected_judgment_warnings(query_id, config_by_id[query_id], relevant_ids))
        cases.append(
            {
                "id": query_id,
                "query": query["query"],
                "split": query["split"],
                "relevantIds": relevant_ids,
            }
        )

    source_hashes = {
        "fixtureSha256": sha256_path(args.fixture),
        "querySetSha256": sha256_path(args.query_set),
        "configSha256": sha256_path(args.config),
        "captureSha256": sha256_path(args.capture),
        "poolManifestSha256": sha256_path(args.pool_manifest),
        "reviewPoolSha256": sha256_path(args.review_pool),
    }
    mode = "legacy_unspecified" if selection is None else selection["mode"]
    if selection:
        source_hashes["selectionSha256"] = sha256_path(args.selection)
        for field in ("aiReviewSha256", "aiRecheckSha256", "additionalAiReviewSha256", "transferPlanSha256", "humanReviewSha256", "conversationJudgmentsSha256"):
            if selection.get(field) is not None:
                source_hashes[field] = selection[field]
    excluded_queries = [
        {"id": query["id"], "reason": exclusions[query["id"]]}
        for query in queries
        if query["id"] in exclusions
    ]
    labeled = dict(fixture)
    data_type_suffix = {
        "ai-only": "ai_consensus",
        "hybrid": "hybrid",
        "human": "human",
        "legacy_unspecified": "legacy_unspecified",
    }[mode]
    labeled["dataType"] = f"real_catalog_snapshot_labeled_pooled_{data_type_suffix}"
    labeled["cases"] = cases
    labeled["labelReview"] = {
        "schemaVersion": "support-program-label-review-v1",
        "mode": mode,
        "sourceHashes": source_hashes,
        "sourceCounts": selection["sourceCounts"] if selection else None,
        "requiredHumanReviewCount": selection["requiredHumanReviewCount"] if selection else None,
        "pendingHumanReviewCount": selection["pendingHumanReviewCount"] if selection else None,
        "counts": {
            "reviewRowCount": len(rows),
            "labeledQueryCount": sum(case["relevantIds"] is not None for case in cases),
            "excludedQueryCount": len(excluded_queries),
        },
        "excludedQueries": excluded_queries,
        "warnings": warnings,
    }
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    write_json_new(output_path, labeled)

    print(
        json.dumps(
            {
                "output": str(output_path),
                "reviewMode": mode,
                "queryCount": len(cases),
                "labeledQueryCount": sum(case["relevantIds"] is not None for case in cases),
                "excludedQueryCount": sum(case["relevantIds"] is None for case in cases),
                "relevantLabelCount": sum(len(case["relevantIds"] or []) for case in cases),
                "warningCount": len(warnings),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
