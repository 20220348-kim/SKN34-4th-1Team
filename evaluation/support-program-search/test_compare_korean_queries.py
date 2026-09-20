import copy
import json
import math
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import compare_korean_queries as comparison


ROOT = Path(__file__).resolve().parent
FIXTURE = ROOT / "runs/support-program-catalog-20260906-v1/review-final-v1/fixture-labeled.json"
QUESTIONS = ROOT / "runs/elasticsearch-korean-queries-20260912-v1/questions.json"


class KoreanQueryComparisonTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "questions.json"
        self.spec = json.loads(QUESTIONS.read_text(encoding="utf-8"))
        self.save()

    def save(self):
        self.path.write_text(json.dumps(self.spec, ensure_ascii=False), encoding="utf-8")

    def test_frozen_questions_have_16_unique_targets_and_48_variants(self):
        fixture, specification, cases = comparison.load_questions(FIXTURE, QUESTIONS)
        self.assertEqual(1422, len(fixture["docs"]))
        self.assertEqual(16, len(specification["groups"]))
        self.assertEqual(48, len(cases))
        self.assertEqual(16, len({case["targetId"] for case in cases}))
        self.assertTrue(all(sum(case["form"] == form for case in cases) == 16 for form in comparison.FORMS))
        self.assertFalse(specification["provenance"]["humanReviewed"])

    def test_snapshot_and_target_hashes_cannot_be_changed(self):
        for target in (False, True):
            self.spec = json.loads(QUESTIONS.read_text(encoding="utf-8"))
            if target:
                self.spec["groups"][0]["contentHash"] = "0" * 64
            else:
                self.spec["fixtureSha256"] = "0" * 64
            self.save()
            with self.subTest(target=target), self.assertRaises(ValueError):
                comparison.load_questions(FIXTURE, self.path)

    def test_false_human_provenance_is_rejected(self):
        self.spec["provenance"]["humanReviewed"] = True
        self.save()
        with self.assertRaisesRegex(ValueError, "provenance"):
            comparison.load_questions(FIXTURE, self.path)

    def test_evidence_must_be_from_the_actual_target_before_http(self):
        self.spec["groups"][0]["evidenceQuotes"] = ["존재하지 않는 내용을 확인한 것처럼 표시한 구절"]
        self.save()
        with patch.object(comparison.lexical, "LocalElasticsearch") as client, self.assertRaisesRegex(ValueError, "evidence"):
            comparison.run(FIXTURE, self.path, "http://127.0.0.1:19200")
        client.assert_not_called()

    def test_duplicate_target_and_missing_form_are_rejected(self):
        for problem in ("target", "form", "query"):
            self.spec = json.loads(QUESTIONS.read_text(encoding="utf-8"))
            group = self.spec["groups"][1]
            if problem == "target":
                group["targetId"] = self.spec["groups"][0]["targetId"]
            elif problem == "form":
                del group["queries"]["spacing"]
            else:
                group["queries"]["keyword"] = self.spec["groups"][0]["queries"]["keyword"]
            self.save()
            with self.subTest(problem=problem), self.assertRaises(ValueError):
                comparison.load_questions(FIXTURE, self.path)

    def test_target_identifier_cannot_leak_into_query(self):
        self.spec["groups"][0]["queries"]["keyword"] = self.spec["groups"][0]["targetId"]
        self.save()
        with self.assertRaisesRegex(ValueError, "query text"):
            comparison.load_questions(FIXTURE, self.path)

    def metric_cases(self):
        return [{"id": f"K01-{form}", "groupId": "K01", "form": form, "targetId": "BIZINFO:A"}
                for form in comparison.FORMS]

    def test_target_hit_metrics_count_variants_and_groups_separately(self):
        cases = self.metric_cases()
        results = {"K01-keyword": ["BIZINFO:A"], "K01-sentence": ["BIZINFO:B", "BIZINFO:A"], "K01-spacing": []}
        metrics = comparison.evaluate_known_items(cases, results, [{"id": "BIZINFO:A"}, {"id": "BIZINFO:B"}])
        self.assertEqual({"1": 1, "5": 2, "20": 2}, metrics["all"]["hitCounts"])
        self.assertEqual(0.5, metrics["all"]["targetMrrAt20"])
        self.assertEqual(1, metrics["groupCount"])
        self.assertEqual(0, metrics["groupsFoundInAllFormsAt20"])
        self.assertEqual(3, metrics["all"]["questionCount"])
        self.assertNotIn("macroRecallAtK", metrics["all"])

    def test_missing_unknown_duplicate_and_excess_results_are_rejected(self):
        for bad in (None, ["UNKNOWN"], ["BIZINFO:A", "BIZINFO:A"], [f"BIZINFO:{n}" for n in range(21)]):
            results = {case["id"]: [] for case in self.metric_cases()}
            if bad is None:
                del results["K01-spacing"]
            else:
                results["K01-spacing"] = bad
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                comparison.evaluate_known_items(self.metric_cases(), results, [{"id": "BIZINFO:A"}])

    def test_saved_metrics_are_recomputed_without_network(self):
        fixture, specification, cases = comparison.load_questions(FIXTURE, QUESTIONS)
        _, keyword = comparison.lexical.baseline_results(fixture["docs"], cases, comparison.K)
        report = {"schemaVersion": comparison.SCHEMA, "status": "complete",
                  **comparison.input_metadata(FIXTURE, QUESTIONS, fixture, specification, cases), "variants": {}}
        # Synthetic IDs exercise the verifier only; these are never saved as an actual ES capture.
        for name in ("keyword", *comparison.lexical.FIELDS):
            results = keyword if name == "keyword" else {case["id"]: [] for case in cases}
            report["variants"][name] = {"candidateIds": results, "metrics": comparison.evaluate_known_items(cases, results, fixture["docs"])}
        with patch.object(comparison.lexical, "LocalElasticsearch") as client:
            comparison.verify(FIXTURE, QUESTIONS, report)
            client.assert_not_called()
        for field in ("questionsSha256", "questionCount", "provenance"):
            changed = copy.deepcopy(report)
            changed[field] = None
            with self.subTest(field=field), self.assertRaises(ValueError):
                comparison.verify(FIXTURE, QUESTIONS, changed)
        report["variants"]["nori_bm25"]["metrics"]["all"]["targetMrrAt20"] = 1
        with self.assertRaisesRegex(ValueError, "metrics"):
            comparison.verify(FIXTURE, QUESTIONS, report)

    def test_frozen_report_accepts_only_float_rounding_differences_without_network(self):
        report = json.loads((QUESTIONS.parent / "report.json").read_text(encoding="utf-8"))
        with patch.object(comparison.lexical, "LocalElasticsearch") as client:
            comparison.verify(FIXTURE, QUESTIONS, report)
            rounded = copy.deepcopy(report)
            for variant in rounded["variants"].values():
                for summary in (variant["metrics"]["all"], *variant["metrics"]["byForm"].values()):
                    summary["targetMrrAt20"] = math.nextafter(summary["targetMrrAt20"], math.inf)
                    for cutoff, value in summary["hitRates"].items():
                        summary["hitRates"][cutoff] = math.nextafter(value, math.inf)
            comparison.verify(FIXTURE, QUESTIONS, rounded)
            client.assert_not_called()

        for kind in ("mrr", "rate", "count", "rank", "nan", "boolean", "question_hash"):
            with self.subTest(kind=kind):
                changed = copy.deepcopy(report)
                metrics = changed["variants"]["nori_bm25"]["metrics"]
                if kind == "mrr":
                    metrics["all"]["targetMrrAt20"] += 1e-8
                elif kind == "rate":
                    metrics["all"]["hitRates"]["20"] += 1e-8
                elif kind == "count":
                    metrics["all"]["hitCounts"]["20"] = float(metrics["all"]["hitCounts"]["20"])
                elif kind == "rank":
                    row = next(row for row in metrics["perQuery"] if row["targetRank"] is not None)
                    row["targetRank"] += 1e-13
                elif kind == "question_hash":
                    changed["questionsSha256"] = "0" * 64
                else:
                    metrics["all"]["targetMrrAt20"] = float("nan") if kind == "nan" else True
                error = "source or configuration" if kind == "question_hash" else "metrics cannot be reproduced"
                with self.assertRaisesRegex(ValueError, error):
                    comparison.verify(FIXTURE, QUESTIONS, changed)

    @unittest.skipUnless(os.environ.get("LOCAL_ES_INTEGRATION_URL"), "Opt-in real Elasticsearch known-item integration")
    def test_live_known_item_capture_and_recheck(self):
        self.spec["groups"] = self.spec["groups"][:1]
        self.save()
        report = comparison.run(FIXTURE, self.path, os.environ["LOCAL_ES_INTEGRATION_URL"])
        comparison.verify(FIXTURE, self.path, report)
        self.assertEqual(3, report["questionCount"])
        self.assertEqual(1, report["groupCount"])
        self.assertEqual(0, report["actualModelApiCalls"])
        self.assertTrue(all(len(variant["candidateIds"]) == 3 for variant in report["variants"].values()))


if __name__ == "__main__":
    unittest.main()
