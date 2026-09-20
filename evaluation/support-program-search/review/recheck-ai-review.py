#!/usr/bin/env python3
"""Collect one bounded offline recheck, preserving the original AI review."""
import argparse
import importlib.util
from pathlib import Path


HERE = Path(__file__).resolve().parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


RUNNER = load("recheck_runner", "run-ai-review.py")
SELECT = load("recheck_select", "select-review-mode.py")
PAGE = RUNNER.PAGE
SCHEMA = "support-program-ai-recheck-v1"
PREPARED_SCHEMA = "support-program-ai-recheck-prepared-v1"
canonical_hash = RUNNER.canonical_hash
file_hash = RUNNER.file_hash


def derive_targets(base_review, base_hash, fixture, rows):
    consensus = SELECT.ai_consensus(rows, base_review, base_hash)
    targets = [row for row in rows if consensus[(row["query_id"], row["program_id"])]["source"] == "unresolved"]
    docs = {doc["id"]: doc for doc in fixture["docs"]}
    pairs = [{"queryId": row["query_id"], "programId": row["program_id"]} for row in targets]
    blind = [{**pair, "referenceDate": fixture["referenceDate"], "question": row["query"],
              "announcement": docs[row["program_id"]]["text"]} for pair, row in zip(pairs, targets)]
    return pairs, blind


def validate_assignments(assignments, base_review):
    ids = {judge["id"] for judge in base_review["policy"]["judges"]}
    PAGE.require_keys(assignments, ids, "Recheck assignments")
    for agent in assignments.values():
        PAGE.require_text(agent, "assigned agent ID", maximum=300, nonempty=True)
    original_agents = {vote["agentId"] for vote in base_review["judgments"]}
    if len(set(assignments.values())) != 5 or original_agents.intersection(assignments.values()):
        raise ValueError("Recheck requires five distinct new agents")


def validate_recheck(result, base_review, base_hash, fixture, manifest, rows):
    """Validate against ALL original rows, not only the rechecked subset."""
    RUNNER.validate_ai_review(base_review, fixture, manifest, rows)
    if base_review["status"] != "complete":
        raise ValueError("Recheck requires a completed original review")
    PAGE.require_keys(result, {"schemaVersion", "baseAiReviewSha256", "identity", "fixtureSha256",
                               "policy", "policySha256", "inputSha256", "targetPairs", "assignments",
                               "judgments", "pendingCount", "status", "roundLimit"}, "AI recheck")
    if result["schemaVersion"] != SCHEMA or result["baseAiReviewSha256"] != base_hash:
        raise ValueError("AI recheck base source changed")
    for field in ("identity", "fixtureSha256", "policy", "policySha256"):
        if result[field] != base_review[field]:
            raise ValueError(f"AI recheck {field} differs from original")
    if type(result["roundLimit"]) is not int or result["roundLimit"] != 1:
        raise ValueError("AI recheck round limit must be one")
    pairs, blind = derive_targets(base_review, base_hash, fixture, rows)
    if not pairs or result["targetPairs"] != pairs:
        raise ValueError("AI recheck targets must equal original unresolved pairs in pool order")
    if result["inputSha256"] != canonical_hash(blind):
        raise ValueError("AI recheck input differs from fixed source")
    validate_assignments(result["assignments"], base_review)
    targets = {(p["queryId"], p["programId"]) for p in pairs}
    by_pair = {(row["query_id"], row["program_id"]): row for row in rows}
    docs = {doc["id"]: doc for doc in fixture["docs"]}
    if not isinstance(result["judgments"], list):
        raise ValueError("Recheck judgments must be a list")
    seen = set()
    for vote in result["judgments"]:
        if not isinstance(vote, dict):
            raise ValueError("Recheck judgment must be an object")
        for field in ("queryId", "programId"):
            PAGE.require_text(vote.get(field), field, nonempty=True)
        pair = (vote["queryId"], vote["programId"])
        if pair not in targets:
            raise ValueError("AI recheck vote is outside target pairs")
        RUNNER.validate_vote(vote, by_pair[pair], docs[pair[1]], result["policy"], fixture["referenceDate"])
        key = RUNNER.vote_key(vote)
        if key in seen or result["assignments"][vote["judgeId"]] != vote["agentId"]:
            raise ValueError("Duplicate recheck judgment or assigned agent mismatch")
        seen.add(key)
    if len(seen) != 5 * len(targets):
        raise ValueError("AI recheck coverage is incomplete")
    if type(result["pendingCount"]) is not int or result["pendingCount"] != 0 or result["status"] != "complete":
        raise ValueError("AI recheck must be complete")
    return result


