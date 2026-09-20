#!/usr/bin/env python3
"""Verify a frozen support-program review run without API or model execution."""
import argparse
import contextlib
import io
import importlib.util
import json
import shutil
import sys
import tempfile
from pathlib import Path


HERE = Path(__file__).resolve().parent


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


RUNNER = load_module("verify_ai_runner", "run-ai-review.py")
SELECTOR = load_module("verify_selector", "select-review-mode.py")
RECHECK = load_module("verify_recheck", "recheck-ai-review.py")
TRANSFER = load_module("verify_transfer", "transfer-ai-review.py")
LABELS = load_module("verify_labels", "apply-labels.py")
EVALUATOR = load_module("verify_evaluator", "../evaluate.py")


def read(path):
    return RUNNER.PAGE.load_json(path)


def invoke(module, args):
    old = module.parse_args
    module.parse_args = lambda: args
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            module.main()
    finally:
        module.parse_args = old


def same_json(left, right):
    return read(left) == read(right)


def _verify_cause_audit(path, prepared, blind_path):
    audit = read(path)
    RUNNER.PAGE.require_keys(audit, {"schemaVersion", "baseAiReviewSha256", "inputSha256", "auditor", "records", "sourceCrosscheck"}, "Cause audit")
    if audit["sourceCrosscheck"] != {"agentId": "/root", "kind": "ai-source-crosscheck"}:
        raise ValueError("Invalid cause-audit source crosscheck")
    if audit.get("schemaVersion") != "support-program-ai-recheck-cause-audit-v1":
        raise ValueError("Invalid cause-audit schema")
    if audit.get("baseAiReviewSha256") != prepared["baseAiReviewSha256"] or audit.get("inputSha256") != prepared["inputSha256"]:
        raise ValueError("Cause-audit source hash differs")
    if audit.get("auditor") != {"agentId": "/root/luna_recheck_2", "model": "gpt-5.6-luna", "kind": "ai-audit-after-blind-vote"}:
        raise ValueError("Invalid cause-audit auditor")
    blind = {(item["queryId"], item["programId"]): item["announcement"]
             for item in RUNNER.read_jsonl(blind_path)}
    records = audit.get("records")
    if not isinstance(records, list) or len(records) != len(blind):
        raise ValueError("Cause-audit coverage differs")
    causes = {"decision_reason_mismatch", "explicit_fact_misread", "partial_match", "eligibility_confusion", "insufficient_source", "other_interpretation"}
    seen = set()
    for record in records:
        RUNNER.PAGE.require_keys(record, {"queryId", "programId", "primaryCause", "explanation", "missingInformation", "affectedJudgeIds", "evidence"}, "Cause-audit record")
        for field in ("queryId", "programId", "primaryCause", "explanation"):
            RUNNER.PAGE.require_text(record[field], field, maximum=2000, nonempty=True)
        pair = (record["queryId"], record["programId"])
        if pair in seen or pair not in blind or record["primaryCause"] not in causes:
            raise ValueError("Cause-audit target or cause is invalid")
        for field in ("missingInformation", "affectedJudgeIds"):
            if not isinstance(record[field], list):
                raise ValueError("Cause-audit fields are invalid")
            for item in record[field]:
                RUNNER.PAGE.require_text(item, field, maximum=1000, nonempty=True)
            if len(record[field]) != len(set(record[field])):
                raise ValueError("Duplicate cause-audit list item")
        if not record["affectedJudgeIds"] or not set(record["affectedJudgeIds"]) <= {f"judge-{i}" for i in range(1, 6)}:
            raise ValueError("Unknown or missing affected judge")
        evidence = record["evidence"]
        if not isinstance(evidence, list) or len(evidence) > 3 or any(not isinstance(item, str) or not item.strip() or len(item) > 300 or item not in blind[pair] for item in evidence):
            raise ValueError("Cause-audit evidence is invalid")
        if len(evidence) != len(set(evidence)):
            raise ValueError("Duplicate cause-audit evidence")
        seen.add(pair)
    if seen != set(blind):
        raise ValueError("Cause-audit target coverage differs")


