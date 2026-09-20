import hashlib
import importlib.util
import json
import shutil
import sys
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = Path(__file__).with_name("verify-shared-run.py")
RUN = ROOT / "runs" / "support-program-catalog-20260906-v1"


class SharedRunVerificationTest(unittest.TestCase):
    def run_cli(self, path, with_recheck=False, with_capture=False):
        command = [sys.executable, "-B", str(SCRIPT), "--run-dir", str(path)]
        if with_recheck:
            command.append("--with-recheck")
        if with_capture:
            command.append("--with-capture")
        return subprocess.run(
            command,
            capture_output=True, text=True, check=False,
        )

    def test_real_frozen_run_replays_all_modes_offline(self):
        result = self.run_cli(RUN)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        value = json.loads(result.stdout)
        self.assertEqual(value["status"], "ok")
        self.assertEqual(value["judgments"], 1605)
        self.assertFalse(value["actualSearchEvaluated"])
        self.assertEqual(set(value["modes"]), {"ai-only", "hybrid", "human"})

    def test_missing_source_fails_without_running_or_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self.run_cli(directory)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(json.loads(result.stdout)["status"], "failed")
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_changed_judge_source_fails_cleanly(self):
        with tempfile.TemporaryDirectory() as directory:
            copy = Path(directory) / RUN.name
            shutil.copytree(RUN, copy, ignore=shutil.ignore_patterns("outputs", "review.html", "web"))
            judge = copy / "review-v2" / "codex-ai-v1" / "judge-1.jsonl"
            judge.write_text(judge.read_text(encoding="utf-8") + "\n", encoding="utf-8")
            result = self.run_cli(copy)
            self.assertNotEqual(result.returncode, 0)
            failure = json.loads(result.stdout)
            self.assertEqual(failure["status"], "failed")
            self.assertIn("Malformed judge JSON", failure["error"])

    def copied_run(self, directory):
        copy = Path(directory) / RUN.name
        relative_files = [
            "fixture-unlabeled.json", "query-set.json", "pool-config.json",
            "review-v2/review-pool.csv", "review-v2/review-pool-provenance.csv",
            "review-v2/review-pool-manifest.json", "review-v2/conversation-judgments.json",
        ]
        for mode in ("ai", "hybrid", "human"):
            relative_files.extend(f"review-v2/selected-{mode}-v1/{name}"
                                  for name in ("selection.json", "reviewed.csv", "review-progress.json"))
        relative_files.extend(
            f"review-v2/codex-ai-v1/{name}" for name in (
                "ai-review.json", "prepared.json", "policy.json", "assignments.json",
                "blind-input.jsonl", *[f"judge-{number}.jsonl" for number in range(1, 6)]))
        for relative in relative_files:
            target = copy / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(RUN / relative, target)
        return copy

    def copied_recheck_run(self, directory):
        copy = self.copied_run(directory)
        recheck = RUN / "review-v2" / "codex-ai-recheck-v1"
        target = copy / "review-v2" / "codex-ai-recheck-v1"
        target.mkdir(parents=True, exist_ok=True)
        for name in ("prepared.json", "policy.json", "blind-input.jsonl", "assignments.json", "ai-recheck.json", "cause-audit.json", "review-plan.md"):
            shutil.copyfile(recheck / name, target / name)
        for number in range(1, 6):
            shutil.copyfile(recheck / f"judge-{number}.jsonl", target / f"judge-{number}.jsonl")
        for mode in ("ai", "hybrid"):
            source_dir = RUN / "review-v2" / f"selected-{mode}-recheck-v1"
            destination = copy / "review-v2" / f"selected-{mode}-recheck-v1"
            destination.mkdir(parents=True, exist_ok=True)
            for name in ("selection.json", "reviewed.csv", "review-progress.json"):
                shutil.copyfile(source_dir / name, destination / name)
        return copy

    def capture_verifier(self):
        spec = importlib.util.spec_from_file_location("shared_capture_test", SCRIPT)
        verifier = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(verifier)
        return verifier

    def copied_capture_run(self, directory):
        copy = self.copied_recheck_run(directory)
        for source in self.capture_verifier().capture_files(RUN):
            target = copy / source.relative_to(RUN)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        return copy

    def test_capture_requires_every_frozen_artifact_and_does_not_claim_completion(self):
        with tempfile.TemporaryDirectory() as directory:
            copy = self.copied_recheck_run(directory)
            result = self.run_cli(copy, with_capture=True)
            self.assertNotEqual(result.returncode, 0)
            value = json.loads(result.stdout)
            self.assertEqual(value["status"], "failed")
            self.assertIn("actual-capture-v3/capture.json", value["error"])
            self.assertIn("report-heldout.json", value["error"])
            self.assertNotIn("actualSearchEvaluated", value)

    def test_capture_replays_pool_judgments_labels_and_all_splits_offline_without_source_writes(self):
        verifier = self.capture_verifier()
        paths = verifier.capture_files(RUN)
        before = {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}
        with patch("socket.socket.connect", side_effect=AssertionError("Network use is forbidden")):
            value = verifier.verify_run(RUN, with_capture=True)
        self.assertEqual(value["status"], "ok")
        self.assertTrue(value["actualSearchEvaluated"])
        self.assertEqual(value["recheck"]["judgments"], 210)
        self.assertEqual(value["capture"]["observations"], 16)
        self.assertEqual(value["capture"]["reviewPairCount"], 570)
        self.assertEqual(value["capture"]["additionalJudgments"], 1245)
        self.assertEqual(value["capture"]["sourceCounts"]["human"], 0)
        self.assertEqual(value["capture"]["splits"], ["all", "dev", "heldout"])
        self.assertEqual(before, {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths})

    def test_capture_candidate_and_additional_judge_tampering_are_rejected(self):
        for kind in ("capture", "judge"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                copy = self.copied_capture_run(directory)
                if kind == "capture":
                    path = copy / "actual-capture-v3/capture.json"
                    value = json.loads(path.read_text(encoding="utf-8"))
                    value["observations"][0]["candidateIds"].pop()
                    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
                else:
                    path = copy / "review-final-v1/additional-ai-v1/judge-1.jsonl"
                    lines = path.read_text(encoding="utf-8").splitlines()
                    value = json.loads(lines[1])
                    value["reason"] += " 변조"
                    lines[1] = json.dumps(value, ensure_ascii=False)
                    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
                result = self.run_cli(copy, with_capture=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(json.loads(result.stdout)["status"], "failed")

    def test_capture_selection_and_metric_report_tampering_are_rejected(self):
        for kind in ("selection", "all", "dev", "heldout"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                copy = self.copied_capture_run(directory)
                if kind == "selection":
                    path = copy / "review-final-v1/selected-ai-transfer-v1/selection.json"
                    value = json.loads(path.read_text(encoding="utf-8"))
                    value["evaluableQueryCount"] += 1
                else:
                    path = copy / "review-final-v1" / f"report-{kind}.json"
                    value = json.loads(path.read_text(encoding="utf-8"))
                    value["capture"]["final"]["mrrAt5"] = "forged"
                path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
                result = self.run_cli(copy, with_capture=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(json.loads(result.stdout)["status"], "failed")

    def test_capture_missing_additional_judge_and_labeled_fixture_fail_cleanly(self):
        for relative in ("additional-ai-v1/judge-5.jsonl", "fixture-labeled.json"):
            with self.subTest(relative=relative), tempfile.TemporaryDirectory() as directory:
                copy = self.copied_capture_run(directory)
                (copy / "review-final-v1" / relative).unlink()
                result = self.run_cli(copy, with_capture=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(json.loads(result.stdout)["status"], "failed")

    def test_recheck_missing_artifact_fails_cleanly(self):
        with tempfile.TemporaryDirectory() as directory:
            copy = self.copied_recheck_run(directory)
            path = copy / "review-v2" / "codex-ai-recheck-v1" / "blind-input.jsonl"
            path.unlink()
            result = self.run_cli(copy, with_recheck=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(json.loads(result.stdout)["status"], "failed")

    def test_recheck_blind_input_tamper_fails_cleanly(self):
        with tempfile.TemporaryDirectory() as directory:
            copy = self.copied_recheck_run(directory)
            path = copy / "review-v2" / "codex-ai-recheck-v1" / "blind-input.jsonl"
            path.write_bytes(path.read_bytes() + b"\n")
            result = self.run_cli(copy, with_recheck=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(json.loads(result.stdout)["status"], "failed")

    def test_recheck_selected_v2_tamper_fails_cleanly(self):
        with tempfile.TemporaryDirectory() as directory:
            copy = self.copied_recheck_run(directory)
            path = copy / "review-v2" / "selected-ai-recheck-v1" / "selection.json"
            value = json.loads(path.read_text(encoding="utf-8"))
            value["evaluableQueryCount"] += 1
            path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
            result = self.run_cli(copy, with_recheck=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(json.loads(result.stdout)["status"], "failed")

    def test_recheck_cause_audit_rejects_unknown_judge_empty_quote_and_duplicate(self):
        cases = ("unknown", "empty", "duplicate")
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                copy = self.copied_recheck_run(directory)
                path = copy / "review-v2" / "codex-ai-recheck-v1" / "cause-audit.json"
                value = json.loads(path.read_text(encoding="utf-8"))
                if case == "unknown":
                    value["records"][0]["affectedJudgeIds"] = ["judge-unknown"]
                elif case == "empty":
                    value["records"][0]["evidence"] = [""]
                else:
                    value["records"].append(dict(value["records"][0]))
                path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
                result = self.run_cli(copy, with_recheck=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(json.loads(result.stdout)["status"], "failed")

    def test_recheck_success_summary_and_no_network(self):
        spec = importlib.util.spec_from_file_location("shared_recheck_network_test", SCRIPT)
        verifier = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(verifier)
        with patch("socket.socket.connect", side_effect=AssertionError("Network use is forbidden")):
            value = verifier.verify_run(RUN, with_recheck=True)
        self.assertEqual(value["status"], "ok")
        self.assertFalse(value["actualSearchEvaluated"])
        self.assertEqual(value["recheck"], {
            "judgments": 210,
            "modes": {"ai-only": "ready", "hybrid": "needs-human"},
            "sourceCounts": {"ai": 303, "human": 0, "unresolved": 18},
            "evaluableQueryCount": 8,
        })

    def test_config_and_provenance_tamper_fail_hash_validation(self):
        for relative in ("pool-config.json", "review-v2/review-pool-provenance.csv"):
            with self.subTest(relative=relative), tempfile.TemporaryDirectory() as directory:
                copy = self.copied_run(directory)
                path = copy / relative
                path.write_bytes(path.read_bytes() + b"\n")
                result = self.run_cli(copy)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(json.loads(result.stdout)["status"], "failed")

    def test_missing_or_changed_selection_artifact_fails_cleanly(self):
        for relative, suffix in (
            ("review-v2/selected-ai-v1/selection.json", ""),
            ("review-v2/selected-hybrid-v1/reviewed.csv", "tamper"),
        ):
            with self.subTest(relative=relative), tempfile.TemporaryDirectory() as directory:
                copy = self.copied_run(directory)
                path = copy / relative
                if suffix:
                    path.write_bytes(path.read_bytes() + suffix.encode())
                else:
                    path.unlink()
                result = self.run_cli(copy)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(json.loads(result.stdout)["status"], "failed")

    def test_success_does_not_modify_frozen_sources(self):
        def digest_tree(root):
            return {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
                    for path in root.rglob("*") if path.is_file()}
        before = digest_tree(RUN)
        result = self.run_cli(RUN)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(before, digest_tree(RUN))

    def test_recollection_line_endings_do_not_change_saved_reference(self):
        spec = importlib.util.spec_from_file_location("shared_run_newline_test", SCRIPT)
        verifier = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(verifier)
        original_collect = verifier.RUNNER.collect

        def collect_with_crlf(args):
            original_collect(args)
            output = Path(args.output)
            output.write_bytes(output.read_bytes().replace(b"\r\n", b"\n").replace(b"\n", b"\r\n"))

        with patch.object(verifier.RUNNER, "collect", side_effect=collect_with_crlf), \
                patch("socket.socket.connect", side_effect=AssertionError("Network use is forbidden")):
            result = verifier.verify_run(RUN)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["judgments"], 1605)

    def test_duplicate_json_keys_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            copy = self.copied_run(directory)
            path = copy / "review-v2" / "selected-ai-v1" / "selection.json"
            original = path.read_text(encoding="utf-8")
            changed = original.replace('"mode": "ai-only"', '"mode": "ai-only", "mode": "ai-only"', 1)
            self.assertNotEqual(original, changed)
            path.write_text(changed, encoding="utf-8")
            result = self.run_cli(copy)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(json.loads(result.stdout)["status"], "failed")


if __name__ == "__main__":
    unittest.main()
