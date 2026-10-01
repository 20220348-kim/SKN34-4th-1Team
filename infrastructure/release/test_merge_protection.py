import copy
import json
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import ci_policy
import merge_protection as protection
from repository import Fork

ROOT = Path(__file__).resolve().parents[2]
FORK = Fork("alice/project")


class ApiTests(unittest.TestCase):
    def call(self, output, code=0, **kwargs):
        process = subprocess.CompletedProcess([], code, output, "private error text")
        with patch.object(protection.subprocess, "run", return_value=process) as run:
            result = protection.api("repos/alice/project/rules", **kwargs)
        self.assertNotIn("--slurp", run.call_args.args[0])
        return result

    def test_older_cli_pagination_reads_all_pages(self):
        self.assertEqual(self.call("[1,2]\n [3]\n []", pages=True), [1, 2, 3])
        self.assertEqual(self.call("[]", pages=True), [])
        self.assertEqual(self.call('{"id":7}'), {"id": 7})

    def test_incomplete_pages_are_rejected(self):
        for output in ("", "[1]\n[", '[1]\n{"message":"private"}', "[] trailing"):
            with (
                self.subTest(output=output),
                self.assertRaises((TypeError, ValueError)),
            ):
                self.call(output, pages=True)

    def test_only_explicit_optional_404_is_absent(self):
        self.assertIsNone(self.call('{"status":"404"}', 1, absent=True))
        for status in (401, "403", 404, 500, None):
            with (
                self.subTest(status=status),
                self.assertRaises(protection.PolicyAccessError) as raised,
            ):
                self.call(json.dumps({"status": status, "message": "private"}), 1)
            self.assertNotIn("private", str(raised.exception))
        with self.assertRaisesRegex(protection.PolicyAccessError, "permission_denied"):
            self.call('{"status":"403"}', 1, absent=True)
        with self.assertRaises(protection.PolicyAccessError):
            self.call("[]", 1, pages=True)


