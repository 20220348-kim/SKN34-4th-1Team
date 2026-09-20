#!/usr/bin/env python3
"""Reuse fixed AI judgments and judge only new pairs from a real search capture."""

import argparse
import csv
import hashlib
import io
import json
from pathlib import Path
from types import SimpleNamespace
import importlib.util


HERE = Path(__file__).resolve().parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SELECT = load("transfer_selection", "select-review-mode.py")
RUNNER = load("transfer_runner", "run-ai-review.py")
RECHECK = load("transfer_recheck", "recheck-ai-review.py")
PAGE = RUNNER.PAGE
POOL = PAGE.POOL
SCHEMA = "support-program-review-selection-transfer-v1"
PLAN_SCHEMA = "support-program-ai-transfer-plan-v1"
STABLE_FIELDS = ("name", "referenceDate", "catalogFingerprint", "querySetSha256", "configSha256")


def row_key(row):
    return row["query_id"], row["program_id"]


def csv_bytes(rows):
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=POOL.REVIEW_FIELDS)
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue().encode("utf-8-sig")


def expected_pairs(fixture, queries, config, captured):
    configurations = {item["id"]: item for item in config["queries"]}
    result = set()
    for query in queries["queries"]:
        qid = query["id"]
        configuration = configurations[qid]
        ids = set(captured[qid][0]) | set(configuration["expectedExampleIds"])
        ids.update(item[0] for item in POOL.keyword_candidates(
            fixture["docs"], qid, query["query"], config["keywordLimit"]))
        ids.update(item[0] for item in POOL.broad_candidates(
            fixture["docs"], qid, configuration, config["broadLimit"], config["broadTieLimit"]))
        result.update((qid, pid) for pid in ids)
    return result


def sources(args):
    fixture = PAGE.load_fixture(args.fixture)
    queries = PAGE.load_json(args.query_set)
    config = PAGE.load_json(args.config)
    POOL.validate_inputs(fixture, queries, config)
    previous_manifest = PAGE.load_json(args.previous_manifest)
    final_manifest = PAGE.load_json(args.pool_manifest)
    previous_rows = PAGE.load_verified_pool(args.previous_pool, previous_manifest)
    final_rows = PAGE.load_verified_pool(args.review_pool, final_manifest)
    for manifest, rows in ((previous_manifest, previous_rows), (final_manifest, final_rows)):
        PAGE.validate_sources(fixture, queries, manifest, rows)
        if manifest.get("configSha256") != RUNNER.file_hash(args.config):
            raise ValueError("Pool configuration changed")
        if any(any(row[field] for field in POOL.MUTABLE_REVIEW_FIELDS) for row in rows):
            raise ValueError("Transfer requires the original unjudged pools")
    if previous_manifest["captureIncluded"] is not False or final_manifest["captureIncluded"] is not True:
        raise ValueError("Transfer requires a draft source and a final pool with a real search capture")
    if any(previous_manifest[field] != final_manifest[field] for field in STABLE_FIELDS):
        raise ValueError("Snapshot, queries, or pool configuration changed")
    captured, _ = POOL.load_capture(args.capture, fixture, queries)
    if (final_manifest.get("captureFileSha256") != RUNNER.file_hash(args.capture)
            or final_manifest.get("candidateLimit") != 20 or final_manifest.get("finalResultLimit") != 5):
        raise ValueError("Final pool capture identity changed")
    empty = {query["id"]: ([], []) for query in queries["queries"]}
    if set(map(row_key, previous_rows)) != expected_pairs(fixture, queries, config, empty):
        raise ValueError("Previous pool does not match the fixed draft configuration")
    if set(map(row_key, final_rows)) != expected_pairs(fixture, queries, config, captured):
        raise ValueError("Final pool does not contain exactly the configured real capture pool")
    previous = {row_key(row): row for row in previous_rows}
    final = {row_key(row): row for row in final_rows}
    if not previous.keys() <= final.keys():
        raise ValueError("Previously judged pairs disappeared")
    for pair, row in previous.items():
        if any(row[field] != final[pair][field] for field in POOL.IMMUTABLE_REVIEW_FIELDS):
            raise ValueError("Previously judged content changed")
    ai = PAGE.load_json(args.ai_review)
    RUNNER.validate_ai_review(ai, fixture, previous_manifest, previous_rows)
    if ai["fixtureSha256"] != RUNNER.file_hash(args.fixture) or ai["status"] != "complete":
        raise ValueError("Previous AI review is incomplete or its fixture changed")
    recheck = PAGE.load_json(args.ai_recheck) if args.ai_recheck else None
    if recheck is not None:
        RECHECK.validate_recheck(recheck, ai, RUNNER.file_hash(args.ai_review), fixture, previous_manifest, previous_rows)
    added = [row for row in final_rows if row_key(row) not in previous]
    hashes = {field: RUNNER.file_hash(getattr(args, argument)) for field, argument in (
        ("fixtureSha256", "fixture"), ("querySetFileSha256", "query_set"), ("configSha256", "config"),
        ("captureSha256", "capture"), ("previousPoolSha256", "previous_pool"),
        ("previousManifestSha256", "previous_manifest"), ("finalPoolSha256", "review_pool"),
        ("finalManifestSha256", "pool_manifest"), ("aiReviewSha256", "ai_review"))}
    hashes["aiRecheckSha256"] = RUNNER.file_hash(args.ai_recheck) if args.ai_recheck else None
    plan = {"schemaVersion": PLAN_SCHEMA, "identity": PAGE.review_identity(final_manifest),
            "sourceHashes": hashes, "policySha256": ai["policySha256"],
            "previousPairCount": len(previous_rows), "additionalPairCount": len(added),
            "additionalJudgmentCount": 5 * len(added),
            "additionalPairs": [{"queryId": row["query_id"], "programId": row["program_id"]} for row in added]}
    return fixture, queries, previous_manifest, previous_rows, final_manifest, final_rows, ai, recheck, added, plan


