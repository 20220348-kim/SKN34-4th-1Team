"""Replay the focused-semantic experiment without APIs or additional packages."""
import argparse
import hashlib
import importlib.util
import json
from collections import Counter
from decimal import Decimal
from fractions import Fraction
from pathlib import Path

HERE = Path(__file__).resolve().parent
PRIOR = HERE.parent / "rrf-tuning-20261015-v1"
ROOT = HERE.parents[3]
OFFSETS = (1, 5, 10, 20, 40, 60)
METRICS = ("recallAt20", "recallAt5", "mrrAt5")
EPS = 1e-12


def load(path):
    return json.loads(path.read_text(encoding="utf-8-sig"), parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def fuse(semantic, bm25, offset, exact=False):
    scores = {}
    for ids in (semantic, bm25):
        for rank, pid in enumerate(ids, 1):
            # Production uses Double, adding semantic first, then BM25.
            increment = Fraction(1, offset + rank) if exact else 1.0 / (float(offset) + rank)
            scores[pid] = scores.get(pid, 0) + increment
    ranks = {pid: rank for rank, pid in enumerate(bm25, 1)}
    return sorted(scores, key=lambda pid: (-scores[pid], ranks.get(pid, 10**9), pid))[:20]


def validate(inputs, additions, previous, helper):
    for name, expected in inputs["priorCanonicalHashes"].items():
        assert digest(load(PRIOR / name)) == expected, f"Historical input changed: {name}"
    assert hashlib.sha256((PRIOR / "replay.py").read_text(encoding="utf-8").encode()).hexdigest() == inputs["priorReplayLfSha256"]
    labels = helper.validate_labels(previous, load(PRIOR / "labels.json"))
    assert len(labels) == 828
    fixture = load(ROOT / previous["sourceFixture"]["path"])
    docs = {row["id"]: row["text"] for row in fixture["docs"]}
    qids = set(previous["questions"])
    for key in ("currentQdrantTop20", "focusQdrantTop20", "focusExactTop20AtCapture"):
        assert set(inputs[key]) == qids
        for ids in inputs[key].values():
            assert len(ids) == len(set(ids)) == 20 and set(ids) <= set(docs)
    assert all(inputs["currentQdrantTop20"][q] == previous["pools"]["20"][q]["semantic"] for q in qids)
    assert inputs["focusQdrantTop20"] == inputs["focusExactTop20AtCapture"]
    # Reconstruct the focused text from the already-shared fixture, without copying it.
    field_order = ("제목", "기관", "지원대상", "분야", "지역", "신청기간", "내용")
    focused_docs = []
    for doc in fixture["docs"]:
        lines = doc["text"].split("\n")
        assert len(lines) == 7
        fields = {}
        for key, line in zip(field_order, lines):
            assert line.startswith(key + ": ")
            fields[key] = line[len(key) + 2:]
        text = "\n".join(f"{key}: {fields[key]}" for key in inputs["textSchema"]["includedFieldsInOrder"])
        focused_docs.append({"id": doc["id"], "sourceContentHash": doc["contentHash"], "focusedContentHash": hashlib.sha256(text.encode()).hexdigest(), "text": text})
    assert digest(focused_docs) == inputs["textSchema"]["documentsSha256"], "Focused text schema differs from embedded capture"
    embedding = inputs["embedding"]
    assert len(embedding["batchSizes"]) == embedding["actualCalls"] == 45
    assert sum(embedding["batchSizes"]) == len(docs) == 1422
    assert Decimal(embedding["actualInputTokens"]) * Decimal(embedding["rateUsdPerMillionInputTokens"]) / 1000000 == Decimal(embedding["estimatedUsdAtRecordedRate"])
    original_labels = dict(labels)
    rows = additions["labels"]
    assert len(rows) == 50
    seen = set()
    for row in rows:
        pair = row["queryId"], row["programId"]
        assert pair not in labels and pair not in seen and pair[0] in qids and pair[1] in docs
        seen.add(pair)
        a, b = row["reviewerA"], row["reviewerB"]
        assert row["decision"] == (a["decision"] if a["decision"] == b["decision"] else "unclear")
        for reviewer in (a, b):
            assert (reviewer["queryId"], reviewer["programId"]) == pair
            assert reviewer["decision"] in ("relevant", "irrelevant", "unclear")
            assert reviewer["reason"] and len(reviewer["reason"]) <= 1000
            quotes = reviewer.get("evidence")
            if quotes is None:
                quotes = [reviewer["quote"]] if reviewer.get("quote") else []
            assert len(quotes) <= 3 and (quotes or reviewer["decision"] == "unclear")
            for entry in quotes:
                quote = entry if isinstance(entry, str) else entry["quote"]
                assert 0 < len(quote) <= 300 and quote in docs[pair[1]]
        labels[pair] = row
    needed = {(q, pid) for q in qids for pid in inputs["focusQdrantTop20"][q]} - set(original_labels)
    assert seen == needed, "Review coverage must equal new unjudged focused top20 pairs"
    return labels, original_labels


def assess(rankings, baseline, labels, positive, helper):
    cases = {}
    for qid, ids in rankings.items():
        assert len(ids) == len(set(ids)) == 20 and all((qid, pid) in labels for pid in ids)
        relevant = {pid for (q, pid), row in labels.items() if q == qid and row["decision"] == "relevant"}
        unclear = {pid for (q, pid), row in labels.items() if q == qid and row["decision"] == "unclear"}
        delta = helper.paired_delta(ids, baseline[qid], relevant, unclear)
        cases[qid] = {"rankedIds": ids, "relevantCount": len(relevant), "unclearCount": len(unclear), "score": helper.evaluate(ids, relevant, unclear), "pairedDeltaVsCurrentK60": delta, "knownRegressionMetrics": [] if delta is None else [m for m in METRICS if delta["knownRelevantOnly"][m] < -EPS], "possibleRegressionMetrics": [] if delta is None else [m for m in METRICS if delta["bounds"][m][0] < -EPS]}
    delta = helper.aggregate(cases[q]["pairedDeltaVsCurrentK60"] for q in positive)
    return {"aggregate": helper.aggregate(cases[q]["score"] for q in positive), "pairedDeltaVsCurrentK60": delta, "macroThreeMetricKnownNonregression": all(delta["knownRelevantOnly"][m] >= -EPS for m in METRICS), "macroThreeMetricPairedLowerNonnegative": all(delta["bounds"][m][0] >= -EPS for m in METRICS), "knownRegressionQueries": [q for q in positive if cases[q]["knownRegressionMetrics"]], "possibleRegressionQueries": [q for q in positive if cases[q]["possibleRegressionMetrics"]], "cases": cases}


def calculate(inputs, additions, helper):
    previous = load(PRIOR / "inputs.json")
    labels, original_labels = validate(inputs, additions, previous, helper)
    qids, positive = list(previous["questions"]), previous["frozenPositiveQueryIds"]
    current, focus = inputs["currentQdrantTop20"], inputs["focusQdrantTop20"]
    bm25 = {q: previous["pools"]["20"][q]["bm25"] for q in qids}
    baseline = {q: fuse(current[q], bm25[q], 60) for q in qids}
    grids = {}
    arithmetic_differences = []
    for representation, semantic in (("current", current), ("focus", focus)):
        grids[representation] = {str(k): assess({q: fuse(semantic[q], bm25[q], k) for q in qids}, baseline, labels, positive, helper) for k in OFFSETS}
        for k in OFFSETS:
            for q in qids:
                floating = fuse(semantic[q], bm25[q], k)
                exact = fuse(semantic[q], bm25[q], k, exact=True)
                if floating != exact:
                    relevant = {pid for (qid, pid), row in labels.items() if qid == q and row["decision"] == "relevant"}
                    unclear = {pid for (qid, pid), row in labels.items() if qid == q and row["decision"] == "unclear"}
                    helper.compare(helper.evaluate(floating, relevant, unclear), helper.evaluate(exact, relevant, unclear))
                    if q in positive:
                        helper.compare(helper.paired_delta(floating, baseline[q], relevant, unclear), helper.paired_delta(exact, baseline[q], relevant, unclear))
                    arithmetic_differences.append({"representation": representation, "offset": k, "queryId": q, "positions": [{"rank": rank, "productionFloatId": a, "exactFractionId": b} for rank, (a, b) in enumerate(zip(floating, exact), 1) if a != b], "allMetricPointsAndBoundsUnchanged": True})
    methods = {"semantic_current": assess(current, baseline, labels, positive, helper), "semantic_focus": assess(focus, baseline, labels, positive, helper), "rrf_current_k60": grids["current"]["60"], "rrf_focus_k1": grids["focus"]["1"], "bm25": assess(bm25, baseline, labels, positive, helper)}
    # Preserve and verify the earlier828-label offset experiment as its own history.
    historical = {}
    for k in OFFSETS:
        data = assess({q: fuse(current[q], bm25[q], k) for q in qids}, baseline, original_labels, positive, helper)
        summary = {"aggregate": data["aggregate"], "pairedDeltaVsK60": data["pairedDeltaVsCurrentK60"], "knownRegressionQueries": data["knownRegressionQueries"], "possibleRegressionQueries": data["possibleRegressionQueries"]}
        helper.compare(summary, inputs["original828OffsetExperiment"]["settings"][str(k)])
        historical[str(k)] = summary
    semantic_delta = {}
    for q in positive:
        r = {pid for (qid, pid), row in labels.items() if qid == q and row["decision"] == "relevant"}
        u = {pid for (qid, pid), row in labels.items() if qid == q and row["decision"] == "unclear"}
        semantic_delta[q] = helper.paired_delta(focus[q], current[q], r, u)
    return {"kind": "semantic-focus-20261015-v1-replay", "inputsCanonicalSha256": digest(inputs), "labelsCanonicalSha256": digest(additions), "replaySourceLfSha256": hashlib.sha256(Path(__file__).read_text(encoding="utf-8").encode()).hexdigest(), "queryCount": len(qids), "positiveQueryIds": positive, "noMatchQueryIds": [q for q in qids if q not in positive], "labelCounts": dict(Counter(row["decision"] for row in labels.values())), "methods": methods, "offsetGridsOn878Labels": grids, "scoreArithmeticAudit": {"metricBasis": "IEEE754 binary64, same division/addition order as production Kotlin Double; BM25 rank then identity on floating-score ties", "comparisons": 2 * len(OFFSETS) * len(qids), "differencesVsExactFraction": arithmetic_differences, "allMetricPointsAndBoundsUnchanged": True, "adoptedFocusK1MatchesExactFraction": all(fuse(focus[q], bm25[q], 1) == fuse(focus[q], bm25[q], 1, exact=True) for q in qids)}, "semanticFocusVsCurrent": {"aggregatePairedDelta": helper.aggregate(semantic_delta.values()), "cases": semantic_delta}, "original828OffsetExperimentVerified": {"settings": historical, "selectedOffset": inputs["original828OffsetExperiment"]["selectedOffset"], "lopoSelectedOffsetCounts": inputs["original828OffsetExperiment"]["lopoSelectedOffsetCounts"]}, "qdrantParity": {"focusExactTop20Matches": sum(focus[q] == inputs["focusExactTop20AtCapture"][q] for q in qids), "currentFrozenTop20Matches": sum(current[q] == previous["pools"]["20"][q]["semantic"] for q in qids), "queryCount": len(qids)}, "decision": inputs["decision"], "posthocExploration": True, "freshHoldoutQueries": 0, "humanReviews": 0, "replayApiCalls": 0, "boundMeaning": "Exact unknown-label assignment bounds, not confidence intervals; paired comparisons share the same label assignments. Macro nonregression is not per-query nonregression."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="Write a new report; refuse existing output paths")
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location("historical_rrf_replay", PRIOR / "replay.py")
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    result = calculate(load(HERE / "inputs.json"), load(HERE / "labels.json"), helper)
    if args.output:
        with args.output.open("x", encoding="utf-8") as stream:
            json.dump(result, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        print(f"Wrote {args.output}")
    else:
        helper.compare(result, load(HERE / "metrics.json"))
        print("Verified5 methods, both6-offset grids,16 cases, exact label bounds,50 review additions, Qdrant top20 parity and original828-label history; API calls0.")


if __name__ == "__main__":
    main()
