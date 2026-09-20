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


SPEC = importlib.util.spec_from_file_location("ranking_replay", Path(__file__).with_name("evaluate-ranking-replay.py"))
replay = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(replay)


class RankingReplayTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.paths = {key: self.directory / f"{key}.json" for key in ("fixture", "requests", "capture")}
        self.review_path = self.directory / "reviewed.csv"
        self.results_path = self.directory / "results.jsonl"
        docs = [{"id": f"BIZINFO:{letter}", "text": f"지원 공고 {letter}",
                 "sortTimestamp": "2026-09-06T00:00:00"} for letter in "ABCDEF"]
        for doc in docs:
            doc["contentHash"] = hashlib.sha256(doc["text"].encode()).hexdigest()
        self.fixture = {
            "name": "frozen", "dataType": "real_catalog_snapshot_labeled_pooled_legacy_unspecified",
            "referenceDate": "2026-09-06", "docs": docs,
            "catalog": {"presentProgramCount": 6, "eligibleProgramCount": 6,
                        "eligibleCatalogFingerprint": eligible_catalog_fingerprint(docs)},
            "cases": [
                {"id": "Q1", "query": "지원 목적", "split": "dev", "relevantIds": ["BIZINFO:A", "BIZINFO:F"]},
                {"id": "Q2", "query": "조건 불명", "split": "heldout", "relevantIds": None},
            ],
        }
        self.rows = []
        for case, decisions in zip(self.fixture["cases"], (
            {"A": "relevant", "B": "irrelevant", "C": "unclear", "D": "", "F": "relevant"},
            {"A": "relevant", "B": "irrelevant"},
        )):
            self.rows.extend({"query_id": case["id"], "query": case["query"], "split": case["split"],
                              "program_id": f"BIZINFO:{letter}", "decision": decision}
                             for letter, decision in decisions.items())
        with self.review_path.open("w", encoding="utf-8-sig", newline="") as file:
            writer = csv.DictWriter(file, fieldnames=["query_id", "query", "split", "program_id", "decision"])
            writer.writeheader()
            writer.writerows(self.rows)
        self.fixture["labelReview"] = {
            "schemaVersion": "support-program-label-review-v1", "mode": "legacy_unspecified",
            "sourceHashes": {"reviewPoolSha256": replay.comparison.sha256_path(self.review_path)},
            "counts": {"reviewRowCount": len(self.rows), "labeledQueryCount": 1, "excludedQueryCount": 1},
            "excludedQueries": [{"id": "Q2", "reason": "Unresolved reference"}],
        }
        self.capture = {
            "schemaVersion": CAPTURE_SCHEMA_VERSION,
            "querySet": {"name": "frozen", "sha256": query_set_sha256(self.fixture["cases"])},
            "capturedAt": "2026-09-06T01:00:00Z", "referenceDate": "2026-09-06",
            "catalog": copy.deepcopy(self.fixture["catalog"]), "acceptingOnly": True,
            "search": {"candidateLimit": 20, "finalResultLimit": 5, "scoringVersion": "ranking-v3"},
            "observations": [{"id": case["id"], "query": case["query"], "split": case["split"],
                              "candidateIds": [f"BIZINFO:{letter}" for letter in "ABCDE"], "finalProgramIds": []}
                             for case in self.fixture["cases"]],
        }
        self.paths["capture"].write_text(json.dumps(self.capture), encoding="utf-8")
        self.requests = {
            "schemaVersion": replay.INPUT_SCHEMA_VERSION, "referenceDate": "2026-09-06",
            "catalog": copy.deepcopy(self.fixture["catalog"]),
            "sourceCaptureSha256": replay.comparison.sha256_path(self.paths["capture"]),
            "queries": [{"id": case["id"], "split": case["split"], "request": {
                "originalQuery": case["query"], "scoringVersion": "ranking-v3", "resultLimit": 5,
                "candidates": [{"id": f"BIZINFO:{letter}", "title": f"공고 {letter}"} for letter in "ABCDE"],
            }} for case in self.fixture["cases"]],
        }
        self.results = []
        for query, finals in zip(self.requests["queries"], (("ABCDE", "A"), ("AB", ""))):
            for variant, ids in zip(replay.VARIANTS, finals):
                request = query["request"]
                self.results.append({
                    "queryId": query["id"], "variant": variant,
                    "requestSha256": replay.canonical_sha256(request),
                    "promptSha256": ("a" if variant == "before" else "b") * 64,
                    "response": {"originalQuery": request["originalQuery"], "scoringVersion": "ranking-v3",
                                 "rankings": [{"programId": f"BIZINFO:{letter}"} for letter in ids]},
                })
        self.save()

    def save(self):
        for key in ("fixture", "requests"):
            self.paths[key].write_text(json.dumps(getattr(self, key), ensure_ascii=False), encoding="utf-8")
        self.results_path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in self.results) + "\n",
                                     encoding="utf-8")

    def report(self):
        return replay.evaluate_ranking_replay(self.paths["fixture"], self.review_path, self.paths["requests"],
                                             self.results_path, self.paths["capture"])

    def arguments(self, output):
        return ["--fixture", str(self.paths["fixture"]), "--reviewed-csv", str(self.review_path),
                "--requests", str(self.paths["requests"]), "--results", str(self.results_path),
                "--source-capture", str(self.paths["capture"]), "--output", str(output)]

    def test_denominators_stay_fixed_and_excluded_queries_stay_officially_excluded(self):
        report = self.report()
        first, excluded = report["perQuery"]
        self.assertEqual(["BIZINFO:A", "BIZINFO:F"], first["relevantIds"])
        # F is a known pooled positive outside the candidate set; this is not pooled Recall.
        self.assertEqual(1, first["fixedCandidates"]["knownRelevantCount"])
        self.assertEqual(1.0, first["after"]["knownPositiveCandidateRetention"])
        self.assertEqual(1.0, first["before"]["knownNegativeSelectionRate"])
        self.assertEqual(0.0, first["after"]["knownNegativeSelectionRate"])
        self.assertEqual("excluded", excluded["officialStatus"])
        self.assertIsNone(excluded["relevantIds"])
        all_cases = report["splits"]["all"]
        self.assertEqual(["Q2"], all_cases["officialExcludedQueryIds"])
        self.assertEqual(2, all_cases["fixedCandidateCounts"]["knownRelevantCount"])
        self.assertEqual(1.0, all_cases["before"]["knownPositiveCandidateRetention"])
        self.assertEqual(0.5, all_cases["after"]["knownPositiveCandidateRetention"])
        self.assertEqual(-1.0, all_cases["delta"]["knownNegativeSelectionRate"])
        self.assertTrue(report["sourceCaptureVerified"])
        self.assertTrue(report["reviewedCsv"]["fixtureHashVerified"])

    def test_unclear_blank_missing_are_separate_unjudged_and_empty_response_is_valid(self):
        first, second = self.report()["perQuery"]
        self.assertEqual([
            {"programId": "BIZINFO:C", "decision": "unclear"},
            {"programId": "BIZINFO:D", "decision": "blank"},
            {"programId": "BIZINFO:E", "decision": "missing"},
        ], first["before"]["final"]["unjudged"])
        self.assertEqual(1, first["before"]["final"]["knownIrrelevantCount"])
        self.assertEqual(3, first["before"]["final"]["unjudgedCount"])
        self.assertEqual(0, second["after"]["final"]["count"])

    def test_rejects_request_identity_metadata_candidate_order_and_source_hash_mismatches(self):
        original = copy.deepcopy(self.requests)
        mutations = [
            lambda r: r.update(schemaVersion="unsupported"),
            lambda r: r.update(sourceCaptureSha256="0" * 64),
            lambda r: r.update(referenceDate="2026-09-07"),
            lambda r: r["catalog"].update(presentProgramCount=7),
            lambda r: r["queries"][0].update(id="unknown"),
            lambda r: r["queries"][0].update(split="heldout"),
            lambda r: r["queries"][0]["request"].update(originalQuery="changed"),
            lambda r: r["queries"][0]["request"].update(scoringVersion="changed"),
            lambda r: r["queries"][0]["request"].update(resultLimit=4),
            lambda r: r["queries"][0]["request"]["candidates"].reverse(),
            lambda r: r["queries"][0]["request"]["candidates"][0].update(id="BIZINFO:F"),
            lambda r: r["queries"][0]["request"]["candidates"].append({"id": "BIZINFO:A"}),
            lambda r: r["queries"].append(copy.deepcopy(r["queries"][0])),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(index=index):
                self.requests = copy.deepcopy(original)
                mutate(self.requests)
                self.save()
                with self.assertRaises(ValueError):
                    self.report()

    def test_rejects_changed_capture_even_when_its_envelope_hash_is_updated(self):
        self.capture["observations"][0]["query"] = "changed"
        self.paths["capture"].write_text(json.dumps(self.capture), encoding="utf-8")
        self.requests["sourceCaptureSha256"] = replay.comparison.sha256_path(self.paths["capture"])
        self.save()
        with self.assertRaises(ValueError):
            self.report()

    def test_rejects_result_hash_duplicates_missing_variant_unknown_ids_and_invalid_contracts(self):
        original = copy.deepcopy(self.results)
        mutations = [
            lambda r: r[0].update(requestSha256="0" * 64),
            lambda r: r[0].update(promptSha256="invalid"),
            lambda r: r[0].update(promptSha256="c" * 64),
            lambda r: r[0].update(queryId="unknown"),
            lambda r: r[0].update(variant="other"),
            lambda r: r.append(copy.deepcopy(r[0])),
            lambda r: r.pop(),
            lambda r: r[0]["response"].update(originalQuery="different"),
            lambda r: r[0]["response"].update(scoringVersion="different"),
            lambda r: r[0]["response"]["rankings"][0].update(programId="BIZINFO:F"),
            lambda r: r[0]["response"]["rankings"][0].update(programId="unknown"),
            lambda r: r[0]["response"]["rankings"][1].update(programId="BIZINFO:A"),
            lambda r: r[0]["response"]["rankings"].append({"programId": "BIZINFO:A"}),
            lambda r: r[0].update(response=[]),
            lambda r: r[0]["response"].update(rankings={}),
            lambda r: r[0]["response"].update(rankings=["BIZINFO:A"]),
            lambda r: r.clear(),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(index=index):
                self.results = copy.deepcopy(original)
                mutate(self.results)
                self.save()
                with self.assertRaises(ValueError):
                    self.report()

    def test_rejects_changed_candidate_content_hash_and_linked_csv(self):
        self.requests["queries"][0]["request"]["candidates"][0]["title"] = "changed"
        self.save()
        with self.assertRaisesRegex(ValueError, "requestSha256"):
            self.report()
        with self.review_path.open("a", encoding="utf-8") as file:
            file.write("\n")
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            self.report()

    def test_canonical_hash_uses_sorted_keys_compact_utf8(self):
        expected = hashlib.sha256('{"a":"한글","b":1}'.encode("utf-8")).hexdigest()
        self.assertEqual(expected, replay.canonical_sha256({"b": 1, "a": "한글"}))

    def test_subset_reports_omissions_and_empty_split_ratios_as_null(self):
        self.requests["queries"] = self.requests["queries"][:1]
        self.results = self.results[:2]
        self.save()
        report = self.report()
        self.assertEqual(["Q2"], report["omittedQueryIds"])
        heldout = report["splits"]["heldout"]
        self.assertEqual(0, heldout["queryCount"])
        self.assertIsNone(heldout["before"]["knownPositiveCandidateRetention"])
        self.assertIsNone(heldout["after"]["knownNegativeSelectionRate"])

    def test_cli_creates_only_new_output_and_preserves_inputs(self):
        output = self.directory / "report.json"
        replay.main(self.arguments(output))
        original = output.read_bytes()
        self.assertEqual(replay.REPORT_SCHEMA_VERSION, json.loads(original)["schemaVersion"])
        for path in (output, self.paths["fixture"], self.paths["requests"], self.results_path, self.paths["capture"]):
            with self.subTest(path=path), redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                replay.main(self.arguments(path))
        self.assertEqual(original, output.read_bytes())
        symlink = self.directory / "dangling.json"
        symlink.symlink_to(self.directory / "missing.json")
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            replay.main(self.arguments(symlink))


if __name__ == "__main__":
    unittest.main()