def additional_manifest(final_manifest, previous_manifest, rows):
    return {"schemaVersion": "support-program-review-pool-manifest-v1",
            **{field: final_manifest[field] for field in STABLE_FIELDS},
            "captureIncluded": False, "captureFileSha256": None,
            "candidateLimit": None, "finalResultLimit": None,
            "reviewRowCount": len(rows),
            "perQueryCounts": {qid: sum(row["query_id"] == qid for row in rows)
                               for qid in final_manifest["perQueryCounts"]},
            "poolKeySha256": POOL.pool_key_sha256(rows),
            "reviewStructureSha256": POOL.review_structure_sha256(rows),
            "generatedReviewCsvSha256": hashlib.sha256(csv_bytes(rows)).hexdigest(),
            "parentPoolIdentity": PAGE.review_identity(final_manifest),
            "parentCaptureFileSha256": final_manifest["captureFileSha256"],
            "previousPoolKeySha256": previous_manifest["poolKeySha256"]}


def prepare(args):
    POOL.validate_new_output_paths([("Transfer directory", args.output_dir)],
        [("input", value) for value in vars(args).values() if isinstance(value, str) and value != args.output_dir])
    fixture, _, previous_manifest, _, manifest, _, ai, _, added, plan = sources(args)
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=False)
    RUNNER.write_new_json(output / "transfer-plan.json", plan)
    if added:
        pool_path = output / "review-pool.csv"
        manifest_path = output / "review-pool-manifest.json"
        with pool_path.open("xb") as file:
            file.write(csv_bytes(added))
        RUNNER.write_new_json(manifest_path, additional_manifest(manifest, previous_manifest, added))
        RUNNER.prepare(SimpleNamespace(fixture=args.fixture, query_set=args.query_set,
            review_pool=str(pool_path), pool_manifest=str(manifest_path), model=ai["policy"]["model"],
            output_dir=str(output / "prepared")))
    print(json.dumps({"outputDirectory": str(output), "previousPairCount": plan["previousPairCount"],
                      "additionalPairCount": len(added), "additionalJudgmentCount": 5 * len(added)}))
    return plan


def source_selection(manifest, rows, ai, ai_hash, recheck=None, recheck_hash=None):
    selection, _, _ = SELECT.compose_selection("ai-only", rows, manifest, ai_review=ai,
        ai_review_sha256=ai_hash, ai_recheck=recheck, ai_recheck_sha256=recheck_hash)
    return {"manifest": manifest, "selection": selection,
            "canonicalSelectionSha256": RUNNER.canonical_hash(selection)}


