import copy
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("budget_100", Path(__file__).with_name("compare.py"))
budget = importlib.util.module_from_spec(spec)
spec.loader.exec_module(budget)


class BudgetComparisonTest(unittest.TestCase):
    def setUp(self):
        self.docs = {f"BIZINFO:{i}": {"text": f"제목: 공고{i}", "contentHash": "test-hash"} for i in range(1, 22)}
        self.cases = [{"id": "Q001", "targetId": "BIZINFO:16", "query": "지원 검색", "evidenceQuote": "테스트"}]
        self.candidates = {"Q001": {str(k): [f"BIZINFO:{i}" for i in range(1, k + 1)] for k in (15, 20)}}
        self.timings = [{"queryId": "Q001", "k": k, "pass": repeat, "httpMs": 2.0, "elasticsearchTookMs": 1}
                        for k in (15, 20) for repeat in range(budget.PASSES)]

    def summarize(self):
        return budget.summarize(self.cases, self.candidates, self.docs, self.timings)

    def test_real_inputs_have_100_distinct_grounded_targets(self):
        fixture, specification, cases = budget.load_inputs()
        self.assertEqual(len(fixture["docs"]), 1422)
        self.assertEqual(len(cases), 100)
        self.assertFalse(specification["provenance"]["humanReviewed"])

    def test_cutoff_boundary_is_inclusive(self):
        for rank in (1, 15, 16, 20, 21):
            with self.subTest(rank=rank):
                self.cases[0]["targetId"] = f"BIZINFO:{rank}"
                result = self.summarize()
                self.assertEqual(result["cutoffs"]["15"]["targetHitCount"], int(rank <= 15))
                self.assertEqual(result["cutoffs"]["20"]["targetHitCount"], int(rank <= 20))
                self.assertEqual(result["lostQueryIds"], ["Q001"] if 16 <= rank <= 20 else [])
                self.assertEqual(result["missingAtBothQueryIds"], ["Q001"] if rank > 20 else [])

    def test_prefix_mismatch_is_rejected(self):
        self.candidates["Q001"]["15"].reverse()
        with self.assertRaises(ValueError):
            self.summarize()

    def test_bad_candidate_sets_are_rejected(self):
        original = copy.deepcopy(self.candidates)
        for invalid in (["unknown"], ["BIZINFO:1", "BIZINFO:1"], list(self.docs)):
            self.candidates = copy.deepcopy(original)
            self.candidates["Q001"]["20"] = invalid
            with self.assertRaises(ValueError):
                self.summarize()

    def test_missing_question_is_rejected(self):
        self.candidates.clear()
        with self.assertRaises(ValueError):
            self.summarize()

    def test_missing_or_duplicate_timing_is_rejected(self):
        last = self.timings.pop()
        with self.assertRaises(ValueError):
            self.summarize()
        self.timings.extend([last, last])
        with self.assertRaises(ValueError):
            self.summarize()

    def test_nonfinite_timing_is_rejected(self):
        self.timings[0]["httpMs"] = float("nan")
        with self.assertRaises(ValueError):
            self.summarize()

    def test_first_pass_is_not_in_warm_median(self):
        for timing in self.timings:
            timing["httpMs"] = 999 if timing["pass"] == 0 else 2
        result = self.summarize()["cutoffs"]["20"]
        self.assertEqual(result["firstPass"]["httpMs"]["median"], 999)
        self.assertEqual(result["warmPasses"]["httpMs"]["median"], 2)
        self.assertEqual(result["warmPasses"]["samples"], 3)

    def test_external_network_and_other_local_services_are_blocked(self):
        for address in (("api.openai.com", 443), ("127.0.0.1", 6333), ("127.0.0.1", 8080)):
            with self.assertRaises(RuntimeError):
                budget.restrict_network("socket.connect", (None, address))
        with self.assertRaises(RuntimeError):
            budget.restrict_network("socket.getaddrinfo", ("api.openai.com", 443))
        budget.restrict_network("socket.connect", (None, ("127.0.0.1", 19200)))

    def test_saved_report_reproduces_offline(self):
        path = Path(__file__).with_name("report.json")
        if not path.exists():
            self.skipTest("Capture has not been run yet")
        import json
        report = json.loads(path.read_text(encoding="utf-8"))
        budget.verify(report)
        report["summary"]["cutoffs"]["15"]["targetHitCount"] += 1
        with self.assertRaises(ValueError):
            budget.verify(report)


if __name__ == "__main__":
    unittest.main()
