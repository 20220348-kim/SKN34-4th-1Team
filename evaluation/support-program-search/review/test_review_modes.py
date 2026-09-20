import copy
import csv
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


REVIEW_DIR = Path(__file__).resolve().parent


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, REVIEW_DIR / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MODE = load_module("review_modes_test_subject", "select-review-mode.py")
RUNNER = load_module("review_modes_ai_runner", "run-ai-review.py")
SUPPORT = load_module("review_modes_scenarios", "test_review_tools.py")


class ReviewModeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.scenario = SUPPORT.create_scenario(self.root)
        self.pool = SUPPORT.build_pool(self.scenario)
        self.fixture = MODE.PAGE.load_fixture(self.scenario.paths["fixture"])
        self.manifest = MODE.PAGE.load_json(self.pool.pool_manifest)
        self.rows = MODE.PAGE.load_verified_pool(self.pool.review_pool, self.manifest)

    def tearDown(self):
        self.temp.cleanup()

    def ai_review(self, decisions=None, missing=0):
        policy = RUNNER.make_policy("synthetic-model")
        docs = {doc["id"]: doc for doc in self.fixture["docs"]}
        votes = []
        for row in self.rows:
            pair = (row["query_id"], row["program_id"])
            choices = (decisions or {}).get(pair, ["relevant"] * 5)
            doc = docs[row["program_id"]]
            for judge, decision in zip(policy["judges"], choices):
                votes.append({
                    "queryId": row["query_id"], "programId": row["program_id"],
                    "contentHash": doc["contentHash"], "judgeId": judge["id"], "decision": decision,
                    "reason": "고정 공고에 근거한 테스트 판정", "evidence": [doc["text"].splitlines()[0]],
                    "judgmentId": RUNNER.canonical_hash([row["query_id"], row["program_id"], judge["id"]]),
                    "agentId": f"/root/synthetic-{judge['id']}", "model": "synthetic-model", "usage": None,
                    "requestSha256": RUNNER.canonical_hash(RUNNER.build_request(policy, row, doc, self.fixture["referenceDate"], judge)),
                })
        if missing:
            votes = votes[:-missing]
        value = {
            "schemaVersion": RUNNER.SCHEMA, "executionKind": "codex-subagent", "identity": MODE.PAGE.review_identity(self.manifest),
            "catalogFingerprint": self.manifest["catalogFingerprint"], "fixtureSha256": MODE.file_hash(self.scenario.paths["fixture"]),
            "policy": policy, "policySha256": RUNNER.canonical_hash(policy), "judgments": votes,
            "pendingCount": 5 * len(self.rows) - len(votes), "status": "incomplete" if len(votes) != 5 * len(self.rows) else "complete",
        }
        RUNNER.validate_ai_review(value, self.fixture, self.manifest, self.rows)
        return value

    def human_review(self, pairs=None, decision="relevant"):
        progress = MODE.human_progress(self.rows, self.manifest)
        for item in progress["judgments"]:
            if pairs is None or MODE.key(item) in pairs:
                item.update(decision=decision, reason="사용자가 고정 공고 내용을 확인함", reviewer="사용자", provenance={"kind": "browser"})
        return progress

    def compose(self, mode="ai-only", ai=None, human=None, seeds=()):
        ai = ai if ai is not None else self.ai_review()
        return MODE.compose_selection(
            mode, self.rows, self.manifest, ai_review=ai, human_export=human, seeds=seeds,
            ai_review_sha256=MODE.canonical_hash(ai),
            human_review_sha256=MODE.canonical_hash(human) if human is not None else None,
            conversation_judgments_sha256=MODE.canonical_hash(seeds) if seeds else None,
        )

    def cli_args(self, mode="ai-only", ai=None, human=None, output="selection"):
        ai_path = SUPPORT.write_json(self.root / f"{output}-ai.json", ai or self.ai_review())
        human_path = SUPPORT.write_json(self.root / f"{output}-human.json", human) if human else None
        return SimpleNamespace(
            fixture=self.scenario.paths["fixture"], query_set=self.scenario.paths["query_set"],
            review_pool=self.pool.review_pool, pool_manifest=self.pool.pool_manifest,
            ai_review=ai_path, human_review=human_path, conversation_judgments=None,
            mode=mode, output_dir=str(self.root / output),
        )

    def test_unanimous_ai_ready_and_no_human_labels_prefilled(self):
        selection, csv_bytes, progress = self.compose()
        self.assertEqual(selection["status"], "ready")
        self.assertEqual(selection["sourceCounts"], {"ai": len(self.rows), "human": 0, "unresolved": 0})
        self.assertEqual(selection["requiredHumanReviewCount"], 0)
        self.assertTrue(all(not item["decision"] and not item["reviewer"] for item in progress["judgments"]))
        self.assertEqual(selection["reviewedCsvSha256"], MODE.hashlib.sha256(csv_bytes).hexdigest())
        rows = list(csv.DictReader(io.StringIO(csv_bytes.decode("utf-8-sig"))))
        self.assertEqual(MODE.validate_selection(selection, rows, self.manifest), selection)

    def test_four_one_consensus_but_three_two_excludes_whole_query(self):
        pair = (self.rows[0]["query_id"], self.rows[0]["program_id"])
        for choices, decision, excluded in (
            (["relevant"] * 4 + ["irrelevant"], "relevant", False),
            (["irrelevant"] * 4 + ["unclear"], "irrelevant", False),
            (["relevant"] * 3 + ["irrelevant"] * 2, "unclear", True),
            (["unclear"] * 5, "unclear", True),
        ):
            with self.subTest(choices=choices):
                selection, _, _ = self.compose(ai=self.ai_review({pair: choices}))
                item = next(item for item in selection["records"] if MODE.key(item) == pair)
                self.assertEqual(item["decision"], decision)
                self.assertEqual(pair[0] in selection["excludedQueries"], excluded)
                self.assertEqual(selection["status"], "ready")

    def test_all_unclear_does_not_create_a_ready_empty_evaluation(self):
        choices = {(row["query_id"], row["program_id"]): ["unclear"] * 5 for row in self.rows}
        selection, _, _ = self.compose(ai=self.ai_review(choices))
        self.assertEqual(selection["status"], "no-evaluable-queries")
        self.assertEqual(selection["evaluableQueryCount"], 0)
        self.assertEqual(len(selection["excludedQueries"]), len(self.manifest["perQueryCounts"]))

    def test_missing_judges_are_incomplete_not_implicit_negative(self):
        selection, _, _ = self.compose(ai=self.ai_review(missing=1))
        self.assertEqual(selection["status"], "incomplete-ai")
        self.assertEqual(selection["aiPendingCount"], 1)
        self.assertEqual(selection["records"][-1]["decision"], "unclear")
        self.assertEqual(selection["records"][-1]["source"], "unresolved")

    def test_ai_only_preserves_but_does_not_use_existing_human_disagreement(self):
        human = self.human_review(decision="irrelevant")
        selection, _, progress = self.compose(human=human)
        self.assertTrue(all(item["decision"] == "relevant" for item in selection["records"]))
        self.assertEqual(progress, human)
        seed = human["judgments"][0]
        selection, _, progress = self.compose(seeds=[seed])
        self.assertEqual(selection["records"][0]["decision"], "relevant")
        self.assertEqual(progress["judgments"][0], seed)
        self.assertEqual(sum(bool(item["decision"]) for item in progress["judgments"]), 1)

    def test_human_mode_requires_every_nonunclear_human_judgment_and_ignores_ai(self):
        selection, _, _ = self.compose(mode="human")
        self.assertEqual(selection["status"], "needs-human")
        self.assertEqual(selection["pendingHumanReviewCount"], len(self.rows))
        self.assertIsNone(selection["aiReviewSha256"])
        complete = self.human_review(decision="irrelevant")
        selection, _, _ = self.compose(mode="human", human=complete)
        self.assertEqual(selection["status"], "ready")
        self.assertEqual(selection["sourceCounts"]["human"], len(self.rows))
        complete["judgments"][0]["decision"] = "unclear"
        selection, _, _ = self.compose(mode="human", human=complete)
        self.assertEqual(selection["status"], "needs-human")
        self.assertEqual(selection["pendingHumanReviewCount"], 1)

    def test_hybrid_requires_disagreements_and_deterministic_consensus_sample(self):
        pair = (self.rows[0]["query_id"], self.rows[0]["program_id"])
        ai = self.ai_review({pair: ["relevant"] * 3 + ["irrelevant"] * 2})
        initial, _, _ = self.compose(mode="hybrid", ai=ai)
        self.assertEqual(initial["status"], "needs-human")
        required = {MODE.key(item) for item in initial["records"] if item["requiredHumanReview"]}
        self.assertIn(pair, required)
        self.assertTrue(initial["hybridSample"])
        sample_queries = {item["queryId"] for item in initial["hybridSample"]}
        self.assertEqual(sample_queries, set(self.manifest["perQueryCounts"]))
        repeated, _, _ = self.compose(mode="hybrid", ai=ai)
        self.assertEqual(initial["hybridSample"], repeated["hybridSample"])
        human = self.human_review(required)
        selection, _, _ = self.compose(mode="hybrid", ai=ai, human=human)
        self.assertEqual(selection["status"], "ready")
        self.assertEqual(selection["pendingHumanReviewCount"], 0)
        self.assertEqual(selection["excludedQueries"], {})
        self.assertEqual(selection["hybridSample"], initial["hybridSample"])

    def test_hybrid_partial_required_human_is_not_replaced_with_ai(self):
        initial, _, _ = self.compose(mode="hybrid")
        pair = MODE.key(initial["hybridSample"][0])
        human = self.human_review({pair})
        next(item for item in human["judgments"] if MODE.key(item) == pair)["reason"] = ""
        selection, _, _ = self.compose(mode="hybrid", human=human)
        record = next(item for item in selection["records"] if MODE.key(item) == pair)
        self.assertEqual(record["source"], "unresolved")
        self.assertEqual(record["decision"], "relevant")
        self.assertTrue(record["requiredHumanReview"])
        self.assertEqual(selection["status"], "needs-human")

    def test_human_export_can_clear_a_seed_without_resurrecting_it(self):
        seed = self.human_review()["judgments"][0]
        human = MODE.human_progress(self.rows, self.manifest)
        selection, _, progress = self.compose(mode="human", human=human, seeds=[seed])
        self.assertEqual(progress["judgments"][0]["decision"], "")
        self.assertEqual(selection["sourceCounts"]["human"], 0)
        self.assertIsNotNone(selection["conversationJudgmentsSha256"])

    def test_rejects_explicit_ai_identity_or_nested_ai_provenance_as_human(self):
        for change in (
            {"reviewer": "AI judge"}, {"provenance": {"kind": "ai"}},
            {"provenance": {"kind": "browser", "original": {"model": "gpt-test"}}},
            {"provenance": {"source": "ai"}},
        ):
            with self.subTest(change=change):
                human = self.human_review()
                human["judgments"][0].update(change)
                with self.assertRaises(ValueError):
                    self.compose(mode="human", human=human)

    def test_foreign_duplicate_missing_and_invalid_human_rows_rejected(self):
        for case in ("hash", "duplicate", "missing", "unknown", "decision"):
            with self.subTest(case=case):
                human = self.human_review()
                if case == "hash":
                    human["querySetSha256"] = "0" * 64
                elif case == "duplicate":
                    human["judgments"][-1] = human["judgments"][0]
                elif case == "missing":
                    human["judgments"].pop()
                elif case == "unknown":
                    human["judgments"][0]["programId"] = "UNKNOWN"
                else:
                    human["judgments"][0]["decision"] = "probably"
                with self.assertRaises(ValueError):
                    self.compose(mode="human", human=human)

    def test_selection_rejects_changed_csv_hashes_mode_counts_votes_and_requirements(self):
        initial, csv_bytes, _ = self.compose(mode="hybrid")
        rows = list(csv.DictReader(io.StringIO(csv_bytes.decode("utf-8-sig"))))
        for case in ("identity", "decision", "count", "pending", "sample", "required", "ai-votes", "status"):
            with self.subTest(case=case):
                selection = copy.deepcopy(initial)
                if case == "identity":
                    selection["identity"]["querySetSha256"] = "0" * 64
                elif case == "decision":
                    selection["records"][0]["decision"] = "irrelevant"
                elif case == "count":
                    selection["sourceCounts"]["ai"] += 1
                elif case == "pending":
                    selection["pendingHumanReviewCount"] = 0
                elif case == "sample":
                    selection["hybridSample"].pop()
                elif case == "required":
                    selection["records"][0]["requiredHumanReview"] = not selection["records"][0]["requiredHumanReview"]
                elif case == "ai-votes":
                    provenance = selection["records"][0]["provenance"]
                    (provenance.get("aiReference") or provenance)["votes"]["relevant"] -= 1
                else:
                    selection["status"] = "ready"
                with self.assertRaises(ValueError):
                    MODE.validate_selection(selection, rows, self.manifest)
        rows[0]["summary"] = "변경한 공고"
        with self.assertRaisesRegex(ValueError, "immutable"):
            MODE.validate_selection(initial, rows, self.manifest)

    def test_cli_validates_ai_content_request_evidence_duplicate_and_fixture_hash(self):
        for case in ("content", "request", "evidence", "duplicate", "missing", "fixture-file"):
            with self.subTest(case=case):
                ai = self.ai_review()
                if case == "content":
                    ai["judgments"][0]["contentHash"] = "0" * 64
                elif case == "request":
                    ai["judgments"][0]["requestSha256"] = "0" * 64
                elif case == "evidence":
                    ai["judgments"][0]["evidence"] = ["원문에 없는 문장"]
                elif case == "duplicate":
                    ai["judgments"][1] = ai["judgments"][0]
                elif case == "missing":
                    ai["judgments"].pop()
                else:
                    ai["fixtureSha256"] = "0" * 64
                args = self.cli_args(ai=ai, output=case)
                with self.assertRaises(ValueError):
                    SUPPORT.call_main(MODE, args)
                self.assertFalse(Path(args.output_dir).exists())

    def test_cli_outputs_human_only_progress_and_standalone_page_without_overwrite(self):
        args = self.cli_args(mode="hybrid")
        SUPPORT.call_main(MODE, args)
        output = Path(args.output_dir)
        self.assertEqual({path.name for path in output.iterdir()}, {"selection.json", "reviewed.csv", "review-progress.json", "review.html"})
        progress = MODE.PAGE.load_json(output / "review-progress.json")
        self.assertTrue(all(item["provenance"] is None and item["decision"] == "" for item in progress["judgments"]))
        html = (output / "review.html").read_text(encoding="utf-8")
        self.assertIn("다음 필수 사람 검토", html)
        self.assertIn(":selection:", html)
        self.assertNotIn("__REVIEW_DATA__", html)
        original = {path.name: path.read_bytes() for path in output.iterdir()}
        with self.assertRaises(FileExistsError):
            SUPPORT.call_main(MODE, args)
        self.assertEqual(original, {path.name: path.read_bytes() for path in output.iterdir()})

    def test_human_cli_does_not_even_read_ai_file(self):
        args = self.cli_args(mode="human", human=self.human_review())
        args.ai_review = str(self.root / "does-not-exist.json")
        SUPPORT.call_main(MODE, args)
        selection = MODE.PAGE.load_json(Path(args.output_dir) / "selection.json")
        self.assertEqual(selection["status"], "ready")
        self.assertIsNone(selection["aiReviewSha256"])

    def test_maximum_korean_ai_reasons_and_human_provenance_remain_bounded(self):
        ai = self.ai_review()
        for vote in ai["judgments"]:
            vote["reason"] = "가" * 1000
        RUNNER.validate_ai_review(ai, self.fixture, self.manifest, self.rows)
        human = self.human_review()
        human["judgments"][0]["provenance"] = {"kind": "browser", "note": "가" * 3200}
        MODE.PAGE.validate_judgment(human["judgments"][0])
        for mode in ("ai-only", "hybrid", "human"):
            with self.subTest(mode=mode):
                selection, _, progress = self.compose(mode=mode, ai=ai, human=human)
                self.assertEqual(selection["status"], "ready")
                self.assertEqual(progress, human)
                for item in selection["records"]:
                    self.assertLess(len(MODE.PAGE.script_json(item["provenance"]).encode("utf-8")), 10000)

    def test_human_labels_require_source_hash_and_counts_reject_bool(self):
        selection, csv_bytes, _ = self.compose(mode="human", human=self.human_review())
        rows = list(csv.DictReader(io.StringIO(csv_bytes.decode("utf-8-sig"))))
        selection["humanReviewSha256"] = None
        with self.assertRaisesRegex(ValueError, "human input source hash"):
            MODE.validate_selection(selection, rows, self.manifest)
        selection, csv_bytes, _ = self.compose()
        rows = list(csv.DictReader(io.StringIO(csv_bytes.decode("utf-8-sig"))))
        selection["sourceCounts"]["human"] = False
        with self.assertRaisesRegex(ValueError, "integers"):
            MODE.validate_selection(selection, rows, self.manifest)


if __name__ == "__main__":
    unittest.main()
