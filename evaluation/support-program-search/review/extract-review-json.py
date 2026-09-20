#!/usr/bin/env python3
"""Recover a full review CSV from browser judgments without trusting exported content."""

import argparse
import csv
import importlib.util
import json
from pathlib import Path


_spec = importlib.util.spec_from_file_location("browser_review_page", Path(__file__).with_name("build-review-page.py"))
PAGE = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(PAGE)


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--review-pool", required=True)
    parser.add_argument("--pool-manifest", required=True)
    parser.add_argument("--review-json", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def apply_judgments(rows, manifest, export):
    PAGE.require_keys(export, set(PAGE.IDENTITY_FIELDS) | {"reviewer", "judgments"}, "Browser review export")
    identity = PAGE.review_identity(manifest)
    if type(export["captureIncluded"]) is not bool or any(export[field] != value for field, value in identity.items()):
        raise ValueError("Browser review export belongs to a different review pool")
    PAGE.require_text(export["reviewer"], "export reviewer", maximum=100)
    judgments = export["judgments"]
    if not isinstance(judgments, list) or len(judgments) != len(rows):
        raise ValueError("Browser review export must contain every original row, including unreviewed rows")
    expected_keys = {(row["query_id"], row["program_id"]) for row in rows}
    by_key = {}
    for judgment in judgments:
        PAGE.validate_judgment(judgment)
        key = (judgment["queryId"], judgment["programId"])
        if key not in expected_keys:
            raise ValueError("Unknown browser review query/program row")
        if key in by_key:
            raise ValueError("Duplicate browser review query/program row")
        by_key[key] = judgment
    if set(by_key) != expected_keys:
        raise ValueError("Browser review export is missing original rows")
    return [
        {**row, **{field: by_key[(row["query_id"], row["program_id"])][field] for field in PAGE.POOL.MUTABLE_REVIEW_FIELDS}}
        for row in rows
    ]


def main():
    args = parse_args()
    PAGE.POOL.validate_new_output_paths(
        [("Converted review CSV", args.output)],
        [("review pool", args.review_pool), ("manifest", args.pool_manifest), ("browser review JSON", args.review_json)],
    )
    manifest = PAGE.load_json(args.pool_manifest)
    rows = PAGE.load_verified_pool(args.review_pool, manifest)
    export = PAGE.load_json(args.review_json)
    output_rows = apply_judgments(rows, manifest, export)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x", encoding="utf-8-sig", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=PAGE.POOL.REVIEW_FIELDS)
        writer.writeheader()
        writer.writerows(output_rows)
    completed = sum(PAGE.is_complete(row) for row in output_rows)
    selected = sum(bool(row["decision"]) for row in output_rows)
    print(json.dumps({"output": str(output), "reviewRowCount": len(output_rows), "completedRowCount": completed, "incompleteRowCount": selected - completed, "unselectedRowCount": len(output_rows) - selected, "note": "Draft judgments are preserved, not certified as complete. Keep the original JSON for provenance; CSV contains only the existing review columns."}, ensure_ascii=False))


if __name__ == "__main__":
    main()
