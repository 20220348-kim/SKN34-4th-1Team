#!/usr/bin/env python3
"""Select AI-only, hybrid, or human labels without changing their provenance."""

import argparse
import csv
import hashlib
import importlib.util
import io
import json
import math
import re
from pathlib import Path


REVIEW_DIR = Path(__file__).resolve().parent


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, REVIEW_DIR / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PAGE = load_module("selection_review_page", "build-review-page.py")
EXTRACT = load_module("selection_review_export", "extract-review-json.py")
SCHEMA = "support-program-review-selection-v1"
SCHEMA_RECHECK = "support-program-review-selection-v2"
MODES = {"ai-only", "hybrid", "human"}
RECORD_FIELDS = {"queryId", "programId", "decision", "reason", "reviewer", "source", "requiredHumanReview", "provenance"}
SELECTION_FIELDS = {
    "schemaVersion", "identity", "mode", "status", "records", "excludedQueries",
    "reviewedCsvSha256", "aiReviewSha256", "humanReviewSha256", "conversationJudgmentsSha256",
    "sourceCounts", "requiredHumanReviewCount", "pendingHumanReviewCount", "evaluableQueryCount",
    "aiPendingCount", "hybridSample",
}


def canonical_hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def file_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest() if path else None


def key(item):
    return (item["queryId"], item["programId"])


def blank_judgment(row):
    return {"queryId": row["query_id"], "programId": row["program_id"], "decision": "", "reason": "", "reviewer": "", "provenance": None}


def validate_human_judgment(item):
    PAGE.validate_judgment(item)
    if re.search(r"(?i)(?:\b(?:ai|gpt\w*|chatgpt|claude|gemini|llm|openai)\b|인공지능)", item["reviewer"]):
        raise ValueError("AI reviewer cannot be represented as a human reviewer")

    def inspect(value):
        if isinstance(value, dict):
            if any(field in value for field in ("judgeId", "model", "aiReviewSha256", "requestSha256", "policySha256")):
                raise ValueError("AI provenance cannot be represented as human provenance")
            if "kind" in value and value["kind"] not in {"browser", "conversation", "human"}:
                raise ValueError("Unsupported human provenance kind")
            if "source" in value and value["source"] not in {"browser", "conversation", "human"}:
                raise ValueError("Unsupported human provenance source")
            for nested in value.values():
                inspect(nested)
        elif isinstance(value, list):
            for nested in value:
                inspect(nested)

    inspect(item["provenance"])


def human_progress(rows, manifest, human_export=None, seeds=()):
    """Use the explicit export as current progress; seeds remain separate evidence."""
    progress = {**PAGE.review_identity(manifest), "reviewer": "사용자", "judgments": [blank_judgment(row) for row in rows]}
    seeded = {key(item): item for item in seeds}
    for item in seeds:
        validate_human_judgment(item)
    if human_export is not None:
        EXTRACT.apply_judgments(rows, manifest, human_export)
        progress = human_export
        # A browser export may intentionally clear or change an earlier judgment.
        # The original conversation file is retained by hash, not silently restored.
    else:
        progress["judgments"] = [seeded.get(key(item), item) for item in progress["judgments"]]
        if seeds:
            progress["reviewer"] = seeds[0]["reviewer"]
    for item in progress["judgments"]:
        validate_human_judgment(item)
    return progress


