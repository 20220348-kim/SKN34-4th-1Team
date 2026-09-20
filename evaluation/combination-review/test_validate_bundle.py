"""Mutation tests for source integrity and provenance; no model quality assertions."""

import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import unittest

from validate_bundle import DEFAULT_BUNDLE, read_json, validate_bundle


class BundleValidationTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "bundle"
        shutil.copytree(DEFAULT_BUNDLE, self.root)

    def write(self, name, data):
        path = self.root / name
        path.write_bytes((json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))

    def change_artifact(self, kind, change):
        """Update the checksum too so deeper checks are exercised, not only hashing."""
        manifest = read_json(self.root / "manifest.json")
        filename = manifest["artifacts"][kind]["path"]
        data = read_json(self.root / filename)
        change(data)
        self.write(filename, data)
        raw = (self.root / filename).read_bytes()
        manifest["artifacts"][kind].update(sha256=hashlib.sha256(raw).hexdigest(), byteLength=len(raw))
        self.write("manifest.json", manifest)

    def test_real_bundle_has_no_quality_score_or_human_review_claim(self):
        report = validate_bundle(self.root)
        self.assertTrue(report["integrityValid"])
        self.assertEqual((3, 12, 18), (report["sourceCount"], report["evidenceCount"], report["caseCount"]))
        self.assertEqual(15, report["caseKinds"]["OFFICIAL_SOURCE_SCENARIO"])
        self.assertEqual(0, report["humanReviewedCaseCount"])
        self.assertIsNone(report["qualityScore"])
        self.assertFalse(report["modelExecuted"])
        self.assertFalse(report["productionApproved"])

    def test_source_byte_tampering_fails_before_interpretation(self):
        path = self.root / "sources/general.hwpx"
        raw = bytearray(path.read_bytes())
        raw[-1] ^= 1
        path.write_bytes(raw)
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            validate_bundle(self.root)

    def test_edited_excerpt_fails_even_with_updated_artifact_hash(self):
        self.change_artifact("evidence", lambda d: d["evidence"][0]["quotes"][0].update(text="공식 원문에 없는 허용 문장"))
        with self.assertRaisesRegex(ValueError, "quote mismatch"):
            validate_bundle(self.root)

    def test_wrong_paragraph_locator_fails(self):
        self.change_artifact("evidence", lambda d: d["evidence"][0]["quotes"][0].update(paragraph=1))
        with self.assertRaisesRegex(ValueError, "quote mismatch"):
            validate_bundle(self.root)

    def test_omitted_linked_appendix_fails(self):
        self.change_artifact("cases", lambda d: d["cases"][0]["evidenceIds"].remove("G-PAST-LISTS"))
        with self.assertRaisesRegex(ValueError, "missing linked context"):
            validate_bundle(self.root)

    def test_bundle_path_cannot_escape_directory(self):
        data = read_json(self.root / "manifest.json")
        data["sources"][0]["path"] = "../outside.hwpx"
        self.write("manifest.json", data)
        with self.assertRaisesRegex(ValueError, "missing/outside bundle file"):
            validate_bundle(self.root)

    def test_source_version_must_match_bytes(self):
        data = read_json(self.root / "manifest.json")
        data["sources"][0]["version"] = "sha256:" + "0" * 64
        self.write("manifest.json", data)
        with self.assertRaisesRegex(ValueError, "version/hash mismatch"):
            validate_bundle(self.root)

    def test_unacquired_investment_notice_cannot_gain_a_fabricated_identity(self):
        data = read_json(self.root / "manifest.json")
        data["programs"][2]["identity"] = {"sourceCode":"BIZINFO", "sourceProgramId":"PBLN_999", "subProgramId":None}
        self.write("manifest.json", data)
        with self.assertRaisesRegex(ValueError, "resolved program needs a source"):
            validate_bundle(self.root)

    def test_synthetic_evidence_cannot_enter_official_excerpts(self):
        self.change_artifact("evidence", lambda d: d["evidence"][0].update(provenance="SYNTHETIC_NOT_OFFICIAL"))
        with self.assertRaisesRegex(ValueError, "synthetic evidence in official bundle"):
            validate_bundle(self.root)

    def test_conflict_fixture_must_keep_synthetic_label(self):
        self.change_artifact("cases", lambda d: d["cases"][14]["syntheticContext"][0].update(provenance="OFFICIAL"))
        with self.assertRaisesRegex(ValueError, "unlabeled synthetic source"):
            validate_bundle(self.root)

    def test_missing_evidence_cannot_be_expected_permission(self):
        self.change_artifact("cases", lambda d: d["cases"][13]["expected"]["judgments"][0].update(status="PERMISSION_IN_SCOPE"))
        with self.assertRaisesRegex(ValueError, "no evidence must not imply permission"):
            validate_bundle(self.root)

    def test_technical_failure_cannot_be_a_normal_insufficient_evidence_judgment(self):
        self.change_artifact("cases", lambda d: d["cases"][15]["expected"].update(
            executionStatus="SUCCEEDED", judgments=[{"stage":"APPLICATION", "status":"INSUFFICIENT_EVIDENCE", "scope":"fake fallback"}]))
        with self.assertRaisesRegex(ValueError, "technical failure must not become a judgment"):
            validate_bundle(self.root)

    def test_draft_cannot_claim_production_approval(self):
        data = read_json(self.root / "manifest.json")
        data["productionApproved"] = True
        self.write("manifest.json", data)
        with self.assertRaisesRegex(ValueError, "must not be production-approved"):
            validate_bundle(self.root)

    def test_duplicate_json_keys_are_rejected(self):
        (self.root / "manifest.json").write_text('{"schemaVersion":1,"schemaVersion":2}', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "duplicate JSON key"):
            validate_bundle(self.root)

    def test_duplicate_case_ids_are_rejected(self):
        self.change_artifact("cases", lambda d: d["cases"][1].update(id=d["cases"][0]["id"]))
        with self.assertRaisesRegex(ValueError, "duplicate/invalid case id"):
            validate_bundle(self.root)

    def test_pdf_page_out_of_bounds_is_rejected(self):
        self.change_artifact("evidence", lambda d: d["evidence"][6]["visualCrossCheck"].update(pages=[25]))
        with self.assertRaisesRegex(ValueError, "invalid visual page/reviewer"):
            validate_bundle(self.root)


if __name__ == "__main__":
    unittest.main()