def compose_selection(rows, manifest, source_selections, transfer_plan_hash, conversation_hash=None):
    records = {SELECT.key(record): record for source in source_selections for record in source["selection"]["records"]}
    ordered = [records[row_key(row)] for row in rows]
    output_rows = [{**row, **{field: record[field] for field in POOL.MUTABLE_REVIEW_FIELDS}}
                   for row, record in zip(rows, ordered)]
    encoded = csv_bytes(output_rows)
    previous = source_selections[0]["selection"]
    additional = source_selections[1]["selection"] if len(source_selections) == 2 else None
    pending = sum(source["selection"]["aiPendingCount"] for source in source_selections)
    selection = {"schemaVersion": SCHEMA, "identity": PAGE.review_identity(manifest), "mode": "ai-only",
        "records": ordered, "reviewedCsvSha256": hashlib.sha256(encoded).hexdigest(),
        "aiReviewSha256": previous["aiReviewSha256"], "aiRecheckSha256": previous.get("aiRecheckSha256"),
        "additionalAiReviewSha256": additional["aiReviewSha256"] if additional else None,
        "transferPlanSha256": transfer_plan_hash,
        "humanReviewSha256": None, "conversationJudgmentsSha256": conversation_hash,
        "aiPendingCount": pending, "hybridSample": [], "transferSources": source_selections,
        **SELECT.summarize("ai-only", ordered, manifest, pending)}
    return selection, encoded, output_rows


def validate_selection(selection, rows, manifest):
    """Validate each unchanged source under its own pool, then the exact combined result."""
    PAGE.require_keys(selection, SELECT.SELECTION_FIELDS | {
        "aiRecheckSha256", "additionalAiReviewSha256", "transferPlanSha256", "transferSources"}, "Transferred AI selection")
    if selection["schemaVersion"] != SCHEMA or selection["mode"] != "ai-only" or manifest["captureIncluded"] is not True:
        raise ValueError("Transferred AI selection requires ai-only and a final capture pool")
    if (POOL.pool_key_sha256(rows) != manifest["poolKeySha256"]
            or POOL.review_structure_sha256(rows) != manifest["reviewStructureSha256"]
            or type(manifest.get("reviewRowCount")) is not int or len(rows) != manifest["reviewRowCount"]):
        raise ValueError("Final transfer pool rows or immutable content changed")
    counts = {qid: sum(row["query_id"] == qid for row in rows) for qid in manifest["perQueryCounts"]}
    if (counts != manifest["perQueryCounts"]
            or any(type(count) is not int for count in manifest["perQueryCounts"].values())):
        raise ValueError("Final transfer pool counts changed")
    SELECT.require_hash(selection["conversationJudgmentsSha256"], "conversationJudgmentsSha256", optional=True)
    SELECT.require_hash(selection["transferPlanSha256"], "transferPlanSha256")
    source_selections = selection["transferSources"]
    if not isinstance(source_selections, list) or len(source_selections) not in {1, 2}:
        raise ValueError("Transfer requires one previous source and at most one additional source")
    row_map = {row_key(row): row for row in rows}
    covered = set()
    for index, source in enumerate(source_selections):
        PAGE.require_keys(source, {"manifest", "selection", "canonicalSelectionSha256"}, "Transfer source")
        source_manifest, selected = source["manifest"], source["selection"]
        if (selected.get("schemaVersion") not in {SELECT.SCHEMA, SELECT.SCHEMA_RECHECK}
                or selected.get("mode") != "ai-only"):
            raise ValueError("Transfer sources must be original AI-only selections")
        if (source_manifest.get("captureIncluded") is not False
                or any(source_manifest.get(field) != manifest.get(field) for field in STABLE_FIELDS)):
            raise ValueError("Transferred source snapshot, query set, or configuration changed")
        if source["canonicalSelectionSha256"] != RUNNER.canonical_hash(selected):
            raise ValueError("Transferred source selection changed")
        source_rows = []
        for record in selected["records"]:
            pair = SELECT.key(record)
            if pair not in row_map or pair in covered:
                raise ValueError("Unknown or overlapping transferred pair")
            covered.add(pair)
            source_rows.append({**row_map[pair], **{field: record[field] for field in POOL.MUTABLE_REVIEW_FIELDS}})
        if type(source_manifest.get("reviewRowCount")) is not int or len(source_rows) != source_manifest["reviewRowCount"]:
            raise ValueError("Transferred source row count changed")
        counts = {qid: sum(row["query_id"] == qid for row in source_rows) for qid in manifest["perQueryCounts"]}
        if (counts != source_manifest.get("perQueryCounts")
                or any(type(count) is not int for count in source_manifest["perQueryCounts"].values())):
            raise ValueError("Transferred source per-query counts changed")
        SELECT.validate_selection(selected, source_rows, source_manifest)
        if selected["reviewedCsvSha256"] != hashlib.sha256(csv_bytes(source_rows)).hexdigest():
            raise ValueError("Transferred source CSV hash changed")
        if index == 0 and selected["aiPendingCount"]:
            raise ValueError("Previous AI source must be complete")
        if index == 1:
            unjudged = [{**row, **dict.fromkeys(POOL.MUTABLE_REVIEW_FIELDS, "")} for row in source_rows]
            if source_manifest != additional_manifest(manifest, source_selections[0]["manifest"], unjudged):
                raise ValueError("Additional source does not match the final capture difference")
            if selected["schemaVersion"] != SELECT.SCHEMA:
                raise ValueError("Additional transfer source must use its original five judgments")
    if covered != set(row_map) or len(row_map) != len(rows):
        raise ValueError("Transferred selections must cover every final pair exactly once")
    expected, _, expected_rows = compose_selection(rows, manifest, source_selections,
        selection["transferPlanSha256"], selection["conversationJudgmentsSha256"])
    if expected_rows != rows or RUNNER.canonical_hash(selection) != RUNNER.canonical_hash(expected):
        raise ValueError("Transferred selection differs from its verified sources")
    return selection