def ai_consensus(rows, ai_review, ai_hash, recheck=None, recheck_hash=None):
    """Four matching non-unclear votes, but only after all five have completed."""
    by_pair = {(row["query_id"], row["program_id"]): [] for row in rows}
    for item in ai_review["judgments"]:
        by_pair[key(item)].append(item)
    rechecked = set()
    if recheck is not None:
        for item in recheck["judgments"]:
            rechecked.add(key(item))
        for pair in rechecked:
            by_pair[pair] = [item for item in recheck["judgments"] if key(item) == pair]
    records = {}
    for pair, votes in by_pair.items():
        counts = {decision: sum(item["decision"] == decision for item in votes) for decision in ("relevant", "irrelevant", "unclear")}
        counts["missing"] = 5 - len(votes)
        decision = "unclear"
        if len(votes) == 5:
            decision = next((choice for choice in ("relevant", "irrelevant") if counts[choice] >= 4), "unclear")
        reason = "동일 모델의 독립 실행 5회: 추천 가능 {relevant}, 추천 불가 {irrelevant}, 정보 부족 {unclear}, 미완료 {missing}. ".format(**counts)
        reason += "5회 중 4회 이상 합의(정확도 확률이 아님)." if decision != "unclear" else "미완료 또는 합의 부족으로 정답을 확정하지 않음."
        provenance = {
            "kind": "ai_consensus", "aiReviewSha256": ai_hash, "votes": counts,
            # Pair IDs, judge ID, and source hash reference the full vote without
            # duplicating long reasons/evidence into bounded provenance.
            "judgments": [{field: item[field] for field in ("judgeId", "decision")} for item in sorted(votes, key=lambda vote: vote["judgeId"])],
        }
        if pair in rechecked:
            provenance["recheckSha256"] = recheck_hash
        records[pair] = {
            "queryId": pair[0], "programId": pair[1], "decision": decision, "reason": reason,
            "reviewer": "AI 독립 판정 5개", "source": "ai" if decision != "unclear" else "unresolved",
            "requiredHumanReview": False,
            "provenance": provenance,
        }
    return records


def hybrid_sample(consensus, ai_hash):
    """Freeze a rank-independent 10% consensus sample, at least one per query."""
    query_ids = sorted({pair[0] for pair in consensus})
    selected = []
    for query_id in query_ids:
        candidates = [pair for pair, record in consensus.items() if pair[0] == query_id and record["source"] == "ai"]
        candidates.sort(key=lambda pair: (canonical_hash([ai_hash, *pair]), pair))
        selected.extend(candidates[:max(1, math.ceil(len(candidates) / 10))])
    return [{"queryId": pair[0], "programId": pair[1]} for pair in sorted(selected)]


def summarize(mode, records, manifest, ai_pending):
    counts = {source: sum(item["source"] == source for item in records) for source in ("ai", "human", "unresolved")}
    required = sum(item["requiredHumanReview"] for item in records)
    pending = sum(item["requiredHumanReview"] and item["source"] != "human" for item in records)
    unresolved_queries = {item["queryId"] for item in records if item["source"] == "unresolved"}
    # An empty pool cannot establish that a query has no relevant document.
    unresolved_queries.update(query_id for query_id, count in manifest["perQueryCounts"].items() if count == 0)
    excluded = {query_id: "AI 합의로 확정하지 못한 공고 또는 빈 검토 풀이 있어 질문 전체를 평가에서 제외함." for query_id in sorted(unresolved_queries)} if mode == "ai-only" else {}
    evaluable = len(manifest["perQueryCounts"]) - len(unresolved_queries)
    if ai_pending:
        status = "incomplete-ai"
    elif mode != "ai-only" and (pending or unresolved_queries):
        status = "needs-human"
    elif not evaluable:
        status = "no-evaluable-queries"
    else:
        status = "ready"
    return {
        "status": status, "sourceCounts": counts, "requiredHumanReviewCount": required,
        "pendingHumanReviewCount": pending, "evaluableQueryCount": evaluable, "excludedQueries": excluded,
    }


