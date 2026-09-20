#!/usr/bin/env python3
"""Build one self-contained, offline human-review page from a verified pool."""

import argparse
import csv
import importlib.util
import json
import re
from pathlib import Path


REVIEW_DIR = Path(__file__).resolve().parent
_pool_spec = importlib.util.spec_from_file_location("browser_review_pool", REVIEW_DIR / "build-review-pool.py")
POOL = importlib.util.module_from_spec(_pool_spec)
_pool_spec.loader.exec_module(POOL)
from evaluate import load_fixture, _validate_capture_fixture


SCHEMA = "support-program-browser-review-v1"
IDENTITY_FIELDS = (
    "schemaVersion", "name", "referenceDate", "querySetSha256",
    "reviewStructureSha256", "poolKeySha256", "captureIncluded",
)
JUDGMENT_FIELDS = {"queryId", "programId", "decision", "reason", "reviewer", "provenance"}
ALLOWED_DECISIONS = {"", "relevant", "irrelevant", "unclear"}


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", required=True)
    parser.add_argument("--query-set", required=True)
    parser.add_argument("--review-pool", required=True)
    parser.add_argument("--pool-manifest", required=True)
    parser.add_argument("--conversation-judgments")
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def _unique_json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON field: {key}")
        result[key] = value
    return result


def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"), object_pairs_hook=_unique_json_object)


def require_keys(value, keys, description):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError(f"{description} must contain exactly: {', '.join(sorted(keys))}")


def require_text(value, description, maximum=None, nonempty=False):
    if not isinstance(value, str) or (maximum is not None and len(value) > maximum):
        raise ValueError(f"Invalid {description}")
    if nonempty and (not value.strip() or value != value.strip()):
        raise ValueError(f"{description} must be nonempty and trimmed")


