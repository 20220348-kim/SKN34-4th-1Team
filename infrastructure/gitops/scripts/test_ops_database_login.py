"""Original authentication evidence, private MySQL login and disposable-target guards."""

import copy
import json
import subprocess
import unittest
from unittest.mock import patch

import ops_db_snapshot as database

IDENTITY = "a" * 64
PASSWORD = "synthetic_한글_password_'\\_$"
COMMAND = ["docker", "exec", "-i", IDENTITY, *database.storage.AUTH]


def accounts():
    return {
        "schema_version": 1,
        "accounts": [
            {
                "user": user,
                "host": host,
                "plugin": "caching_sha2_password",
                "authentication_hex": "24412430303524" + "41" * 63,
                "locked": "N",
                "expired": "N",
                "ssl": "",
                "simple_auth": 1,
            }
            for user, host in sorted(database.ACCOUNT_IDENTITIES)
        ],
    }


class AccountTests(unittest.TestCase):
    def test_capture_reads_only_supported_original_accounts(self):
        value = accounts()
        with patch.object(
            database, "query", return_value="\n".join(json.dumps(row) for row in value["accounts"])
        ) as query:
            self.assertEqual(database.read_accounts(["source"]), value)
        query.assert_called_once_with(["source"], database.ACCOUNTS)
        self.assertNotIn("SELECT *", database.ACCOUNTS)

    def test_missing_locked_expired_external_or_multiple_authentication_is_rejected(self):
        for changes in (
            {"user": "unexpected"},
            {"host": "other-host"},
            {"plugin": "mysql_native_password"},
            {"locked": "Y"},
            {"expired": "Y"},
            {"ssl": "X509"},
            {"simple_auth": 0},
            {"simple_auth": True},
            {"authentication_hex": ""},
            {"authentication_hex": "AB';SELECT 1;"},
        ):
            value = accounts()
            value["accounts"][0].update(changes)
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                database.validate_accounts(value)
        for value in (None, {}, {"schema_version": 1, "accounts": []}):
            with self.assertRaises(ValueError):
                database.validate_accounts(value)


class TransportTests(unittest.TestCase):
    def test_password_and_sql_only_use_stdin_and_success_requires_authentication(self):
        with patch.object(
            database.subprocess,
            "run",
            return_value=subprocess.CompletedProcess([], 0, b"ok\n", b""),
        ) as run:
            self.assertEqual(
                database.credential_query(IDENTITY, "govbiz_ops", PASSWORD, "SELECT 1;"), "ok"
            )
        args = run.call_args.args[0]
        self.assertNotIn(PASSWORD, " ".join(args))
        self.assertNotIn("SELECT 1;", args)
        self.assertEqual(run.call_args.kwargs["input"], (PASSWORD + "\nSELECT 1;").encode())
        self.assertNotIn("env", run.call_args.kwargs)
        self.assertIn("--protocol=TCP", args)
        self.assertIn("--no-defaults", args)

    def test_root_uses_socket_to_select_the_captured_localhost_account(self):
        with patch.object(
            database.subprocess,
            "run",
            return_value=subprocess.CompletedProcess([], 0, b"ok\n", b""),
        ) as run:
            database.credential_query(IDENTITY, "root", PASSWORD, "SELECT 1;")
        args = run.call_args.args[0]
        self.assertIn("--protocol=SOCKET", args)
        self.assertNotIn("--host=127.0.0.1", args)
        self.assertNotIn("--protocol=TCP", args)

    def test_connection_failure_or_success_is_not_a_password_denial(self):
        for result in (
            subprocess.CompletedProcess([], 0, b"1\n", b""),
            subprocess.CompletedProcess([], 1, b"", b"ERROR 2003 (HY000): unavailable"),
            subprocess.CompletedProcess([], 1, b"", b"ERROR 1045 (28000): Access denied"),
        ):
            with patch.object(database.subprocess, "run", return_value=result):
                if b"1045" in result.stderr:
                    self.assertIsNone(
                        database.credential_query(
                            IDENTITY, "root", PASSWORD, "SELECT 1;", denied=True
                        )
                    )
                else:
                    with self.assertRaises(ValueError):
                        database.credential_query(
                            IDENTITY, "root", PASSWORD, "SELECT 1;", denied=True
                        )
        with (
            patch.object(
                database.subprocess, "run", side_effect=subprocess.TimeoutExpired("mysql", 30)
            ),
            self.assertRaisesRegex(ValueError, "did not complete"),
        ):
            database.credential_query(IDENTITY, "root", PASSWORD, "SELECT 1;")

    def test_line_breaks_and_noncanonical_targets_are_rejected_before_execution(self):
        for identity, user, password in (
            ("source-pod", "root", PASSWORD),
            (IDENTITY, "other", PASSWORD),
            (IDENTITY, "root", PASSWORD + "\nSQL"),
        ):
            with patch.object(database.subprocess, "run") as run, self.assertRaises(ValueError):
                database.credential_query(identity, user, password, "SELECT 1;")
            run.assert_not_called()