def compose_selection(mode, rows, manifest, ai_review=None, human_export=None, seeds=(),
                      ai_review_sha256=None, human_review_sha256=None, conversation_judgments_sha256=None,
                      ai_recheck=None, ai_recheck_sha256=None):
    if mode not in MODES:
        raise ValueError("Unknown review mode")
    if mode != "human" and ai_review is None:
        raise ValueError("AI-only and hybrid modes require --ai-review")
    if ai_recheck is not None:
        if mode == "human":
            raise ValueError("Human mode must not use an AI recheck")
        require_hash(ai_recheck_sha256, "aiRecheckSha256")
        targets = {key(pair) for pair in ai_recheck["targetPairs"]}
        unresolved = {pair for pair, item in ai_consensus(rows, ai_review, ai_review_sha256).items()
                      if item["source"] == "unresolved"}
        if not targets or targets != unresolved or targets != {key(vote) for vote in ai_recheck["judgments"]}:
            raise ValueError("Recheck targets must equal original unresolved pairs")
    progress = human_progress(rows, manifest, human_export, seeds)
    humans = {key(item): item for item in progress["judgments"]}
    consensus = ai_consensus(rows, ai_review, ai_review_sha256, ai_recheck, ai_recheck_sha256) if mode != "human" else {}
    sample = hybrid_sample(consensus, ai_review_sha256) if mode == "hybrid" else []
    sample_keys = {key(item) for item in sample}
    records = []
    for row in rows:
        pair = (row["query_id"], row["program_id"])
        item = consensus.get(pair, {**blank_judgment(row), "source": "unresolved", "requiredHumanReview": False})
        required = mode == "human" or (mode == "hybrid" and (item["source"] != "ai" or pair in sample_keys))
        human = humans[pair]
        complete_human = PAGE.is_complete(human) and human["decision"] != "unclear"
        if mode != "ai-only" and complete_human:
            item = {
                **human, "source": "human", "requiredHumanReview": required,
                "provenance": {"kind": "human", "humanJudgmentSha256": canonical_hash(human),
                               "humanProvenanceSha256": canonical_hash(human["provenance"]),
                               "aiReference": consensus.get(pair, {}).get("provenance")},
            }
        elif required:
            item = {
                **human, "source": "unresolved", "requiredHumanReview": True,
                "provenance": {"kind": "pending_human", "humanJudgmentSha256": canonical_hash(human),
                               "humanProvenanceSha256": canonical_hash(human["provenance"]),
                               "aiReference": consensus.get(pair, {}).get("provenance")},
            }
        else:
            item = {**item, "requiredHumanReview": required}
        records.append(item)
    pending = ai_review["pendingCount"] if mode != "human" else 0
    selection = {
        "schemaVersion": SCHEMA_RECHECK if ai_recheck is not None else SCHEMA, "identity": PAGE.review_identity(manifest), "mode": mode,
        "records": records, "reviewedCsvSha256": None,
        "aiReviewSha256": ai_review_sha256 if mode != "human" else None,
        "humanReviewSha256": human_review_sha256,
        "conversationJudgmentsSha256": conversation_judgments_sha256,
        "aiPendingCount": pending, "hybridSample": sample,
        **summarize(mode, records, manifest, pending),
    }
    if ai_recheck is not None:
        selection["aiRecheckSha256"] = ai_recheck_sha256
        selection["aiRecheckTargetPairs"] = [{"queryId": q, "programId": p} for q, p in sorted(targets)]
    output_rows = [{**row, **{field: record[field] for field in PAGE.POOL.MUTABLE_REVIEW_FIELDS}} for row, record in zip(rows, records)]
    csv_text = io.StringIO(newline="")
    writer = csv.DictWriter(csv_text, fieldnames=PAGE.POOL.REVIEW_FIELDS)
    writer.writeheader()
    writer.writerows(output_rows)
    csv_bytes = csv_text.getvalue().encode("utf-8-sig")
    selection["reviewedCsvSha256"] = hashlib.sha256(csv_bytes).hexdigest()
    validate_selection(selection, output_rows, manifest)
    return selection, csv_bytes, progress


def require_hash(value, description, optional=False):
    if optional and value is None:
        return
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
        raise ValueError(f"Invalid {description} SHA-256")