def select(args):
    POOL.validate_new_output_paths([("Selection directory", args.output_dir)],
        [("input", value) for value in vars(args).values() if isinstance(value, str) and value != args.output_dir])
    fixture, _, previous_manifest, previous_rows, manifest, rows, ai, recheck, added, plan = sources(args)
    additional_dir = Path(args.additional_dir)
    if PAGE.load_json(additional_dir / "transfer-plan.json") != plan:
        raise ValueError("Transfer plan or fixed source hashes changed")
    hashes = plan["sourceHashes"]
    selections = [source_selection(previous_manifest, previous_rows, ai, hashes["aiReviewSha256"],
                                   recheck, hashes["aiRecheckSha256"])]
    if added:
        if not args.additional_ai_review:
            raise ValueError("New capture pairs require their separate AI review")
        added_manifest = PAGE.load_json(additional_dir / "review-pool-manifest.json")
        added_rows = PAGE.load_verified_pool(additional_dir / "review-pool.csv", added_manifest)
        if added_rows != added or added_manifest != additional_manifest(manifest, previous_manifest, added):
            raise ValueError("Additional review pool changed")
        additional_ai = PAGE.load_json(args.additional_ai_review)
        RUNNER.validate_ai_review(additional_ai, fixture, added_manifest, added)
        if additional_ai["fixtureSha256"] != hashes["fixtureSha256"] or additional_ai["policy"] != ai["policy"]:
            raise ValueError("Additional AI fixture or policy changed")
        old_agents = {vote["agentId"] for vote in ai["judgments"]}
        if recheck is not None:
            old_agents.update(vote["agentId"] for vote in recheck["judgments"])
        if old_agents.intersection(vote["agentId"] for vote in additional_ai["judgments"]):
            raise ValueError("Additional pairs require new independent agents")
        selections.append(source_selection(added_manifest, added, additional_ai, RUNNER.file_hash(args.additional_ai_review)))
    elif args.additional_ai_review:
        raise ValueError("No new pairs exist; an additional AI review is not allowed")
    seeds = PAGE.load_seeds(args.conversation_judgments, fixture, manifest, rows)
    progress = SELECT.human_progress(rows, manifest, seeds=seeds)
    conversation_hash = RUNNER.file_hash(args.conversation_judgments) if args.conversation_judgments else None
    selection, encoded, selected_rows = compose_selection(rows, manifest, selections,
        RUNNER.file_hash(additional_dir / "transfer-plan.json"), conversation_hash)
    validate_selection(selection, selected_rows, manifest)
    html = SELECT.build_human_page(selection, progress, rows, manifest)
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=False)
    with (output / "reviewed.csv").open("xb") as file:
        file.write(encoded)
    RUNNER.write_new_json(output / "selection.json", selection)
    RUNNER.write_new_json(output / "review-progress.json", progress)
    with (output / "review.html").open("x", encoding="utf-8") as file:
        file.write(html)
    print(json.dumps({"outputDirectory": str(output), **{field: selection[field] for field in
        ("status", "sourceCounts", "aiPendingCount", "evaluableQueryCount", "excludedQueries")}}, ensure_ascii=False))
    return selection


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("prepare", "select"):
        child = commands.add_parser(command)
        for name in ("fixture", "query-set", "config", "capture", "previous-pool", "previous-manifest",
                     "review-pool", "pool-manifest", "ai-review", "output-dir"):
            child.add_argument("--" + name, required=True)
        child.add_argument("--ai-recheck")
    child = commands.choices["select"]
    child.add_argument("--additional-dir", required=True)
    child.add_argument("--additional-ai-review")
    child.add_argument("--conversation-judgments")
    return parser.parse_args()


def main():
    args = parse_args()
    (prepare if args.command == "prepare" else select)(args)


if __name__ == "__main__":
    main()
