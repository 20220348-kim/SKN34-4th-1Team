import json
import io
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

import gate
import publish

SHA, TREE, POLICY = "a" * 40, "b" * 40, "c" * 40
DIGEST = "sha256:" + "d" * 64
KEY = "e" * 64
URI = "ghcr.io/govbiz-team/govbiz-ai-service"
REAL_RUN = subprocess.run


def run_record(filename="ci.yml", **changes):
    return {"id": 10, "run_attempt": 1, "head_sha": SHA, "head_branch": "develop",
            "event": "push", "status": "completed", "conclusion": "success",
            "path": ".github/workflows/" + filename,
            "head_repository": {"full_name": gate.REPOSITORY}, **changes}


class ReleaseGateTests(unittest.TestCase):
    def event(self, **changes):
        return {"repository": {"full_name": gate.REPOSITORY}, "workflow_run": run_record(**changes)}

    def responses(self, changed=None):
        def get(path):
            if "/git/ref/" in path:
                return {"object": {"sha": SHA}}
            filename = path.split("/workflows/")[1].split("/")[0]
            return {"workflow_runs": changed if changed is not None else [run_record(filename)]}
        return get

    def test_only_own_develop_push_success_can_trigger(self):
        self.assertEqual(gate.candidate("workflow_run", self.event(), "", ""), SHA)
        for change in ({"event": "pull_request"}, {"head_branch": "main"},
                       {"head_repository": {"full_name": "fork/GovBiz"}},
                       {"status": "in_progress"}, {"conclusion": "failure"},
                       {"head_sha": "develop;echo bad"}):
            with self.subTest(change=change):
                self.assertIsNone(gate.candidate("workflow_run", self.event(**change), "", ""))
        event = self.event()
        event["repository"]["full_name"] = "fork/GovBiz"
        self.assertIsNone(gate.candidate("workflow_run", event, "", ""))

    def test_manual_dispatch_requires_develop_and_full_sha(self):
        self.assertEqual(gate.candidate("workflow_dispatch", self.event(), "refs/heads/develop", SHA), SHA)
        self.assertIsNone(gate.candidate("workflow_dispatch", self.event(), "refs/heads/topic", SHA))
        self.assertIsNone(gate.candidate("push", self.event(), "refs/heads/develop", SHA))

    def test_all_three_exact_workflows_required(self):
        self.assertTrue(gate.eligible(SHA, self.responses()))
        self.assertFalse(gate.eligible(SHA, self.responses([])))
        self.assertFalse(gate.eligible(SHA, self.responses([run_record(path=".github/workflows/fake.yml")])))

    def test_new_failed_or_pending_run_overrides_old_success(self):
        for changes in ({"id": 11, "conclusion": "failure"},
                        {"id": 11, "status": "in_progress", "conclusion": None},
                        {"run_attempt": 2, "conclusion": "failure"}):
            self.assertFalse(gate.eligible(SHA, self.responses([run_record(), run_record(**changes)])))

    def test_superseded_sha_is_rejected_before_workflow_queries(self):
        queries = []
        def get(path):
            queries.append(path)
            return {"object": {"sha": TREE}}
        self.assertFalse(gate.eligible(SHA, get))
        self.assertEqual(len(queries), 1)

    def test_api_failures_are_not_hidden(self):
        with self.assertRaises(subprocess.CalledProcessError):
            gate.eligible(SHA, lambda _: (_ for _ in ()).throw(subprocess.CalledProcessError(1, "gh")))


