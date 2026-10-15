"""Recalculate this fixed RRF experiment with the Python standard library only."""
import argparse
import hashlib
import itertools
import json
import math
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
METRICS = ("recallAt20", "recallAt5", "mrrAt5")
BASELINE = "frozen-baseline"
MAX_UNCLEAR_PER_QUERY = 18
EPS = 1e-12


def load(path):
    return json.loads(path.read_text(encoding="utf-8-sig"), parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def fuse(semantic, bm25, weight, tie):
    scores = {}
    for ids, value in ((semantic, 1.0), (bm25, weight)):
        for rank, identity in enumerate(ids, 1):
            scores[identity] = scores.get(identity, 0.0) + value / (60 + rank)
    tie_ranks = {identity: rank for rank, identity in enumerate(semantic if tie == "semantic" else bm25, 1)}
    return sorted(scores, key=lambda identity: (-scores[identity], tie_ranks.get(identity, 10**9), identity))[:20]

def points(ids, relevant):
    return {
        "recallAt20": len(set(ids[:20]) & relevant) / len(relevant),
        "recallAt5": len(set(ids[:5]) & relevant) / len(relevant),
        "mrrAt5": next((1.0 / rank for rank, identity in enumerate(ids[:5], 1) if identity in relevant), 0.0),
    }

def evaluate(ids, relevant, unclear):
    if not relevant:
        return {"knownRelevantOnly": None, "bounds": None, "returnedCount": len(ids), "unclearReturned": len(set(ids) & unclear)}
    bounds = {}
    for metric, k in (("recallAt20", 20), ("recallAt5", 5)):
        hits = len(set(ids[:k]) & relevant)
        inside = len(set(ids[:k]) & unclear)
        outside = len(unclear) - inside
        bounds[metric] = [hits / (len(relevant) + outside), (hits + inside) / (len(relevant) + inside)]
    point = points(ids, relevant)
    bounds["mrrAt5"] = [point["mrrAt5"], points(ids, relevant | unclear)["mrrAt5"]]
    return {"knownRelevantOnly": point, "bounds": bounds, "returnedCount": len(ids), "unclearReturned": len(set(ids) & unclear)}

def aggregate(scores):
    scores = [score for score in scores if score["knownRelevantOnly"] is not None]
    return {
        "knownRelevantOnly": {metric: sum(score["knownRelevantOnly"][metric] for score in scores) / len(scores) for metric in METRICS},
        "bounds": {metric: [sum(score["bounds"][metric][side] for score in scores) / len(scores) for side in (0, 1)] for metric in METRICS},
    }

def paired_delta(ids, baseline, relevant, unclear):
    """Exact paired extrema without a 2**N full unknown-label enumeration."""
    if not relevant:
        return None
    if len(unclear) > MAX_UNCLEAR_PER_QUERY:
        raise ValueError(f"Blocked: {len(unclear)} unclear labels exceed predeclared cap18")
    a, b = points(ids, relevant), points(baseline, relevant)
    bounds = {}
    for metric, cutoff in (("recallAt20", 20), ("recallAt5", 5)):
        left, right = set(ids[:cutoff]), set(baseline[:cutoff])
        fixed_delta = len(left & relevant) - len(right & relevant)
        plus = len((left - right) & unclear)
        minus = len((right - left) & unclear)
        neutral = len(unclear) - plus - minus
        lower, upper = [], []
        for total in range(len(unclear) + 1):
            # For a fixed number of positive unknowns, choose positive/negative
            # difference contributors first and neutral contributors second.
            maximum = fixed_delta + min(plus, total) - max(0, total - plus - neutral)
            minimum = fixed_delta + max(0, total - minus - neutral) - min(minus, total)
            lower.append(minimum / (len(relevant) + total))
            upper.append(maximum / (len(relevant) + total))
        bounds[metric] = [min(lower), max(upper)]
    # Only unknowns in either top5 can change either reciprocal rank: at most10.
    influential = sorted((set(ids[:5]) | set(baseline[:5])) & unclear)
    deltas = []
    for flags in itertools.product((False, True), repeat=len(influential)):
        truth = relevant | {identity for identity, yes in zip(influential, flags) if yes}
        deltas.append(points(ids, truth)["mrrAt5"] - points(baseline, truth)["mrrAt5"])
    bounds["mrrAt5"] = [min(deltas), max(deltas)]
    return {"knownRelevantOnly": {metric: a[metric] - b[metric] for metric in METRICS}, "bounds": bounds}

def construct(expanded, frozen):
    pools = expanded["pools"]
    if set(pools) != {"20", "50", "100"}:
        raise ValueError("Expected exactly pool20, pool50, pool100")
    for depth, queries in pools.items():
        if set(queries) != set(frozen):
            raise ValueError(f"Query set changed at pool{depth}")
        for qid, modes in queries.items():
            for mode in ("semantic", "bm25"):
                ids = modes[mode]
                if len(ids) != int(depth) or len(ids) != len(set(ids)):
                    raise ValueError(f"Expected unique source top{depth}: {qid}/{mode}")
    settings = {}
    for depth, weight, tie in itertools.product((20, 50, 100), (1.0, 1.5, 2.0, 3.0), ("semantic", "bm25")):
        identity = f"p{depth}-w{weight:g}-{tie}"
        settings[identity] = {
            "sourcePoolPerMethod": depth, "bm25Weight": weight, "semanticWeight": 1.0,
            "rrfOffset": 60, "tieBreak": tie, "outputCutoff": 20,
            "rankings": {qid: fuse(modes["semantic"], modes["bm25"], weight, tie) for qid, modes in pools[str(depth)].items()},
        }
    controls = {
        BASELINE: {"sourcePoolPerMethod": 20, "bm25Weight": 1.0, "semanticWeight": 1.0, "rrfOffset": 60, "tieBreak": "semantic", "outputCutoff": 20, "rankings": {qid: row["rrf"] for qid, row in frozen.items()}},
        "semantic-current-p100": {"rankings": {qid: modes["semantic"][:20] for qid, modes in pools["100"].items()}, "sourcePoolPerMethod": 100, "outputCutoff": 20},
        "bm25-current-p100": {"rankings": {qid: modes["bm25"][:20] for qid, modes in pools["100"].items()}, "sourcePoolPerMethod": 100, "outputCutoff": 20},
    }
    return settings, controls

def comparison(left, right):
    return {
        "exactOrderMatch": left == right,
        "top20Overlap": len(set(left[:20]) & set(right[:20])),
        "changedPositions": [i + 1 for i, (a, b) in enumerate(zip(left[:20], right[:20])) if a != b],
        "onlyLeftTop20": sorted(set(left[:20]) - set(right[:20])),
        "onlyRightTop20": sorted(set(right[:20]) - set(left[:20])),
    }

def drift_report(expanded, frozen):
    return {
        qid: {
            mode: {
                "frozenVsNewPool20": comparison(frozen[qid][mode], expanded["pools"]["20"][qid][mode]),
                "newPool20VsPool50Prefix": comparison(expanded["pools"]["20"][qid][mode], expanded["pools"]["50"][qid][mode][:20]),
                "newPool20VsPool100Prefix": comparison(expanded["pools"]["20"][qid][mode], expanded["pools"]["100"][qid][mode][:20]),
            } for mode in ("semantic", "bm25")
        } for qid in frozen
    }

def enrich(settings, labels, frozen, frozen_positive, updated_positive, current_baseline):
    relevant = {qid: {pid for (q, pid), row in labels.items() if q == qid and row["decision"] == "relevant"} for qid in frozen}
    unclear = {qid: {pid for (q, pid), row in labels.items() if q == qid and row["decision"] == "unclear"} for qid in frozen}
    for qid in frozen:
        if len(unclear[qid]) > MAX_UNCLEAR_PER_QUERY:
            raise ValueError(f"Blocked: {qid} has {len(unclear[qid])} unclear labels; cap18")
    for config in settings.values():
        cases = {}
        for qid, ids in config.pop("rankings").items():
            baseline = frozen[qid]["rrf"]
            score = evaluate(ids, relevant[qid], unclear[qid])
            cases[qid] = {
                "rankedIds": ids, "relevantCount": len(relevant[qid]), "unclearCount": len(unclear[qid]),
                "score": score, "pairedDeltaVsBaseline": paired_delta(ids, baseline, relevant[qid], unclear[qid]),
                "pairedDeltaVsCurrentPool20Baseline": paired_delta(ids, current_baseline[qid], relevant[qid], unclear[qid]),
                "knownRelevantRankChanges": [
                    {"id": identity, "oldRank": baseline.index(identity) + 1 if identity in baseline else None, "newRank": ids.index(identity) + 1 if identity in ids else None}
                    for identity in sorted(relevant[qid])
                    if (baseline.index(identity) + 1 if identity in baseline else None) != (ids.index(identity) + 1 if identity in ids else None)
                ],
            }
        config["cases"] = cases
        config["aggregate"] = aggregate(cases[qid]["score"] for qid in frozen_positive)
        config["pairedDeltaVsBaseline"] = aggregate(cases[qid]["pairedDeltaVsBaseline"] for qid in frozen_positive)
        config["pairedDeltaVsCurrentPool20Baseline"] = aggregate(cases[qid]["pairedDeltaVsCurrentPool20Baseline"] for qid in frozen_positive)
        config["allUpdatedPositiveQueriesAggregate"] = aggregate(cases[qid]["score"] for qid in updated_positive)

def select(settings, qids):
    baseline = aggregate(settings[BASELINE]["cases"][qid]["score"] for qid in qids)["knownRelevantOnly"]
    eligible = []
    for name, config in settings.items():
        score = aggregate(config["cases"][qid]["score"] for qid in qids)["knownRelevantOnly"]
        if all(score[metric] >= baseline[metric] - EPS for metric in ("recallAt5", "mrrAt5")):
            key = (round(score["recallAt20"], 12), round(score["mrrAt5"], 12), round(score["recallAt5"], 12), -config["sourcePoolPerMethod"], -config["bm25Weight"], config["tieBreak"] == "semantic", name == BASELINE)
            eligible.append((key, name))
    return max(eligible)[1], [name for _, name in sorted(eligible, reverse=True)]

def validate_labels(inputs, bundle):
    fixture = load(ROOT / inputs["sourceFixture"]["path"])
    assert digest(fixture) == inputs["sourceFixture"]["canonicalJsonSha256"], "Fixture changed"
    docs = {row["id"]: row["text"] for row in fixture["docs"]}
    original = bundle["originalLabels"]
    labels = {(row["queryId"], row["programId"]): row for row in original}
    assert len(original) == len(labels) == 748
    additional = bundle["additionalReview"]["labels"]
    assert len(additional) == 80
    seen = set()
    for row in additional:
        pair = row["queryId"], row["programId"]
        assert pair not in labels and pair not in seen
        seen.add(pair)
        a, b = row["reviewerA"], row["reviewerB"]
        assert row["decision"] == (a["decision"] if a["decision"] == b["decision"] else "unclear")
        for reviewer in (a, b):
            assert (reviewer["queryId"], reviewer["programId"]) == pair
            assert reviewer["decision"] in ("relevant", "irrelevant", "unclear")
            assert reviewer["reason"] and len(reviewer["reason"]) <= 1000
            assert len(reviewer["evidence"]) <= 3 and (reviewer["evidence"] or reviewer["decision"] == "unclear")
            for entry in reviewer["evidence"]:
                if isinstance(entry, str):
                    quote = entry
                    possible = [docs[pair[1]]] + [source["text"] for source in bundle["sourceEvidence"].values()]
                    assert any(quote in text for text in possible)
                else:
                    quote = entry["quote"]
                    source = entry["source"]
                    text = docs[pair[1]] if source == "announcement" else bundle["sourceEvidence"][source.removeprefix("work/retrieval-full16-20261015/")]["text"]
                    assert quote in text
                assert 0 < len(quote) <= 300
        labels[pair] = row
    for row in original:
        assert row["decision"] in ("relevant", "irrelevant", "unclear")
        for entry in row.get("sourceReview", {}).get("evidence", []):
            source = bundle["sourceEvidence"][entry["file"]]
            assert source["sha256"] == entry["sha256"] and entry["quote"] in source["text"]
    assert all(qid in inputs["questions"] and pid in docs for qid, pid in labels)
    return labels


def calculate(inputs, bundle):
    labels = validate_labels(inputs, bundle)
    frozen = inputs["frozenRankings"]
    positive = inputs["frozenPositiveQueryIds"]
    original_positive = sorted({row["queryId"] for row in bundle["originalLabels"] if row["decision"] == "relevant"})
    assert sorted(positive) == original_positive and len(positive) == 12
    settings, controls = construct(inputs, frozen)
    final_pairs = {(qid, pid) for config in list(settings.values()) + list(controls.values()) for qid, ids in config["rankings"].items() for pid in ids}
    assert final_pairs <= set(labels), "Missing final candidate judgment"
    updated_positive = [qid for qid in frozen if any(q == qid and row["decision"] == "relevant" for (q, _), row in labels.items())]
    current = dict(settings["p20-w1-semantic"]["rankings"])
    enrich(settings, labels, frozen, positive, updated_positive, current)
    enrich(controls, labels, frozen, positive, updated_positive, current)
    candidates = {**settings, BASELINE: controls[BASELINE]}
    selected, eligible = select(candidates, positive)
    folds = []
    for held_out in positive:
        train = [qid for qid in positive if qid != held_out]
        chosen, fold_eligible = select(candidates, train)
        folds.append({"heldOut": held_out, "trainingQueryIds": train, "selectedConfig": chosen, "eligibleConfigs": fold_eligible, "heldOutScore": candidates[chosen]["cases"][held_out]["score"], "heldOutPairedDeltaVsBaseline": candidates[chosen]["cases"][held_out]["pairedDeltaVsBaseline"]})
    old_scores = {}
    for mode in ("semantic", "rrf", "bm25"):
        cases = []
        for qid in positive:
            relevant = {row["programId"] for row in bundle["originalLabels"] if row["queryId"] == qid and row["decision"] == "relevant"}
            unclear = {row["programId"] for row in bundle["originalLabels"] if row["queryId"] == qid and row["decision"] == "unclear"}
            cases.append(evaluate(frozen[qid][mode], relevant, unclear))
        old_scores[mode] = aggregate(cases)
    for config in list(settings.values()) + list(controls.values()):
        for case in config["cases"].values():
            case.pop("rankedIds")  # Deterministically reconstructed from inputs.
    return {"kind": "fixed-24-setting-rrf-exploration", "inputsCanonicalSha256": digest(inputs), "labelsCanonicalSha256": digest(bundle), "replaySourceLfSha256": hashlib.sha256(Path(__file__).read_text(encoding="utf-8").encode()).hexdigest(), "queryCount": len(frozen), "frozenPositiveQueryIds": positive, "updatedPositiveQueryIds": updated_positive, "newlyPositiveQueryIds": sorted(set(updated_positive) - set(positive)), "labelCounts": dict(Counter(row["decision"] for row in labels.values())), "finalCandidatePairCount": len(final_pairs), "originalReportedAggregateOnOriginalLabels": old_scores, "selectedConfigOnAllFrozenPositiveQueries": selected, "eligibleConfigsOnAllFrozenPositiveQueries": eligible, "configurations": settings, "controls": controls, "captureDrift": drift_report(inputs, frozen), "leaveOnePositiveQueryOut": {"selectedConfigCounts": dict(Counter(fold["selectedConfig"] for fold in folds)), "aggregate": aggregate(fold["heldOutScore"] for fold in folds), "pairedDeltaVsBaseline": aggregate(fold["heldOutPairedDeltaVsBaseline"] for fold in folds), "folds": folds}, "replayExternalApiCalls": 0}


def compare(actual, expected, path="metrics"):
    if isinstance(actual, float) or isinstance(expected, float):
        assert type(actual) in (int, float) and type(expected) in (int, float), path
        assert math.isfinite(actual) and math.isfinite(expected) and math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-12), path
    elif isinstance(actual, dict):
        assert isinstance(expected, dict) and set(actual) == set(expected), path
        for key in actual:
            compare(actual[key], expected[key], f"{path}.{key}")
    elif isinstance(actual, list):
        assert isinstance(expected, list) and len(actual) == len(expected), path
        for number, (left, right) in enumerate(zip(actual, expected)):
            compare(left, right, f"{path}[{number}]")
    else:
        assert type(actual) is type(expected) and actual == expected, path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="Write a newly named report; existing files are never overwritten")
    args = parser.parse_args()
    inputs = load(HERE / "inputs.json")
    result = calculate(inputs, load(HERE / "labels.json"))
    result["deploymentDecision"] = inputs["deploymentDecision"]
    assert result["deploymentDecision"]["selectedByPredeclaredRule"] == result["selectedConfigOnAllFrozenPositiveQueries"]
    if args.output:
        with args.output.open("x", encoding="utf-8") as stream:
            json.dump(result, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        print(f"Wrote {args.output}")
    else:
        compare(result, load(HERE / "metrics.json"))
        print("Verified all24 settings, controls, per-query metrics, label bounds, paired differences and12 LOPO folds; external API calls0.")


if __name__ == "__main__":
    main()
