"""Synthetic selection-to-fixture integration; no network or real review mutation."""

import copy
import json
import tempfile
import unittest
from pathlib import Path

from test_review_tools import (
    LABELS, build_pool, call_main, create_scenario, fill_review, label_args,
    load_module, read_rows, write_json,
)
from evaluate import evaluate_capture, load_fixture


SELECT = load_module("label_provenance_selection", "select-review-mode.py")


class LabelProvenanceTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.scenario = create_scenario(Path(self.temporary.name))
        self.pool = build_pool(self.scenario)
        self.rows = read_rows(self.pool.review_pool)
        self.manifest = json.loads(Path(self.pool.pool_manifest).read_text(encoding="utf-8"))

    def tearDown(self):
        self.temporary.cleanup()

    def votes(self, unclear_queries=(), missing=False):
        judgments = []
        for row in self.rows:
            relevant = (row["query_id"], row["program_id"]) in {("Q01", "SYNTHETIC:1"), ("Q03", "SYNTHETIC:3")}
            for index in range(1, 6):
                decision = "relevant" if relevant else "irrelevant"
                if row["query_id"] in unclear_queries:
                    decision = "relevant" if index <= 3 else "irrelevant"
                judgments.append({
                    "queryId": row["query_id"], "programId": row["program_id"],
                    "judgeId": f"judge-{index}", "decision": decision,
                    "reason": "합성 테스트 근거", "evidence": [row["title"]],
                })
        if missing:
            judgments.pop()
        return {"judgments": judgments, "pendingCount": 1 if missing else 0}

    def human_export(self):
        return {
            **SELECT.PAGE.review_identity(self.manifest), "reviewer": "합성 검토자",
            "judgments": [{
                "queryId": row["query_id"], "programId": row["program_id"],
                "decision": "relevant" if row["query_id"] != "Q02" else "irrelevant",
                "reason": "합성 사람 판정", "reviewer": "합성 검토자", "provenance": {"kind": "browser"},
            } for row in self.rows],
        }

    def selection_args(self, mode="ai-only", unclear_queries=(), missing=False, human=None, exclusions=()):
        selection, csv_bytes, _ = SELECT.compose_selection(
            mode, self.rows, self.manifest,
            ai_review=self.votes(unclear_queries, missing) if mode != "human" else None,
            human_export=human, ai_review_sha256="a" * 64 if mode != "human" else None,
            human_review_sha256="b" * 64 if human else None,
        )
        output_dir = self.scenario.root / "selected"
        output_dir.mkdir()
        csv_path = output_dir / "reviewed.csv"
        csv_path.write_bytes(csv_bytes)
        selection_path = output_dir / "selection.json"
        write_json(selection_path, selection)
        args = label_args(self.scenario, self.pool, self.scenario.root / "labeled.json", exclusions)
        args.review_pool = str(csv_path)
        args.selection = str(selection_path)
        return args, selection

    def test_ai_selection_propagates_audit_and_excludes_entire_uncertain_query(self):
        args, selection = self.selection_args(unclear_queries={"Q01"})
        call_main(LABELS, args)
        fixture = load_fixture(args.output)
        cases = {case["id"]: case for case in fixture["cases"]}
        self.assertIsNone(cases["Q01"]["relevantIds"])
        self.assertEqual([], cases["Q02"]["relevantIds"])
        self.assertEqual(["SYNTHETIC:3"], cases["Q03"]["relevantIds"])
        self.assertEqual("real_catalog_snapshot_labeled_pooled_ai_consensus", fixture["dataType"])
        review = fixture["labelReview"]
        self.assertEqual("ai-only", review["mode"])
        self.assertEqual(selection["sourceCounts"], review["sourceCounts"])
        self.assertEqual("a" * 64, review["sourceHashes"]["aiReviewSha256"])
        self.assertEqual(LABELS.sha256_path(args.selection), review["sourceHashes"]["selectionSha256"])
        self.assertEqual({"reviewRowCount": len(self.rows), "labeledQueryCount": 2, "excludedQueryCount": 1}, review["counts"])
        report = evaluate_capture(self.scenario.capture, fixture, fixture["cases"], candidate_k=20)
        self.assertEqual("ai-only", report["labelReference"]["mode"])
        self.assertEqual(1, report["candidate"]["unlabeledQueriesSkipped"])
        self.assertEqual(1, report["candidate"]["answerableQueries"])
        self.assertEqual(1, report["candidate"]["noMatchQueries"])

    def test_human_selection_is_distinct_and_retains_human_input_hash(self):
        args, _ = self.selection_args(mode="human", human=self.human_export())
        call_main(LABELS, args)
        fixture = load_fixture(args.output)
        self.assertEqual("real_catalog_snapshot_labeled_pooled_human", fixture["dataType"])
        self.assertEqual("human", fixture["labelReview"]["mode"])
        self.assertEqual("b" * 64, fixture["labelReview"]["sourceHashes"]["humanReviewSha256"])
        self.assertNotIn("aiReviewSha256", fixture["labelReview"]["sourceHashes"])

    def test_hybrid_completed_checks_are_not_mislabeled_fully_human_mode(self):
        args, _ = self.selection_args(mode="hybrid", human=self.human_export())
        call_main(LABELS, args)
        fixture = load_fixture(args.output)
        self.assertEqual("hybrid", fixture["labelReview"]["mode"])
        self.assertEqual("real_catalog_snapshot_labeled_pooled_hybrid", fixture["dataType"])
        self.assertGreater(fixture["labelReview"]["requiredHumanReviewCount"], 0)

    def test_unselected_legacy_input_does_not_imply_human_verification(self):
        fill_review(self.pool.review_pool, {("Q03", "SYNTHETIC:3"): "relevant"})
        args = label_args(self.scenario, self.pool, self.scenario.root / "legacy.json")
        call_main(LABELS, args)
        fixture = load_fixture(args.output)
        self.assertEqual("legacy_unspecified", fixture["labelReview"]["mode"])
        self.assertEqual("real_catalog_snapshot_labeled_pooled_legacy_unspecified", fixture["dataType"])
        self.assertTrue(all("human review" not in warning["message"] for warning in fixture["labelReview"]["warnings"]))

    def test_selection_from_different_pool_is_rejected(self):
        args, selection = self.selection_args()
        selection["identity"]["querySetSha256"] = "f" * 64
        write_json(Path(args.selection), selection)
        with self.assertRaisesRegex(ValueError, "another pool"):
            call_main(LABELS, args)
        self.assertFalse(Path(args.output).exists())

    def test_selection_rejects_duplicate_json_fields(self):
        args, _ = self.selection_args()
        path = Path(args.selection)
        text = path.read_text(encoding="utf-8")
        path.write_text(text.replace('"mode": "ai-only"', '"mode": "human", "mode": "ai-only"'), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Duplicate JSON field"):
            call_main(LABELS, args)

    def test_exact_csv_hash_is_checked_even_when_parsed_rows_are_identical(self):
        args, _ = self.selection_args()
        path = Path(args.review_pool)
        path.write_bytes(path.read_bytes() + b"\n")
        with self.assertRaisesRegex(ValueError, "CSV hash"):
            call_main(LABELS, args)
        self.assertFalse(Path(args.output).exists())

    def test_selection_cannot_change_source_counts_or_final_labels(self):
        args, selection = self.selection_args()
        forged = copy.deepcopy(selection)
        forged["sourceCounts"]["human"] = 1
        write_json(Path(args.selection), forged)
        with self.assertRaisesRegex(ValueError, "sourceCounts"):
            call_main(LABELS, args)
        forged = copy.deepcopy(selection)
        forged["records"][0]["decision"] = "unclear"
        write_json(Path(args.selection), forged)
        with self.assertRaisesRegex(ValueError, "differ from reviewed CSV"):
            call_main(LABELS, args)

    def test_incomplete_ai_cannot_publish_partial_labels(self):
        args, selection = self.selection_args(missing=True)
        self.assertEqual("incomplete-ai", selection["status"])
        with self.assertRaisesRegex(ValueError, "not ready"):
            call_main(LABELS, args)

    def test_pending_hybrid_checks_cannot_be_skipped_by_explicit_exclusion(self):
        args, selection = self.selection_args(mode="hybrid", exclusions=["Q01=일부 제외"])
        self.assertGreater(selection["pendingHumanReviewCount"], 0)
        with self.assertRaisesRegex(ValueError, "not ready"):
            call_main(LABELS, args)

    def test_all_ai_unresolved_queries_cannot_produce_reportable_fixture(self):
        args, selection = self.selection_args(unclear_queries={"Q01", "Q02", "Q03"})
        self.assertEqual("no-evaluable-queries", selection["status"])
        with self.assertRaisesRegex(ValueError, "not ready"):
            call_main(LABELS, args)

    def test_combined_automatic_and_explicit_exclusions_cannot_remove_all_queries(self):
        args, _ = self.selection_args(unclear_queries={"Q01"}, exclusions=["Q02=제외", "Q03=제외"])
        with self.assertRaisesRegex(ValueError, "At least one query"):
            call_main(LABELS, args)

    def test_selection_does_not_bypass_final_capture_gate_or_no_clobber(self):
        args, _ = self.selection_args()
        Path(args.output).write_text("기존 결과", encoding="utf-8")
        with self.assertRaises(FileExistsError):
            call_main(LABELS, args)
        self.assertEqual("기존 결과", Path(args.output).read_text(encoding="utf-8"))
        args.output = str(self.scenario.root / "another.json")
        manifest = copy.deepcopy(self.manifest)
        manifest["captureIncluded"] = False
        write_json(Path(args.pool_manifest), manifest)
        with self.assertRaisesRegex(ValueError, "real search capture"):
            call_main(LABELS, args)
        self.assertFalse(Path(args.output).exists())


if __name__ == "__main__":
    unittest.main()