class PublicationTests(unittest.TestCase):
    def config(self, **changes):
        return {"os": "linux", "architecture": "amd64", "config": {"Labels": {
            "ai.govbiz.input-key": KEY, "org.opencontainers.image.source": publish.SOURCE}}, **changes}

    def test_fixed_repository_and_invalid_service(self):
        self.assertEqual(publish.repository("ai-service"), URI)
        with self.assertRaises(ValueError):
            publish.repository("../other")

    def test_input_key_tracks_service_and_build_policy(self):
        self.assertEqual(publish.input_key(TREE, POLICY), publish.input_key(TREE, POLICY))
        self.assertNotEqual(publish.input_key(TREE, POLICY), publish.input_key(SHA, POLICY))
        self.assertNotEqual(publish.input_key(TREE, POLICY), publish.input_key(TREE, SHA))
        with self.assertRaises(ValueError):
            publish.input_key("bad", POLICY)

    def test_new_package_and_permission_failure_are_distinct(self):
        for status in (401, 403, 429, 500):
            with patch.object(publish, "urlopen", side_effect=HTTPError("https://api.github.com", status, "fixture", {}, None)), \
                    self.assertRaises(RuntimeError):
                publish.package_exists("ai-service", "fixture-token")
        with patch.object(publish, "urlopen", side_effect=HTTPError("https://api.github.com", 404, "fixture", {}, None)):
            self.assertFalse(publish.package_exists("ai-service", "fixture-token"))

    def test_existing_package_must_belong_to_this_repository(self):
        for repo, accepted in (("GovBiz-Team/GovBiz", True), ("another/repo", False)):
            stream = io.BytesIO(json.dumps({"repository": {"full_name": repo}}).encode())
            with patch.object(publish, "urlopen", return_value=stream):
                if accepted:
                    self.assertTrue(publish.package_exists("ai-service", "fixture-token"))
                else:
                    with self.assertRaises(ValueError):
                        publish.package_exists("ai-service", "fixture-token")

    def test_only_explicit_manifest_not_found_is_missing(self):
        for error in ("unauthorized", "403 Forbidden", "429 Too Many Requests", "network timeout",
                      "ERROR: another/image:src-test: not found"):
            result = subprocess.CompletedProcess([], 1, "", error)
            with patch.object(publish.subprocess, "run", return_value=result), self.assertRaises(RuntimeError):
                publish.lookup(URI, "src-test", KEY, {})
        result = subprocess.CompletedProcess([], 1, "", f"ERROR: {URI}:src-test: not found\n")
        with patch.object(publish.subprocess, "run", return_value=result):
            self.assertIsNone(publish.lookup(URI, "src-test", KEY, {}))

    def test_lookup_verifies_metadata_at_the_digest_not_mutable_tag(self):
        manifest = subprocess.CompletedProcess([], 0, json.dumps({"digest": DIGEST}), "")
        with patch.object(publish.subprocess, "run", return_value=manifest), \
                patch.object(publish, "run", return_value=subprocess.CompletedProcess([], 0, json.dumps(self.config()))) as run:
            self.assertEqual(publish.lookup(URI, "src-test", KEY, {}), DIGEST)
            self.assertIn(URI + "@" + DIGEST, run.call_args.args)

    def test_conflicting_image_is_not_reused_or_overwritten(self):
        manifest = subprocess.CompletedProcess([], 0, json.dumps({"digest": DIGEST}), "")
        for config in (self.config(architecture="arm64"), self.config(config={"Labels": {}})):
            with patch.object(publish.subprocess, "run", return_value=manifest), \
                    patch.object(publish, "run", return_value=subprocess.CompletedProcess([], 0, json.dumps(config))), \
                    self.assertRaises(ValueError):
                publish.lookup(URI, "src-test", KEY, {})

    def test_reuse_never_builds_or_pushes_and_token_only_on_stdin(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(publish, "git", side_effect=[SHA, TREE, POLICY]), \
                patch.object(publish, "eligible", return_value=True), \
                patch.object(publish, "package_exists", return_value=True), \
                patch.object(publish, "lookup", return_value=DIGEST), \
                patch.object(publish, "run") as command, \
                patch.object(publish.subprocess, "run") as logout:
            output = Path(directory) / "receipt.json"
            publish.publish("ai-service", SHA, output, "fixture-actor", "fixture-token")
            self.assertEqual(json.loads(output.read_text())["digest"], DIGEST)
            self.assertEqual(command.call_count, 1)
            self.assertEqual(command.call_args.args[:2], ("docker", "login"))
            self.assertNotIn("fixture-token", command.call_args.args)
            self.assertEqual(command.call_args.kwargs["input"], "fixture-token")
            logout.assert_called_once()

    def test_superseded_candidate_leaves_no_receipt(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(publish, "git", side_effect=[SHA, TREE, POLICY]), \
                patch.object(publish, "eligible", side_effect=[True, False]), \
                patch.object(publish, "package_exists", return_value=True), \
                patch.object(publish, "lookup", return_value=DIGEST), \
                patch.object(publish, "run"), patch.object(publish.subprocess, "run"):
            output = Path(directory) / "receipt.json"
            with self.assertRaises(ValueError):
                publish.publish("ai-service", SHA, output, "actor", "fixture-token")
            self.assertFalse(output.exists())

    def test_real_git_archive_excludes_untracked_secrets_even_on_failed_push(self):
        for fail_push in (False, True):
            with self.subTest(fail_push=fail_push), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                context = root / "backend/ai-service"
                context.mkdir(parents=True)
                (root / "infrastructure/release").mkdir(parents=True)
                (root / "infrastructure/release/policy").write_text("fixture")
                (context / "Dockerfile").write_text("FROM scratch\n")
                def git(*args):
                    return REAL_RUN(["git", *args], cwd=root, check=True, capture_output=True, text=True).stdout.strip()
                git("init")
                git("add", ".")
                git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                    "-c", "commit.gpgsign=false", "commit", "-m", "fixture")
                sha = git("rev-parse", "HEAD")
                (context / ".env").write_text("SECRET=fixture-never-archive")
                (context / "untracked.py").write_text("private fixture")
                commands = []
                def command(*args, **kwargs):
                    commands.append(args)
                    if args[0] == "git":
                        return REAL_RUN(args, check=True, text=True, **kwargs)
                    if args[:2] == ("docker", "build"):
                        built_context = Path(args[-1])
                        self.assertEqual(sorted(p.name for p in built_context.iterdir()), ["Dockerfile"])
                    if args[:2] == ("docker", "push") and fail_push:
                        raise subprocess.CalledProcessError(1, args)
                    return subprocess.CompletedProcess(args, 0, "")
                with patch.object(publish, "ROOT", root), patch.object(publish, "git", side_effect=git), \
                        patch.object(publish, "eligible", return_value=True), \
                        patch.object(publish, "package_exists", return_value=True), \
                        patch.object(publish, "lookup", side_effect=[None, DIGEST]), \
                        patch.object(publish, "run", side_effect=command), \
                        patch.object(publish.subprocess, "run") as logout:
                    output = root / "receipt.json"
                    if fail_push:
                        with self.assertRaises(subprocess.CalledProcessError):
                            publish.publish("ai-service", sha, output, "actor", "fixture-token")
                        self.assertFalse(output.exists())
                    else:
                        publish.publish("ai-service", sha, output, "actor", "fixture-token")
                        self.assertTrue(output.exists())
                    logout.assert_called_once()
                    self.assertTrue(any(c[:2] == ("docker", "push") for c in commands))

    def test_workflow_is_opt_in_and_has_no_aws_cluster_or_repo_write(self):
        source = (publish.ROOT / ".github/workflows/msa-images.yml").read_text()
        self.assertIn("vars.MSA_RELEASE_ENABLED == 'true'", source)
        self.assertIn("packages: write", source)
        for forbidden in ("contents: write", "kubectl", "send-command", "pull_request_target", "aws-actions/"):
            self.assertNotIn(forbidden, source)

    def test_integrated_copy_keeps_external_writes_migration_locked(self):
        for filename, variable in (("msa-images.yml", "MSA_RELEASE_ENABLED"),
                                   ("msa-promotion.yml", "MSA_PROMOTION_ENABLED")):
            source = (publish.ROOT / ".github/workflows" / filename).read_text()
            with self.subTest(workflow=filename):
                self.assertIn("workflow_dispatch:", source)
                self.assertIn("if: ${{ false && vars." + variable + " == 'true' }}", source)
                self.assertNotIn("  workflow_run:", source)
                self.assertNotIn("  schedule:", source)

    def test_gitops_ci_is_discovered_at_repository_root(self):
        source = (publish.ROOT / ".github/workflows/infra-ci.yml").read_text()
        self.assertIn("working-directory: infrastructure/gitops", source)
        self.assertIn("cache-dependency-path: infrastructure/gitops/scripts/requirements.txt", source)
        self.assertFalse((publish.ROOT / "infrastructure/gitops/.github/workflows/ci.yml").exists())


if __name__ == "__main__":
    unittest.main()