def _compare_selection(out, saved, mode):
    for filename in ("selection.json", "reviewed.csv", "review-progress.json"):
        generated = out / filename
        expected = saved / filename
        if filename.endswith(".json"):
            equal = same_json(generated, expected)
        else:
            equal = generated.read_bytes() == expected.read_bytes()
        if not equal:
            raise ValueError(f"{mode} {filename} differs")


def capture_files(run):
    final = run / "review-final-v1"
    additional = final / "additional-ai-v1"
    return [run / "actual-capture-v3" / "capture.json"] + [
        final / name for name in (
            "review-pool.csv", "review-pool-provenance.csv", "review-pool-manifest.json",
            "fixture-labeled.json", "report-all.json", "report-dev.json", "report-heldout.json",
        )
    ] + [additional / name for name in (
        "transfer-plan.json", "review-pool.csv", "review-pool-manifest.json", "assignments.json",
        "ai-review.json", *[f"judge-{number}.jsonl" for number in range(1, 6)],
        "prepared/prepared.json", "prepared/policy.json", "prepared/blind-input.jsonl",
    )] + [final / "selected-ai-transfer-v1" / name
          for name in ("selection.json", "reviewed.csv", "review-progress.json")]


def _evaluate_report(fixture, capture, split):
    previous_argv = sys.argv
    output = io.StringIO()
    try:
        sys.argv = [str(EVALUATOR.__file__), "--fixture", str(fixture), "--capture", str(capture), "--split", split]
        with contextlib.redirect_stdout(output):
            EVALUATOR.main()
    finally:
        sys.argv = previous_argv
    return json.loads(output.getvalue())


