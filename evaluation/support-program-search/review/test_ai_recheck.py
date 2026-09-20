import copy
import csv
import importlib.util
import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent

def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module

SUPPORT = load("recheck_support", "test_review_tools.py")
MODE = load("recheck_mode", "select-review-mode.py")
RUNNER = load("recheck_runner_test", "run-ai-review.py")
RECHECK = load("recheck_subject", "recheck-ai-review.py")
LABELS = load("recheck_labels", "apply-labels.py")

class RecheckTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name)
        self.scenario = SUPPORT.create_scenario(self.root); self.pool = SUPPORT.build_pool(self.scenario)
        self.fixture = MODE.PAGE.load_fixture(self.scenario.paths["fixture"])
        self.manifest = MODE.PAGE.load_json(self.pool.pool_manifest)
        self.rows = MODE.PAGE.load_verified_pool(self.pool.review_pool, self.manifest)
        self.policy = RUNNER.make_policy("synthetic-model")
        self.base = self.make_review("base-agent", ["relevant"] * 3 + ["irrelevant"] * 2)
        self.base_path = self.root / "base.json"; self.base_path.write_text(__import__("json").dumps(self.base, ensure_ascii=False))
        self.base_hash = hashlib.sha256(self.base_path.read_bytes()).hexdigest()

    def tearDown(self): self.tmp.cleanup()

    def make_review(self, agent_prefix, choices):
        docs = {d["id"]: d for d in self.fixture["docs"]}; votes = []
        for row in self.rows:
            pair = (row["query_id"], row["program_id"]); doc = docs[row["program_id"]]
            for judge, decision in zip(self.policy["judges"], choices):
                key = [*pair, judge["id"]]
                votes.append({"queryId": pair[0], "programId": pair[1], "contentHash": doc["contentHash"],
                    "judgeId": judge["id"], "decision": decision, "reason": "테스트 근거", "evidence": [doc["text"].splitlines()[0]],
                    "judgmentId": RUNNER.canonical_hash(key), "agentId": f"/{agent_prefix}-{judge['id']}",
                    "model": self.policy["model"], "usage": None,
                    "requestSha256": RUNNER.canonical_hash(RUNNER.build_request(self.policy, row, doc, self.fixture["referenceDate"], judge))})
        return {"schemaVersion": RUNNER.SCHEMA, "executionKind": "codex-subagent",
            "identity": MODE.PAGE.review_identity(self.manifest), "catalogFingerprint": self.manifest["catalogFingerprint"],
            "fixtureSha256": MODE.file_hash(self.scenario.paths["fixture"]), "policy": self.policy,
            "policySha256": RUNNER.canonical_hash(self.policy), "judgments": votes, "pendingCount": 0, "status": "complete"}

    def recheck(self):
        targets = MODE.ai_consensus(self.rows, self.base, self.base_hash)
        pairs = sorted(pair for pair, item in targets.items() if item["source"] == "unresolved")
        rows = [r for r in self.rows if (r["query_id"], r["program_id"]) in set(pairs)]
        fresh = self.make_review("fresh-agent", ["relevant"] * 5)
        votes = [v for v in fresh["judgments"] if (v["queryId"], v["programId"]) in set(pairs)]
        assignments = {f"judge-{i}": f"/fresh-agent-judge-{i}" for i in range(1, 6)}
        _, blind = RECHECK.derive_targets(self.base, self.base_hash, self.fixture, self.rows)
        return {"schemaVersion": RECHECK.SCHEMA, "baseAiReviewSha256": self.base_hash,
            "identity": self.base["identity"], "fixtureSha256": self.base["fixtureSha256"], "policy": self.policy,
            "policySha256": RUNNER.canonical_hash(self.policy), "inputSha256": RUNNER.canonical_hash(blind),
            "targetPairs": [{"queryId": q, "programId": p} for q, p in pairs], "assignments": assignments,
            "judgments": votes, "pendingCount": 0, "status": "complete", "roundLimit": 1}, self.rows

    def write_collect_inputs(self, mutate_blind=None, assignments=None, decision="unclear"):
        prep = self.root / f"prepared-{len(list(self.root.glob('prepared-*')))}"; prep.mkdir()
        pairs, blind = RECHECK.derive_targets(self.base, self.base_hash, self.fixture, self.rows)
        if mutate_blind:
            blind = mutate_blind(blind)
        policy = self.policy
        prepared = {"schemaVersion": RECHECK.PREPARED_SCHEMA, "baseAiReviewSha256": self.base_hash,
            "identity": self.base["identity"], "fixtureSha256": self.base["fixtureSha256"],
            "policySha256": self.base["policySha256"], "inputSha256": RUNNER.canonical_hash(blind),
            "targetPairs": pairs, "pairCount": len(pairs), "judgmentCount": 5 * len(pairs), "roundLimit": 1}
        (prep / "prepared.json").write_text(json.dumps(prepared, ensure_ascii=False))
        (prep / "policy.json").write_text(json.dumps(policy, ensure_ascii=False))
        (prep / "blind-input.jsonl").write_text("".join(json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n" for item in blind))
        assignments = assignments or {f"judge-{i}": f"/fresh-agent-judge-{i}" for i in range(1, 6)}
        assignment_path = self.root / "assignments.json"; assignment_path.write_text(json.dumps(assignments))
        docs = {d["id"]: d for d in self.fixture["docs"]}; rowmap = {(r["query_id"], r["program_id"]): r for r in self.rows}
        files = []
        for judge_id, agent in assignments.items():
            lines = [{"schemaVersion": "support-program-codex-judge-v1", "judgeId": judge_id, "agentId": agent,
                "model": policy["model"], "inputSha256": prepared["inputSha256"], "policySha256": prepared["policySha256"]}]
            for pair in [(p["queryId"], p["programId"]) for p in pairs]:
                doc = docs[pair[1]]
                lines.append({"queryId": pair[0], "programId": pair[1], "decision": decision,
                              "reason": "추가 확인 필요", "evidence": [doc["text"].splitlines()[0]] if decision != "unclear" else []})
            path = self.root / f"{judge_id}.jsonl"; path.write_text("\n".join(json.dumps(x, ensure_ascii=False) for x in lines) + "\n"); files.append(str(path))
        args = type("Args", (), {"fixture": self.scenario.paths["fixture"], "query_set": self.scenario.paths["query_set"],
            "review_pool": self.pool.review_pool, "pool_manifest": self.pool.pool_manifest, "base_ai_review": str(self.base_path),
            "prepared_dir": str(prep), "assignments": str(assignment_path), "judge_file": files,
            "output": str(self.root / "recheck.json")})()
        return args

    def make_mixed_base(self):
        """Make one already-resolved pair plus unresolved pairs in the original review."""
        base = self.make_review("base-agent", ["relevant"] * 3 + ["irrelevant"] * 2)
        first = (self.rows[0]["query_id"], self.rows[0]["program_id"])
        for vote in base["judgments"]:
            if (vote["queryId"], vote["programId"]) == first:
                vote["decision"] = "relevant"
        self.base = base
        self.base_path.write_text(json.dumps(base, ensure_ascii=False))
        self.base_hash = hashlib.sha256(self.base_path.read_bytes()).hexdigest()

    def run_selector(self, ai_recheck_path):
        output_dir = self.root / "selection"
        args = SimpleNamespace(
            fixture=self.scenario.paths["fixture"], query_set=self.scenario.paths["query_set"],
            review_pool=self.pool.review_pool, pool_manifest=self.pool.pool_manifest,
            output_dir=str(output_dir), mode="ai-only", ai_review=str(self.base_path),
            ai_recheck=str(ai_recheck_path), human_review=None, conversation_judgments=None,
        )
        original = MODE.parse_args
        MODE.parse_args = lambda: args
        try:
            MODE.main()
        finally:
            MODE.parse_args = original
        return output_dir

    def test_collect_happy_path_and_blind_source_tamper(self):
        args = self.write_collect_inputs(); result = RECHECK.collect(args)
        self.assertEqual(result["status"], "complete")
        bad = self.write_collect_inputs(mutate_blind=lambda blind: [{**blind[0], "announcement": "변조"}] + blind[1:])
        bad.output = str(self.root / "tampered.json")
        # Recompute prepared input hash does not make a changed fixed source acceptable.
        self.assertRaises(ValueError, RECHECK.collect, bad)

    def test_collect_rejects_old_agent_and_incomplete_judges(self):
        old = {f"judge-{i}": f"/base-agent-judge-{i}" for i in range(1, 6)}
        self.assertRaises(ValueError, RECHECK.collect, self.write_collect_inputs(assignments=old))
        args = self.write_collect_inputs(); args.judge_file = args.judge_file[:-1]
        self.assertRaises(ValueError, RECHECK.collect, args)

    def test_complete_recheck_replaces_only_unresolved_consensus(self):
        result, rows = self.recheck()
        RECHECK.validate_recheck(result, self.base, self.base_hash, self.fixture, self.manifest, rows)
        merged = MODE.ai_consensus(self.rows, self.base, self.base_hash, result, "a" * 64)
        self.assertTrue(all(item["source"] == "ai" for item in merged.values()))

    def test_rejects_target_scope_changes_and_bad_quote(self):
        result, rows = self.recheck()
        bad = copy.deepcopy(result); bad["targetPairs"].append({"queryId": "UNKNOWN", "programId": "UNKNOWN"})
        with self.assertRaises(ValueError): RECHECK.validate_recheck(bad, self.base, self.base_hash, self.fixture, self.manifest, rows)
        bad = copy.deepcopy(result); bad["judgments"][0]["evidence"] = ["not in announcement"]
        with self.assertRaises(ValueError): RECHECK.validate_recheck(bad, self.base, self.base_hash, self.fixture, self.manifest, rows)

    def test_rejects_agent_vote_policy_and_provenance_tampering(self):
        result, rows = self.recheck()
        cases = []
        bad = copy.deepcopy(result); bad["assignments"]["judge-5"] = bad["assignments"]["judge-4"]; cases.append(bad)
        bad = copy.deepcopy(result); bad["judgments"].pop(); bad["pendingCount"] = 0; cases.append(bad)
        bad = copy.deepcopy(result); bad["judgments"].append(copy.deepcopy(bad["judgments"][0])); cases.append(bad)
        bad = copy.deepcopy(result); bad["policy"]["model"] = "changed"; cases.append(bad)
        bad = copy.deepcopy(result); bad["targetPairs"] = bad["targetPairs"][:-1]; cases.append(bad)
        for tampered in cases:
            with self.subTest():
                with self.assertRaises(ValueError):
                    RECHECK.validate_recheck(tampered, self.base, self.base_hash, self.fixture, self.manifest, rows)

    def test_unclear_recheck_remains_unresolved(self):
        result, rows = self.recheck()
        for vote in result["judgments"]:
            vote["decision"] = "unclear"
            vote["evidence"] = []
        merged = MODE.ai_consensus(self.rows, self.base, self.base_hash, result, "a" * 64)
        self.assertTrue(all(item["source"] == "unresolved" and item["decision"] == "unclear" for item in merged.values()))

    def test_selector_v2_records_recheck_hash_and_target_pairs(self):
        result, _ = self.recheck()
        selection, _, _ = MODE.compose_selection(
            "ai-only", self.rows, self.manifest, ai_review=self.base, ai_recheck=result,
            ai_review_sha256=self.base_hash, ai_recheck_sha256="b" * 64)
        self.assertEqual(selection["schemaVersion"], MODE.SCHEMA_RECHECK)
        self.assertEqual(selection["aiRecheckSha256"], "b" * 64)
        self.assertEqual(len(selection["aiRecheckTargetPairs"]), len(result["targetPairs"]))
        for record in selection["records"]:
            self.assertEqual(record["provenance"].get("recheckSha256"), "b" * 64)

    def test_mixed_resolved_and_unresolved_recheck_end_to_end_preserves_provenance(self):
        self.make_mixed_base()
        args = self.write_collect_inputs(decision="relevant")
        result = RECHECK.collect(args)
        recheck_path = Path(args.output)
        selection_dir = self.run_selector(recheck_path)
        selection = json.loads((selection_dir / "selection.json").read_text())
        rows = list(csv.DictReader(io.StringIO((selection_dir / "reviewed.csv").read_text(encoding="utf-8-sig"))))
        self.assertEqual(selection["status"], "ready")
        target_pairs = {MODE.key(item) for item in result["targetPairs"]}
        for row, record in zip(rows, selection["records"]):
            pair = MODE.key(record)
            self.assertEqual(record["source"], "ai")
            if pair in target_pairs:
                self.assertEqual(record["provenance"].get("recheckSha256"), hashlib.sha256(recheck_path.read_bytes()).hexdigest())
            else:
                self.assertNotIn("recheckSha256", record["provenance"])
        output = self.root / "labeled.json"
        label_args = SimpleNamespace(
            fixture=self.scenario.paths["fixture"], query_set=self.scenario.paths["query_set"],
            config=self.scenario.paths["config"], capture=self.scenario.paths["capture"],
            pool_manifest=self.pool.pool_manifest, review_pool=str(selection_dir / "reviewed.csv"),
            selection=str(selection_dir / "selection.json"), exclude_query=[], output=str(output),
        )
        original = LABELS.parse_args
        LABELS.parse_args = lambda: label_args
        try:
            LABELS.main()
        finally:
            LABELS.parse_args = original
        labeled = json.loads(output.read_text())
        self.assertEqual(len(labeled["cases"]), len(self.manifest["perQueryCounts"]))
        self.assertEqual(labeled["labelReview"]["sourceHashes"]["aiRecheckSha256"],
                         hashlib.sha256(recheck_path.read_bytes()).hexdigest())
        original = MODE.ai_consensus(self.rows, self.base, self.base_hash)
        for record in selection["records"]:
            if MODE.key(record) not in target_pairs:
                self.assertEqual(record, original[MODE.key(record)])

    def test_recheck_rejects_resolved_pair_added_to_mixed_targets(self):
        self.make_mixed_base()
        result, rows = self.recheck()
        resolved_pair = {"queryId": self.rows[0]["query_id"], "programId": self.rows[0]["program_id"]}
        result["targetPairs"].append(resolved_pair)
        with self.assertRaises(ValueError):
            RECHECK.validate_recheck(result, self.base, self.base_hash, self.fixture, self.manifest, rows)

    def test_selection_v2_rejects_target_scope_and_recheck_provenance_tampering(self):
        self.make_mixed_base()
        result, rows = self.recheck()
        selection, csv_bytes, _ = MODE.compose_selection(
            "ai-only", self.rows, self.manifest, ai_review=self.base, ai_recheck=result,
            ai_review_sha256=self.base_hash, ai_recheck_sha256="b" * 64,
        )
        output_rows = list(csv.DictReader(io.StringIO(csv_bytes.decode("utf-8-sig"))))
        target = {(item["queryId"], item["programId"]) for item in selection["aiRecheckTargetPairs"]}
        cases = []
        bad = copy.deepcopy(selection); bad["aiRecheckTargetPairs"] = bad["aiRecheckTargetPairs"][:-1]; cases.append(bad)
        bad = copy.deepcopy(selection); bad["aiRecheckTargetPairs"].append(copy.deepcopy(bad["aiRecheckTargetPairs"][0])); cases.append(bad)
        bad = copy.deepcopy(selection); bad["aiRecheckTargetPairs"][0] = {"queryId": "UNKNOWN", "programId": "UNKNOWN"}; cases.append(bad)
        bad = copy.deepcopy(selection); bad["aiRecheckSha256"] = "c" * 64; cases.append(bad)
        for bad in cases:
            with self.assertRaises(ValueError):
                MODE.validate_selection(bad, output_rows, self.manifest)
        target_record = next(item for item in selection["records"] if MODE.key(item) in target)
        bad = copy.deepcopy(selection); next(item for item in bad["records"] if MODE.key(item) == MODE.key(target_record))["provenance"].pop("recheckSha256")
        with self.assertRaises(ValueError):
            MODE.validate_selection(bad, output_rows, self.manifest)
        untouched = next(item for item in selection["records"] if MODE.key(item) not in target)
        bad = copy.deepcopy(selection); next(item for item in bad["records"] if MODE.key(item) == MODE.key(untouched))["provenance"]["recheckSha256"] = "b" * 64
        with self.assertRaises(ValueError):
            MODE.validate_selection(bad, output_rows, self.manifest)

    def test_three_two_recheck_vote_stays_unresolved(self):
        self.make_mixed_base()
        result, rows = self.recheck()
        for index, vote in enumerate(result["judgments"]):
            vote["decision"] = "relevant" if index % 5 < 3 else "irrelevant"
        selection, _, _ = MODE.compose_selection(
            "ai-only", self.rows, self.manifest, ai_review=self.base, ai_recheck=result,
            ai_review_sha256=self.base_hash, ai_recheck_sha256="b" * 64,
        )
        targets = {MODE.key(pair) for pair in result["targetPairs"]}
        for record in selection["records"]:
            if MODE.key(record) in targets:
                self.assertEqual((record["source"], record["decision"]), ("unresolved", "unclear"))

    def test_boolean_round_limit_and_pending_count_are_rejected(self):
        result, rows = self.recheck()
        for field in ("roundLimit", "pendingCount"):
            bad = copy.deepcopy(result)
            bad[field] = True if field == "roundLimit" else False
            with self.assertRaises(ValueError):
                RECHECK.validate_recheck(bad, self.base, self.base_hash, self.fixture, self.manifest, rows)

if __name__ == "__main__": unittest.main()
