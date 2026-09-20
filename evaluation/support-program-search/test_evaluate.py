import hashlib
import copy
import unittest
from pathlib import Path
from unittest.mock import patch

from evaluate import (
    CAPTURE_SCHEMA_VERSION,
    baseline_results,
    evaluate_capture,
    evaluate_final_results,
    evaluate_results,
    eligible_catalog_fingerprint,
    load_fixture,
    label_reference_report,
    query_set_sha256,
    validate_capture,
    validate_results,
    tokenize,
)


class RetrievalEvaluationTest(unittest.TestCase):
    def test_baselines_tokenize_each_document_once_and_preserve_tied_order(self):
        docs = [
            {"id": "B", "text": "서울 AI", "sortTimestamp": "2026-09-07"},
            {"id": "A", "text": "서울 AI", "sortTimestamp": "2026-09-07"},
            {"id": "C", "text": "부산 제조", "sortTimestamp": "2026-09-06"},
        ]
        cases = [
            {"id": "Q1", "query": "서울 AI"},
            {"id": "Q2", "query": "부산 제조"},
            {"id": "Q3", "query": "해당 없음"},
        ]
        original = copy.deepcopy(docs)
        with patch("evaluate.tokenize", wraps=tokenize) as tokenizer:
            latest, keyword = baseline_results(docs, cases, k=2)
        self.assertEqual(len(docs) + len(cases), tokenizer.call_count)
        self.assertEqual({case["id"]: ["A", "B"] for case in cases}, latest)
        self.assertEqual({"Q1": ["A", "B"], "Q2": ["C"], "Q3": []}, keyword)
        self.assertEqual(original, docs)

    def capture_fixture(self):
        docs = [
            {"id": "BIZINFO:A", "text": "서울 AI 지원사업"},
            {"id": "BIZINFO:B", "text": "부산 제조 혁신"},
            {"id": "OTHER:C", "text": "전국 수출 지원"},
        ]
        for doc in docs:
            doc["contentHash"] = hashlib.sha256(doc["text"].encode("utf-8")).hexdigest()
        fixture = {
            "name": "capture-fixture-v1",
            "dataType": "real_labeled_catalog_snapshot",
            "referenceDate": "2026-09-05",
            "docs": docs,
            "cases": [
                {"id": "Q1", "query": "서울 AI", "split": "dev", "relevantIds": ["BIZINFO:A"]},
                {"id": "Q2", "query": "지원 없는 질문", "split": "dev", "relevantIds": []},
                {"id": "Q3", "query": "추가 정보 필요", "split": "heldout", "relevantIds": None},
            ],
        }
        fixture["catalog"] = {
            "presentProgramCount": 3,
            "eligibleProgramCount": 3,
            "eligibleCatalogFingerprint": eligible_catalog_fingerprint(docs),
        }
        return fixture

    def capture(self, fixture, observations):
        return {
            "schemaVersion": CAPTURE_SCHEMA_VERSION,
            "querySet": {
                "name": fixture["name"],
                "sha256": query_set_sha256(fixture["cases"]),
            },
            "capturedAt": "2026-09-05T00:00:00Z",
            "referenceDate": fixture["referenceDate"],
            "acceptingOnly": True,
            "catalog": dict(fixture["catalog"]),
            "search": {
                "candidateLimit": 20,
                "finalResultLimit": 5,
                "scoringVersion": "govbiz-support-program-ranking-v3",
            },
            "observations": observations,
        }

    def observation(self, fixture, query_id, candidate_ids, final_program_ids):
        case = next(case for case in fixture["cases"] if case["id"] == query_id)
        return {
            "id": query_id,
            "query": case["query"],
            "split": case["split"],
            "candidateIds": candidate_ids,
            "finalProgramIds": final_program_ids,
        }

    def test_recall_uses_full_relevant_set_and_only_first_k_candidates(self):
        cases = [{"id": "Q", "relevantIds": ["A", "B"]}]
        report = evaluate_results(cases, {"Q": ["A", "X", "B"]}, k=2)
        self.assertEqual(0.5, report["macroRecallAtK"])
        self.assertIsNone(report["noMatchFalsePositiveRate"])

    def test_no_match_queries_are_separate_from_recall(self):
        cases = [{"id": "Q1", "relevantIds": ["A"]}, {"id": "Q2", "relevantIds": []}, {"id": "Q3", "relevantIds": []}]
        report = evaluate_results(cases, {"Q1": ["A"], "Q2": [], "Q3": ["B"]})
        self.assertEqual(1.0, report["macroRecallAtK"])
        self.assertEqual(0.5, report["noMatchFalsePositiveRate"])
        self.assertEqual(1, report["answerableQueries"])
        self.assertEqual(2, report["noMatchQueries"])

    def test_unlabeled_is_skipped_not_treated_as_no_match(self):
        report = evaluate_results([{"id": "Q", "relevantIds": None}], {})
        self.assertEqual(1, report["unlabeledQueriesSkipped"])
        self.assertEqual(0, report["noMatchQueries"])
        self.assertIsNone(report["macroRecallAtK"])
        self.assertIsNone(report["noMatchFalsePositiveRate"])

    def test_empty_case_set_does_not_divide_by_zero(self):
        report = evaluate_results([], {})
        self.assertIsNone(report["macroRecallAtK"])

    def test_final_mrr_uses_first_relevant_program_within_top_five(self):
        cases = [
            {"id": "Q1", "relevantIds": ["A", "B"]},
            {"id": "Q2", "relevantIds": ["C"]},
            {"id": "Q3", "relevantIds": []},
            {"id": "Q4", "relevantIds": None},
        ]
        results = {
            "Q1": ["X", "B", "A"],
            "Q2": ["X1", "X2", "X3", "X4", "X5", "C"],
            "Q3": ["X"],
            "Q4": [],
        }

        report = evaluate_final_results(cases, results)

        self.assertEqual(5, report["k"])
        self.assertEqual(0.5, report["macroRecallAt5"])
        self.assertAlmostEqual(0.25, report["mrrAt5"])
        self.assertEqual(1.0, report["noMatchFalsePositiveRate"])
        details = {detail["queryId"]: detail for detail in report["perQuery"]}
        self.assertEqual(2, details["Q1"]["firstRelevantRankAt5"])
        self.assertEqual(0.5, details["Q1"]["reciprocalRankAt5"])
        self.assertIsNone(details["Q2"]["firstRelevantRankAt5"])
        self.assertEqual(0.0, details["Q2"]["reciprocalRankAt5"])

    def test_query_set_hash_matches_the_korean_core_capture_contract(self):
        cases = [
            {"id": "Q01", "query": "서울 AI 지원", "split": "dev"},
            {"id": "Q02", "query": "수출 바우처", "split": "heldout"},
        ]

        self.assertEqual(
            "eb70524c7e1a92a8250b525ceee8e1b432833aedc6730646b3a009bcb12b4356",
            query_set_sha256(cases),
        )

    def test_missing_observation_is_not_silently_empty_result(self):
        cases = [{"id": "Q", "relevantIds": ["A"]}]
        with self.assertRaisesRegex(ValueError, "incomplete"):
            validate_results({}, [{"id": "A"}], cases, cases)

    def test_duplicate_and_unknown_results_are_rejected(self):
        cases = [{"id": "Q", "relevantIds": ["A"]}]
        for ids in (["A", "A"], ["UNKNOWN"]):
            with self.subTest(ids=ids), self.assertRaises(ValueError):
                validate_results({"Q": ids}, [{"id": "A"}], cases, cases)

    def test_capture_reports_candidate_and_final_stages_separately(self):
        fixture = self.capture_fixture()
        capture = self.capture(
            fixture,
            [
                self.observation(fixture, "Q1", ["BIZINFO:B", "BIZINFO:A"], ["BIZINFO:A"]),
                self.observation(fixture, "Q2", ["BIZINFO:B"], []),
            ],
        )

        stages = validate_capture(capture, fixture, fixture["cases"])
        report = evaluate_capture(capture, fixture, fixture["cases"], candidate_k=20)

        self.assertEqual({"Q1": ["BIZINFO:B", "BIZINFO:A"], "Q2": ["BIZINFO:B"]}, stages["candidate"])
        self.assertEqual({"Q1": ["BIZINFO:A"], "Q2": []}, stages["final"])
        self.assertEqual(1.0, report["candidate"]["macroRecallAtK"])
        self.assertEqual(1.0, report["candidate"]["noMatchFalsePositiveRate"])
        self.assertEqual(1.0, report["final"]["macroRecallAt5"])
        self.assertEqual(1.0, report["final"]["mrrAt5"])
        self.assertEqual(0.0, report["final"]["noMatchFalsePositiveRate"])
        self.assertEqual("2026-09-05", report["referenceDate"])

    def test_capture_keeps_same_raw_id_from_different_sources_distinct(self):
        documents = [
            {"id": "BIZINFO:SHARED", "text": "같은 검색 문서"},
            {"id": "OTHER:SHARED", "text": "같은 검색 문서"},
        ]
        for document in documents:
            document["contentHash"] = hashlib.sha256(document["text"].encode("utf-8")).hexdigest()
        fixture = {
            "name": "shared-source-id-fixture-v1",
            "dataType": "real_labeled_catalog_snapshot",
            "referenceDate": "2026-09-05",
            "docs": documents,
            "cases": [
                {
                    "id": "Q1",
                    "query": "같은 원본 ID를 가진 공고",
                    "split": "dev",
                    "relevantIds": ["BIZINFO:SHARED", "OTHER:SHARED"],
                },
            ],
        }
        fixture["catalog"] = {
            "presentProgramCount": 2,
            "eligibleProgramCount": 2,
            "eligibleCatalogFingerprint": eligible_catalog_fingerprint(documents),
        }
        capture = self.capture(
            fixture,
            [
                self.observation(
                    fixture,
                    "Q1",
                    ["BIZINFO:SHARED", "OTHER:SHARED"],
                    ["OTHER:SHARED"],
                ),
            ],
        )

        stages = validate_capture(capture, fixture, fixture["cases"])

        self.assertEqual(documents[0]["contentHash"], documents[1]["contentHash"])
        self.assertEqual(
            ["BIZINFO:SHARED", "OTHER:SHARED"],
            stages["candidate"]["Q1"],
        )
        self.assertEqual(["OTHER:SHARED"], stages["final"]["Q1"])
        self.assertNotEqual(
            fixture["catalog"]["eligibleCatalogFingerprint"],
            eligible_catalog_fingerprint([documents[0]]),
        )

    def test_capture_rejects_a_different_catalog_snapshot(self):
        fixture = self.capture_fixture()
        capture = self.capture(
            fixture,
            [
                self.observation(fixture, "Q1", ["BIZINFO:A"], ["BIZINFO:A"]),
                self.observation(fixture, "Q2", [], []),
            ],
        )
        capture["catalog"]["presentProgramCount"] = 4

        with self.assertRaisesRegex(ValueError, "does not match the fixture catalog snapshot"):
            validate_capture(capture, fixture, fixture["cases"])

    def test_capture_rejects_a_different_reference_date(self):
        fixture = self.capture_fixture()
        capture = self.capture(
            fixture,
            [
                self.observation(fixture, "Q1", ["BIZINFO:A"], ["BIZINFO:A"]),
                self.observation(fixture, "Q2", [], []),
            ],
        )
        capture["referenceDate"] = "2026-09-06"

        with self.assertRaisesRegex(ValueError, "referenceDate does not match"):
            validate_capture(capture, fixture, fixture["cases"])

    def test_capture_rejects_an_invalid_reference_date(self):
        fixture = self.capture_fixture()
        capture = self.capture(
            fixture,
            [
                self.observation(fixture, "Q1", ["BIZINFO:A"], ["BIZINFO:A"]),
                self.observation(fixture, "Q2", [], []),
            ],
        )
        capture["referenceDate"] = "2026/09/05"

        with self.assertRaisesRegex(ValueError, "ISO-8601 date"):
            validate_capture(capture, fixture, fixture["cases"])

    def test_capture_requires_a_complete_fixture_catalog_with_matching_content_fingerprint(self):
        fixture = self.capture_fixture()
        capture = self.capture(
            fixture,
            [
                self.observation(fixture, "Q1", ["BIZINFO:A"], ["BIZINFO:A"]),
                self.observation(fixture, "Q2", [], []),
            ],
        )
        fixture["docs"][0]["text"] = "변경된 서울 AI 지원사업"
        fixture["docs"][0]["contentHash"] = hashlib.sha256(
            fixture["docs"][0]["text"].encode("utf-8"),
        ).hexdigest()

        with self.assertRaisesRegex(ValueError, "does not match its document contentHash"):
            validate_capture(capture, fixture, fixture["cases"])

        fixture = self.capture_fixture()
        fixture["docs"].pop()
        capture = self.capture(
            fixture,
            [
                self.observation(fixture, "Q1", ["BIZINFO:A"], ["BIZINFO:A"]),
                self.observation(fixture, "Q2", [], []),
            ],
        )
        with self.assertRaisesRegex(ValueError, "entire eligible catalog"):
            validate_capture(capture, fixture, fixture["cases"])

    def test_capture_rejects_fixture_text_changed_without_changing_its_hash_or_catalog(self):
        fixture = self.capture_fixture()
        capture = self.capture(
            fixture,
            [
                self.observation(fixture, "Q1", ["BIZINFO:A"], ["BIZINFO:A"]),
                self.observation(fixture, "Q2", [], []),
            ],
        )
        original_content_hash = fixture["docs"][0]["contentHash"]
        original_catalog = dict(fixture["catalog"])
        fixture["docs"][0]["text"] = "변조된 검색 문서"

        self.assertEqual(original_content_hash, fixture["docs"][0]["contentHash"])
        self.assertEqual(original_catalog, fixture["catalog"])
        with self.assertRaisesRegex(ValueError, "contentHash does not match its UTF-8 text"):
            validate_capture(capture, fixture, fixture["cases"])

    def test_eligible_catalog_fingerprint_is_sorted_by_canonical_id(self):
        docs = self.capture_fixture()["docs"]

        self.assertEqual(
            eligible_catalog_fingerprint(docs),
            eligible_catalog_fingerprint(list(reversed(docs))),
        )

    def test_capture_rejects_unknown_document(self):
        fixture = self.capture_fixture()
        capture = self.capture(
            fixture,
            [
                self.observation(fixture, "Q1", ["BIZINFO:UNKNOWN"], []),
                self.observation(fixture, "Q2", [], []),
            ],
        )

        with self.assertRaisesRegex(ValueError, "Unknown returned document"):
            validate_capture(capture, fixture, fixture["cases"])

    def test_capture_rejects_missing_labeled_observation(self):
        fixture = self.capture_fixture()
        capture = self.capture(
            fixture,
            [self.observation(fixture, "Q1", ["BIZINFO:A"], ["BIZINFO:A"])],
        )

        with self.assertRaisesRegex(ValueError, "incomplete"):
            validate_capture(capture, fixture, fixture["cases"])

    def test_capture_rejects_duplicate_candidate_or_final_program(self):
        fixture = self.capture_fixture()
        duplicate_candidates = self.capture(
            fixture,
            [
                self.observation(fixture, "Q1", ["BIZINFO:A", "BIZINFO:A"], ["BIZINFO:A"]),
                self.observation(fixture, "Q2", [], []),
            ],
        )
        duplicate_final_programs = self.capture(
            fixture,
            [
                self.observation(fixture, "Q1", ["BIZINFO:A", "BIZINFO:B"], ["BIZINFO:A", "BIZINFO:A"]),
                self.observation(fixture, "Q2", [], []),
            ],
        )

        for capture in (duplicate_candidates, duplicate_final_programs):
            with self.subTest(capture=capture), self.assertRaisesRegex(ValueError, "Duplicate returned document"):
                validate_capture(capture, fixture, fixture["cases"])

    def test_capture_rejects_final_program_that_was_not_a_candidate(self):
        fixture = self.capture_fixture()
        capture = self.capture(
            fixture,
            [
                self.observation(fixture, "Q1", ["BIZINFO:A"], ["BIZINFO:B"]),
                self.observation(fixture, "Q2", [], []),
            ],
        )

        with self.assertRaisesRegex(ValueError, "must be candidates"):
            validate_capture(capture, fixture, fixture["cases"])

    def test_capture_requires_canonical_fixture_ids_and_matching_query_set(self):
        fixture = self.capture_fixture()
        capture = self.capture(
            fixture,
            [
                self.observation(fixture, "Q1", ["BIZINFO:A"], ["BIZINFO:A"]),
                self.observation(fixture, "Q2", [], []),
            ],
        )
        fixture_with_bare_ids = self.capture_fixture()
        fixture_with_bare_ids["docs"][0]["id"] = "A"
        fixture_with_bare_ids["cases"][0]["relevantIds"] = ["A"]

        with self.assertRaisesRegex(ValueError, "canonical"):
            validate_capture(capture, fixture_with_bare_ids, fixture_with_bare_ids["cases"])

        capture["querySet"]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "sha256"):
            validate_capture(capture, fixture, fixture["cases"])

    def test_capture_rejects_a_nonstandard_source_code_in_a_canonical_id(self):
        fixture = self.capture_fixture()
        fixture["docs"][0]["id"] = "other:A"
        fixture["cases"][0]["relevantIds"] = ["other:A"]
        fixture["catalog"]["eligibleCatalogFingerprint"] = eligible_catalog_fingerprint(fixture["docs"])
        capture = self.capture(
            fixture,
            [
                self.observation(fixture, "Q1", ["other:A"], ["other:A"]),
                self.observation(fixture, "Q2", [], []),
            ],
        )

        with self.assertRaisesRegex(ValueError, "canonical"):
            validate_capture(capture, fixture, fixture["cases"])

    def test_capture_k_cannot_exceed_the_captured_candidate_limit(self):
        fixture = self.capture_fixture()
        capture = self.capture(
            fixture,
            [
                self.observation(fixture, "Q1", ["BIZINFO:A"], ["BIZINFO:A"]),
                self.observation(fixture, "Q2", [], []),
            ],
        )
        capture["search"]["candidateLimit"] = 1

        with self.assertRaisesRegex(ValueError, "candidateLimit"):
            evaluate_capture(capture, fixture, fixture["cases"], candidate_k=2)

    def test_capture_requires_a_top_five_final_result_limit_and_valid_catalog_fingerprint(self):
        fixture = self.capture_fixture()
        capture = self.capture(
            fixture,
            [
                self.observation(fixture, "Q1", ["BIZINFO:A"], ["BIZINFO:A"]),
                self.observation(fixture, "Q2", [], []),
            ],
        )
        capture["search"]["finalResultLimit"] = 3

        with self.assertRaisesRegex(ValueError, "finalResultLimit"):
            validate_capture(capture, fixture, fixture["cases"])

        capture["search"]["finalResultLimit"] = 5
        capture["catalog"]["eligibleCatalogFingerprint"] = "A" * 64
        with self.assertRaisesRegex(ValueError, "Fingerprint"):
            validate_capture(capture, fixture, fixture["cases"])

    def test_keyword_no_overlap_returns_empty_and_tie_order_is_stable(self):
        docs = [{"id": "B", "text": "서울 AI", "sortTimestamp": "20260101"}, {"id": "A", "text": "서울 AI", "sortTimestamp": "20260101"}]
        cases = [{"id": "Q1", "query": "서울"}, {"id": "Q2", "query": "부산"}]
        latest, keyword = baseline_results(docs, cases, 20)
        self.assertEqual(["A", "B"], latest["Q1"])
        self.assertEqual(["A", "B"], keyword["Q1"])
        self.assertEqual([], keyword["Q2"])

    def test_fixture_has_old_relevant_cases_and_separate_splits(self):
        fixture = load_fixture(Path(__file__).with_name("fixture.json"))
        self.assertEqual("synthetic_not_real_programs", fixture["dataType"])
        self.assertEqual(40, len(fixture["docs"]))
        self.assertEqual(30, len(fixture["cases"]))
        self.assertEqual(20, sum(case["split"] == "dev" for case in fixture["cases"]))
        self.assertEqual(10, sum(case["split"] == "heldout" for case in fixture["cases"]))
        latest, _ = baseline_results(fixture["docs"], fixture["cases"], 20)
        self.assertNotIn("SYNTH_AI_SEOUL", latest["Q01"])
        self.assertNotIn("SYNTH_PATENT", latest["Q27"])
        report = evaluate_results(fixture["cases"], latest)
        self.assertEqual(26, report["answerableQueries"])
        self.assertEqual(3, report["noMatchQueries"])
        self.assertEqual(1, report["unlabeledQueriesSkipped"])

    def reviewed_fixture(self, mode="ai-only"):
        fixture = self.capture_fixture()
        suffix = {"ai-only": "ai_consensus", "hybrid": "hybrid", "human": "human"}[mode]
        fixture["dataType"] = f"real_catalog_snapshot_labeled_pooled_{suffix}"
        fixture["labelReview"] = {
            "schemaVersion": "support-program-label-review-v1",
            "mode": mode,
            "sourceHashes": {"selectionSha256": "a" * 64, "aiReviewSha256": "b" * 64},
            "sourceCounts": {"ai": 2, "human": 0, "unresolved": 1},
            "requiredHumanReviewCount": 0,
            "pendingHumanReviewCount": 0,
            "counts": {"reviewRowCount": 3, "labeledQueryCount": 2, "excludedQueryCount": 1},
            "excludedQueries": [{"id": "Q3", "reason": "Insufficient evidence in one pooled document"}],
            "warnings": [],
        }
        if mode == "hybrid":
            fixture["labelReview"]["sourceCounts"] = {"ai": 2, "human": 1, "unresolved": 0}
            fixture["labelReview"]["requiredHumanReviewCount"] = 1
            fixture["labelReview"]["sourceHashes"]["humanReviewSha256"] = "c" * 64
        elif mode == "human":
            fixture["labelReview"]["sourceCounts"] = {"ai": 0, "human": 3, "unresolved": 0}
            fixture["labelReview"]["requiredHumanReviewCount"] = 3
            del fixture["labelReview"]["sourceHashes"]["aiReviewSha256"]
            fixture["labelReview"]["sourceHashes"]["humanReviewSha256"] = "c" * 64
        return fixture

    def test_capture_includes_ai_reference_provenance_and_pool_limitations(self):
        fixture = self.reviewed_fixture()
        capture = self.capture(fixture, [
            self.observation(fixture, "Q1", ["BIZINFO:A"], ["BIZINFO:A"]),
            self.observation(fixture, "Q2", [], []),
        ])
        report = evaluate_capture(capture, fixture, fixture["cases"], candidate_k=20)
        reference = report["labelReference"]
        self.assertEqual("ai-only", reference["mode"])
        self.assertIn("not independently human-validated", reference["metricInterpretation"])
        self.assertTrue(any("pooled-reference Recall" in item for item in reference["limitations"]))
        self.assertTrue(any("share errors" in item for item in reference["limitations"]))
        self.assertEqual({"total": 3, "evaluated": 2, "excluded": 1}, reference["selectedQueryCounts"])
        self.assertEqual(fixture["labelReview"]["sourceHashes"], reference["sourceHashes"])
        self.assertEqual(1.0, report["candidate"]["macroRecallAtK"])
        self.assertEqual(1.0, report["final"]["mrrAt5"])

    def test_provenance_distinguishes_hybrid_and_human_without_overclaiming(self):
        for mode, phrase in (("hybrid", "unreviewed AI labels"), ("human", "does not establish expert")):
            with self.subTest(mode=mode):
                fixture = self.reviewed_fixture(mode)
                reference = label_reference_report(fixture, fixture["cases"][:2])
                self.assertEqual(mode, reference["mode"])
                self.assertIn(phrase, reference["metricInterpretation"])
                self.assertEqual({"total": 2, "evaluated": 2, "excluded": 0}, reference["selectedQueryCounts"])

    def test_old_fixtures_are_accepted_but_not_inferred_human_verified(self):
        fixture = self.capture_fixture()
        reference = label_reference_report(fixture, fixture["cases"])
        self.assertEqual("legacy_unspecified", reference["mode"])
        self.assertIn("must not be described as human-validated", reference["metricInterpretation"])

    def test_provenance_rejects_mode_conflict_and_missing_audit(self):
        fixture = self.reviewed_fixture()
        invalid = []
        item = copy.deepcopy(fixture)
        item["labelReview"]["mode"] = "human"
        invalid.append((item, "dataType"))
        item = copy.deepcopy(fixture)
        del item["labelReview"]
        invalid.append((item, "requires a labelReview schema"))
        item = copy.deepcopy(fixture)
        del item["labelReview"]["sourceHashes"]["selectionSha256"]
        invalid.append((item, "selection source hash"))
        item = copy.deepcopy(fixture)
        item["labelReview"]["sourceHashes"]["aiReviewSha256"] = "invalid"
        invalid.append((item, "SHA-256"))
        for candidate, message in invalid:
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                label_reference_report(candidate, candidate["cases"])

    def test_provenance_rejects_hidden_exclusions_and_pending_human_checks(self):
        fixture = self.reviewed_fixture("hybrid")
        invalid = []
        item = copy.deepcopy(fixture)
        item["labelReview"]["excludedQueries"] = []
        invalid.append((item, "exclusions do not match"))
        item = copy.deepcopy(fixture)
        item["labelReview"]["counts"]["labeledQueryCount"] = 3
        invalid.append((item, "query counts"))
        item = copy.deepcopy(fixture)
        item["labelReview"]["pendingHumanReviewCount"] = 1
        invalid.append((item, "pending required human"))
        item = copy.deepcopy(fixture)
        item["labelReview"]["sourceCounts"]["ai"] = 99
        invalid.append((item, "source counts do not match"))
        for candidate, message in invalid:
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                label_reference_report(candidate, candidate["cases"])

    def test_ai_only_provenance_rejects_human_claims(self):
        fixture = self.reviewed_fixture()
        fixture["labelReview"]["sourceCounts"] = {"ai": 1, "human": 1, "unresolved": 1}
        with self.assertRaisesRegex(ValueError, "AI-only labels cannot claim human"):
            label_reference_report(fixture, fixture["cases"])


if __name__ == "__main__":
    unittest.main()