class SummaryTests(unittest.TestCase):
    def test_only_complete_success_is_accepted(self):
        for filename, jobs in ci_policy.WORKFLOW_JOBS.items():
            needs = {name: {"result": "success"} for name in jobs}
            ci_policy.check_results(filename, needs)
            for name in jobs:
                for result in ("failure", "cancelled", "skipped", "pending", None):
                    with self.subTest(filename=filename, name=name, result=result):
                        changed = {**needs, name: {"result": result}}
                        with self.assertRaises(ValueError):
                            ci_policy.check_results(filename, changed)

    def test_empty_missing_extra_and_malformed_jobs_are_rejected(self):
        for needs in (
            {},
            [],
            None,
            {"integration": None},
            {"integration": {}},
            {"integration": {"result": "success"}, "unknown": {"result": "success"}},
        ):
            with self.subTest(needs=needs), self.assertRaises(ValueError):
                ci_policy.check_results("llmops-ci.yml", needs)

    def test_cli_preserves_failure_exit_status(self):
        result = subprocess.run(
            [
                sys.executable,
                str(ROOT / "infrastructure/release/ci_policy.py"),
                "llmops-ci.yml",
            ],
            env={"NEEDS_JSON": '{"integration":{"result":"skipped"}}'},
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("integration", result.stderr)


class ProtectionTests(unittest.TestCase):
    def setUp(self):
        self.rule = {"id": 71, **protection.ruleset("main")}
        self.extra = []
        self.classic = None
        self.metadata = {"full_name": FORK.repository, "permissions": {"admin": True}}

    def get(self, path, **kwargs):
        prefix = "repos/" + FORK.repository
        if path == prefix:
            return self.metadata
        if "/rules/branches/" in path:
            return [
                {**rule, "ruleset_id": 71} for rule in self.rule["rules"]
            ] + self.extra
        if path.endswith("/protection"):
            return self.classic
        if path == prefix + "/rulesets/71?includes_parents=true":
            return self.rule
        raise AssertionError(path)

    def report(self):
        return protection.audit(FORK, self.get)

    def test_plan_keeps_zero_reviews_and_binds_all_checks_to_github_actions(self):
        checks = self.rule["rules"][1]["parameters"]["required_status_checks"]
        self.assertEqual(len(checks), 21)
        self.assertEqual(len({item["context"] for item in checks}), 21)
        self.assertEqual({item["integration_id"] for item in checks}, {15368})
        self.assertEqual(self.rule["bypass_actors"], [])
        self.assertEqual(
            self.rule["rules"][0]["parameters"]["required_approving_review_count"], 0
        )
        result = self.report()
        self.assertEqual(result["status"], "PASS")
        self.assertFalse(result["merge_behavior_verified"])
        self.assertTrue(result["administrator_can_edit_rules"])

    def test_missing_weak_checks_or_untrusted_app_do_not_pass(self):
        original = copy.deepcopy(self.rule)
        for change in ("missing", "unbound", "other-app", "strict", "new-branch"):
            self.rule = copy.deepcopy(original)
            params = self.rule["rules"][1]["parameters"]
            if change == "missing":
                params["required_status_checks"].pop()
            elif change in ("unbound", "other-app"):
                params["required_status_checks"][0]["integration_id"] = (
                    None if change == "unbound" else 99
                )
            elif change == "strict":
                params["strict_required_status_checks_policy"] = False
            else:
                params["do_not_enforce_on_create"] = True
            with self.subTest(change=change):
                self.assertEqual(self.report()["status"], "FAIL")

    def test_review_requirements_from_other_effective_rules_remain_visible(self):
        self.extra = [
            {
                "ruleset_id": 71,
                "type": "pull_request",
                "parameters": {
                    "required_approving_review_count": 1,
                    "require_code_owner_review": False,
                    "require_last_push_approval": False,
                },
            }
        ]
        self.assertIn(
            "another_rule_requires_review_approval", self.report()["problems"]
        )

    def test_each_bypass_kind_is_rejected_and_reported(self):
        for actor_type in (
            "RepositoryRole",
            "Team",
            "Integration",
            "OrganizationAdmin",
        ):
            actor = {"actor_type": actor_type, "actor_id": 5, "bypass_mode": "always"}
            self.rule["bypass_actors"] = [actor]
            result = self.report()
            self.assertEqual(result["status"], "FAIL")
            self.assertEqual(result["bypass_rulesets"][0]["actors"], [actor])

    def test_classic_protection_is_not_ignored(self):
        self.classic = {
            "enforce_admins": {"enabled": True},
            "required_pull_request_reviews": {
                "required_approving_review_count": 0,
            },
        }
        self.assertEqual(self.report()["status"], "PASS")
        self.classic["enforce_admins"]["enabled"] = False
        self.assertIn(
            "classic_protection_allows_admin_bypass", self.report()["problems"]
        )
        self.classic["required_pull_request_reviews"][
            "required_approving_review_count"
        ] = 1
        self.assertIn(
            "classic_protection_requires_review_approval", self.report()["problems"]
        )

    def test_scope_missing_rules_or_inactive_ruleset_cannot_pass(self):
        original = copy.deepcopy(self.rule)
        for change in ("branch", "missing", "renamed", "inactive"):
            self.rule = copy.deepcopy(original)
            if change == "branch":
                self.rule["conditions"]["ref_name"]["include"] = ["refs/heads/other"]
            elif change == "missing":
                self.rule["rules"].pop(0)
            elif change == "renamed":
                self.rule["name"] = "unrelated"
            else:
                self.rule["enforcement"] = "evaluate"
                with self.assertRaises(ValueError):
                    self.report()
                continue
            self.assertEqual(self.report()["status"], "FAIL")

    def test_missing_permission_or_bypass_evidence_is_unknown(self):
        self.metadata["permissions"] = {"admin": False}
        with self.assertRaises(ValueError):
            self.report()
        self.metadata["permissions"]["admin"] = True
        del self.rule["bypass_actors"]
        with self.assertRaises(ValueError):
            self.report()

    def test_rules_edited_during_audit_are_not_reported_as_current_success(self):
        for target in ("rules/branches/", "/rulesets/", "/protection"):
            calls = 0

            def get(path, target=target, **kwargs):
                nonlocal calls
                value = copy.deepcopy(self.get(path, **kwargs))
                if target in path:
                    calls += 1
                    if calls == 2:
                        return {} if value is None else None
                return value

            with self.subTest(target=target), self.assertRaises(ValueError):
                protection.audit(FORK, get)

    def test_export_is_offline_and_account_independent(self):
        result = subprocess.run(
            [
                sys.executable,
                str(ROOT / "infrastructure/release/merge_protection.py"),
                "ruleset",
                "--repository",
                "alice/project",
                "--branch",
                "develop",
            ],
            text=True,
            capture_output=True,
            check=True,
        )
        self.assertEqual(
            json.loads(result.stdout)["conditions"]["ref_name"]["include"],
            ["refs/heads/develop"],
        )


if __name__ == "__main__":
    unittest.main()
