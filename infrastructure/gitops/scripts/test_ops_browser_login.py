"""Browser evidence must fail closed and keep the login secret out of argv/output."""

import json
import subprocess
import unittest
from unittest.mock import patch

import smoke_ops_evaluation as smoke

EXPECTED = {
    "10000000-0000-4000-8000-000000000001": {
        "execution_spec_sha256": "a" * 64,
        "report_sha256": "b" * 64,
    }
}
PROOF = {
    "status": "PASS",
    "response_source": "core_ops_http",
    "browser_version": "154.0.0.0",
    "password_login_verified": True,
    "httponly_cookie_received": True,
    "core_ops_identity_verified": True,
    "reload_verified": True,
    "details_verified": 1,
    "reports_verified": 1,
    "logout_verified": True,
    "unauthorized_after_logout": True,
    "browser_closed": True,
}


class BrowserEvidenceTests(unittest.TestCase):
    def test_password_is_only_passed_through_stdin_and_not_saved_in_evidence(self):
        with patch.object(smoke, "execute", return_value=json.dumps(PROOF)) as run:
            result = smoke.browser_login(
                "private-test-password", EXPECTED, {"PATH": "fixture"}
            )
        command = run.call_args.args[0]
        options = run.call_args.kwargs
        self.assertEqual(command[0], "node")
        self.assertEqual(command[1].name, "ops_browser_login.mjs")
        self.assertNotIn("private-test-password", str(command))
        self.assertEqual(options["env"], {"PATH": "fixture"})
        self.assertEqual(json.loads(options["data"])["expected"], EXPECTED)
        self.assertEqual(
            json.loads(options["data"])["password"], "private-test-password"
        )
        self.assertNotIn("private-test-password", json.dumps(result))
        self.assertEqual(result, PROOF)

    def test_incomplete_or_replayed_evidence_is_rejected(self):
        for key, value in (
            ("response_source", "captured_restore_http"),
            ("password_login_verified", False),
            ("httponly_cookie_received", 1),
            ("core_ops_identity_verified", False),
            ("reload_verified", False),
            ("details_verified", 0),
            ("reports_verified", 0),
            ("unauthorized_after_logout", False),
            ("browser_closed", False),
        ):
            with (
                self.subTest(key=key),
                patch.object(
                    smoke, "execute", return_value=json.dumps({**PROOF, key: value})
                ),
                self.assertRaisesRegex(ValueError, "Incomplete"),
            ):
                smoke.browser_login("private-test-password", EXPECTED, {})

    def test_failed_process_missing_version_and_extra_secrets_never_pass(self):
        with (
            patch.object(
                smoke, "execute", side_effect=subprocess.CalledProcessError(1, ["node"])
            ),
            self.assertRaises(subprocess.CalledProcessError),
        ):
            smoke.browser_login("private-test-password", EXPECTED, {})
        for proof in (
            {**PROOF, "browser_version": ""},
            {**PROOF, "cookie": "unexpected"},
        ):
            with (
                patch.object(smoke, "execute", return_value=json.dumps(proof)),
                self.assertRaises(ValueError),
            ):
                smoke.browser_login("private-test-password", EXPECTED, {})


if __name__ == "__main__":
    unittest.main()
