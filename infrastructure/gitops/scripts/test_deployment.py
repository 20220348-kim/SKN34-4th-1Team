"""Offline admission tests: no GitHub writes, registry pulls or cluster access."""

import contextlib
import copy
import io
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import deployment as deploy
import deployment_candidate as bundle
import fork_cluster as cluster
import gate
import yaml
from check_msa import REPOSITORY_ROOT, SERVICES
from repository import Fork
from test_sync_images import SHA, ci_results

FORK = Fork("alice/project")
BASE = "b" * 40
CHECKS = [
    {"workflow": name, "runId": i + 100, "runAttempt": 1}
    for i, name in enumerate(gate.WORKFLOWS)
]


def rules(required):
    return [
        {"type": "deletion"},
        {"type": "non_fast_forward"},
        {
            "type": "pull_request",
            "parameters": {
                "required_approving_review_count": 1,
                "dismiss_stale_reviews_on_push": True,
                "require_last_push_approval": True,
                "required_review_thread_resolution": True,
            },
        },
        {
            "type": "required_status_checks",
            "parameters": {
                "strict_required_status_checks_policy": True,
                "required_status_checks": [{"context": name} for name in required],
            },
        },
    ]


class SourceFixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix="deployment-test-")
        cls.addClassCleanup(cls.directory.cleanup)
        cls.root = Path(cls.directory.name).resolve()
        bundle.git_bytes(cls.root, "init", "--quiet")
        cls.source = {}
        for directory in (bundle.CHART_PATH, bundle.PREFIX + "environments/portfolio"):
            for path in (REPOSITORY_ROOT / directory).rglob("*"):
                if path.is_file():
                    cls.source[path.relative_to(REPOSITORY_ROOT).as_posix()] = (
                        path.read_bytes()
                    )
        cls.source[bundle.CHECK_WORKFLOW] = b"name: trusted fixture\n"
        cls.source["infrastructure/release/policy.txt"] = b"policy fixture\n"
        for service in SERVICES:
            cls.source[f"backend/{service}/source.txt"] = service.encode()
        cls.sha = deploy.commit_tree(cls.root, cls.source)
        bundle.git_bytes(cls.root, "update-ref", "HEAD", cls.sha)
        cls.receipts = cls.receipts_for(cls.sha)
        with patch.object(
            bundle, "render", return_value={s: b"[]\n" for s in SERVICES}
        ):
            cls.files = bundle.build(
                cls.root, FORK, cls.sha, BASE, 123, CHECKS, cls.receipts
            )

    @classmethod
    def receipts_for(cls, sha):
        result = []
        release = (
            bundle.git_bytes(cls.root, "rev-parse", sha + ":infrastructure/release")
            .decode()
            .strip()
        )
        for index, service in enumerate(SERVICES):
            tree = (
                bundle.git_bytes(cls.root, "rev-parse", sha + ":backend/" + service)
                .decode()
                .strip()
            )
            key = bundle.digest(f"v1\nlinux/amd64\n{tree}\n{release}\n".encode())
            result.append(
                {
                    "schemaVersion": 2,
                    "visibility": "public",
                    "service": service,
                    "repository": FORK.image(service),
                    "digest": "sha256:" + str(index) * 64,
                    "platform": "linux/amd64",
                    "verifiedRevision": sha,
                    "sourceTree": tree,
                    "inputKey": key,
                    "tag": "src-" + key,
                }
            )
        return result

    def mocked_renderer(self):
        return patch.object(
            bundle, "render", return_value={s: b"[]\n" for s in SERVICES}
        )


