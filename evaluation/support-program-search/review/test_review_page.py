import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


REVIEW_DIR = Path(__file__).resolve().parent


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, REVIEW_DIR / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PAGE = load_module("review_page_test_subject", "build-review-page.py")
EXTRACT = load_module("review_json_test_subject", "extract-review-json.py")
SUPPORT = load_module("existing_review_test_scenarios", "test_review_tools.py")


class BrowserReviewTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.scenario = SUPPORT.create_scenario(self.root)
        self.pool_args = SUPPORT.build_pool(self.scenario)
        self.fixture = PAGE.load_json(self.scenario.paths["fixture"])
        self.query_set = PAGE.load_json(self.scenario.paths["query_set"])
        self.manifest = PAGE.load_json(self.pool_args.pool_manifest)
        self.rows = SUPPORT.read_rows(self.pool_args.review_pool)
        self.template_dir = self.root / "templates"
        self.template_dir.mkdir()
        (self.template_dir / "review-page.html").write_text("<script type=\"application/json\" id=\"data\">__REVIEW_DATA__</script>", encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def seed_file(self):
        seeds = {
            "referenceDate": self.fixture["referenceDate"],
            "querySetSha256": self.manifest["querySetSha256"],
            "reviewer": "대화 사용자",
            "reviewMethod": "대화에서 제시된 요약을 읽고 판단함",
            "judgments": [
                {
                    "queryId": "Q01", "programId": self.fixture["docs"][index]["id"],
                    "contentHash": self.fixture["docs"][index]["contentHash"],
                    "presentedQuery": "알파 지원을 찾고 있어",
                    "presentedProgramTitle": f"알파 지원 {index + 1}",
                    "presentedProgramSummary": "대화에서 보여준 짧은 요약",
                    "decision": "relevant" if index == 0 else "irrelevant",
                    "userResponse": "추천해도 되지" if index == 0 else "안 되지 지역이 다르니까",
                    "userReason": None if index == 0 else "지역이 다르니까",
                }
                for index in range(2)
            ],
        }
        path = self.root / "conversation.json"
        SUPPORT.write_json(path, seeds)
        return path, seeds

    def page_args(self, seeds=None, name="review.html"):
        return SimpleNamespace(
            fixture=self.scenario.paths["fixture"], query_set=self.scenario.paths["query_set"],
            review_pool=self.pool_args.review_pool, pool_manifest=self.pool_args.pool_manifest,
            conversation_judgments=str(seeds) if seeds else None, output=str(self.root / name),
        )

    def build_page(self, args):
        with patch.object(PAGE, "REVIEW_DIR", self.template_dir):
            return SUPPORT.call_main(PAGE, args)

    def export(self):
        return {
            **PAGE.review_identity(self.manifest), "reviewer": "검토자",
            "judgments": [
                {"queryId": row["query_id"], "programId": row["program_id"],
                 "decision": "", "reason": "", "reviewer": "", "provenance": None}
                for row in self.rows
            ],
        }

    def test_build_preserves_two_human_judgments_and_raw_conversation(self):
        seeds_path, seeds = self.seed_file()
        args = self.page_args(seeds_path)
        self.build_page(args)
        html = Path(args.output).read_text(encoding="utf-8")
        payload = json.loads(html.split(">", 1)[1].rsplit("</script>", 1)[0])
        self.assertEqual(payload["rows"], self.rows)
        self.assertEqual(len(payload["seedJudgments"]), 2)
        first, second = payload["seedJudgments"]
        self.assertEqual(first["decision"], "relevant")
        self.assertIn("별도 사유 미입력", first["reason"])
        self.assertEqual(first["provenance"]["userResponse"], "추천해도 되지")
        self.assertIsNone(first["provenance"]["userReason"])
        self.assertEqual(first["provenance"]["presentedProgramSummary"], seeds["judgments"][0]["presentedProgramSummary"])
        self.assertEqual(second["decision"], "irrelevant")
        self.assertEqual(second["reason"], "지역이 다르니까")
        self.assertEqual(first["reviewer"], "대화 사용자")

    def test_build_refuses_tampered_fixture_hash_and_catalog(self):
        for kind in ("content", "fingerprint", "count"):
            with self.subTest(kind=kind):
                fixture = copy.deepcopy(self.fixture)
                if kind == "content":
                    fixture["docs"][0]["text"] += "tampered"
                elif kind == "fingerprint":
                    fixture["catalog"]["eligibleCatalogFingerprint"] = "0" * 64
                else:
                    fixture["catalog"]["eligibleProgramCount"] -= 1
                SUPPORT.write_json(Path(self.scenario.paths["fixture"]), fixture)
                with self.assertRaises(ValueError):
                    self.build_page(self.page_args())
                self.assertFalse((self.root / "review.html").exists())

    def test_build_refuses_changed_query_and_manifest_identity(self):
        query_set = copy.deepcopy(self.query_set)
        query_set["queries"][0]["query"] = "다른 질문"
        with self.assertRaisesRegex(ValueError, "query-set hash"):
            PAGE.validate_sources(self.fixture, query_set, self.manifest, self.rows)
        for field, value in (("name", "other"), ("referenceDate", "2026-09-05"), ("catalogFingerprint", "0" * 64)):
            with self.subTest(field=field):
                manifest = {**self.manifest, field: value}
                with self.assertRaises(ValueError):
                    PAGE.validate_sources(self.fixture, self.query_set, manifest, self.rows)

    def test_refuses_immutable_tamper_even_if_manifest_structure_was_changed(self):
        rows = copy.deepcopy(self.rows)
        rows[0]["summary"] = "거짓 요약"
        manifest = {**self.manifest, "reviewStructureSha256": PAGE.POOL.review_structure_sha256(rows)}
        with self.assertRaisesRegex(ValueError, "fixture text"):
            PAGE.validate_sources(self.fixture, self.query_set, manifest, rows)

    def test_pool_rejects_missing_duplicate_unknown_or_changed_rows(self):
        for kind in ("missing", "duplicate", "unknown", "changed", "bad-decision"):
            with self.subTest(kind=kind):
                rows = copy.deepcopy(self.rows)
                if kind == "missing":
                    rows.pop()
                elif kind == "duplicate":
                    rows[-1] = rows[0]
                elif kind == "unknown":
                    rows[0]["query_id"] = "UNKNOWN"
                elif kind == "changed":
                    rows[0]["title"] += "변경"
                else:
                    rows[0]["decision"] = "maybe"
                path = self.root / f"{kind}.csv"
                SUPPORT.write_rows(path, rows)
                with self.assertRaises(ValueError):
                    PAGE.load_verified_pool(path, self.manifest)

    def test_seed_rejects_wrong_source_identity_unknown_duplicate_or_conflict(self):
        path, seeds = self.seed_file()
        for kind in ("hash", "query-hash", "date", "unknown", "duplicate", "blank", "conflict"):
            with self.subTest(kind=kind):
                value = copy.deepcopy(seeds)
                rows = copy.deepcopy(self.rows)
                if kind == "hash":
                    value["judgments"][0]["contentHash"] = "0" * 64
                elif kind == "query-hash":
                    value["querySetSha256"] = "0" * 64
                elif kind == "date":
                    value["referenceDate"] = "2026-09-05"
                elif kind == "unknown":
                    value["judgments"][0]["programId"] = "SYNTHETIC:UNKNOWN"
                elif kind == "duplicate":
                    value["judgments"].append(value["judgments"][0])
                elif kind == "blank":
                    value["judgments"][0]["decision"] = ""
                else:
                    row = next(row for row in rows if (row["query_id"], row["program_id"]) == ("Q01", "SYNTHETIC:1"))
                    row["decision"] = "irrelevant"
                SUPPORT.write_json(path, value)
                with self.assertRaises(ValueError):
                    PAGE.load_seeds(path, self.fixture, self.manifest, rows)

    def test_inline_json_escapes_script_breakout_and_unicode_separators(self):
        raw = {"text": '</script><img src=x onerror="alert(1)"> & \u2028 \u2029'}
        encoded = PAGE.script_json(raw)
        self.assertEqual(json.loads(encoded), raw)
        for forbidden in ("<", ">", "&", "\u2028", "\u2029"):
            self.assertNotIn(forbidden, encoded)

    def test_seed_export_roundtrip_retains_decisions_without_fabricating_other_labels(self):
        path, seeds = self.seed_file()
        seed_judgments = PAGE.load_seeds(path, self.fixture, self.manifest, self.rows)
        seeded = {(item["queryId"], item["programId"]): item for item in seed_judgments}
        exported = self.export()
        exported["judgments"] = [
            seeded.get((item["queryId"], item["programId"]), item)
            for item in exported["judgments"]
        ]
        serialized = PAGE.script_json(exported)
        restored = json.loads(serialized)
        converted = EXTRACT.apply_judgments(self.rows, self.manifest, restored)
        self.assertEqual(sum(PAGE.is_complete(row) for row in converted), 2)
        self.assertEqual(sum(not row["decision"] for row in converted), len(self.rows) - 2)
        for judgment in restored["judgments"]:
            if judgment["provenance"]:
                original = next(item for item in seeds["judgments"] if item["programId"] == judgment["programId"])
                self.assertEqual(judgment["provenance"]["userResponse"], original["userResponse"])
                self.assertEqual(judgment["provenance"]["userReason"], original["userReason"])

    def test_existing_csv_draft_is_accepted_and_not_marked_complete(self):
        rows = copy.deepcopy(self.rows)
        rows[0].update(decision="relevant", reason="", reviewer="검토자")
        path = self.root / "draft.csv"
        SUPPORT.write_rows(path, rows)
        restored = PAGE.load_verified_pool(path, self.manifest)
        self.assertEqual(restored[0]["decision"], "relevant")
        self.assertFalse(PAGE.is_complete(restored[0]))

    def test_build_refuses_existing_output_without_changing_it(self):
        args = self.page_args()
        Path(args.output).write_text("기존 검토 결과", encoding="utf-8")
        with self.assertRaises(FileExistsError):
            self.build_page(args)
        self.assertEqual(Path(args.output).read_text(encoding="utf-8"), "기존 검토 결과")

    def test_build_requires_one_template_token(self):
        (self.template_dir / "review-page.html").write_text("__REVIEW_DATA____REVIEW_DATA__", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "exactly one"):
            self.build_page(self.page_args())
        self.assertFalse((self.root / "review.html").exists())

    def test_json_loader_rejects_duplicate_fields(self):
        path = self.root / "duplicate.json"
        path.write_text('{"decision":"relevant","decision":"irrelevant"}', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Duplicate JSON field"):
            PAGE.load_json(path)

    def test_convert_preserves_partial_progress_and_all_original_fields(self):
        exported = self.export()
        exported["judgments"][0].update(decision="relevant", reason="작성 중인 사유", reviewer="")
        exported["judgments"][1].update(decision="unclear", reason="", reviewer="작성자")
        exported["judgments"][2].update(decision="irrelevant", reason="지역 불일치", reviewer="작성자")
        exported["judgments"][3].update(reason="선택 전 메모", reviewer="작성자")
        exported["judgments"].reverse()
        path = self.root / "browser.json"
        SUPPORT.write_json(path, exported)
        args = SimpleNamespace(review_pool=self.pool_args.review_pool, pool_manifest=self.pool_args.pool_manifest,
                               review_json=str(path), output=str(self.root / "converted.csv"))
        stdout = SUPPORT.call_main(EXTRACT, args)
        report = json.loads(stdout)
        self.assertEqual(report["completedRowCount"], 1)
        self.assertEqual(report["incompleteRowCount"], 2)
        self.assertEqual(report["unselectedRowCount"], 1)
        converted = SUPPORT.read_rows(args.output)
        self.assertEqual(PAGE.POOL.review_structure_sha256(converted), self.manifest["reviewStructureSha256"])
        self.assertEqual([(row["query_id"], row["program_id"]) for row in converted], [(row["query_id"], row["program_id"]) for row in self.rows])
        self.assertEqual(converted[0]["reason"], "작성 중인 사유")
        self.assertEqual(converted[1]["decision"], "unclear")
        self.assertEqual(converted[3]["reason"], "선택 전 메모")
        self.assertEqual(converted[3]["decision"], "")

    def test_convert_exact_identity_and_row_contract(self):
        for kind in ("hash", "capture", "missing", "duplicate", "unknown", "extra", "missing-field", "immutable", "bad-decision", "bad-reason", "bad-reviewer", "bad-provenance"):
            with self.subTest(kind=kind):
                exported = self.export()
                if kind == "hash":
                    exported["reviewStructureSha256"] = "0" * 64
                elif kind == "capture":
                    exported["captureIncluded"] = 1
                elif kind == "missing":
                    exported["judgments"].pop()
                elif kind == "duplicate":
                    exported["judgments"][-1] = exported["judgments"][0]
                elif kind == "unknown":
                    exported["judgments"][0]["programId"] = "SYNTHETIC:UNKNOWN"
                elif kind == "extra":
                    exported["unexpected"] = True
                elif kind == "missing-field":
                    del exported["judgments"][0]["provenance"]
                elif kind == "immutable":
                    exported["judgments"][0]["title"] = "외부 제목"
                elif kind == "bad-decision":
                    exported["judgments"][0]["decision"] = "yes"
                elif kind == "bad-reason":
                    exported["judgments"][0]["reason"] = "가" * 2001
                elif kind == "bad-reviewer":
                    exported["judgments"][0]["reviewer"] = "가" * 101
                else:
                    exported["judgments"][0]["provenance"] = "not an object"
                with self.assertRaises(ValueError):
                    EXTRACT.apply_judgments(self.rows, self.manifest, exported)

    def test_convert_refuses_existing_output_and_original_csv(self):
        path = self.root / "browser.json"
        SUPPORT.write_json(path, self.export())
        original = Path(self.pool_args.review_pool).read_bytes()
        args = SimpleNamespace(review_pool=self.pool_args.review_pool, pool_manifest=self.pool_args.pool_manifest,
                               review_json=str(path), output=self.pool_args.review_pool)
        with self.assertRaises(FileExistsError):
            SUPPORT.call_main(EXTRACT, args)
        self.assertEqual(Path(self.pool_args.review_pool).read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