def _verify_capture(run, source, temp, model):
    final = run / "review-final-v1"
    additional = final / "additional-ai-v1"
    selected = final / "selected-ai-transfer-v1"
    capture = run / "actual-capture-v3" / "capture.json"
    generated_pool = temp / "final-pool"
    pool_args = argparse.Namespace(
        fixture=str(source["fixture"]), query_set=str(source["query_set"]), config=str(source["config"]),
        capture=str(capture), previous_review=None,
        review_pool=str(generated_pool / "review-pool.csv"),
        provenance=str(generated_pool / "review-pool-provenance.csv"),
        pool_manifest=str(generated_pool / "review-pool-manifest.json"),
    )
    invoke(RUNNER.PAGE.POOL, pool_args)
    for name in ("review-pool.csv", "review-pool-provenance.csv", "review-pool-manifest.json"):
        equal = same_json(generated_pool / name, final / name) if name.endswith(".json") else (
            (generated_pool / name).read_bytes() == (final / name).read_bytes())
        if not equal:
            raise ValueError(f"Final capture pool {name} differs")

    transfer_args = dict(
        fixture=str(source["fixture"]), query_set=str(source["query_set"]), config=str(source["config"]),
        capture=str(capture), previous_pool=str(source["review_pool"]),
        previous_manifest=str(source["pool_manifest"]), review_pool=str(final / "review-pool.csv"),
        pool_manifest=str(final / "review-pool-manifest.json"), ai_review=str(source["ai_review"]),
        ai_recheck=str(run / "review-v2" / "codex-ai-recheck-v1" / "ai-recheck.json"),
    )
    generated_additional = temp / "additional"
    with contextlib.redirect_stdout(io.StringIO()):
        TRANSFER.prepare(argparse.Namespace(**transfer_args, output_dir=str(generated_additional)))
    for name in ("transfer-plan.json", "review-pool-manifest.json", "prepared/prepared.json", "prepared/policy.json"):
        if not same_json(generated_additional / name, additional / name):
            raise ValueError(f"Additional capture preparation {name} differs")
    if (generated_additional / "review-pool.csv").read_bytes() != (additional / "review-pool.csv").read_bytes():
        raise ValueError("Additional capture review-pool.csv differs")
    if RUNNER.read_jsonl(generated_additional / "prepared/blind-input.jsonl") != RUNNER.read_jsonl(additional / "prepared/blind-input.jsonl"):
        raise ValueError("Additional capture blind-input.jsonl differs")

    collected = temp / "additional-ai-review.json"
    with contextlib.redirect_stdout(io.StringIO()):
        RUNNER.collect(argparse.Namespace(
            fixture=str(source["fixture"]), query_set=str(source["query_set"]),
            review_pool=str(additional / "review-pool.csv"), pool_manifest=str(additional / "review-pool-manifest.json"),
            model=model, prepared_dir=str(additional / "prepared"), assignments=str(additional / "assignments.json"),
            judge_file=[str(additional / f"judge-{number}.jsonl") for number in range(1, 6)], output=str(collected),
        ))
    if not same_json(collected, additional / "ai-review.json"):
        raise ValueError("Recollected additional ai-review.json differs")

    generated_selected = temp / "selected-transfer"
    with contextlib.redirect_stdout(io.StringIO()):
        TRANSFER.select(argparse.Namespace(
            **transfer_args, additional_dir=str(additional), additional_ai_review=str(additional / "ai-review.json"),
            conversation_judgments=str(source["conversation"]), output_dir=str(generated_selected),
        ))
    _compare_selection(generated_selected, selected, "ai-only-transfer")
    generated_fixture = temp / "fixture-labeled.json"
    invoke(LABELS, argparse.Namespace(
        fixture=str(source["fixture"]), query_set=str(source["query_set"]), config=str(source["config"]),
        capture=str(capture), pool_manifest=str(final / "review-pool-manifest.json"),
        review_pool=str(selected / "reviewed.csv"), selection=str(selected / "selection.json"),
        exclude_query=[], output=str(generated_fixture),
    ))
    if not same_json(generated_fixture, final / "fixture-labeled.json"):
        raise ValueError("Capture fixture-labeled.json differs")
    for split in ("all", "dev", "heldout"):
        if _evaluate_report(generated_fixture, capture, split) != read(final / f"report-{split}.json"):
            raise ValueError(f"Capture report-{split}.json differs")
    selection = read(selected / "selection.json")
    return {"observations": len(read(capture)["observations"]),
            "reviewPairCount": read(final / "review-pool-manifest.json")["reviewRowCount"],
            "additionalJudgments": len(read(additional / "ai-review.json")["judgments"]),
            "sourceCounts": selection["sourceCounts"], "evaluableQueryCount": selection["evaluableQueryCount"],
            "splits": ["all", "dev", "heldout"]}


