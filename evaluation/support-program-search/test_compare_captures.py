import copy
import csv
import hashlib
import importlib.util
import io
import json
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path

from evaluate import CAPTURE_SCHEMA_VERSION, eligible_catalog_fingerprint, query_set_sha256


SPEC = importlib.util.spec_from_file_location("compare_captures", Path(__file__).with_name("compare-captures.py"))
comparison = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(comparison)


class CaptureComparisonTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.paths = {name: self.directory / f"{name}.json" for name in ("fixture", "before", "after")}
        self.review_path = self.directory / "reviewed.csv"
        docs = [{"id": f"BIZINFO:{letter}", "text": f"지원 공고 {letter}",
                 "sortTimestamp": "2026-09-06T00:00:00"} for letter in "ABCDE"]
        for doc in docs:
            doc["contentHash"] = hashlib.sha256(doc["text"].encode("utf-8")).hexdigest()
        self.fixture = {
            "name": "frozen-fixture", "dataType": "real_catalog_snapshot_labeled_pooled_legacy_unspecified",
            "referenceDate": "2026-09-06", "docs": docs,
            "catalog": {"presentProgramCount": 5, "eligibleProgramCount": 5,
                        "eligibleCatalogFingerprint": eligible_catalog_fingerprint(docs)},
            "cases": [
                {"id": "Q1", "query": "서울 창업", "split": "dev", "relevantIds": ["BIZINFO:A", "BIZINFO:B"]},
                {"id": "Q2", "query": "지원 없음", "split": "dev", "relevantIds": []},
                {"id": "Q3", "query": "수출", "split": "heldout", "relevantIds": ["BIZINFO:C"]},
                {"id": "Q4", "query": "조건 불명", "split": "heldout", "relevantIds": None},
            ],
        }
        self.rows = []
        for case, judgments in zip(self.fixture["cases"], (
            {"A": "relevant", "B": "relevant", "D": "", "E": "unclear"},
            {"A": "irrelevant", "B": "unclear"},
            {"C": "relevant", "A": "irrelevant"},
            {"D": "relevant", "E": "unclear"},
        )):
            for letter, decision in judgments.items():
                self.rows.append({"query_id": case["id"], "split": case["split"], "query": case["query"],
                                  "program_id": f"BIZINFO:{letter}", "decision": decision})
        self.before = self.capture([("ADB", "A"), ("A", ""), ("C", "C"), ("D", "D")])
        self.after = self.capture([("CDEA", "CA"), ("B", "B"), ("B", "B"), ("DE", "D")])
        self.save_reviews()
        self.save_inputs()

    def capture(self, results):
        return {
            "schemaVersion": CAPTURE_SCHEMA_VERSION,
            "querySet": {"name": self.fixture["name"], "sha256": query_set_sha256(self.fixture["cases"])},
            "referenceDate": self.fixture["referenceDate"], "capturedAt": "2026-09-06T01:00:00Z",
            "acceptingOnly": True, "catalog": copy.deepcopy(self.fixture["catalog"]),
            "search": {"candidateLimit": 20, "finalResultLimit": 5, "scoringVersion": "ranking-v3"},
            "observations": [
                {"id": case["id"], "query": case["query"], "split": case["split"],
                 "candidateIds": [f"BIZINFO:{letter}" for letter in candidates],
                 "finalProgramIds": [f"BIZINFO:{letter}" for letter in final]}
                for case, (candidates, final) in zip(self.fixture["cases"], results)
            ],
        }

    def save_reviews(self):
        with self.review_path.open("w", encoding="utf-8-sig", newline="") as file:
            writer = csv.DictWriter(file, fieldnames=["query_id", "split", "query", "program_id", "decision"])
            writer.writeheader()
            writer.writerows(self.rows)
        self.fixture["labelReview"] = {
            "schemaVersion": "support-program-label-review-v1", "mode": "legacy_unspecified",
            "sourceHashes": {"reviewPoolSha256": comparison.sha256_path(self.review_path)},
            "counts": {"reviewRowCount": len(self.rows), "labeledQueryCount": 3, "excludedQueryCount": 1},
            "excludedQueries": [{"id": "Q4", "reason": "Unresolved frozen reference"}],
        }

    def save_inputs(self):
        for name in self.paths:
            self.paths[name].write_text(json.dumps(getattr(self, name), ensure_ascii=False), encoding="utf-8")

    def compare(self):
        return comparison.compare(self.paths["fixture"], self.paths["before"], self.paths["after"], self.review_path)

    def arguments(self, output):
        return ["--fixture", str(self.paths["fixture"]), "--before", str(self.paths["before"]),
                "--after", str(self.paths["after"]), "--reviewed-csv", str(self.review_path), "--output", str(output)]

    def test_preserves_positive_denominators_exclusions_and_original_mrr_positions(self):
        report = self.compare()
        all_cases = report["splits"]["all"]
        self.assertEqual(["Q1", "Q3"], all_cases["positiveQueryIds"])
        self.assertEqual(2, all_cases["positiveQueryCount"])
        self.assertEqual(3, all_cases["relevantDocumentCount"])
        self.assertEqual(["Q4"], all_cases["excludedQueryIds"])
        self.assertEqual(1.0, all_cases["before"]["candidateRecallAt20"])
        self.assertEqual(0.25, all_cases["after"]["candidateRecallAt20"])
        self.assertEqual(0.75, all_cases["before"]["finalRecallAt5"])
        self.assertEqual(0.25, all_cases["after"]["finalRecallAt5"])
        self.assertEqual(0.25, all_cases["after"]["mrrAt5"])
        self.assertEqual(-0.75, all_cases["delta"]["mrrAt5"])
        self.assertEqual(["Q1"], report["splits"]["dev"]["positiveQueryIds"])
        self.assertEqual(["Q3"], report["splits"]["heldout"]["positiveQueryIds"])
        excluded = report["perQuery"][3]
        self.assertEqual("excluded", excluded["status"])
        self.assertIsNone(excluded["relevantIds"])
        self.assertIsNone(excluded["after"]["mrrAt5"])

    def test_lists_new_missing_blank_and_unclear_results_without_relabeling(self):
        result = self.compare()["perQuery"][0]
        self.assertEqual(["BIZINFO:A", "BIZINFO:B"], result["relevantIds"])
        self.assertEqual([
            {"programId": "BIZINFO:C", "decision": "missing"},
            {"programId": "BIZINFO:D", "decision": "blank"},
            {"programId": "BIZINFO:E", "decision": "unclear"},
        ], result["after"]["candidateUnjudged"])
        self.assertEqual([{"programId": "BIZINFO:C", "decision": "missing"}], result["after"]["finalUnjudged"])
        self.assertEqual(0.5, result["after"]["mrrAt5"])

    def test_no_match_false_positive_rate_is_qualified_by_unjudged_final_ids(self):
        report = self.compare()
        before, after = [report["splits"]["all"][name]["noMatch"] for name in ("before", "after")]
        self.assertEqual(0.0, before["noMatchFalsePositiveRate"])
        self.assertEqual(1.0, after["pooledNonemptyResultRate"])
        self.assertIsNone(after["noMatchFalsePositiveRate"])
        self.assertEqual(["Q2"], after["unjudgedFinalQueryIds"])
        self.assertEqual("unjudged_final_returned", report["perQuery"][1]["after"]["noMatchStatus"])
        self.after["observations"][1].update(candidateIds=["BIZINFO:A"], finalProgramIds=["BIZINFO:A"])
        self.save_inputs()
        judged = self.compare()["splits"]["all"]["after"]["noMatch"]
        self.assertEqual(1.0, judged["noMatchFalsePositiveRate"])
        self.assertEqual(["Q2"], judged["knownIrrelevantFinalQueryIds"])

    def test_rejects_schema_snapshot_query_set_date_and_search_limit_mismatches(self):
        original = copy.deepcopy(self.after)
        mutations = [
            lambda c: c.update(schemaVersion="unsupported"),
            lambda c: c["catalog"].update(presentProgramCount=6),
            lambda c: c["catalog"].update(eligibleCatalogFingerprint="0" * 64),
            lambda c: c.update(referenceDate="2026-09-07"),
            lambda c: c["querySet"].update(sha256="0" * 64),
            lambda c: c.update(acceptingOnly=False),
            lambda c: c["search"].update(candidateLimit=21),
            lambda c: c["search"].update(finalResultLimit=4),
            lambda c: c["observations"][0].update(query="different query"),
            lambda c: c["observations"][0].update(split="heldout"),
            lambda c: c["observations"][0].update(candidateIds=["UNKNOWN:X"]),
            lambda c: c["observations"].pop(0),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(index=index):
                self.after = copy.deepcopy(original)
                mutate(self.after)
                self.save_inputs()
                with self.assertRaises(ValueError):
                    self.compare()

    def test_allows_scoring_version_change_but_not_underfilled_search_limits(self):
        self.after["search"]["scoringVersion"] = "ranking-v4"
        self.save_inputs()
        self.assertEqual("ranking-v4", self.compare()["captures"]["after"]["search"]["scoringVersion"])
        self.before["search"]["candidateLimit"] = self.after["search"]["candidateLimit"] = 19
        self.save_inputs()
        with self.assertRaisesRegex(ValueError, "Recall@20"):
            self.compare()

    def test_rejects_duplicate_and_contradictory_review_pairs(self):
        for decision in ("relevant", "irrelevant"):
            with self.subTest(decision=decision):
                self.rows.append({**self.rows[0], "decision": decision})
                self.save_reviews()
                self.save_inputs()
                with self.assertRaisesRegex(ValueError, "Duplicate"):
                    self.compare()
                self.rows.pop()

    def test_rejects_invalid_review_identity_and_decision(self):
        original = dict(self.rows[0])
        for field, value in (("query_id", "unknown"), ("query", "changed"), ("split", "heldout"),
                             ("program_id", "A"), ("decision", "maybe")):
            with self.subTest(field=field):
                self.rows[0] = {**original, field: value}
                self.save_reviews()
                self.save_inputs()
                with self.assertRaises(ValueError):
                    self.compare()

    def test_rejects_changed_csv_hash_and_frozen_positive_label_contradictions(self):
        with self.review_path.open("a", encoding="utf-8") as file:
            file.write("\n")
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            self.compare()
        for decision in ("irrelevant", "unclear", ""):
            with self.subTest(decision=decision):
                self.rows[0]["decision"] = decision
                self.save_reviews()
                self.save_inputs()
                with self.assertRaisesRegex(ValueError, "relevantIds"):
                    self.compare()

    def test_rejects_added_positive_label_and_missing_no_match_review_pool(self):
        self.rows[2]["decision"] = "relevant"
        self.save_reviews()
        self.save_inputs()
        with self.assertRaisesRegex(ValueError, "relevantIds"):
            self.compare()
        self.rows[2]["decision"] = ""
        self.rows = [row for row in self.rows if row["query_id"] != "Q2"]
        self.save_reviews()
        self.save_inputs()
        with self.assertRaisesRegex(ValueError, "relevantIds"):
            self.compare()

    def test_missing_excluded_observation_stays_unobserved_and_excluded(self):
        self.after["observations"].pop()
        self.save_inputs()
        result = self.compare()["perQuery"][-1]
        self.assertEqual("excluded", result["status"])
        self.assertEqual({"observed": False}, result["after"])

    def test_reports_source_hashes_and_unverified_legacy_csv_explicitly(self):
        report = self.compare()
        self.assertTrue(report["reviewedCsv"]["fixtureHashVerified"])
        self.assertEqual("reviewPoolSha256", report["reviewedCsv"]["fixtureHashField"])
        self.assertEqual(comparison.sha256_path(self.paths["fixture"]), report["sourceHashes"]["fixtureSha256"])
        self.assertEqual(comparison.sha256_path(self.review_path), report["sourceHashes"]["reviewedCsvSha256"])
        del self.fixture["labelReview"]
        self.fixture["dataType"] = "real_labeled_catalog_snapshot"
        self.save_inputs()
        self.assertFalse(self.compare()["reviewedCsv"]["fixtureHashVerified"])

    def test_explicit_label_schema_requires_its_linked_csv_hash(self):
        self.fixture["labelReview"]["sourceHashes"] = {"fixtureSha256": "0" * 64}
        self.save_inputs()
        with self.assertRaisesRegex(ValueError, "requires a linked CSV reviewPoolSha256"):
            self.compare()

    def test_cli_writes_new_report_and_refuses_existing_file_and_symlink(self):
        output = self.directory / "report.json"
        comparison.main(self.arguments(output))
        original = output.read_bytes()
        self.assertEqual("support-program-search-comparison-v1", json.loads(original)["schemaVersion"])
        for path in (output, self.paths["fixture"]):
            with self.subTest(path=path), redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                comparison.main(self.arguments(path))
        self.assertEqual(original, output.read_bytes())
        symlink = self.directory / "symlink.json"
        symlink.symlink_to(self.directory / "missing.json")
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            comparison.main(self.arguments(symlink))


if __name__ == "__main__":
    unittest.main()