class SnapshotTests(SourceFixture):
    def test_complete_snapshot_is_deterministic_and_contains_no_executable_policy(self):
        with self.mocked_renderer():
            result = bundle.verify(self.root, FORK, self.files)
        self.assertEqual(result["sourceSha"], self.sha)
        self.assertEqual(result["sourceChecks"], CHECKS)
        self.assertFalse(
            any(
                name.startswith(".github/") or name.endswith(".py")
                for name in self.files
            )
        )
        apps = list(yaml.safe_load_all(self.files[bundle.ARGO]))
        self.assertEqual(len(apps), 5)
        self.assertTrue(
            all(
                app["spec"]["source"]["targetRevision"] == "deploy/fork"
                for app in apps[1:]
            )
        )
        self.assertFalse(
            any("valuesObject" in app["spec"]["source"]["helm"] for app in apps[1:])
        )

    def test_recomputed_hash_cannot_authorize_tampered_chart_values_or_rendering(self):
        paths = [
            bundle.CHART_PATH + "/Chart.yaml",
            bundle.PREFIX + "environments/fork/core-service.yaml",
            bundle.PREFIX + "rendered/core-service.json",
            bundle.ARGO,
        ]
        for path in paths:
            with self.subTest(path=path):
                altered = dict(self.files)
                altered[path] += b"\n"
                manifest = json.loads(altered[bundle.MANIFEST])
                manifest["files"][path] = bundle.digest(altered[path])
                del manifest["candidateHash"]
                manifest["candidateHash"] = bundle.digest(bundle.encoded(manifest))
                altered[bundle.MANIFEST] = bundle.encoded(manifest)
                with (
                    self.mocked_renderer(),
                    self.assertRaisesRegex(ValueError, "differs from the source"),
                ):
                    bundle.verify(self.root, FORK, altered)

    def test_extra_missing_and_changed_files_fail_integrity_check(self):
        missing = dict(self.files)
        del missing[bundle.ARGO]
        for altered in (
            missing,
            self.files | {"unreviewed.sh": b"bad"},
            self.files | {bundle.ARGO: b"bad"},
        ):
            with self.assertRaisesRegex(ValueError, "files changed"):
                bundle.manifest_of(altered, FORK)

    def test_config_only_source_change_produces_new_complete_candidate_with_same_images(
        self,
    ):
        source = dict(self.source)
        path = bundle.PREFIX + "environments/portfolio/core-service.yaml"
        values = yaml.safe_load(source[path])
        values["resources"]["limits"]["memory"] = "1024Mi"
        source[path] = yaml.safe_dump(values).encode()
        sha = deploy.commit_tree(self.root, source, self.sha)
        receipts = self.receipts_for(sha)
        self.assertEqual(
            [r["digest"] for r in receipts], [r["digest"] for r in self.receipts]
        )
        with self.mocked_renderer():
            files = bundle.build(self.root, FORK, sha, BASE, 124, CHECKS, receipts)
            bundle.verify(self.root, FORK, files)
        old, new = [json.loads(f[bundle.MANIFEST]) for f in (self.files, files)]
        self.assertNotEqual(old["candidateHash"], new["candidateHash"])
        values = yaml.safe_load(
            files[bundle.PREFIX + "environments/fork/core-service.yaml"]
        )
        self.assertEqual(values["resources"]["limits"]["memory"], "1024Mi")

    def test_receipt_source_identity_and_distinct_branch_are_enforced(self):
        for field in ("verifiedRevision", "sourceTree", "inputKey"):
            receipts = copy.deepcopy(self.receipts)
            receipts[0][field] = "e" * len(receipts[0][field])
            receipts[0]["tag"] = "src-" + receipts[0]["inputKey"]
            with self.assertRaisesRegex(ValueError, "exact tracked source"):
                bundle.build(self.root, FORK, self.sha, BASE, 123, CHECKS, receipts)
        with self.assertRaises(ValueError):
            bundle.build(
                self.root,
                Fork(FORK.repository, "deploy/fork"),
                self.sha,
                BASE,
                123,
                CHECKS,
                self.receipts,
            )

    def test_commit_tree_preserves_checkout_index_and_branch_and_pins_parent(self):
        before = [
            bundle.git_bytes(self.root, *args)
            for args in (
                ("rev-parse", "HEAD"),
                ("status", "--porcelain"),
                ("ls-files", "--stage"),
            )
        ]
        revision = deploy.commit_tree(self.root, self.files, self.sha)
        self.assertEqual(bundle.tracked_files(self.root, revision), self.files)
        deploy.candidate_parent(self.root, revision, self.sha)
        with self.assertRaisesRegex(ValueError, "one snapshot commit"):
            deploy.candidate_parent(self.root, revision, BASE)
        self.assertEqual(
            bundle.git_bytes(self.root, "rev-parse", revision + "^"), before[0]
        )
        after = [
            bundle.git_bytes(self.root, *args)
            for args in (
                ("rev-parse", "HEAD"),
                ("status", "--porcelain"),
                ("ls-files", "--stage"),
            )
        ]
        self.assertEqual(before, after)
        empty = deploy.commit_tree(self.root, {})
        self.assertEqual(bundle.tracked_files(self.root, empty), {})

    def test_untracked_files_are_excluded_and_symlink_git_blobs_are_rejected(self):
        (self.root / "untracked-secret.txt").write_text("fixture", encoding="utf-8")
        self.addCleanup((self.root / "untracked-secret.txt").unlink)
        self.assertNotIn(
            "untracked-secret.txt",
            bundle.tracked_files(self.root, self.sha, bundle.SOURCE_PATHS),
        )
        listing = b"120000 blob " + b"a" * 40 + b"\tsecret\0"
        with (
            patch.object(bundle, "git_bytes", return_value=listing),
            self.assertRaisesRegex(ValueError, "regular tracked"),
        ):
            bundle.tracked_files(self.root, self.sha)
        with (
            tempfile.TemporaryDirectory() as directory,
            self.assertRaisesRegex(ValueError, "escapes"),
        ):
            bundle.write_files(Path(directory), {"../outside": b"bad"})

    def test_real_helm_renders_and_verifies_all_four_images_and_rejects_hidden_paid_override(
        self,
    ):
        self.assertIsNotNone(
            shutil.which("helm"), "Pinned Helm is required in the Helm CI job"
        )
        files = bundle.build(
            self.root, FORK, self.sha, BASE, 123, CHECKS, self.receipts
        )
        bundle.verify(self.root, FORK, files)
        for service in SERVICES:
            objects = json.loads(files[bundle.PREFIX + f"rendered/{service}.json"])
            deployment = next(item for item in objects if item["kind"] == "Deployment")
            expected = next(r for r in self.receipts if r["service"] == service)
            self.assertEqual(
                deployment["spec"]["template"]["spec"]["containers"][0]["image"],
                expected["repository"] + "@" + expected["digest"],
            )
        source = dict(self.source)
        name = bundle.CHART_PATH + "/templates/deployment.yaml"
        # Values remain disabled; the template changes only the actual rendered endpoint.
        source[name] = source[name].replace(
            b"value: {{ $value | quote }}",
            b'value: {{ if eq $key "OPENAI_BASE_URL" }}"https://api.openai.com/v1"{{ else }}{{ $value | quote }}{{ end }}',
        )
        self.assertNotEqual(source[name], self.source[name])
        sha = deploy.commit_tree(self.root, source, self.sha)
        with self.assertRaises(ValueError):
            bundle.build(
                self.root, FORK, sha, BASE, 123, CHECKS, self.receipts_for(sha)
            )