def collect(args):
    prepared_dir = Path(args.prepared_dir)
    inputs = [args.fixture, args.query_set, args.review_pool, args.pool_manifest, args.base_ai_review,
              args.assignments, *args.judge_file,
              *(prepared_dir / name for name in ("prepared.json", "policy.json", "blind-input.jsonl"))]
    PAGE.POOL.validate_new_output_paths([("AI recheck", args.output)], [("input", path) for path in inputs])
    fixture, manifest, rows, _ = RUNNER.source_inputs(args)
    base = PAGE.load_json(args.base_ai_review)
    RUNNER.validate_ai_review(base, fixture, manifest, rows)
    if base["status"] != "complete" or base["fixtureSha256"] != file_hash(args.fixture):
        raise ValueError("Original AI review is incomplete or fixture file changed")
    base_hash = file_hash(args.base_ai_review)
    pairs, blind = derive_targets(base, base_hash, fixture, rows)
    if RUNNER.read_jsonl(prepared_dir / "blind-input.jsonl") != blind:
        raise ValueError("Prepared blind input differs from regenerated source")
    prepared = PAGE.load_json(prepared_dir / "prepared.json")
    policy = PAGE.load_json(prepared_dir / "policy.json")
    expected = {"schemaVersion": PREPARED_SCHEMA, "baseAiReviewSha256": base_hash,
                "identity": base["identity"], "fixtureSha256": base["fixtureSha256"],
                "policySha256": base["policySha256"], "inputSha256": canonical_hash(blind),
                "targetPairs": pairs, "pairCount": len(pairs), "judgmentCount": 5 * len(pairs), "roundLimit": 1}
    if (prepared != expected or policy != base["policy"]
            or any(type(prepared.get(field)) is not int for field in ("pairCount", "judgmentCount", "roundLimit"))):
        raise ValueError("Prepared recheck metadata/hash/counts differ")
    assignments = PAGE.load_json(args.assignments)
    validate_assignments(assignments, base)
    by_pair = {(row["query_id"], row["program_id"]): row for row in rows}
    docs = {doc["id"]: doc for doc in fixture["docs"]}
    targets = {(p["queryId"], p["programId"]): index for index, p in enumerate(pairs)}
    votes, seen_judges = [], set()
    for path in args.judge_file:
        lines = RUNNER.read_jsonl(path)
        header = lines[0]
        PAGE.require_keys(header, {"schemaVersion", "judgeId", "agentId", "model", "inputSha256", "policySha256"}, "Judge header")
        judge_id = header["judgeId"]
        if not isinstance(judge_id, str) or judge_id not in assignments or judge_id in seen_judges:
            raise ValueError("Unknown or duplicate judge")
        if header != {"schemaVersion": "support-program-codex-judge-v1", "judgeId": judge_id,
                      "agentId": assignments[judge_id], "model": policy["model"],
                      "inputSha256": prepared["inputSha256"], "policySha256": prepared["policySha256"]}:
            raise ValueError("Invalid judge header")
        seen_judges.add(judge_id)
        judge = next(j for j in policy["judges"] if j["id"] == judge_id)
        for line in lines[1:]:
            PAGE.require_keys(line, {"queryId", "programId", "decision", "reason", "evidence"}, "Judge row")
            for field in ("queryId", "programId"):
                PAGE.require_text(line[field], field, nonempty=True)
            pair = (line["queryId"], line["programId"])
            if pair not in targets:
                raise ValueError("Unknown recheck pair")
            row, doc = by_pair[pair], docs[pair[1]]
            votes.append({**line, "contentHash": doc["contentHash"], "judgeId": judge_id,
                          "judgmentId": canonical_hash([*pair, judge_id]), "agentId": header["agentId"],
                          "model": policy["model"], "usage": None,
                          "requestSha256": canonical_hash(RUNNER.build_request(policy, row, doc, fixture["referenceDate"], judge))})
    votes.sort(key=lambda vote: (targets[(vote["queryId"], vote["programId"])], vote["judgeId"]))
    result = {"schemaVersion": SCHEMA, "baseAiReviewSha256": base_hash,
              "identity": base["identity"], "fixtureSha256": base["fixtureSha256"],
              "policy": policy, "policySha256": base["policySha256"], "inputSha256": prepared["inputSha256"],
              "targetPairs": pairs, "assignments": assignments, "judgments": votes,
              "pendingCount": 5 * len(pairs) - len(votes), "status": "complete", "roundLimit": 1}
    validate_recheck(result, base, base_hash, fixture, manifest, rows)
    RUNNER.write_new_json(args.output, result)
    return result


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("fixture", "query-set", "review-pool", "pool-manifest", "base-ai-review", "prepared-dir", "assignments", "output"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--judge-file", action="append", required=True)
    return parser.parse_args()


def main():
    collect(parse_args())


if __name__ == "__main__":
    main()