def validate_judgment(judgment):
    require_keys(judgment, JUDGMENT_FIELDS, "Judgment")
    require_text(judgment["queryId"], "judgment queryId", nonempty=True)
    require_text(judgment["programId"], "judgment programId", nonempty=True)
    decision = judgment["decision"]
    if not isinstance(decision, str) or decision not in ALLOWED_DECISIONS:
        raise ValueError("Invalid judgment decision")
    require_text(judgment["reason"], "judgment reason", maximum=2000)
    require_text(judgment["reviewer"], "judgment reviewer", maximum=100)
    provenance = judgment["provenance"]
    if provenance is not None and not isinstance(provenance, dict):
        raise ValueError("Judgment provenance must be an object or null")
    if len(json.dumps(provenance, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > 10000:
        raise ValueError("Judgment provenance is too long")


def is_complete(judgment):
    return bool(
        judgment["decision"] and judgment["reviewer"].strip()
        and (judgment["decision"] == "irrelevant" or judgment["reason"].strip())
    )


def load_verified_pool(review_pool_path, manifest):
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != "support-program-review-pool-manifest-v1":
        raise ValueError("Unsupported review-pool manifest schema")
    require_text(manifest.get("name"), "manifest name", nonempty=True)
    if type(manifest.get("captureIncluded")) is not bool:
        raise ValueError("Manifest captureIncluded must be a boolean")
    for field in ("querySetSha256", "reviewStructureSha256", "poolKeySha256"):
        value = manifest.get(field)
        if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
            raise ValueError(f"Manifest {field} must be a SHA-256 hash")
    counts = manifest.get("perQueryCounts")
    if not isinstance(counts, dict) or not counts or any(
        not isinstance(key, str) or not key.strip() or type(count) is not int or count < 0
        for key, count in counts.items()
    ):
        raise ValueError("Manifest perQueryCounts is invalid")
    if type(manifest.get("reviewRowCount")) is not int or manifest["reviewRowCount"] < 1:
        raise ValueError("Manifest reviewRowCount must be a positive integer")
    with Path(review_pool_path).open(encoding="utf-8-sig", newline="") as file:
        reader = csv.DictReader(file)
        if reader.fieldnames != POOL.REVIEW_FIELDS:
            raise ValueError("Review pool columns or column order changed")
        rows = list(reader)
    seen = set()
    actual_counts = dict.fromkeys(counts, 0)
    for row in rows:
        require_keys(row, POOL.REVIEW_FIELDS, "Review row")
        if any(not isinstance(value, str) for value in row.values()):
            raise ValueError("Every review row must have all columns")
        key = (row["query_id"], row["program_id"])
        if key in seen:
            raise ValueError("Duplicate query/program row")
        if row["query_id"] not in actual_counts:
            raise ValueError("Unknown query ID in review pool")
        seen.add(key)
        actual_counts[row["query_id"]] += 1
        validate_judgment({
            "queryId": row["query_id"], "programId": row["program_id"],
            "decision": row["decision"], "reason": row["reason"],
            "reviewer": row["reviewer"], "provenance": None,
        })
    if len(rows) != manifest["reviewRowCount"] or actual_counts != counts:
        raise ValueError("Review-pool rows were added or deleted")
    if POOL.pool_key_sha256(rows) != manifest["poolKeySha256"]:
        raise ValueError("Review-pool query/program keys changed")
    if POOL.review_structure_sha256(rows) != manifest["reviewStructureSha256"]:
        raise ValueError("Immutable review-pool content changed")
    return rows


def review_identity(manifest):
    return {field: SCHEMA if field == "schemaVersion" else manifest[field] for field in IDENTITY_FIELDS}


def validate_sources(fixture, query_set, manifest, rows):
    _validate_capture_fixture(fixture, fixture.get("catalog"))
    if not fixture["docs"]:
        raise ValueError("Fixture must contain documents")
    if not isinstance(query_set, dict) or query_set.get("schemaVersion") != "support-program-search-query-set-v1":
        raise ValueError("Unsupported query-set schema")
    if query_set.get("name") != fixture["name"] or manifest["name"] != fixture["name"]:
        raise ValueError("Fixture, query set, and manifest names do not match")
    if manifest.get("referenceDate") != fixture["referenceDate"]:
        raise ValueError("Manifest referenceDate does not match fixture")
    if manifest.get("catalogFingerprint") != fixture["catalog"]["eligibleCatalogFingerprint"]:
        raise ValueError("Manifest catalog fingerprint does not match fixture")
    queries = query_set.get("queries")
    if not isinstance(queries, list) or not queries:
        raise ValueError("Query set must contain queries")
    queries_by_id = {}
    for query in queries:
        if not isinstance(query, dict):
            raise ValueError("Query must be an object")
        require_text(query.get("id"), "query id", nonempty=True)
        require_text(query.get("query"), "query text", nonempty=True)
        if query.get("split") not in {"dev", "heldout"}:
            raise ValueError("Query split must be dev or heldout")
        if query["id"] in queries_by_id:
            raise ValueError("Duplicate query ID")
        queries_by_id[query["id"]] = query
    if set(queries_by_id) != set(manifest["perQueryCounts"]):
        raise ValueError("Manifest query IDs do not match query set")
    if POOL.query_set_sha256(queries) != manifest["querySetSha256"]:
        raise ValueError("Manifest query-set hash does not match")
    docs_by_id = {doc["id"]: doc for doc in fixture["docs"]}
    for row in rows:
        query = queries_by_id[row["query_id"]]
        if row["query"] != query["query"] or row["split"] != query["split"]:
            raise ValueError("Review query text or split does not match query set")
        doc = docs_by_id.get(row["program_id"])
        if doc is None:
            raise ValueError("Review row contains an unknown document ID")
        if any(row[field] != value for field, value in POOL.parse_document(doc).items()):
            raise ValueError("Review document fields do not match fixture text")


def load_seeds(path, fixture, manifest, rows):
    if not path:
        return []
    seeds = load_json(path)
    require_keys(seeds, {"referenceDate", "querySetSha256", "reviewer", "reviewMethod", "judgments"}, "Conversation judgments")
    if any(seeds[field] != manifest[field] for field in ("referenceDate", "querySetSha256")):
        raise ValueError("Conversation judgments belong to a different snapshot or query set")
    require_text(seeds["reviewer"], "conversation reviewer", maximum=100, nonempty=True)
    require_text(seeds["reviewMethod"], "conversation review method", maximum=2000, nonempty=True)
    if not isinstance(seeds["judgments"], list):
        raise ValueError("Conversation judgments must be a list")
    rows_by_key = {(row["query_id"], row["program_id"]): row for row in rows}
    docs_by_id = {doc["id"]: doc for doc in fixture["docs"]}
    result = []
    seen = set()
    for seed in seeds["judgments"]:
        require_keys(seed, {"queryId", "programId", "contentHash", "presentedQuery", "presentedProgramTitle", "presentedProgramSummary", "decision", "userResponse", "userReason"}, "Conversation judgment")
        for field in ("presentedQuery", "presentedProgramTitle", "presentedProgramSummary", "userResponse"):
            require_text(seed[field], f"conversation {field}", maximum=2000, nonempty=True)
        if seed["userReason"] is not None:
            require_text(seed["userReason"], "conversation userReason", maximum=2000)
        judgment = {
            "queryId": seed["queryId"], "programId": seed["programId"],
            "decision": seed["decision"],
            "reason": seed["userReason"] or "대화에서 제시된 요약을 읽고 사용자가 판정함(별도 사유 미입력)",
            "reviewer": seeds["reviewer"],
            "provenance": {
                "kind": "conversation", "basis": "conversation_summary",
                "reviewMethod": seeds["reviewMethod"],
                **{field: seed[field] for field in ("userResponse", "userReason", "presentedQuery", "presentedProgramTitle", "presentedProgramSummary")},
            },
        }
        validate_judgment(judgment)
        if not judgment["decision"]:
            raise ValueError("Conversation judgment cannot be blank")
        key = (judgment["queryId"], judgment["programId"])
        if key in seen:
            raise ValueError("Duplicate conversation judgment")
        seen.add(key)
        original = rows_by_key.get(key)
        if original is None:
            raise ValueError("Conversation judgment is not in this review pool")
        if seed["contentHash"] != docs_by_id[judgment["programId"]]["contentHash"]:
            raise ValueError("Conversation judgment source contentHash changed")
        if any(original[field] for field in POOL.MUTABLE_REVIEW_FIELDS) and any(
            original[field] != judgment[field] for field in POOL.MUTABLE_REVIEW_FIELDS
        ):
            raise ValueError("Conversation judgment conflicts with an existing CSV judgment")
        result.append(judgment)
    return result


def script_json(value):
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    for character, escaped in (("<", "\\u003c"), (">", "\\u003e"), ("&", "\\u0026"), ("\u2028", "\\u2028"), ("\u2029", "\\u2029")):
        encoded = encoded.replace(character, escaped)
    return encoded


def main():
    args = parse_args()
    template_path = REVIEW_DIR / "review-page.html"
    POOL.validate_new_output_paths(
        [("Review page", args.output)],
        [("fixture", args.fixture), ("query set", args.query_set), ("review pool", args.review_pool),
         ("manifest", args.pool_manifest), ("conversation judgments", args.conversation_judgments),
         ("HTML template", template_path)],
    )
    fixture = load_fixture(args.fixture)
    query_set = load_json(args.query_set)
    manifest = load_json(args.pool_manifest)
    rows = load_verified_pool(args.review_pool, manifest)
    validate_sources(fixture, query_set, manifest, rows)
    seeds = load_seeds(args.conversation_judgments, fixture, manifest, rows)
    payload = {**review_identity(manifest), "rows": rows, "seedJudgments": seeds}
    template = template_path.read_text(encoding="utf-8")
    if template.count("__REVIEW_DATA__") != 1:
        raise ValueError("Review-page template must contain exactly one data token")
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x", encoding="utf-8") as file:
        file.write(template.replace("__REVIEW_DATA__", script_json(payload)))
    print(json.dumps({"output": str(output), "reviewRowCount": len(rows), "seedJudgmentCount": len(seeds), "captureIncluded": manifest["captureIncluded"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