class AdmissionTests(SourceFixture):
    def admission(self, **overrides):
        stack = contextlib.ExitStack()
        defaults = {
            "require_rules": None,
            "head": BASE,
            "source_checks": CHECKS,
            "select_release": ({"head_sha": self.sha}, []),
            "checked_receipts": self.receipts,
            "ensure_revision": None,
            "verify": None,
        }
        for name, value in defaults.items():
            options = overrides.get(name, {"return_value": value})
            stack.enter_context(patch.object(deploy, name, **options))
        return stack

    def test_success_and_stale_source_base_ci_receipt_and_final_race(self):
        with self.admission(head={"side_effect": [BASE, BASE, self.sha]}):
            self.assertEqual(
                deploy.admit(self.root, FORK, self.files)["sourceSha"], self.sha
            )
        cases = [
            {"head": {"return_value": "e" * 40}},
            {"source_checks": {"side_effect": ValueError("source stale")}},
            {"source_checks": {"return_value": CHECKS[:-1]}},
            {"select_release": {"return_value": None}},
            {
                "checked_receipts": {
                    "return_value": [
                        self.receipts[0] | {"digest": "sha256:" + "e" * 64}
                    ]
                }
            },
            {"head": {"side_effect": [BASE, "e" * 40]}},
        ]
        for case in cases:
            with (
                self.subTest(case=case),
                self.admission(**case),
                self.assertRaises(ValueError),
            ):
                deploy.admit(self.root, FORK, self.files)

    def test_actions_policy_checkout_must_match_exact_candidate_source(self):
        with (
            patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}),
            patch.object(deploy, "git_bytes", return_value=BASE.encode()),
            patch.object(deploy, "require_rules") as rules_call,
            self.assertRaisesRegex(ValueError, "policy checkout differs"),
        ):
            deploy.admit(self.root, FORK, self.files)
        rules_call.assert_not_called()

    def test_prepare_does_not_write_any_files_after_admission_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "candidate"
            with (
                self.admission(
                    select_release={
                        "return_value": ({"head_sha": self.sha, "id": 123}, [])
                    }
                ),
                patch.object(deploy, "build", return_value=self.files),
                patch.object(
                    deploy, "admit", side_effect=ValueError("source advanced")
                ),
                self.assertRaises(ValueError),
            ):
                deploy.prepare_candidate(self.root, FORK, output)
            self.assertFalse(output.exists())

    def test_approved_release_uses_immutable_historical_source_without_expiring_artifacts(
        self,
    ):
        with (
            patch.object(deploy, "require_rules"),
            patch.object(deploy, "head", return_value=BASE),
            patch.object(deploy, "ensure_revision"),
            patch.object(deploy, "tracked_files", return_value=self.files),
            self.mocked_renderer(),
            patch.object(deploy, "source_checks") as current,
            patch.object(deploy, "checked_receipts") as artifacts,
        ):
            record, files, revision = deploy.approved_release(self.root, FORK)
        self.assertEqual(record["verifiedRevision"], self.sha)
        self.assertEqual(files, self.files)
        self.assertEqual(revision, BASE)
        current.assert_not_called()
        artifacts.assert_not_called()

    def test_proposal_pushes_only_candidate_and_dispatches_default_branch_checker(self):
        manifest = json.loads(self.files[bundle.MANIFEST])
        with (
            patch.object(deploy, "admit", return_value=manifest),
            patch.object(deploy, "ensure_revision"),
            patch.object(deploy, "commit_tree", return_value=SHA),
            patch.object(deploy, "tracked_files", return_value=self.files),
            patch.object(deploy, "head", return_value=SHA),
            patch.object(deploy, "git_bytes") as git,
            patch.object(deploy.subprocess, "run") as command,
            patch.object(deploy, "mutation", return_value={"number": 42}) as post,
        ):
            result = deploy.propose(self.root, FORK, self.files, "123-1")
            partial = {}
            command.side_effect = [None, RuntimeError("dispatch failed")]
            with self.assertRaisesRegex(RuntimeError, "dispatch failed"):
                deploy.propose(self.root, FORK, self.files, "123-2", result=partial)
            self.assertTrue(partial["candidate_created"])
            self.assertEqual(partial["candidate_pr"], "42")
            self.assertFalse(partial["check_dispatched"])

        self.assertTrue(result["candidate_created"])
        self.assertEqual(git.call_args.args[1:3], ("push", "origin"))
        self.assertTrue(
            git.call_args.args[3].startswith(SHA + ":refs/heads/candidates/fork/")
        )
        self.assertEqual(post.call_args.args[1]["base"], "deploy/fork")
        self.assertEqual(
            command.call_args.args[0],
            [
                "gh",
                "workflow",
                "run",
                "deployment-ci.yml",
                "--repo",
                FORK.repository,
                "--ref",
                "main",
                "-f",
                "candidate_sha=" + SHA,
                "-f",
                "pr_number=42",
            ],
        )

    def test_source_evidence_has_all_five_latest_run_attempts(self):
        evidence = []
        # Reuse the real gate fixture identity, not this class's source fixture identity.
        from test_promote_image import FORK as gate_fork

        self.assertIsNone(
            gate.blocked_reason(
                SHA, gate_fork, ci_results(["success"]), evidence=evidence
            )
        )
        self.assertEqual(evidence, CHECKS)
        with (
            patch.object(deploy, "head", return_value=BASE),
            patch.object(deploy, "blocked_reason") as gate_call,
            self.assertRaisesRegex(ValueError, "Source advanced"),
        ):
            deploy.source_checks(FORK, SHA)
        gate_call.assert_not_called()


