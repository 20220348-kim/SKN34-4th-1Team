"""Synthetic capture extension tests; never call a model or alter shared run artifacts."""

import copy
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from test_review_tools import POOL, LABELS, build_pool, call_main, create_scenario, load_module, write_json
from evaluate import evaluate_capture


TRANSFER = load_module("transfer_under_test", "transfer-ai-review.py")
RUNNER = TRANSFER.RUNNER
SELECT = TRANSFER.SELECT
PAGE = TRANSFER.PAGE


class TransferTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.scenario = create_scenario(self.root)
        self.final = build_pool(self.scenario, "final")
        self.previous = SimpleNamespace(**vars(self.final))
        self.previous.capture = None
        self.previous.review_pool = str(self.root / "previous" / "review.csv")
        self.previous.pool_manifest = str(self.root / "previous" / "manifest.json")
        self.previous.provenance = str(self.root / "previous" / "provenance.csv")
        call_main(POOL, self.previous)
        self.fixture = PAGE.load_fixture(self.scenario.paths["fixture"])
        self.previous_manifest = PAGE.load_json(self.previous.pool_manifest)
        self.previous_rows = PAGE.load_verified_pool(self.previous.review_pool, self.previous_manifest)
        self.policy = RUNNER.make_policy("synthetic-model")
        self.unresolved = TRANSFER.row_key(self.previous_rows[0])
        base = self.make_ai(self.previous_manifest, self.previous_rows, "original", self.unresolved)
        self.ai_path = write_json(self.root / "original-ai.json", base)
        pairs, blind = TRANSFER.RECHECK.derive_targets(base, RUNNER.file_hash(self.ai_path), self.fixture, self.previous_rows)
        fresh = self.make_ai(self.previous_manifest, self.previous_rows, "recheck")
        recheck_votes = [vote for vote in fresh["judgments"] if (vote["queryId"], vote["programId"]) == self.unresolved]
        for vote in recheck_votes:
            vote.update(decision="unclear", evidence=[])
        recheck = {"schemaVersion": TRANSFER.RECHECK.SCHEMA,
            "baseAiReviewSha256": RUNNER.file_hash(self.ai_path), "identity": base["identity"],
            "fixtureSha256": base["fixtureSha256"], "policy": self.policy, "policySha256": base["policySha256"],
            "inputSha256": RUNNER.canonical_hash(blind), "targetPairs": pairs,
            "assignments": {judge["id"]: f"recheck-{judge['id']}" for judge in self.policy["judges"]},
            "judgments": recheck_votes, "pendingCount": 0, "status": "complete", "roundLimit": 1}
        self.recheck_path = write_json(self.root / "original-recheck.json", recheck)
        self.args = SimpleNamespace(command="prepare", fixture=self.scenario.paths["fixture"],
            query_set=self.scenario.paths["query_set"], config=self.scenario.paths["config"],
            capture=self.scenario.paths["capture"], previous_pool=self.previous.review_pool,
            previous_manifest=self.previous.pool_manifest, review_pool=self.final.review_pool,
            pool_manifest=self.final.pool_manifest, ai_review=self.ai_path, ai_recheck=self.recheck_path,
            output_dir=str(self.root / "additional"))
        self.frozen = {path: Path(path).read_bytes() for path in (
            self.ai_path, self.recheck_path, self.previous.review_pool, self.previous.pool_manifest)}

    def tearDown(self):
        self.temp.cleanup()

    def make_ai(self, manifest, rows, prefix, unresolved=None):
        docs = {doc["id"]: doc for doc in self.fixture["docs"]}
        votes = []
        for row in rows:
            pair = TRANSFER.row_key(row)
            doc = docs[pair[1]]
            for index, judge in enumerate(self.policy["judges"]):
                decision = "relevant" if pair != unresolved or index < 3 else "irrelevant"
                votes.append({"queryId": pair[0], "programId": pair[1], "contentHash": doc["contentHash"],
                    "judgeId": judge["id"], "decision": decision, "reason": "합성 검증 근거",
                    "evidence": [doc["text"].splitlines()[0]], "judgmentId": RUNNER.canonical_hash([*pair, judge["id"]]),
                    "agentId": f"{prefix}-{judge['id']}", "model": self.policy["model"], "usage": None,
                    "requestSha256": RUNNER.canonical_hash(RUNNER.build_request(self.policy, row, doc, self.fixture["referenceDate"], judge))})
        return {"schemaVersion": RUNNER.SCHEMA, "executionKind": "codex-subagent",
            "identity": PAGE.review_identity(manifest), "catalogFingerprint": manifest["catalogFingerprint"],
            "fixtureSha256": RUNNER.file_hash(self.scenario.paths["fixture"]), "policy": self.policy,
            "policySha256": RUNNER.canonical_hash(self.policy), "judgments": votes, "pendingCount": 0, "status": "complete"}

    def prepare(self):
        return call_main(TRANSFER, self.args)

    def selection_args(self, missing=False):
        additional_dir = Path(self.args.output_dir)
        manifest = PAGE.load_json(additional_dir / "review-pool-manifest.json")
        rows = PAGE.load_verified_pool(additional_dir / "review-pool.csv", manifest)
        ai = self.make_ai(manifest, rows, "additional")
        if missing:
            ai["judgments"].pop()
            ai.update(pendingCount=1, status="incomplete")
        ai_path = write_json(self.root / "additional-ai.json", ai)
        return SimpleNamespace(**{**vars(self.args), "command": "select",
            "additional_dir": str(additional_dir), "additional_ai_review": ai_path,
            "conversation_judgments": None, "output_dir": str(self.root / "selected")})

    def labeled_args(self, selected_args):
        return SimpleNamespace(fixture=self.args.fixture, query_set=self.args.query_set,
            config=self.args.config, capture=self.args.capture, pool_manifest=self.args.pool_manifest,
            review_pool=str(Path(selected_args.output_dir) / "reviewed.csv"),
            selection=str(Path(selected_args.output_dir) / "selection.json"), exclude_query=[],
            output=str(self.root / "labeled.json"))

    def test_prepare_only_new_pairs_without_reading_environment_or_network(self):
        with patch.dict("os.environ", {}, clear=True), patch("socket.socket", side_effect=AssertionError("network")):
            self.prepare()
        directory = Path(self.args.output_dir)
        plan = PAGE.load_json(directory / "transfer-plan.json")
        self.assertEqual(3, plan["previousPairCount"])
        self.assertEqual(1, plan["additionalPairCount"])
        self.assertEqual(5, plan["additionalJudgmentCount"])
        self.assertEqual([{"queryId": "Q02", "programId": "SYNTHETIC:2"}], plan["additionalPairs"])
        blind = RUNNER.read_jsonl(directory / "prepared" / "blind-input.jsonl")
        self.assertEqual(1, len(blind))
        self.assertEqual("Q02", blind[0]["queryId"])
        self.assertNotIn("decision", blind[0])
        self.assertFalse(PAGE.load_json(directory / "review-pool-manifest.json")["captureIncluded"])
        for path, raw in self.frozen.items():
            self.assertEqual(raw, Path(path).read_bytes())

    def test_select_preserves_recheck_uncertainty_and_all_ai_source_hashes(self):
        self.prepare()
        args = self.selection_args()
        with patch("socket.socket", side_effect=AssertionError("network")):
            call_main(TRANSFER, args)
        selected = PAGE.load_json(Path(args.output_dir) / "selection.json")
        self.assertEqual({"ai": 3, "human": 0, "unresolved": 1}, selected["sourceCounts"])
        self.assertEqual(2, selected["evaluableQueryCount"])
        self.assertEqual("ready", selected["status"])
        self.assertEqual(TRANSFER.SCHEMA, selected["schemaVersion"])
        uncertain = next(record for record in selected["records"] if SELECT.key(record) == self.unresolved)
        self.assertEqual("unclear", uncertain["decision"])
        self.assertEqual(RUNNER.file_hash(self.recheck_path), uncertain["provenance"]["recheckSha256"])
        additional = next(record for record in selected["records"] if record["queryId"] == "Q02")
        self.assertEqual(RUNNER.file_hash(args.additional_ai_review), additional["provenance"]["aiReviewSha256"])
        self.assertNotIn("recheckSha256", additional["provenance"])
        progress = PAGE.load_json(Path(args.output_dir) / "review-progress.json")
        self.assertTrue(all(not record["decision"] for record in progress["judgments"]))
        call_main(LABELS, self.labeled_args(args))
        labeled = PAGE.load_fixture(self.root / "labeled.json")
        hashes = labeled["labelReview"]["sourceHashes"]
        self.assertEqual(RUNNER.file_hash(self.ai_path), hashes["aiReviewSha256"])
        self.assertEqual(RUNNER.file_hash(self.recheck_path), hashes["aiRecheckSha256"])
        self.assertEqual(RUNNER.file_hash(args.additional_ai_review), hashes["additionalAiReviewSha256"])
        self.assertEqual(RUNNER.file_hash(Path(args.additional_dir) / "transfer-plan.json"), hashes["transferPlanSha256"])
        self.assertEqual("ai-only", labeled["labelReview"]["mode"])
        report = evaluate_capture(self.scenario.capture, labeled, labeled["cases"], candidate_k=20)
        self.assertEqual(hashes["additionalAiReviewSha256"], report["labelReference"]["sourceHashes"]["additionalAiReviewSha256"])
        self.assertEqual(0, report["labelReference"]["sourceCounts"]["human"])
        for path, raw in self.frozen.items():
            self.assertEqual(raw, Path(path).read_bytes())

    def test_incomplete_additional_review_cannot_publish(self):
        self.prepare()
        args = self.selection_args(missing=True)
        call_main(TRANSFER, args)
        selection = PAGE.load_json(Path(args.output_dir) / "selection.json")
        self.assertEqual("incomplete-ai", selection["status"])
        self.assertEqual(1, selection["aiPendingCount"])
        with self.assertRaisesRegex(ValueError, "not ready"):
            call_main(LABELS, self.labeled_args(args))
        self.assertFalse((self.root / "labeled.json").exists())

    def test_zero_additions_need_no_new_judgments(self):
        capture = copy.deepcopy(self.scenario.capture)
        capture["observations"][1]["candidateIds"] = []
        write_json(Path(self.args.capture), capture)
        final = build_pool(self.scenario, "same-pairs-final")
        self.args.review_pool, self.args.pool_manifest = final.review_pool, final.pool_manifest
        self.prepare()
        self.assertFalse((Path(self.args.output_dir) / "prepared").exists())
        args = SimpleNamespace(**{**vars(self.args), "command": "select", "additional_dir": self.args.output_dir,
            "additional_ai_review": None, "conversation_judgments": None, "output_dir": str(self.root / "selected")})
        call_main(TRANSFER, args)
        selection = PAGE.load_json(Path(args.output_dir) / "selection.json")
        self.assertEqual(1, len(selection["transferSources"]))
        self.assertIsNone(selection["additionalAiReviewSha256"])
        self.assertEqual(0, selection["aiPendingCount"])

    def test_source_fixture_policy_and_plan_tampering_are_rejected(self):
        original = Path(self.args.fixture).read_bytes()
        Path(self.args.fixture).write_bytes(original + b"\n")
        with self.assertRaisesRegex(ValueError, "fixture changed"):
            self.prepare()
        Path(self.args.fixture).write_bytes(original)
        self.prepare()
        args = self.selection_args()
        original_ai = PAGE.load_json(args.additional_ai_review)
        tampered = copy.deepcopy(original_ai)
        tampered["policy"]["model"] = "other-model"
        write_json(Path(args.additional_ai_review), tampered)
        with self.assertRaises(ValueError):
            call_main(TRANSFER, args)
        write_json(Path(args.additional_ai_review), original_ai)
        plan_path = Path(args.additional_dir) / "transfer-plan.json"
        plan = PAGE.load_json(plan_path)
        plan["sourceHashes"]["aiRecheckSha256"] = "a" * 64
        write_json(plan_path, plan)
        with self.assertRaisesRegex(ValueError, "fixed source hashes"):
            call_main(TRANSFER, args)

    def test_capture_changed_or_omitted_candidate_rejected(self):
        original = Path(self.args.capture).read_bytes()
        Path(self.args.capture).write_bytes(original + b"\n")
        with self.assertRaisesRegex(ValueError, "capture identity"):
            self.prepare()
        Path(self.args.capture).write_bytes(original)
        capture = copy.deepcopy(self.scenario.capture)
        capture["observations"][0]["candidateIds"].append("SYNTHETIC:3")
        write_json(Path(self.args.capture), capture)
        manifest = PAGE.load_json(self.args.pool_manifest)
        manifest["captureFileSha256"] = RUNNER.file_hash(self.args.capture)
        write_json(Path(self.args.pool_manifest), manifest)
        with self.assertRaisesRegex(ValueError, "configured real capture pool"):
            self.prepare()

    def test_selected_sources_cannot_overlap_disappear_change_or_become_human(self):
        self.prepare()
        args = self.selection_args()
        call_main(TRANSFER, args)
        manifest = PAGE.load_json(args.pool_manifest)
        selection = PAGE.load_json(Path(args.output_dir) / "selection.json")
        rows = PAGE.load_verified_pool(Path(args.output_dir) / "reviewed.csv", manifest)
        SELECT.validate_selection(selection, rows, manifest)
        variants = []
        bad = copy.deepcopy(selection); bad["transferSources"].append(copy.deepcopy(bad["transferSources"][0])); variants.append(bad)
        bad = copy.deepcopy(selection); bad["records"].pop(); variants.append(bad)
        bad = copy.deepcopy(selection); bad["records"][0]["source"] = "human"; variants.append(bad)
        bad = copy.deepcopy(selection); bad["aiRecheckSha256"] = "f" * 64; variants.append(bad)
        bad = copy.deepcopy(selection); bad["aiPendingCount"] = False; variants.append(bad)
        bad = copy.deepcopy(selection); bad["transferSources"][0]["selection"]["records"][0]["decision"] = "relevant"; variants.append(bad)
        for bad in variants:
            with self.subTest():
                with self.assertRaises(ValueError):
                    SELECT.validate_selection(bad, rows, manifest)
        changed_rows = copy.deepcopy(rows)
        changed_rows[0]["title"] += " 변조"
        with self.assertRaisesRegex(ValueError, "immutable content"):
            SELECT.validate_selection(selection, changed_rows, manifest)

    def test_output_files_are_never_overwritten(self):
        self.prepare()
        with self.assertRaises(FileExistsError):
            self.prepare()
        args = self.selection_args()
        call_main(TRANSFER, args)
        with self.assertRaises(FileExistsError):
            call_main(TRANSFER, args)

    def test_additional_judgments_cannot_claim_previous_agent_identities(self):
        self.prepare()
        args = self.selection_args()
        ai = PAGE.load_json(args.additional_ai_review)
        for prefix in ("original", "recheck"):
            for vote in ai["judgments"]:
                vote["agentId"] = f"{prefix}-{vote['judgeId']}"
            write_json(Path(args.additional_ai_review), ai)
            with self.assertRaisesRegex(ValueError, "new independent agents"):
                call_main(TRANSFER, args)
        self.assertFalse(Path(args.output_dir).exists())

    def test_actual_conversation_seed_is_preserved_without_becoming_an_ai_label(self):
        self.prepare()
        args = self.selection_args()
        row = self.previous_rows[-1]
        doc = next(doc for doc in self.fixture["docs"] if doc["id"] == row["program_id"])
        seed = {"referenceDate": self.fixture["referenceDate"],
            "querySetSha256": self.previous_manifest["querySetSha256"],
            "reviewer": "합성 사용자", "reviewMethod": "합성 대화 입력",
            "judgments": [{"queryId": row["query_id"], "programId": row["program_id"],
                "contentHash": doc["contentHash"], "presentedQuery": row["query"],
                "presentedProgramTitle": row["title"], "presentedProgramSummary": row["summary"],
                "decision": "irrelevant", "userResponse": "추천 불가", "userReason": "합성 사람 의견"}]}
        args.conversation_judgments = write_json(self.root / "conversation.json", seed)
        call_main(TRANSFER, args)
        selected = PAGE.load_json(Path(args.output_dir) / "selection.json")
        record = next(item for item in selected["records"] if SELECT.key(item) == TRANSFER.row_key(row))
        self.assertEqual("ai", record["source"])
        self.assertEqual("relevant", record["decision"])
        self.assertEqual(0, selected["sourceCounts"]["human"])
        progress = PAGE.load_json(Path(args.output_dir) / "review-progress.json")
        human = next(item for item in progress["judgments"] if SELECT.key(item) == TRANSFER.row_key(row))
        self.assertEqual("irrelevant", human["decision"])
        self.assertEqual("conversation", human["provenance"]["kind"])
        self.assertEqual(RUNNER.file_hash(args.conversation_judgments), selected["conversationJudgmentsSha256"])


if __name__ == "__main__":
    unittest.main()
