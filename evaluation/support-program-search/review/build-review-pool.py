#!/usr/bin/env python3
"""Build a deterministic blind review pool without calling external services."""

import argparse
import csv
import hashlib
import json
import re
import sys
import unicodedata
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from evaluate import validate_capture as validate_search_capture


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
PROVENANCE_FIELDS = [
    "query_id",
    "program_id",
    "in_production",
    "production_rank",
    "in_final",
    "final_rank",
    "in_keyword",
    "keyword_rank",
    "keyword_score",
    "in_broad",
    "broad_rank",
    "broad_score",
    "broad_matched_groups",
    "in_expected",
]
LINE_FIELDS = {
    "제목": "title",
    "기관": "organization",
    "지원대상": "target_description",
    "분야": "categories",
    "지역": "regions",
    "신청기간": "application_period",
    "내용": "summary",
}
KEYWORD_STOP_WORDS = {
    "지원",
    "지원받고",
    "기업",
    "개인",
    "비용",
    "싶어",
    "있는데",
    "필요해",
    "받을",
    "만드는",
    "관계없는",
    "일반",
}


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", required=True)
    parser.add_argument("--query-set", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--capture")
    parser.add_argument("--previous-review")
    parser.add_argument("--review-pool", required=True)
    parser.add_argument("--provenance", required=True)
    parser.add_argument("--pool-manifest", required=True)
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


def validate_new_output_paths(output_paths, input_paths):
    outputs = [(description, Path(path), Path(path).resolve(strict=False)) for description, path in output_paths]
    inputs = [(description, Path(path).resolve(strict=False)) for description, path in input_paths if path]
    resolved_outputs = [resolved for _, _, resolved in outputs]
    if len(resolved_outputs) != len(set(resolved_outputs)):
        raise ValueError("Output paths must be distinct")
    for index, resolved in enumerate(resolved_outputs):
        for other in resolved_outputs[index + 1 :]:
            if resolved in other.parents or other in resolved.parents:
                raise ValueError("An output path cannot contain another output path")
    input_aliases = {resolved for _, resolved in inputs}
    for description, raw_path, resolved in outputs:
        if raw_path.exists() or raw_path.is_symlink():
            raise FileExistsError(f"{description} already exists: {raw_path}")
        if resolved in input_aliases:
            raise ValueError(f"{description} aliases an input path: {raw_path}")


def normalize(value):
    return unicodedata.normalize("NFC", value).casefold()


def tokenize(value):
    return set(re.findall(r"[a-z0-9가-힣]+", normalize(value)))


def contains_any(value, terms):
    haystack = normalize(value)
    return any(normalize(term) in haystack for term in terms)


def deterministic_tie_key(query_id, program_id):
    return hashlib.sha256(f"{query_id}:{program_id}".encode("utf-8")).hexdigest()


def parse_document(doc):
    parsed = {field: "" for field in LINE_FIELDS.values()}
    for line in doc["text"].splitlines():
        label, separator, value = line.partition(":")
        field = LINE_FIELDS.get(label.strip())
        if separator and field and not parsed[field]:
            parsed[field] = value.strip()
    if not parsed["title"]:
        raise ValueError(f"Document has no title line: {doc['id']}")
    return parsed


def validate_inputs(fixture, query_set, config):
    if query_set.get("schemaVersion") != "support-program-search-query-set-v1":
        raise ValueError("Unsupported query-set schema")
    if config.get("schemaVersion") != "support-program-review-pool-config-v1":
        raise ValueError("Unsupported pool-config schema")
    if query_set.get("name") != fixture.get("name"):
        raise ValueError("Query-set name does not match fixture name")
    if config.get("querySetName") != query_set.get("name"):
        raise ValueError("Pool-config name does not match query-set name")

    queries = query_set.get("queries")
    configurations = config.get("queries")
    if not isinstance(queries, list) or not isinstance(configurations, list):
        raise ValueError("Queries and configurations must be lists")
    query_ids = [query.get("id") for query in queries]
    config_ids = [item.get("id") for item in configurations]
    if len(query_ids) != len(set(query_ids)) or len(config_ids) != len(set(config_ids)):
        raise ValueError("Duplicate query or pool-config ID")
    if query_ids != config_ids:
        raise ValueError("Pool-config query IDs and order must match the query set")
    if any(query.get("split") not in {"dev", "heldout"} for query in queries):
        raise ValueError("Every query split must be dev or heldout")

    docs = fixture.get("docs")
    if not isinstance(docs, list) or not docs:
        raise ValueError("Fixture must contain documents")
    doc_ids = [doc.get("id") for doc in docs]
    if len(doc_ids) != len(set(doc_ids)):
        raise ValueError("Fixture contains duplicate document IDs")
    known_ids = set(doc_ids)
    for item in configurations:
        outcome = item.get("expectedOutcome")
        expected = item.get("expectedExampleIds")
        if outcome not in {"match", "no_match"}:
            raise ValueError(f"Invalid expected outcome for {item['id']}")
        if not isinstance(expected, list) or not set(expected) <= known_ids:
            raise ValueError(f"Unknown expected example ID for {item['id']}")
        if outcome == "match" and not expected:
            raise ValueError(f"Match query requires an expected example for {item['id']}")
        if outcome == "no_match" and expected:
            raise ValueError(f"No-match query cannot have an expected example for {item['id']}")
        for field in ("regionTerms", "targetTerms", "intentGroups"):
            if not isinstance(item.get(field), list):
                raise ValueError(f"Invalid {field} for {item['id']}")
        if not item["intentGroups"] or any(
            not isinstance(group, list) or not group for group in item["intentGroups"]
        ):
            raise ValueError(f"Every query requires nonempty intent groups for {item['id']}")

    for limit_name in ("keywordLimit", "broadLimit", "broadTieLimit"):
        limit = config.get(limit_name)
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
            raise ValueError(f"{limit_name} must be a positive integer")
    if config["broadTieLimit"] < config["broadLimit"]:
        raise ValueError("broadTieLimit cannot be smaller than broadLimit")


def keyword_candidates(docs, query_id, query, limit):
    query_words = tokenize(query) - KEYWORD_STOP_WORDS
    scored = []
    for doc in docs:
        score = len(query_words & tokenize(doc["text"]))
        if score > 0:
            scored.append((doc, score))
    scored.sort(key=lambda item: (-item[1], deterministic_tie_key(query_id, item[0]["id"])))
    return [(doc["id"], score) for doc, score in scored[:limit]]


def broad_candidates(docs, query_id, configuration, limit, tie_limit):
    region_terms = configuration["regionTerms"]
    target_terms = configuration["targetTerms"]
    intent_groups = configuration["intentGroups"]
    scored = []
    for doc in docs:
        fields = parse_document(doc)
        matched_groups = []
        for index, terms in enumerate(intent_groups, start=1):
            matched_terms = [term for term in terms if contains_any(doc["text"], [term])]
            if matched_terms:
                matched_groups.append(f"G{index}:{matched_terms[0]}")
        if not matched_groups:
            continue

        score = 2 * len(matched_groups)
        title_terms = [term for group in intent_groups for term in group]
        if contains_any(fields["title"], title_terms):
            score += 3
        if region_terms and contains_any(doc["text"], region_terms):
            score += 2
        if target_terms and contains_any(doc["text"], target_terms):
            score += 2
        priority = 1 if len(matched_groups) >= 2 else 0
        scored.append((doc, priority, score, matched_groups))

    scored.sort(
        key=lambda item: (
            -item[1],
            -item[2],
            deterministic_tie_key(query_id, item[0]["id"]),
        )
    )
    selected = scored[:limit]
    if selected:
        cutoff = (selected[-1][1], selected[-1][2])
        for item in scored[limit:]:
            if len(selected) >= tie_limit or (item[1], item[2]) != cutoff:
                break
            selected.append(item)
    return [
        (doc["id"], score, matched_groups)
        for doc, _, score, matched_groups in selected
    ]


def load_capture(path, fixture, query_set):
    empty = {query["id"]: ([], []) for query in query_set["queries"]}
    if path is None:
        return empty, None

    capture = load_json(path)
    validation_cases = [
        {
            "id": query["id"],
            "query": query["query"],
            "split": query["split"],
            "relevantIds": [],
        }
        for query in query_set["queries"]
    ]
    validation_fixture = dict(fixture)
    validation_fixture["cases"] = validation_cases
    stages = validate_search_capture(capture, validation_fixture, validation_cases)
    if capture.get("acceptingOnly") is not True:
        raise ValueError("Capture must use acceptingOnly=true")
    search = capture.get("search", {})
    if search.get("candidateLimit") != 20 or search.get("finalResultLimit") != 5:
        raise ValueError("Capture must use candidateLimit=20 and finalResultLimit=5")
    captured = {
        query["id"]: (
            stages["candidate"][query["id"]],
            stages["final"][query["id"]],
        )
        for query in query_set["queries"]
    }
    return captured, capture


def rank_map(items):
    return {item[0]: (rank, *item[1:]) for rank, item in enumerate(items, start=1)}


def bool_text(value):
    return "true" if value else "false"


def load_previous_review(path):
    if path is None:
        return {}
    previous = {}
    with Path(path).open(encoding="utf-8-sig", newline="") as file:
        reader = csv.DictReader(file)
        if reader.fieldnames != REVIEW_FIELDS:
            raise ValueError("Previous review columns or column order changed")
        for row in reader:
            key = (row["query_id"], row["program_id"])
            if key in previous:
                raise ValueError("Previous review contains duplicate query/program rows")
            previous[key] = row
    return previous


def has_review_judgment(row):
    return any(row[field].strip() for field in MUTABLE_REVIEW_FIELDS)


def write_json_new(path, value):
    with Path(path).open("x", encoding="utf-8") as file:
        json.dump(value, file, ensure_ascii=False, indent=2)
        file.write("\n")


def main():
    args = parse_args()
    output_paths = [
        ("Review pool", args.review_pool),
        ("Provenance", args.provenance),
        ("Pool manifest", args.pool_manifest),
    ]
    input_paths = [
        ("Fixture", args.fixture),
        ("Query set", args.query_set),
        ("Pool config", args.config),
        ("Capture", args.capture),
        ("Previous review", args.previous_review),
    ]
    validate_new_output_paths(output_paths, input_paths)

    fixture = load_json(args.fixture)
    query_set = load_json(args.query_set)
    config = load_json(args.config)
    validate_inputs(fixture, query_set, config)

    docs = fixture["docs"]
    docs_by_id = {doc["id"]: doc for doc in docs}
    config_by_id = {item["id"]: item for item in config["queries"]}
    captured, capture = load_capture(args.capture, fixture, query_set)
    previous_review = load_previous_review(args.previous_review)
    review_rows = []
    provenance_rows = []
    per_query_counts = {}

    for query in query_set["queries"]:
        query_id = query["id"]
        configuration = config_by_id[query_id]
        keyword = keyword_candidates(docs, query_id, query["query"], config["keywordLimit"])
        broad = broad_candidates(
            docs,
            query_id,
            configuration,
            config["broadLimit"],
            config["broadTieLimit"],
        )
        production_ids, final_ids = captured[query_id]
        production = [(program_id,) for program_id in production_ids]
        final = [(program_id,) for program_id in final_ids]
        expected = [(program_id,) for program_id in configuration["expectedExampleIds"]]

        keyword_by_id = rank_map(keyword)
        broad_by_id = rank_map(broad)
        production_by_id = rank_map(production)
        final_by_id = rank_map(final)
        expected_by_id = rank_map(expected)
        pool_ids = (
            set(keyword_by_id)
            | set(broad_by_id)
            | set(production_by_id)
            | set(expected_by_id)
        )

        blind_ids = sorted(
            pool_ids,
            key=lambda program_id: deterministic_tie_key(query_id, program_id),
        )
        for program_id in blind_ids:
            fields = parse_document(docs_by_id[program_id])
            previous = previous_review.get((query_id, program_id))
            row = {
                "query_id": query_id,
                "split": query["split"],
                "query": query["query"],
                "decision": "",
                "reason": "",
                "reviewer": "",
                **fields,
                "program_id": program_id,
            }
            if previous:
                if any(previous[field] != row[field] for field in IMMUTABLE_REVIEW_FIELDS):
                    raise ValueError(
                        f"Previous review does not match the current pool for {query_id}/{program_id}"
                    )
                for field in MUTABLE_REVIEW_FIELDS:
                    row[field] = previous[field]
            review_rows.append(row)

        for program_id in sorted(pool_ids):
            keyword_value = keyword_by_id.get(program_id)
            broad_value = broad_by_id.get(program_id)
            production_value = production_by_id.get(program_id)
            final_value = final_by_id.get(program_id)
            provenance_rows.append(
                {
                    "query_id": query_id,
                    "program_id": program_id,
                    "in_production": bool_text(production_value is not None),
                    "production_rank": production_value[0] if production_value else "",
                    "in_final": bool_text(final_value is not None),
                    "final_rank": final_value[0] if final_value else "",
                    "in_keyword": bool_text(keyword_value is not None),
                    "keyword_rank": keyword_value[0] if keyword_value else "",
                    "keyword_score": keyword_value[1] if keyword_value else "",
                    "in_broad": bool_text(broad_value is not None),
                    "broad_rank": broad_value[0] if broad_value else "",
                    "broad_score": broad_value[1] if broad_value else "",
                    "broad_matched_groups": " | ".join(broad_value[2]) if broad_value else "",
                    "in_expected": bool_text(program_id in expected_by_id),
                }
            )
        per_query_counts[query_id] = len(pool_ids)

    current_keys = {(row["query_id"], row["program_id"]) for row in review_rows}
    vanished_judgments = sorted(
        key for key, row in previous_review.items()
        if key not in current_keys and has_review_judgment(row)
    )
    if vanished_judgments:
        formatted = ", ".join(f"{query_id}/{program_id}" for query_id, program_id in vanished_judgments)
        raise ValueError(f"Previously judged rows disappeared from the current pool: {formatted}")

    review_path = Path(args.review_pool)
    provenance_path = Path(args.provenance)
    manifest_path = Path(args.pool_manifest)
    for output_path in (review_path, provenance_path, manifest_path):
        output_path.parent.mkdir(parents=True, exist_ok=True)
    with review_path.open("x", encoding="utf-8-sig", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=REVIEW_FIELDS)
        writer.writeheader()
        writer.writerows(review_rows)
    with provenance_path.open("x", encoding="utf-8-sig", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=PROVENANCE_FIELDS)
        writer.writeheader()
        writer.writerows(provenance_rows)

    manifest = {
        "schemaVersion": "support-program-review-pool-manifest-v1",
        "name": query_set["name"],
        "referenceDate": fixture["referenceDate"],
        "catalogFingerprint": fixture["catalog"]["eligibleCatalogFingerprint"],
        "querySetSha256": query_set_sha256(query_set["queries"]),
        "configSha256": sha256_path(args.config),
        "captureIncluded": capture is not None,
        "captureFileSha256": sha256_path(args.capture) if capture is not None else None,
        "candidateLimit": capture["search"]["candidateLimit"] if capture is not None else None,
        "finalResultLimit": capture["search"]["finalResultLimit"] if capture is not None else None,
        "reviewRowCount": len(review_rows),
        "perQueryCounts": per_query_counts,
        "poolKeySha256": pool_key_sha256(review_rows),
        "reviewStructureSha256": review_structure_sha256(review_rows),
        "generatedReviewCsvSha256": sha256_path(review_path),
        "provenanceCsvSha256": sha256_path(provenance_path),
        "expectedOutcomes": {
            item["id"]: item["expectedOutcome"] for item in config["queries"]
        },
        "expectedExampleIds": {
            item["id"]: item["expectedExampleIds"] for item in config["queries"]
        },
    }
    write_json_new(manifest_path, manifest)

    print(
        json.dumps(
            {
                "queryCount": len(query_set["queries"]),
                "reviewRowCount": len(review_rows),
                "captureIncluded": capture is not None,
                "perQueryCounts": per_query_counts,
                "poolManifest": str(manifest_path),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
