import copy
import importlib.util
import json
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("budget300", Path(__file__).with_name("compare.py"))
budget = importlib.util.module_from_spec(spec)
spec.loader.exec_module(budget)


class ExtendedBudgetTest(unittest.TestCase):
    def test_original_100_are_preserved_and_200_are_distinct(self):
        fixture, provenance, cases = budget.load_inputs()
        original = budget.base.load_inputs()[2]
        self.assertEqual(cases[:100], original)
        self.assertEqual(len(cases), 300)
        self.assertEqual(len({case["targetId"] for case in cases}), 300)
        self.assertEqual(len({case["query"] for case in cases}), 300)
        self.assertFalse(provenance["extension"]["humanReviewed"])
        self.assertEqual(budget.metadata(fixture, provenance, cases)["localElasticsearchSearchCalls"], 2400)

    def test_mutated_extension_is_rejected(self):
        original = json.loads(budget.ADDED.read_text(encoding="utf-8"))
        mutations = [
            lambda data: data.update(baseQuestionsSha256="wrong"),
            lambda data: data.update(fixtureSha256="wrong"),
            lambda data: data["provenance"].update(humanReviewed=True),
            lambda data: data["cases"].pop(),
            lambda data: data["cases"].reverse(),
            lambda data: data["cases"][0].update(evidenceQuote="원문에 없는 근거 문장입니다"),
            lambda data: data["cases"][0].update(query=data["cases"][1]["query"]),
            lambda data: data["cases"][0].update(id="Q001"),
        ]
        for mutation in mutations:
            data = copy.deepcopy(original)
            mutation(data)
            with self.subTest(mutation=mutation), patch.object(budget, "ADDED") as path:
                path.read_text.return_value = json.dumps(data, ensure_ascii=False)
                with self.assertRaises(ValueError):
                    budget.load_inputs()

    def test_existing_shared_inputs_and_base_report_still_verify(self):
        report = json.loads((budget.BASE / "report.json").read_text(encoding="utf-8"))
        budget.base.verify(report)

    def test_group_summaries_keep_boundary_losses(self):
        fixture, _, cases = budget.load_inputs()
        common = [doc["id"] for doc in fixture["docs"] if doc["id"] not in {case["targetId"] for case in cases}][:19]
        candidates, timings = {}, []
        for index, case in enumerate(cases):
            # First 100: target rank 1; new 200: rank 16.
            ids = [case["targetId"], *common] if index < 100 else common[:15] + [case["targetId"]] + common[15:]
            candidates[case["id"]] = {"15": ids[:15], "20": ids}
            timings.extend({"queryId": case["id"], "k": k, "pass": repeat, "httpMs": 2.0, "elasticsearchTookMs": 1}
                           for k in (15, 20) for repeat in range(budget.base.PASSES))
        summary = budget.summaries(fixture, cases, candidates, timings)
        self.assertEqual(summary["all300"]["cutoffs"]["20"]["targetHitCount"], 300)
        self.assertEqual(summary["all300"]["cutoffs"]["15"]["targetHitCount"], 100)
        self.assertEqual(len(summary["new200"]["lostQueryIds"]), 200)
        self.assertEqual(summary["previous100"]["lostQueryIds"], [])
        candidates["unexpected"] = candidates[cases[0]["id"]]
        with self.assertRaises(ValueError):
            budget.summaries(fixture, cases, candidates, timings)

    def test_saved_report_reproduces_all_and_subgroup_metrics(self):
        path = Path(__file__).with_name("report.json")
        if not path.exists():
            self.skipTest("Actual capture not produced yet")
        report = json.loads(path.read_text(encoding="utf-8"))
        budget.verify(report)
        report["summaries"]["new200"]["cutoffs"]["15"]["targetHitCount"] += 1
        with self.assertRaises(ValueError):
            budget.verify(report)


if __name__ == "__main__":
    unittest.main()
