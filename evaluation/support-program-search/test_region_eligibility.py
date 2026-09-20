"""Synthetic saved-output tests validate the evaluator, never actual model judgment."""

import copy
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


TOOL_PATH = Path(__file__).with_name("evaluate-region-eligibility.py")
SPEC = importlib.util.spec_from_file_location("region_evaluator", TOOL_PATH)
region = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(region)
FIXTURE_PATH = Path(__file__).with_name("region-eligibility-fixture.json")


class RegionEligibilityEvaluationTest(unittest.TestCase):
    def setUp(self):
        self.fixture = region.replay.load_json(FIXTURE_PATH)
        requests = region.build_requests(self.fixture)
        self.capture = {
            "schemaVersion": region.CAPTURE_SCHEMA,
            "scoringVersion": region.SCORING_VERSION,
            "fixtureSha256": region.replay.canonical_sha256(self.fixture),
            "provenance": {"kind": "mock"},
            "observations": [],
        }
        for row, case in zip(requests, self.fixture["cases"]):
            rankings = []
            for candidate in self.fixture["candidates"]:
                expected = case["expected"][candidate["id"]]
                rankings.append({
                    "programId": candidate["id"], "semanticRelevance": 35,
                    "targetAssessment": {
                        "eligibility": "MATCH",
                        "evidence": [{"field": "TARGET_DESCRIPTION", "quote": "AI 분야 기업"}],
                        "explanation": "모의 출력: AI 업종과 지원 대상이 일치합니다.",
                    },
                    "regionAssessment": {
                        "eligibility": expected["eligibility"],
                        "evidence": [copy.deepcopy(expected["requiredEvidence"])] if "requiredEvidence" in expected else [],
                        "explanation": "평가기만 검증하는 모의 출력이며 실제 모델 판단이 아닙니다.",
                    },
                    "supportTypeFit": 10,
                    "recommendationReasons": ["평가 도구 검증용 모의 출력"],
                })
            self.capture["observations"].append({
                "caseId": row["caseId"], "requestSha256": region.replay.canonical_sha256(row["request"]),
                "output": {"rankings": rankings},
            })

    def assessment(self, case_id="REGION_SEOUL", program_id="SYNTH:REGION_01"):
        observation = next(row for row in self.capture["observations"] if row["caseId"] == case_id)
        return next(row for row in observation["output"]["rankings"] if row["programId"] == program_id)["regionAssessment"]

    def result(self, case_id="REGION_SEOUL", program_id="SYNTH:REGION_01"):
        report = region.evaluate(self.fixture, self.capture)
        return next(row for row in report["perAssessment"] if row["caseId"] == case_id and row["programId"] == program_id)

    def test_all_24_mock_labels_pass_without_claiming_real_quality(self):
        report = region.evaluate(self.fixture, self.capture)
        self.assertEqual((report["caseCount"], report["assessmentCount"], report["passedAssessments"]), (3, 24, 24))
        self.assertTrue(report["passed"])
        self.assertFalse(report["provenanceVerified"])
        self.assertEqual(report["provenance"]["kind"], "mock")
        self.assertIn("mock 결과는 평가기 동작만 검증", report["limitation"])

    def test_seoul_alone_does_not_prove_seocho_or_exclude_it(self):
        for wrong in ("MATCH", "INCOMPATIBLE"):
            with self.subTest(eligibility=wrong):
                assessment = self.assessment()
                assessment["eligibility"] = wrong
                assessment["evidence"] = [{"field": "SUMMARY", "quote": self.fixture["candidates"][0]["summary"]}]
                self.assertIn("ELIGIBILITY_MISMATCH", self.result()["failures"])

    def test_legacy_v4_capture_keeps_its_original_request_identity(self):
        del self.capture["scoringVersion"]
        requests = region.build_requests(self.fixture, region.LEGACY_SCORING_VERSION)
        for observation, row in zip(self.capture["observations"], requests, strict=True):
            observation["requestSha256"] = region.replay.canonical_sha256(row["request"])
        report = region.evaluate(self.fixture, self.capture)
        self.assertTrue(report["passed"])
        self.assertEqual(region.LEGACY_SCORING_VERSION, report["scoringVersion"])
        self.capture["scoringVersion"] = region.SCORING_VERSION
        with self.assertRaisesRegex(ValueError, "identity"):
            region.evaluate(self.fixture, self.capture)

    def test_unknown_scoring_version_is_rejected(self):
        self.capture["scoringVersion"] = "invented-version"
        with self.assertRaisesRegex(ValueError, "scoring version"):
            region.evaluate(self.fixture, self.capture)

    def test_explicit_district_matches_while_other_city_is_incompatible(self):
        self.assertEqual(self.result("REGION_SEOCHO")["expectedEligibility"], "MATCH")
        self.assertEqual(self.result("REGION_BUSAN")["expectedEligibility"], "INCOMPATIBLE")

    def test_exact_nonregional_target_quote_does_not_support_match(self):
        assessment = self.assessment(program_id="SYNTH:REGION_02")
        assessment["evidence"] = [{"field": "TARGET_DESCRIPTION", "quote": "AI 분야 기업"}]
        result = self.result(program_id="SYNTH:REGION_02")
        self.assertTrue(result["exactEvidence"])
        self.assertFalse(result["regionalClauseSupported"])
        self.assertEqual(result["failures"], ["MISSING_REGIONAL_SOURCE_CLAUSE"])

    def test_exact_nonregional_summary_quote_does_not_support_match(self):
        self.assessment(program_id="SYNTH:REGION_02")["evidence"] = [
            {"field": "SUMMARY", "quote": "AI 제품 사업화 비용을 지원합니다."},
        ]
        self.assertEqual(self.result(program_id="SYNTH:REGION_02")["failures"], ["MISSING_REGIONAL_SOURCE_CLAUSE"])

    def test_full_source_option_including_required_clause_is_accepted(self):
        self.assessment(program_id="SYNTH:REGION_02")["evidence"] = [
            {"field": "SUMMARY", "quote": self.fixture["candidates"][1]["summary"]},
        ]
        self.assertTrue(self.result(program_id="SYNTH:REGION_02")["passed"])

    def test_exact_copy_from_different_candidate_is_rejected(self):
        self.assessment(program_id="SYNTH:REGION_02")["evidence"] = [
            {"field": "SUMMARY", "quote": self.fixture["candidates"][2]["summary"]},
        ]
        self.assertIn("INVALID_EXACT_EVIDENCE", self.result(program_id="SYNTH:REGION_02")["failures"])

    def test_missing_known_evidence_is_not_accepted(self):
        self.assessment(program_id="SYNTH:REGION_02")["evidence"] = []
        self.assertEqual(self.result(program_id="SYNTH:REGION_02")["failures"],
                         ["INVALID_EXACT_EVIDENCE", "MISSING_REGIONAL_SOURCE_CLAUSE"])

    def test_nationwide_is_positive_only_with_explicit_source(self):
        for case in self.fixture["cases"]:
            self.assertEqual(case["expected"]["SYNTH:REGION_04"]["eligibility"], "MATCH")
            self.assertEqual(case["expected"]["SYNTH:REGION_05"]["eligibility"], "UNKNOWN")
            self.assertEqual(case["expected"]["SYNTH:REGION_06"]["eligibility"], "UNKNOWN")

    def test_relocation_exception_does_not_assume_relocation_intent(self):
        expected = [case["expected"]["SYNTH:REGION_07"]["eligibility"] for case in self.fixture["cases"]]
        self.assertEqual(expected, ["MATCH", "MATCH", "UNKNOWN"])
        self.assessment("REGION_BUSAN", "SYNTH:REGION_07")["eligibility"] = "INCOMPATIBLE"
        self.assertIn("ELIGIBILITY_MISMATCH", self.result("REGION_BUSAN", "SYNTH:REGION_07")["failures"])

    def test_exception_cannot_be_dropped_from_nationwide_quote(self):
        self.assessment("REGION_BUSAN", "SYNTH:REGION_08")["evidence"] = [
            {"field": "SUMMARY", "quote": "전국 기업이 신청할 수 있으나"},
        ]
        self.assertIn("MISSING_REGIONAL_SOURCE_CLAUSE", self.result("REGION_BUSAN", "SYNTH:REGION_08")["failures"])

    def test_final_top_five_is_not_a_full_assessment_capture(self):
        self.capture["observations"][0]["output"]["rankings"] = self.capture["observations"][0]["output"]["rankings"][:5]
        with self.assertRaisesRegex(ValueError, "pre-filter"):
            region.evaluate(self.fixture, self.capture)

    def test_missing_duplicate_or_unknown_cases_are_rejected(self):
        original = copy.deepcopy(self.capture)
        for bad in (original["observations"][:-1], original["observations"] + [original["observations"][0]],
                    [{**original["observations"][0], "caseId": "UNKNOWN"}, *original["observations"][1:]]):
            with self.subTest(observations=len(bad)), self.assertRaises(ValueError):
                self.capture["observations"] = bad
                region.evaluate(self.fixture, self.capture)

    def test_changed_fixture_or_request_hash_is_rejected(self):
        for target, field in ((self.capture, "fixtureSha256"), (self.capture["observations"][0], "requestSha256")):
            with self.subTest(field=field):
                original = target[field]
                target[field] = "0" * 64
                with self.assertRaisesRegex(ValueError, "hash mismatch|identity"):
                    region.evaluate(self.fixture, self.capture)
                target[field] = original

    def test_fixture_known_label_requires_its_own_original_source_clause(self):
        expected = self.fixture["cases"][0]["expected"]["SYNTH:REGION_02"]
        for evidence in (None, {"field": "SUMMARY", "quote": "원문에 없는 합성 지역 조건"}):
            with self.subTest(evidence=evidence), self.assertRaises(ValueError):
                expected["requiredEvidence"] = evidence
                region.validate_fixture(self.fixture)

    def test_requests_do_not_leak_labels_and_are_detached(self):
        requests = region.build_requests(self.fixture)
        self.assertEqual(len(requests), 3)
        for row in requests:
            self.assertEqual(set(row["request"]), {"originalQuery", "scoringVersion", "resultLimit", "candidates", "companyConditions"})
            self.assertNotIn("expected", json.dumps(row, ensure_ascii=False))
        requests[0]["request"]["candidates"][0]["summary"] = "changed"
        self.assertNotEqual(requests[0]["request"]["candidates"][0]["summary"], self.fixture["candidates"][0]["summary"])

    def test_live_provenance_requires_model_and_prompt_but_is_not_self_proving(self):
        self.capture["provenance"] = {"kind": "live_openai"}
        with self.assertRaisesRegex(ValueError, "model"):
            region.evaluate(self.fixture, self.capture)
        self.capture["provenance"].update(model="gpt-5.6-luna", promptSha256="a" * 64)
        report = region.evaluate(self.fixture, self.capture)
        self.assertFalse(report["provenanceVerified"])
        self.assertIn("별도 API 사용 기록", report["limitation"])

    def test_cli_without_capture_only_emits_requests_with_zero_calls(self):
        completed = subprocess.run([sys.executable, "-B", str(TOOL_PATH)], text=True, capture_output=True,
                                   encoding="utf-8", env={**__import__("os").environ, "PYTHONIOENCODING": "utf-8"})
        self.assertEqual(completed.returncode, 0, completed.stderr)
        result = json.loads(completed.stdout)
        self.assertEqual((result["actualApiCalls"], result["maximumPlannedRankingCalls"]), (0, 3))
        self.assertEqual(len(result["requests"]), 3)

    def test_cli_fails_semantic_mismatch_without_modifying_capture(self):
        self.assessment()["eligibility"] = "MATCH"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "mock-capture.json"
            contents = json.dumps(self.capture, ensure_ascii=False)
            path.write_text(contents, encoding="utf-8")
            completed = subprocess.run([sys.executable, "-B", str(TOOL_PATH), "--capture", str(path)],
                                       text=True, capture_output=True, encoding="utf-8",
                                       env={**__import__("os").environ, "PYTHONIOENCODING": "utf-8"})
            self.assertEqual(completed.returncode, 1, completed.stderr)
            self.assertFalse(json.loads(completed.stdout)["passed"])
            self.assertEqual(path.read_text(encoding="utf-8"), contents)

    def test_built_requests_and_mock_outputs_follow_production_models(self):
        sys.path.insert(0, str(TOOL_PATH.parents[2] / "backend/ai-service"))
        from app.support_program_ranking.models import SupportProgramRankingOutput, SupportProgramRankingRequest

        for request, observation in zip(region.build_requests(self.fixture), self.capture["observations"]):
            SupportProgramRankingRequest.model_validate(request["request"])
            SupportProgramRankingOutput.model_validate(observation["output"])


if __name__ == "__main__":
    unittest.main()