class RuleAndCheckTests(unittest.TestCase):
    def test_active_rules_require_all_checks_latest_review_and_strict_base(self):
        valid = rules({deploy.CHECK_NAME})
        self.assertEqual(deploy.rule_errors(valid, {deploy.CHECK_NAME}), [])
        variants = [[], valid[1:], rules({"unrelated"})]
        for index, key in (
            (2, "dismiss_stale_reviews_on_push"),
            (2, "require_last_push_approval"),
            (2, "required_review_thread_resolution"),
            (3, "strict_required_status_checks_policy"),
        ):
            altered = copy.deepcopy(valid)
            altered[index]["parameters"][key] = False
            variants.append(altered)
        for value in variants:
            self.assertTrue(deploy.rule_errors(value, {deploy.CHECK_NAME}))
        calls = []

        def get(path):
            calls.append(path)
            required = (
                {name for names in gate.WORKFLOWS.values() for name in names}
                if "/main?" in path
                else {deploy.CHECK_NAME}
            )
            return rules(required)

        deploy.require_rules(FORK, get)
        self.assertTrue(any("deploy%2Ffork" in path for path in calls))
        with self.assertRaises(ValueError):
            deploy.require_rules(FORK, lambda _: [])

    def run_check(self, *, failure=None, changed=False, ref="refs/heads/main"):
        pr = {
            "state": "open",
            "base": {"ref": "deploy/fork", "repo": {"full_name": FORK.repository}},
            "head": {
                "ref": "candidates/fork/test",
                "sha": SHA,
                "repo": {"full_name": FORK.repository},
            },
        }
        after = copy.deepcopy(pr)
        if changed:
            after["head"]["sha"] = BASE
        with tempfile.TemporaryDirectory() as directory:
            event = Path(directory) / "event.json"
            event.write_text(
                json.dumps({"inputs": {"pr_number": "42", "candidate_sha": SHA}})
            )
            env = {
                "GITHUB_EVENT_NAME": "workflow_dispatch",
                "GITHUB_EVENT_PATH": str(event),
                "GITHUB_REPOSITORY": FORK.repository,
                "GOVBIZ_RELEASE_BRANCH": "main",
                "GITHUB_REF": ref,
                "GITHUB_RUN_ID": "99",
            }
            with (
                patch.dict(os.environ, env),
                patch("sys.argv", ["deployment.py", "check"]),
                patch.object(deploy, "api", side_effect=[pr, after]),
                patch.object(deploy, "mutation") as post,
                patch.object(deploy, "ensure_revision"),
                patch.object(deploy, "tracked_files"),
                patch.object(
                    deploy,
                    "admit",
                    side_effect=failure,
                    return_value={"candidateHash": "abc", "baseSha": BASE},
                ),
                patch.object(deploy, "candidate_parent"),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                if failure or changed or ref != "refs/heads/main":
                    with self.assertRaises(ValueError):
                        deploy.main()
                else:
                    deploy.main()
        return post.call_args_list

    def test_check_posts_to_exact_candidate_and_failure_never_inherits_success(self):
        calls = self.run_check()
        self.assertEqual(
            [call.args[1]["state"] for call in calls], ["pending", "success"]
        )
        self.assertTrue(
            all(call.args[0].endswith("/statuses/" + SHA) for call in calls)
        )
        for options in ({"failure": ValueError("stale")}, {"changed": True}):
            calls = self.run_check(**options)
            self.assertEqual(
                [call.args[1]["state"] for call in calls], ["pending", "failure"]
            )
        self.assertEqual(self.run_check(ref="refs/heads/candidates/fork/untrusted"), [])

    def test_connected_runtime_cannot_write_secrets_or_argo_overrides_on_approved_branch(
        self,
    ):
        import connected_runtime as connected

        settings = cluster.initial_settings(FORK) | {"mode": "gitops"}
        args = SimpleNamespace(
            features="ai",
            env_file=[],
            origin="http://127.0.0.1:5173",
            helm="helm",
            apply=True,
            allow_background_paid_work=False,
        )
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(connected, "read_inputs", return_value={}),
            patch.object(connected, "secret_updates", return_value={"ai-runtime": {}}),
            patch.object(connected, "policy_errors", return_value=[]),
            patch.object(connected, "load_profile", return_value=None),
            patch.object(connected, "quiet") as secret_io,
            patch.object(connected, "patch_secret") as secret_write,
            patch.object(cluster, "locked", return_value=contextlib.nullcontext()),
            patch.object(cluster, "verify_context"),
            patch.object(
                cluster,
                "applications",
                return_value=cluster.argo_resources(settings)[1:],
            ),
            patch.object(cluster, "run", return_value="") as execute,
            contextlib.redirect_stdout(io.StringIO()),
            self.assertRaisesRegex(ValueError, "deployment PR"),
        ):
            connected.configure(args, Path(directory), settings)
        secret_io.assert_not_called()
        secret_write.assert_not_called()
        self.assertTrue(
            all(call.args[0][0] == "helm" for call in execute.call_args_list)
        )

    def test_gitops_applies_reviewed_applications_and_accepts_unmodified_legacy_source(
        self,
    ):
        settings = cluster.initial_settings(FORK)
        desired = cluster.argo_resources(settings)
        snapshot = {bundle.ARGO: yaml.safe_dump_all(desired).encode()}
        legacy = copy.deepcopy(desired[1:])
        for app in legacy:
            app["spec"]["source"]["targetRevision"] = "main"
            del app["spec"]["source"]["helm"]["kubeVersion"]
        install = b"fixture Argo installation"
        with (
            tempfile.TemporaryDirectory() as directory,
            patch("connected_runtime.load_profile", return_value=None),
            patch.object(
                cluster,
                "approved_bundle",
                return_value=({"visibility": "public"}, snapshot, BASE),
            ),
            patch.object(cluster, "verify_context"),
            patch.object(cluster, "verify_pull_rights"),
            patch.object(
                cluster,
                "run",
                side_effect=[
                    SHA,
                    SHA + " refs/heads/main",
                    "",
                    "",
                    "",
                    '{"items": []}',
                ],
            ),
            patch.object(cluster, "applications", return_value=legacy),
            patch.object(cluster, "apply") as apply,
            patch.object(cluster, "urlopen", return_value=io.BytesIO(install)),
            patch.object(cluster, "ARGO_INSTALL_SHA256", bundle.digest(install)),
            patch.object(cluster, "write_json"),
            patch.object(deploy, "head", return_value=BASE),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            cluster._gitops(SimpleNamespace(helm="helm"), Path(directory), settings)
        self.assertEqual(settings["mode"], "gitops")
        self.assertEqual(apply.call_args.args[1], desired)
        self.assertEqual(apply.call_count, 2)

    def test_live_argo_overrides_are_rejected_even_without_a_local_profile(self):
        settings = cluster.initial_settings(FORK)
        desired = cluster.argo_resources(settings)
        snapshot = {bundle.ARGO: yaml.safe_dump_all(desired).encode()}
        changed = copy.deepcopy(desired[1:])
        changed[0]["spec"]["source"]["helm"]["valuesObject"] = {
            "env": {"UNREVIEWED": "true"}
        }
        with (
            tempfile.TemporaryDirectory() as directory,
            patch("connected_runtime.load_profile", return_value=None),
            patch.object(
                cluster,
                "approved_bundle",
                return_value=({"visibility": "public"}, snapshot, BASE),
            ),
            patch.object(cluster, "verify_context"),
            patch.object(cluster, "verify_pull_rights"),
            patch.object(
                cluster, "run", side_effect=[SHA, SHA + " refs/heads/main", ""]
            ),
            patch.object(cluster, "applications", return_value=changed),
            patch.object(cluster, "apply") as apply,
            self.assertRaisesRegex(ValueError, "Argo source/overrides"),
        ):
            cluster._gitops(SimpleNamespace(helm="helm"), Path(directory), settings)
        apply.assert_not_called()

    def test_local_profile_blocks_gitops_before_snapshot_network_or_cluster_write(self):
        settings = cluster.initial_settings(FORK)
        with (
            tempfile.TemporaryDirectory() as directory,
            patch("connected_runtime.load_profile", return_value={"features": ["ai"]}),
            patch.object(cluster, "approved_bundle") as remote,
            patch.object(cluster, "apply") as apply,
            self.assertRaisesRegex(ValueError, "Review integration"),
        ):
            cluster._gitops(SimpleNamespace(helm="helm"), Path(directory), settings)
        remote.assert_not_called()
        apply.assert_not_called()


if __name__ == "__main__":
    unittest.main()
