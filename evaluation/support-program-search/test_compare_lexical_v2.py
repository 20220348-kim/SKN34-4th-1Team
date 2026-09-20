import copy
import json
import math
import unittest
from unittest.mock import patch

import compare_lexical_v2 as comparison


class LexicalV2ComparisonTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture, cls.cases, _ = comparison.load_inputs()
        cls.report = json.loads((comparison.RUN / "report.json").read_text(encoding="utf-8"))

    def test_shared_report_recomputes_and_keeps_the_original_300_baseline(self):
        original = copy.deepcopy(self.report)
        comparison.verify(self.report)
        self.assertEqual(original, self.report)

    def test_accepts_rounding_differences_in_mrr_and_median_only(self):
        report = copy.deepcopy(self.report)
        for group in ("existing300", "additional16"):
            for variant in comparison.CONFIGS:
                value = report["summaries"][group][variant]["mrr20"]
                report["summaries"][group][variant]["mrr20"] = math.nextafter(value, math.inf)
        for passes in report["summaries"]["timing"].values():
            for repeat, value in passes.items():
                passes[repeat] = math.nextafter(value, math.inf)
        comparison.verify(report)

    def test_rejects_material_or_invalid_float_metrics(self):
        for metric in ("mrr20", "median"):
            for value in (0.1, float("nan"), float("inf"), -float("inf"), True, "0.9"):
                with self.subTest(metric=metric, value=value):
                    report = copy.deepcopy(self.report)
                    if metric == "mrr20":
                        report["summaries"]["existing300"]["v2"]["mrr20"] = value
                    else:
                        report["summaries"]["timing"]["v2"]["0"] = value
                    with self.assertRaisesRegex(ValueError, "Saved metrics cannot be reproduced"):
                        comparison.verify(report)

    def test_rejects_float_metric_difference_above_tolerance(self):
        for metric in ("mrr20", "median"):
            with self.subTest(metric=metric):
                report = copy.deepcopy(self.report)
                if metric == "mrr20":
                    report["summaries"]["existing300"]["v2"]["mrr20"] += 1e-8
                else:
                    report["summaries"]["timing"]["v2"]["0"] += 1e-6
                with self.assertRaisesRegex(ValueError, "Saved metrics cannot be reproduced"):
                    comparison.verify(report)

    def test_counts_ranks_and_summary_structure_remain_exact(self):
        for kind in ("count", "float_count", "boolean_count", "rank", "float_rank", "order", "missing", "extra"):
            with self.subTest(kind=kind):
                report = copy.deepcopy(self.report)
                summary = report["summaries"]["existing300"]
                if kind in ("count", "float_count", "boolean_count"):
                    counts = summary["v2"]["hitCounts"]
                    counts["20"] = {"count": counts["20"] + 1, "float_count": float(counts["20"]),
                                    "boolean_count": True}[kind]
                elif kind in ("rank", "float_rank"):
                    row = next(row for row in summary["perQuery"] if row["v2"] is not None)
                    row["v2"] = row["v2"] + 1 if kind == "rank" else row["v2"] + 1e-13
                elif kind == "order":
                    summary["perQuery"].reverse()
                elif kind == "missing":
                    del summary["lostAt20"]
                else:
                    summary["unexpected"] = 0
                with self.assertRaisesRegex(ValueError, "Saved metrics cannot be reproduced"):
                    comparison.verify(report)

    def test_current_verifier_hash_is_accepted_and_unknown_source_hashes_are_rejected(self):
        _, _, provenance = comparison.load_inputs()
        report = copy.deepcopy(self.report)
        report.update(comparison.metadata(self.fixture, self.cases, provenance))
        comparison.verify(report)
        for source in report["sourceSha256"]:
            with self.subTest(source=source):
                changed = copy.deepcopy(report)
                changed["sourceSha256"][source] = "0" * 64
                with self.assertRaisesRegex(ValueError, "Report inputs/configuration/provenance changed"):
                    comparison.verify(changed)

    def test_new_metadata_uses_current_source_folder(self):
        _, _, provenance = comparison.load_inputs()
        sources = comparison.metadata(self.fixture, self.cases, provenance)["sourceSha256"]
        self.assertEqual(3, sum(path.startswith("backend/core-service/") for path in sources))
        self.assertFalse(any(path.startswith("backend/core-api/") for path in sources))

    def test_frozen_capture_still_requires_exact_original_paths_and_source_hashes(self):
        for path in self.report["sourceSha256"]:
            if not path.startswith("backend/core-api/"):
                continue
            for kind in ("hash", "renamed", "extra"):
                with self.subTest(path=path, kind=kind):
                    report = copy.deepcopy(self.report)
                    sources = report["sourceSha256"]
                    current_path = path.replace("backend/core-api/", "backend/core-service/", 1)
                    if kind == "hash":
                        sources[path] = "0" * 64
                    elif kind == "renamed":
                        sources[current_path] = sources.pop(path)
                    else:
                        sources[current_path] = sources[path]
                    with self.assertRaisesRegex(ValueError, "Report inputs/configuration/provenance changed"):
                        comparison.verify(report)

    def test_extra_cases_are_separate_ai_only_targets_with_exact_source_quotes(self):
        self.assertEqual(316, len(self.cases))
        self.assertEqual(316, len({case["targetId"] for case in self.cases}))
        self.assertEqual("N001", self.cases[300]["id"])
        _, _, provenance = comparison.load_inputs()
        self.assertIs(provenance["humanReviewed"], False)

    def test_rejects_changed_input_hash_or_human_review_claim(self):
        original = json.loads(comparison.ADDED.read_text(encoding="utf-8"))
        for field in ("hash", "human"):
            changed = copy.deepcopy(original)
            if field == "hash":
                changed["fixtureSha256"] = "0" * 64
            else:
                changed["provenance"]["humanReviewed"] = True
            with patch.object(comparison, "ADDED") as source:
                source.read_text.return_value = json.dumps(changed)
                with self.assertRaises(ValueError):
                    comparison.load_inputs()

    def test_rejects_target_reselection_and_invented_evidence(self):
        original = json.loads(comparison.ADDED.read_text(encoding="utf-8"))
        for field in ("target", "quote"):
            changed = copy.deepcopy(original)
            if field == "target":
                changed["cases"].reverse()
            else:
                changed["cases"][0]["evidenceQuote"] = "실제 공고에는 없는 임의의 증거 문장"
            with patch.object(comparison, "ADDED") as source:
                source.read_text.return_value = json.dumps(changed)
                with self.assertRaises(ValueError):
                    comparison.load_inputs()

    def test_rejects_missing_duplicate_and_unknown_candidates(self):
        for kind in ("missing", "duplicate", "unknown"):
            candidates = copy.deepcopy(self.report["candidateIds"])
            if kind == "missing":
                del candidates["v2"]["Q001"]
            elif kind == "duplicate":
                candidates["v2"]["Q001"][1] = candidates["v2"]["Q001"][0]
            else:
                candidates["v2"]["Q001"][0] = "OTHER:absent"
            with self.assertRaises(ValueError):
                comparison.summarize(self.fixture, self.cases, candidates, self.report["timings"])

    def test_rejects_missing_duplicate_or_invalid_timings(self):
        for kind in ("missing", "duplicate", "nan", "negative", "boolean"):
            timings = copy.deepcopy(self.report["timings"])
            if kind == "missing":
                timings.pop()
            elif kind == "duplicate":
                timings[1] = timings[0]
            else:
                timings[0]["httpMs"] = {"nan": float("nan"), "negative": -1, "boolean": True}[kind]
            with self.assertRaises(ValueError):
                comparison.summarize(self.fixture, self.cases, self.report["candidateIds"], timings)

    def test_rejects_fabricated_metrics_and_changed_source_configuration(self):
        for field in ("metrics", "config", "status"):
            report = copy.deepcopy(self.report)
            if field == "metrics":
                report["summaries"]["existing300"]["v2"]["hitCounts"]["20"] = 300
            elif field == "config":
                report["indexDefinitions"]["v2"]["settings"]["analysis"]["tokenizer"]["korean_words"]["decompound_mode"] = "mixed"
            else:
                report["status"] = "failed"
            with self.assertRaises(ValueError):
                comparison.verify(report)

    def test_network_guard_rejects_paid_remote_and_application_endpoints(self):
        for address in (("api.openai.com", 443), ("127.0.0.1", 8080), ("127.0.0.1", 6333)):
            with self.assertRaises(RuntimeError):
                comparison.base.restrict_network("socket.connect", (None, address))
        comparison.base.restrict_network("socket.connect", (None, ("127.0.0.1", 19200)))


if __name__ == "__main__":
    unittest.main()