def validate_selection(selection, rows, manifest):
    """Validate selection/CSV linkage; caller also compares the actual CSV file hash."""
    if not isinstance(selection, dict):
        raise ValueError("Review selection must be an object")
    if selection.get("schemaVersion") == "support-program-review-selection-transfer-v1":
        transfer = load_module("selection_ai_transfer", "transfer-ai-review.py")
        return transfer.validate_selection(selection, rows, manifest)
    schema = selection.get("schemaVersion")
    required_fields = SELECTION_FIELDS | ({"aiRecheckSha256", "aiRecheckTargetPairs"} if schema == SCHEMA_RECHECK else set())
    PAGE.require_keys(selection, required_fields, "Review selection")
    if schema not in {SCHEMA, SCHEMA_RECHECK} or selection["mode"] not in MODES:
        raise ValueError("Unsupported review selection schema or mode")
    recheck_targets = set()
    if schema == SCHEMA_RECHECK:
        if selection["mode"] == "human":
            raise ValueError("Human mode must not use an AI recheck")
        require_hash(selection["aiRecheckSha256"], "aiRecheckSha256")
        if not isinstance(selection["aiRecheckTargetPairs"], list) or not selection["aiRecheckTargetPairs"]:
            raise ValueError("Invalid AI recheck target pairs")
        for pair in selection["aiRecheckTargetPairs"]:
            PAGE.require_keys(pair, {"queryId", "programId"}, "Recheck target pair")
            for field in ("queryId", "programId"):
                PAGE.require_text(pair[field], field, nonempty=True)
            if key(pair) in recheck_targets:
                raise ValueError("Duplicate AI recheck target pair")
            recheck_targets.add(key(pair))
    identity = PAGE.review_identity(manifest)
    if selection["identity"] != identity or type(selection["identity"].get("captureIncluded")) is not bool:
        raise ValueError("Review selection belongs to another pool")
    if PAGE.POOL.pool_key_sha256(rows) != manifest["poolKeySha256"] or PAGE.POOL.review_structure_sha256(rows) != manifest["reviewStructureSha256"]:
        raise ValueError("Review selection immutable rows changed")
    for field in ("reviewedCsvSha256", "aiReviewSha256", "humanReviewSha256", "conversationJudgmentsSha256"):
        require_hash(selection[field], field, optional=field != "reviewedCsvSha256")
    mode = selection["mode"]
    if (mode == "human") != (selection["aiReviewSha256"] is None):
        raise ValueError("Selected mode has an invalid AI source reference")
    if type(selection["aiPendingCount"]) is not int or not 0 <= selection["aiPendingCount"] <= 5 * len(rows):
        raise ValueError("Invalid AI pending count")
    if mode == "human" and selection["aiPendingCount"]:
        raise ValueError("Human mode must not depend on AI completion")
    records = selection["records"]
    if not isinstance(records, list) or len(records) != len(rows):
        raise ValueError("Selection must include every pool row")
    row_map = {(row["query_id"], row["program_id"]): row for row in rows}
    if not recheck_targets <= set(row_map):
        raise ValueError("Unknown AI recheck target pair")
    seen = set()
    reconstructed_ai = {}
    missing_votes = 0
    for item in records:
        PAGE.require_keys(item, RECORD_FIELDS, "Selection record")
        pair = key(item)
        if pair not in row_map or pair in seen:
            raise ValueError("Unknown or duplicate selection record")
        seen.add(pair)
        PAGE.validate_judgment({field: item[field] for field in PAGE.JUDGMENT_FIELDS})
        if item["source"] not in {"ai", "human", "unresolved"} or type(item["requiredHumanReview"]) is not bool:
            raise ValueError("Invalid selection source or human requirement")
        if any(item[field] != row_map[pair][field] for field in PAGE.POOL.MUTABLE_REVIEW_FIELDS):
            raise ValueError("Selection judgments differ from reviewed CSV")
        if item["source"] != "unresolved" and (not PAGE.is_complete(item) or item["decision"] == "unclear"):
            raise ValueError("Resolved selection record is incomplete")
        if mode == "ai-only" and (item["source"] == "human" or item["requiredHumanReview"]):
            raise ValueError("AI-only labels must not use human judgments")
        if mode == "human" and (item["source"] == "ai" or not item["requiredHumanReview"]):
            raise ValueError("Human mode requires human review for every row")
        provenance = item["provenance"]
        if item["source"] == "human" or (item["requiredHumanReview"] and item["source"] == "unresolved"):
            PAGE.require_keys(provenance, {"kind", "humanJudgmentSha256", "humanProvenanceSha256", "aiReference"}, "Human selection provenance")
            expected_kind = "human" if item["source"] == "human" else "pending_human"
            if provenance["kind"] != expected_kind:
                raise ValueError("Human selection requires explicit human provenance")
            for field in ("humanJudgmentSha256", "humanProvenanceSha256"):
                require_hash(provenance[field], field)
            if mode == "human" and provenance["aiReference"] is not None:
                raise ValueError("Human mode must not depend on AI provenance")
            validate_human_judgment({**{field: item[field] for field in PAGE.JUDGMENT_FIELDS}, "provenance": None})
        if mode != "human":
            ai_provenance = provenance if isinstance(provenance, dict) and provenance.get("kind") == "ai_consensus" else (provenance or {}).get("aiReference")
            ai_fields = {"kind", "aiReviewSha256", "votes", "judgments"}
            if pair in recheck_targets:
                ai_fields.add("recheckSha256")
            PAGE.require_keys(ai_provenance, ai_fields, "AI consensus provenance")
            if ai_provenance["kind"] != "ai_consensus" or ai_provenance["aiReviewSha256"] != selection["aiReviewSha256"]:
                raise ValueError("AI consensus source reference changed")
            if pair in recheck_targets and ai_provenance["recheckSha256"] != selection["aiRecheckSha256"]:
                raise ValueError("AI recheck source reference changed")
            votes = ai_provenance["judgments"]
            if not isinstance(votes, list) or len(votes) > 5:
                raise ValueError("Invalid AI consensus votes")
            judge_ids = set()
            for vote in votes:
                PAGE.require_keys(vote, {"judgeId", "decision"}, "AI consensus vote reference")
                if vote["judgeId"] not in {f"judge-{number}" for number in range(1, 6)} or vote["judgeId"] in judge_ids:
                    raise ValueError("Invalid or duplicate AI judge")
                judge_ids.add(vote["judgeId"])
                if vote["decision"] not in {"relevant", "irrelevant", "unclear"}:
                    raise ValueError("Invalid AI consensus decision")
            counts = {choice: sum(vote["decision"] == choice for vote in votes) for choice in ("relevant", "irrelevant", "unclear")}
            counts["missing"] = 5 - len(votes)
            if ai_provenance["votes"] != counts or any(type(value) is not int for value in ai_provenance["votes"].values()):
                raise ValueError("AI vote counts changed")
            missing_votes += counts["missing"]
            consensus_decision = next((choice for choice in ("relevant", "irrelevant") if len(votes) == 5 and counts[choice] >= 4), "unclear")
            reconstructed_ai[pair] = {"source": "ai" if consensus_decision != "unclear" else "unresolved"}
            if item["source"] == "ai" and item["decision"] != consensus_decision:
                raise ValueError("AI selection contradicts recorded votes")
            if mode == "ai-only" and (item["decision"] != consensus_decision or item["source"] != reconstructed_ai[pair]["source"]):
                raise ValueError("AI-only consensus or unresolved decision changed")
        if item["requiredHumanReview"] and item["source"] == "ai":
            raise ValueError("Required human review cannot be replaced by AI fallback")
    if missing_votes != selection["aiPendingCount"]:
        raise ValueError("AI pending count differs from missing votes")
    expected_sample = hybrid_sample(reconstructed_ai, selection["aiReviewSha256"]) if mode == "hybrid" else []
    if selection["hybridSample"] != expected_sample:
        raise ValueError("Hybrid sample plan changed")
    if mode == "hybrid":
        sample_keys = {key(item) for item in expected_sample}
        for item in records:
            required = reconstructed_ai[key(item)]["source"] != "ai" or key(item) in sample_keys
            if item["requiredHumanReview"] != required:
                raise ValueError("Hybrid human requirement changed")
    summary = summarize(mode, records, manifest, selection["aiPendingCount"])
    for field, value in summary.items():
        if selection[field] != value:
            raise ValueError(f"Selection {field} does not match its records")
    for field in ("requiredHumanReviewCount", "pendingHumanReviewCount", "evaluableQueryCount"):
        if type(selection[field]) is not int:
            raise ValueError(f"Selection {field} must be an integer")
    if any(type(value) is not int for value in selection["sourceCounts"].values()):
        raise ValueError("Selection source counts must be integers")
    if selection["sourceCounts"]["human"] and not (selection["humanReviewSha256"] or selection["conversationJudgmentsSha256"]):
        raise ValueError("Human labels require an explicit human input source hash")
    return selection