class RestoreGuardTests(unittest.TestCase):
    def setUp(self):
        self.target = {
            "Id": IDENTITY,
            "Name": "/govbiz-ops-db-verify-" + "b" * 32,
            "Config": {"Labels": {database.RESTORE_LABEL: "1"}},
            "HostConfig": {"NetworkMode": "none", "Tmpfs": {"/var/lib/mysql": "rw"}},
            "Mounts": [{"Type": "tmpfs"}],
            "State": {"Running": True},
        }

    def test_source_named_volume_or_unlabelled_database_is_never_modified(self):
        for field, value in (
            ("Name", "/existing-personal-mysql"),
            ("Config", {"Labels": {}}),
            ("HostConfig", {"NetworkMode": "bridge", "Tmpfs": {}}),
            ("Mounts", [{"Type": "volume"}]),
            ("State", {"Running": False}),
        ):
            target = copy.deepcopy(self.target)
            target[field] = value
            with (
                patch.object(database.storage, "inspect", return_value=target),
                patch.object(database, "query") as query,
                self.assertRaises(ValueError),
            ):
                database.verify_database_login(
                    COMMAND,
                    accounts(),
                    {"database": PASSWORD, "mysql_root": PASSWORD},
                    {"evaluations_evaluationrun": 2},
                )
            query.assert_not_called()
        with patch.object(database.storage, "inspect") as inspect, self.assertRaises(ValueError):
            database.verify_database_login(["kubectl", "exec", "source"], accounts(), {}, {})
        inspect.assert_not_called()

    def test_recovery_uses_original_hashes_and_never_password_based_account_creation(self):
        def query(command, sql):
            self.assertEqual(command, COMMAND)
            if sql.startswith("SELECT COUNT"):
                return "0"
            self.assertIn("QUOTE(UNHEX('", sql)
            self.assertNotIn(PASSWORD, sql)
            self.assertNotIn("IDENTIFIED BY", sql)
            self.assertIn("GRANT SELECT ON govbiz_ops.*", sql)
            self.assertNotIn("GRANT ALL", sql)
            return ""

        def login(identity, user, password, sql, *, denied=False):
            self.assertEqual(identity, IDENTITY)
            if denied:
                self.assertNotEqual(password, PASSWORD)
                return None
            self.assertEqual(password, PASSWORD)
            return ("root@localhost" if user == "root" else "govbiz_ops@%") + "\tgovbiz_ops\n2"

        with (
            patch.object(database.storage, "inspect", return_value=self.target),
            patch.object(database, "query", side_effect=query),
            patch.object(database, "credential_query", side_effect=login),
        ):
            result = database.verify_database_login(
                COMMAND,
                accounts(),
                {"database": PASSWORD, "mysql_root": PASSWORD},
                {"evaluations_evaluationrun": 2},
            )
        self.assertTrue(result["database_login_verified"])
        self.assertFalse(result["source_grants_restored"])

    def test_existing_application_account_is_not_overwritten(self):
        with (
            patch.object(database.storage, "inspect", return_value=self.target),
            patch.object(database, "query", return_value="1") as query,
            self.assertRaises(ValueError),
        ):
            database.verify_database_login(
                COMMAND,
                accounts(),
                {"database": PASSWORD, "mysql_root": PASSWORD},
                {"evaluations_evaluationrun": 2},
            )
        self.assertEqual(query.call_count, 1)


if __name__ == "__main__":
    unittest.main()