def verify_run(run_dir, with_recheck=False, with_capture=False):
    with_recheck = with_recheck or with_capture
    run = Path(run_dir).resolve()
    review = run / "review-v2"
    ai = review / "codex-ai-v1"
    source = {
        "fixture": run / "fixture-unlabeled.json",
        "query_set": run / "query-set.json",
        "config": run / "pool-config.json",
        "review_pool": review / "review-pool.csv",
        "provenance": review / "review-pool-provenance.csv",
        "pool_manifest": review / "review-pool-manifest.json",
        "conversation": review / "conversation-judgments.json",
        "ai_review": ai / "ai-review.json",
        "prepared": ai / "prepared.json",
        "policy": ai / "policy.json",
        "assignments": ai / "assignments.json",
        "blind_input": ai / "blind-input.jsonl",
    }
    judges = [ai / f"judge-{number}.jsonl" for number in range(1, 6)]
    selected_dirs = {
        "ai-only": review / "selected-ai-v1",
        "hybrid": review / "selected-hybrid-v1",
        "human": review / "selected-human-v1",
    }
    recheck_dir = review / "codex-ai-recheck-v1"
    recheck_selected_dirs = {
        "ai-only": review / "selected-ai-recheck-v1",
        "hybrid": review / "selected-hybrid-recheck-v1",
    }
    selected_files = [directory / filename for directory in selected_dirs.values()
                      for filename in ("selection.json", "reviewed.csv", "review-progress.json")]
    required = list(source.values()) + judges + selected_files
    if with_recheck:
        required += [recheck_dir / name for name in (
            "prepared.json", "policy.json", "blind-input.jsonl", "assignments.json", "ai-recheck.json", "cause-audit.json",
            *[f"judge-{number}.jsonl" for number in range(1, 6)])]
        required += [directory / filename for directory in recheck_selected_dirs.values()
                     for filename in ("selection.json", "reviewed.csv", "review-progress.json")]
    if with_capture:
        required += capture_files(run)
    missing = [str(path.relative_to(run)) for path in required if not path.is_file()]
    if missing:
        raise ValueError("missing source: " + ", ".join(missing))

    # Existing source/pool validators reject changed fixture, query, manifest, or CSV.
    fixture = RUNNER.PAGE.load_fixture(source["fixture"])
    query = RUNNER.PAGE.load_json(source["query_set"])
    manifest = RUNNER.PAGE.load_json(source["pool_manifest"])
    config = RUNNER.PAGE.load_json(source["config"])
    RUNNER.PAGE.POOL.validate_inputs(fixture, query, config)
    rows = RUNNER.PAGE.load_verified_pool(source["review_pool"], manifest)
    if manifest.get("configSha256") != RUNNER.PAGE.POOL.sha256_path(source["config"]):
        raise ValueError("Pool-config hash differs")
    if manifest.get("provenanceCsvSha256") != RUNNER.PAGE.POOL.sha256_path(source["provenance"]):
        raise ValueError("Provenance CSV hash differs")
    RUNNER.PAGE.validate_sources(fixture, query, manifest, rows)
    policy = read(source["policy"])
    RUNNER.validate_policy(policy)
    model = policy["model"]

    with tempfile.TemporaryDirectory(prefix="verify-shared-run-") as temp_name:
        temp = Path(temp_name)
        copied = {}
        for key in ("fixture", "query_set", "config", "review_pool", "provenance", "pool_manifest", "conversation", "prepared", "policy", "assignments", "blind_input"):
            target = temp / Path(source[key]).name
            shutil.copyfile(source[key], target)
            copied[key] = target
        copied_judges = []
        for path in judges:
            target = temp / path.name
            shutil.copyfile(path, target)
            copied_judges.append(str(target))
        prepared_dir = temp / "prepared"
        prepared_dir.mkdir()
        for key in ("prepared", "policy"):
            shutil.copyfile(copied[key], prepared_dir / Path(copied[key]).name)
        shutil.copyfile(copied["blind_input"], prepared_dir / "blind-input.jsonl")
        # Use the saved prepared/policy/assignments and original judge JSONL in isolation.
        collected = temp / "ai-review.json"
        collect_args = argparse.Namespace(
            fixture=str(copied["fixture"]), query_set=str(copied["query_set"]),
            review_pool=str(copied["review_pool"]), pool_manifest=str(copied["pool_manifest"]),
            model=model, prepared_dir=str(prepared_dir), assignments=str(copied["assignments"]),
            judge_file=copied_judges, output=str(collected),
        )
        with contextlib.redirect_stdout(io.StringIO()):
            RUNNER.collect(collect_args)
        if not same_json(collected, source["ai_review"]):
            raise ValueError("recollected ai-review.json differs")
        saved_ai = temp / "saved-ai-review.json"
        shutil.copyfile(source["ai_review"], saved_ai)

        mode_results = {}
        for mode in ("ai-only", "hybrid", "human"):
            out = temp / ("selected-" + mode)
            args = argparse.Namespace(
                fixture=str(copied["fixture"]), query_set=str(copied["query_set"]),
                review_pool=str(copied["review_pool"]), pool_manifest=str(copied["pool_manifest"]),
                mode=mode, ai_review=str(saved_ai) if mode != "human" else None,
                human_review=None, conversation_judgments=str(copied["conversation"]),
                output_dir=str(out),
            )
            invoke(SELECTOR, args)
            saved = selected_dirs[mode]
            _compare_selection(out, saved, mode)
            mode_results[mode] = read(out / "selection.json")["status"]

        recheck_summary = None
        if with_recheck:
            recheck_prepared = temp / "recheck-prepared"
            recheck_prepared.mkdir()
            for name in ("prepared.json", "policy.json", "blind-input.jsonl"):
                shutil.copyfile(recheck_dir / name, recheck_prepared / name)
            recheck_copied_judges = []
            for number in range(1, 6):
                target = temp / f"recheck-judge-{number}.jsonl"
                shutil.copyfile(recheck_dir / f"judge-{number}.jsonl", target)
                recheck_copied_judges.append(str(target))
            recheck_assignments = temp / "recheck-assignments.json"
            shutil.copyfile(recheck_dir / "assignments.json", recheck_assignments)
            recheck_output = temp / "ai-recheck.json"
            recheck_args = argparse.Namespace(
                fixture=str(copied["fixture"]), query_set=str(copied["query_set"]),
                review_pool=str(copied["review_pool"]), pool_manifest=str(copied["pool_manifest"]),
                base_ai_review=str(saved_ai), prepared_dir=str(recheck_prepared),
                assignments=str(recheck_assignments), judge_file=recheck_copied_judges,
                output=str(recheck_output),
            )
            with contextlib.redirect_stdout(io.StringIO()):
                RECHECK.collect(recheck_args)
            saved_recheck = temp / "saved-ai-recheck.json"
            shutil.copyfile(recheck_dir / "ai-recheck.json", saved_recheck)
            if not same_json(recheck_output, saved_recheck):
                raise ValueError("recollected ai-recheck.json differs")
            _verify_cause_audit(recheck_dir / "cause-audit.json", read(recheck_dir / "prepared.json"), recheck_dir / "blind-input.jsonl")
            recheck_results = {}
            for mode in ("ai-only", "hybrid"):
                out = temp / ("selected-recheck-" + mode)
                args = argparse.Namespace(
                    fixture=str(copied["fixture"]), query_set=str(copied["query_set"]),
                    review_pool=str(copied["review_pool"]), pool_manifest=str(copied["pool_manifest"]),
                    mode=mode, ai_review=str(saved_ai), ai_recheck=str(saved_recheck), human_review=None,
                    conversation_judgments=str(copied["conversation"]), output_dir=str(out),
                )
                invoke(SELECTOR, args)
                _compare_selection(out, recheck_selected_dirs[mode], mode + "-recheck")
                recheck_results[mode] = read(out / "selection.json")["status"]
            saved_recheck_data = read(recheck_dir / "ai-recheck.json")
            selected_ai = read(recheck_selected_dirs["ai-only"] / "selection.json")
            recheck_summary = {"judgments": len(saved_recheck_data["judgments"]),
                               "modes": recheck_results,
                               "sourceCounts": selected_ai["sourceCounts"],
                               "evaluableQueryCount": selected_ai["evaluableQueryCount"]}

        capture_summary = _verify_capture(run, source, temp, model) if with_capture else None

    result = {"status": "ok", "checks": 1 + len(mode_results), "modes": mode_results,
              "judgments": len(read(source["ai_review"])["judgments"]),
              "actualSearchEvaluated": False}
    if with_recheck:
        result["recheck"] = recheck_summary
        result["checks"] += 4  # Recollection, cause audit, and two selected modes.
    if with_capture:
        result["capture"] = capture_summary
        result["actualSearchEvaluated"] = True
        result["checks"] += 8  # Pool, preparation, recollection, selection, labels, and three reports.
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--with-recheck", action="store_true")
    parser.add_argument("--with-capture", action="store_true", help="Replay the real capture pool and metrics, including recheck verification")
    args = parser.parse_args(argv)
    try:
        result = verify_run(args.run_dir, with_recheck=args.with_recheck, with_capture=args.with_capture)
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(json.dumps({"status": "failed", "error": str(error)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