def build_human_page(selection, progress, rows, manifest):
    """Reuse the existing offline page with an isolated storage key and required-row navigation."""
    payload = {**PAGE.review_identity(manifest), "rows": [{**row, **{field: "" for field in PAGE.POOL.MUTABLE_REVIEW_FIELDS}} for row in rows],
               "seedJudgments": [item for item in progress["judgments"] if any(item[field] for field in ("decision", "reason", "reviewer")) or item["provenance"] is not None]}
    required = [{"queryId": item["queryId"], "programId": item["programId"]} for item in selection["records"] if item["requiredHumanReview"]]
    template = (REVIEW_DIR / "review-page.html").read_text(encoding="utf-8")
    additions = '''
  const requiredPairs = new Set(__REQUIRED_PAIRS__.map((item) => key(item.queryId, item.programId)));
  const requirementPanel = document.createElement("section");
  requirementPanel.className = "notice";
  const requirementText = document.createElement("p");
  const requirementButton = document.createElement("button");
  requirementButton.type = "button";
  requirementButton.textContent = "다음 필수 사람 검토";
  requirementPanel.append(requirementText, requirementButton);
  $("scope").after(requirementPanel);
  function updateRequirements() {
    const remaining = [...requiredPairs].filter((pair) => {
      const item = judgments.get(pair);
      return !complete(item) || item.decision === "unclear";
    });
    const currentRequired = requiredPairs.has(rowKey(data.rows[current]));
    requirementText.textContent = __MODE_HINT__ + " · 필수 " + requiredPairs.size + "건 중 미완료 " + remaining.length
      + "건 · 현재 공고: " + (currentRequired ? "필수 검토 대상" : "선택 검토 대상")
      + ". AI 판정은 사람 판정으로 미리 입력되지 않습니다.";
    requirementButton.disabled = remaining.length === 0;
  }
  requirementButton.addEventListener("click", () => {
    const indexes = data.rows.map((row, index) => ({row, index}));
    const rotated = indexes.slice(current + 1).concat(indexes.slice(0, current + 1));
    const next = rotated.find(({row}) => {
      const item = judgments.get(rowKey(row));
      return requiredPairs.has(rowKey(row)) && (!complete(item) || item.decision === "unclear");
    });
    if (!next) return;
    $("query-filter").value = "";
    current = next.index;
    save();
    render(true);
  });
'''
    hint = {"ai-only": "AI 전용 모드: 사람 검토 의무 없음", "hybrid": "혼합 모드: 불일치 전부와 질문별 합의 표본 10%(최소 1건) 확인", "human": "사람 모드: 모든 공고 확인"}[selection["mode"]]
    additions = additions.replace("__REQUIRED_PAIRS__", PAGE.script_json(required)).replace("__MODE_HINT__", PAGE.script_json(hint))
    replacements = [
        ("__REVIEW_DATA__", PAGE.script_json(payload)),
        ('const storageKey = "govbiz-review:" + JSON.stringify(identityFields.map((field) => data[field]));',
         'const storageKey = "govbiz-review:" + JSON.stringify(identityFields.map((field) => data[field])) + ":selection:" + ' + json.dumps(canonical_hash(selection)) + ';'),
        ('  function group() {', additions + '\n  function group() {'),
        ('    updateCounts();\n  }\n  function render', '    updateCounts();\n    updateRequirements();\n  }\n  function render'),
        ('" 대화에서 확인한 "', '" 이전에 입력한 사람 검토 "'),
    ]
    for old, new in replacements:
        if template.count(old) != 1:
            raise ValueError("Review-page template changed; cannot safely add mode instructions")
        template = template.replace(old, new)
    return template


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("fixture", "query-set", "review-pool", "pool-manifest", "output-dir"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--mode", choices=sorted(MODES), default="ai-only")
    parser.add_argument("--ai-review")
    parser.add_argument("--ai-recheck")
    parser.add_argument("--human-review")
    parser.add_argument("--conversation-judgments")
    return parser.parse_args()


def main():
    args = parse_args()
    output = Path(args.output_dir)
    if output.exists() or output.is_symlink():
        raise FileExistsError(f"Selection output directory already exists: {output}")
    inputs = [getattr(args, field, None) for field in ("fixture", "query_set", "review_pool", "pool_manifest", "ai_review", "ai_recheck", "human_review", "conversation_judgments")]
    if any(path and output.resolve() == Path(path).resolve() for path in inputs):
        raise ValueError("Output directory aliases an input")
    fixture = PAGE.load_fixture(args.fixture)
    queries = PAGE.load_json(args.query_set)
    manifest = PAGE.load_json(args.pool_manifest)
    rows = PAGE.load_verified_pool(args.review_pool, manifest)
    PAGE.validate_sources(fixture, queries, manifest, rows)
    if any(any(row[field] for field in PAGE.POOL.MUTABLE_REVIEW_FIELDS) for row in rows):
        raise ValueError("Use the original unjudged review pool and provide human progress explicitly with --human-review")
    seeds = PAGE.load_seeds(args.conversation_judgments, fixture, manifest, rows)
    human = PAGE.load_json(args.human_review) if args.human_review else None
    ai = None
    ai_recheck = None
    if args.mode != "human":
        if not args.ai_review:
            raise ValueError("Selected mode requires --ai-review")
        ai = PAGE.load_json(args.ai_review)
        runner = load_module("selection_ai_runner", "run-ai-review.py")
        runner.validate_ai_review(ai, fixture, manifest, rows)
        if ai["fixtureSha256"] != file_hash(args.fixture):
            raise ValueError("AI review fixture file hash changed")
        if getattr(args, "ai_recheck", None):
            recheck_module = load_module("selection_ai_recheck", "recheck-ai-review.py")
            ai_recheck = PAGE.load_json(args.ai_recheck)
            recheck_module.validate_recheck(ai_recheck, ai, file_hash(args.ai_review), fixture, manifest, rows)
    elif getattr(args, "ai_recheck", None):
        raise ValueError("Human mode must not use an AI recheck")
    selection, csv_bytes, progress = compose_selection(
        args.mode, rows, manifest, ai, human, seeds,
        ai_review_sha256=file_hash(args.ai_review) if args.mode != "human" else None,
        ai_recheck=ai_recheck, ai_recheck_sha256=file_hash(args.ai_recheck) if ai_recheck is not None else None,
        human_review_sha256=file_hash(args.human_review), conversation_judgments_sha256=file_hash(args.conversation_judgments),
    )
    html = build_human_page(selection, progress, rows, manifest)
    output.mkdir(parents=True, exist_ok=False)
    with (output / "reviewed.csv").open("xb") as file:
        file.write(csv_bytes)
    for filename, value in (("selection.json", selection), ("review-progress.json", progress)):
        with (output / filename).open("x", encoding="utf-8") as file:
            json.dump(value, file, ensure_ascii=False, indent=2)
            file.write("\n")
    with (output / "review.html").open("x", encoding="utf-8") as file:
        file.write(html)
    print(json.dumps({"outputDirectory": str(output), "mode": args.mode, **{field: selection[field] for field in ("status", "sourceCounts", "requiredHumanReviewCount", "pendingHumanReviewCount", "evaluableQueryCount", "excludedQueries")},
                      "note": "Ready means selected labels are available, not that search quality is independently verified. AI agreement is not a correctness probability. The original AI run and human inputs remain separate."}, ensure_ascii=False))


if __name__ == "__main__":
    main()
