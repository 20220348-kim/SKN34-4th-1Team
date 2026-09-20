import contextlib
import copy
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path

def load(name, file):
    s=importlib.util.spec_from_file_location(name, Path(__file__).with_name(file)); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
AI=load("runner_under_test","run-ai-review.py")
SUPPORT=load("runner_support","test_review_tools.py")

class RunnerTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.root=Path(self.tmp.name)
        self.sc=SUPPORT.create_scenario(self.root); self.pool=SUPPORT.build_pool(self.sc)
        self.fixture=AI.PAGE.load_fixture(self.sc.paths["fixture"]); self.manifest=AI.PAGE.load_json(self.pool.pool_manifest)
        self.rows=SUPPORT.read_rows(self.pool.review_pool)
        self.prep=self.root/"prepared"
        self.base=["--fixture",self.sc.paths["fixture"],"--query-set",self.sc.paths["query_set"],"--review-pool",self.pool.review_pool,"--pool-manifest",self.pool.pool_manifest,"--model","synthetic-model"]
    def tearDown(self): self.tmp.cleanup()
    def run_prepare(self):
        import sys
        old=sys.argv; sys.argv=["run", "prepare", *self.base, "--output-dir",str(self.prep)]
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                AI.main()
        finally: sys.argv=old
    def make_judges(self, count=5):
        prepared=json.loads((self.prep/"prepared.json").read_text()); blind=[json.loads(x) for x in (self.prep/"blind-input.jsonl").read_text().splitlines()]
        assignments={f"judge-{i}":f"task-{i}" for i in range(1,6)}; (self.root/"assignments.json").write_text(json.dumps(assignments))
        paths=[]
        for i in range(1,count+1):
            lines=[{"schemaVersion":"support-program-codex-judge-v1","judgeId":f"judge-{i}","agentId":f"task-{i}","model":"synthetic-model","inputSha256":prepared["inputSha256"],"policySha256":prepared["policySha256"]}]
            for item in blind: lines.append({"queryId":item["queryId"],"programId":item["programId"],"decision":"irrelevant","reason":"테스트 판정","evidence":[item["announcement"].splitlines()[0]]})
            path=self.root/f"judge-{i}.jsonl"; path.write_text("".join(json.dumps(x,ensure_ascii=False)+"\n" for x in lines)); paths.append(path)
        return paths
    def collect(self, paths, output=None):
        import sys
        old=sys.argv; argv=["run","collect",*self.base,"--prepared-dir",str(self.prep),"--assignments",str(self.root/"assignments.json"),"--output",str(output or self.root/"result.json")]
        for p in paths: argv += ["--judge-file",str(p)]
        sys.argv=argv
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                AI.main()
        finally: sys.argv=old
    def test_prepare_is_blind_and_no_clobber(self):
        self.run_prepare(); self.assertEqual(set(p.name for p in self.prep.iterdir()),{"prepared.json","policy.json","blind-input.jsonl"})
        for line in (self.prep/"blind-input.jsonl").read_text().splitlines(): self.assertNotRegex(line,r"decision|reviewer|ranking|source|split")
        with self.assertRaises(FileExistsError): self.run_prepare()
    def test_collect_complete_and_schema(self):
        self.run_prepare(); self.collect(self.make_judges()); result=json.loads((self.root/"result.json").read_text()); self.assertEqual(result["status"],"complete"); self.assertEqual(result["pendingCount"],0); AI.validate_ai_review(result,self.fixture,self.manifest,self.rows)
    def test_partial_collect_is_incomplete(self):
        self.run_prepare(); self.collect(self.make_judges(2)); result=json.loads((self.root/"result.json").read_text()); self.assertEqual(result["status"],"incomplete"); self.assertEqual(result["pendingCount"],len(self.rows)*3)
    def test_agent_identity_must_be_distinct(self):
        self.run_prepare(); paths=self.make_judges(); text=paths[1].read_text().replace('"agentId": "task-2"','"agentId": "task-1"'); paths[1].write_text(text)
        with self.assertRaises(ValueError): self.collect(paths)
    def test_evidence_must_be_exact_and_decisive(self):
        doc=self.fixture["docs"][0]
        with self.assertRaises(ValueError): AI.validate_decision({"decision":"relevant","reason":"x","evidence":[]},doc)
        with self.assertRaises(ValueError): AI.validate_decision({"decision":"relevant","reason":"x","evidence":["not in source"]},doc)
    def test_policy_and_judgment_hashes_are_stable(self):
        policy=AI.make_policy("synthetic-model"); self.assertEqual(policy["schemaVersion"],"support-program-ai-judge-policy-v2"); self.assertNotIn("maxOutputTokens",policy)
        row=self.rows[0]; doc=next(x for x in self.fixture["docs"] if x["id"]==row["program_id"]); a=AI.build_request(policy,row,doc,self.fixture["referenceDate"],policy["judges"][0]); b=AI.build_request(policy,row,doc,self.fixture["referenceDate"],policy["judges"][1]); self.assertNotEqual(AI.canonical_hash(a),AI.canonical_hash(b))
    def test_truncated_judge_file_rejected(self):
        self.run_prepare(); paths=self.make_judges(1); paths[0].write_bytes(paths[0].read_bytes().rstrip(b"\n"));
        with self.assertRaises(ValueError): self.collect(paths)

    def test_prepared_source_tampering_is_rejected(self):
        self.run_prepare()
        paths = self.make_judges()
        blind_path = self.prep / "blind-input.jsonl"
        original = blind_path.read_text()
        changed = original.replace("알파", "변조", 1)
        blind_path.write_text(changed)
        with self.assertRaisesRegex(ValueError, "blind input"):
            self.collect(paths)
        self.assertFalse((self.root / "result.json").exists())

    def test_changed_model_or_policy_hash_is_rejected(self):
        self.run_prepare()
        paths = self.make_judges()
        policy_path = self.prep / "policy.json"
        policy = json.loads(policy_path.read_text())
        policy["model"] = "changed-model"
        policy_path.write_text(json.dumps(policy))
        with self.assertRaisesRegex(ValueError, "Model differs"):
            self.collect(paths)

    def test_unknown_duplicate_pairs_and_judge_files_are_rejected(self):
        self.run_prepare()
        paths = self.make_judges(1)
        original = paths[0].read_text()
        lines = original.splitlines()
        paths[0].write_text(original + lines[1] + "\n")
        with self.assertRaisesRegex(ValueError, "Duplicate pair"):
            self.collect(paths)
        paths[0].write_text(original.replace('"queryId": "Q01"', '"queryId": "UNKNOWN"', 1))
        with self.assertRaisesRegex(ValueError, "Unknown pair"):
            self.collect(paths)
        paths[0].write_text(original)
        with self.assertRaisesRegex(ValueError, "duplicate judge"):
            self.collect(paths + paths)

    def test_collected_output_never_overwrites_existing_file(self):
        self.run_prepare()
        paths = self.make_judges()
        output = self.root / "result.json"
        output.write_text("preserve previous judgments")
        with self.assertRaises(FileExistsError):
            self.collect(paths)
        self.assertEqual(output.read_text(), "preserve previous judgments")

    def test_ai_metadata_rejects_fabricated_usage_and_boolean_count(self):
        self.run_prepare()
        self.collect(self.make_judges())
        original = json.loads((self.root / "result.json").read_text())
        for field, value in (("usage", {"totalTokens": 0}), ("judgmentId", "0" * 64),
                             ("requestSha256", "0" * 64), ("contentHash", "0" * 64)):
            result = copy.deepcopy(original)
            result["judgments"][0][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                AI.validate_ai_review(result, self.fixture, self.manifest, self.rows)
        result = copy.deepcopy(original)
        result["pendingCount"] = False
        with self.assertRaises(ValueError):
            AI.validate_ai_review(result, self.fixture, self.manifest, self.rows)

    def test_all_assignments_must_be_distinct_even_for_partial_collection(self):
        self.run_prepare()
        paths = self.make_judges(1)
        path = self.root / "assignments.json"
        assignments = json.loads(path.read_text())
        assignments["judge-5"] = assignments["judge-4"]
        path.write_text(json.dumps(assignments))
        with self.assertRaisesRegex(ValueError, "five distinct"):
            self.collect(paths)

    def test_metadata_counts_and_duplicate_json_fields_are_rejected(self):
        self.run_prepare()
        paths = self.make_judges(1)
        path = self.prep / "prepared.json"
        prepared = json.loads(path.read_text())
        prepared["pairCount"] += 1
        path.write_text(json.dumps(prepared))
        with self.assertRaisesRegex(ValueError, "counts"):
            self.collect(paths)
        bad = self.root / "duplicate.jsonl"
        bad.write_text('{"decision":"relevant","decision":"irrelevant"}\n')
        with self.assertRaisesRegex(ValueError, "Malformed"):
            AI.read_jsonl(bad)

if __name__=="__main__": unittest.main()
