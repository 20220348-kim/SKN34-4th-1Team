"""Offline guards and opt-in disposable MySQL 8.4 tests for manual production seeding."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, nullcontext
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import test_application_seed_mysql as personal_tests


SPEC = importlib.util.spec_from_file_location("production_seed", Path(__file__).with_name("seed-production-demo.py"))
seed = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(seed)
TEST_HASH = "$2b$10$" + "a" * 53
HASHES = {email: TEST_HASH for email in seed.EMAILS}


class ProductionSeedGuardTest(unittest.TestCase):
    def test_single_transaction_no_reset_no_default_password(self):
        sql = seed.build_sql([1, 2, 3, 4, 5], HASHES)
        self.assertEqual(sql.splitlines().count("START TRANSACTION;"), 1)
        self.assertEqual(sql.splitlines().count("COMMIT;"), 1)
        self.assertEqual(sql.count("GET_LOCK("), 1)
        self.assertEqual(sql.count("RELEASE_LOCK("), 1)
        self.assertIn("SET @reset_personal_demo_data = 0;", sql)
        public = (seed.SEED_DIR / "production-public.sql").read_text()
        self.assertNotRegex(public, r"(?im)^\s*(DELETE|UPDATE|REPLACE)\b")
        self.assertNotIn("govbiz-admin1", sql)
        self.assertNotIn("govbiz-demo1", sql)
        self.assertNotIn("INSERT INTO account_admin_action", sql)

    def test_envelope_changes_fail_closed(self):
        source = (seed.SEED_DIR / "application-preparations.sql").read_text()
        for changed in (source.replace("COMMIT;", "COMMIT WORK;"), source + "START TRANSACTION;\n",
                        source + "ALTER TABLE account ADD unsafe INT;\n"):
            with self.assertRaises(ValueError):
                seed.personal_body(changed)

    def test_ids_and_hashes_are_validated(self):
        for ids in ([1, 2, 3, 4, 4], [1], [1, 2, 3, 4, "5; DELETE"]):
            with self.assertRaises(ValueError):
                seed.build_sql(ids, HASHES)
        for hashes in ({seed.EMAILS[0]: "plain-password"}, {"unknown@test.example": TEST_HASH}):
            with self.assertRaises(ValueError):
                seed.build_sql([1, 2, 3, 4, 5], hashes)

    def test_client_uses_private_options_and_verified_tls(self):
        with tempfile.TemporaryDirectory() as directory:
            ca = Path(directory) / "ca.pem"
            ca.touch()
            with seed.mysql_client({"host": "db.rds.amazonaws.com", "password": 'x#"\\$secret'}, ca) as command:
                options = Path(command[1].split("=", 1)[1])
                self.assertEqual(options.stat().st_mode & 0o777, 0o600)
                self.assertNotIn("secret", " ".join(command))
                self.assertIn("--ssl-mode=VERIFY_IDENTITY", command)
                self.assertNotIn("--no-login-paths", command)  # Ubuntu MySQL 8.0 client compatibility
                self.assertNotIn("--force", command)
            self.assertFalse(options.exists())

    def test_world_readable_hashes_and_symlinks_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "hashes.json"
            source.write_text("{}")
            source.chmod(0o644)
            with self.assertRaises(ValueError):
                seed.private_file(source)
            source.chmod(0o600)
            seed.private_file(source)
            link = source.with_name("link")
            link.symlink_to(source)
            with self.assertRaises(ValueError):
                seed.private_file(link)

    def test_root_can_read_ssm_user_env_without_chown(self):
        from types import SimpleNamespace
        import stat
        info = SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=1001)
        with patch.object(Path, "lstat", return_value=info), patch.object(seed.os, "geteuid", return_value=0):
            with self.assertRaises(ValueError):
                seed.private_file(Path("hashes"))
            seed.private_file(Path("env"), allow_root_reader=True)
            info.st_mode = stat.S_IFREG | 0o640
            with self.assertRaises(ValueError):
                seed.private_file(Path("env"), allow_root_reader=True)

    def test_default_preflight_is_read_only_and_no_secrets_in_failure(self):
        data = {"version": "8.4.9", "accounts": [], "program_ids": [1, 2, 3, 4, 5]}
        with patch.object(seed, "query", return_value=json.dumps(data)) as query:
            seed.preflight(["mysql"])
            self.assertIn("SET SESSION TRANSACTION READ ONLY;", query.call_args.args[1])
            self.assertNotIn("INSERT", query.call_args.args[1])
        with patch.object(seed.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "", "ERROR 3819 (HY000): password-secret SQL-hash")):
            with self.assertRaises(ValueError) as error:
                seed.query(["mysql", "--defaults-file=/private-test/client.cnf"], "private SQL")
            self.assertIn("3819", str(error.exception))
            self.assertNotIn("password-secret", str(error.exception))
            self.assertNotIn("SQL-hash", str(error.exception))
            self.assertEqual(seed.subprocess.run.call_args.kwargs["env"]["MYSQL_TEST_LOGIN_FILE"], "/private-test/unused-login.cnf")

    def test_manual_plan_apply_and_admin_confirmation(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            plan = Path(directory) / "plan.json"
            hashes = Path(directory) / "hashes.json"
            hashes.write_text(json.dumps(HASHES))
            hashes.chmod(0o600)
            stack.enter_context(patch.object(seed, "open", side_effect=lambda *a: tempfile.TemporaryFile()))
            stack.enter_context(patch.object(seed.fcntl, "flock"))
            stack.enter_context(patch.object(seed, "connection_from_compose", return_value={
                "host": "demo.rds.amazonaws.com", "database": "govbiz", "port": 3306}))
            stack.enter_context(patch.object(seed, "mysql_client", return_value=nullcontext(["mysql"])))
            stack.enter_context(patch.object(seed, "preflight", return_value={
                "accounts": [], "program_ids": [1, 2, 3, 4, 5]}))
            stack.enter_context(patch("builtins.print"))
            query = stack.enter_context(patch.object(seed, "query", return_value="GOVBIZ_PRODUCTION_DEMO_OK\n"))
            args = ["seed-production-demo.py", "--plan-file", str(plan)]
            with patch.object(seed.sys, "argv", args):
                seed.main()
            query.assert_not_called()
            self.assertEqual(plan.stat().st_mode & 0o777, 0o600)
            with patch.object(seed.sys, "argv", args + ["--apply", "--account-hashes-file", str(hashes)]):
                with self.assertRaisesRegex(ValueError, "관리자"):
                    seed.main()
            query.assert_not_called()
            with patch.object(seed.sys, "argv", args + ["--apply", "--confirm-new-admin", "--account-hashes-file", str(hashes)]):
                seed.main()
            self.assertEqual(query.call_count, 1)
            document = json.loads(plan.read_text())
            document["host"] = "different.rds.amazonaws.com"
            plan.write_text(json.dumps(document))
            with patch.object(seed.sys, "argv", args + ["--apply", "--confirm-new-admin"]):
                with self.assertRaisesRegex(ValueError, "계획"):
                    seed.main()
            self.assertEqual(query.call_count, 1)


@unittest.skipUnless(os.environ.get("RUN_SEED_MYSQL_TESTS") == "1", "requires explicit disposable Docker MySQL test")
class ProductionSeedMySqlTest(unittest.TestCase):
    docker = personal_tests.PersonalDemoSeedMySqlTest.__dict__["docker"]
    query = personal_tests.PersonalDemoSeedMySqlTest.__dict__["query"]

    @classmethod
    def setUpClass(cls):
        personal_tests.PersonalDemoSeedMySqlTest.setUpClass.__func__(cls)
        migrations = personal_tests.ROOT / "backend/core-service/src/main/resources/db/migration"
        for version in (6, 8, 9, 13, 17, 20, 22):
            path, = migrations.glob(f"V{version}__*.sql")
            cls.query(path.read_text())
        cls.query("""INSERT INTO support_program (
            source_code,source_program_id,title,organization,summary,categories,regions,
            target_description,application_period_raw,application_end_date,source_url
        ) VALUES ('BIZINFO','PROGRAM-5','공고 5','기관','요약',JSON_ARRAY(),JSON_ARRAY(),'대상','상시',
            DATE_ADD(CURDATE(),INTERVAL 120 DAY),'https://example.test/5');""")

    def setUp(self):
        self.query("""DELETE FROM account;
            UPDATE support_program SET application_end_date=DATE_ADD(CURDATE(),INTERVAL 90 DAY),is_source_present=TRUE;
            INSERT INTO account(email,password_hash,role,terms_agreed_at) VALUES ('real@example.test','unchanged','USER',NOW());
        """)
        self.ids = [int(n) for n in self.query("SELECT id FROM support_program ORDER BY id LIMIT 5").stdout.split()]

    def snapshot(self):
        return self.query("\n".join(f"SELECT * FROM {table} ORDER BY 1;" for table in (
            "account", "company", "company_partner_profile", "account_session", "partner_recruitment",
            "partner_proposal", "saved_support_program", "application_preparation", "application_preparation_fact",
            "application_preparation_content", "combination_review", "combination_review_program",
            "combination_review_run", "combination_review_run_source",
        ))).stdout

    def test_complete_seed_and_retry_preserve_edited_rows_and_sessions(self):
        self.query(seed.build_sql(self.ids, HASHES))
        self.assertEqual(self.query("""SELECT
            (SELECT COUNT(*) FROM account), (SELECT COUNT(*) FROM company),
            (SELECT COUNT(*) FROM partner_recruitment), (SELECT COUNT(*) FROM partner_proposal),
            (SELECT COUNT(*) FROM saved_support_program), (SELECT COUNT(*) FROM application_preparation),
            (SELECT COUNT(*) FROM combination_review), (SELECT COUNT(*) FROM account_admin_action);""").stdout.strip(),
            "7\t6\t5\t4\t20\t12\t12\t0")
        self.query("""UPDATE account SET password_hash='kept-password' WHERE email='member@govbiz.local';
            UPDATE partner_recruitment SET title='한글 수정 & 그대로', closed_at=NOW();
            UPDATE partner_proposal SET decision='ACCEPTED',responded_at=NOW();
            UPDATE company SET company_name='사용자 수정 기업';
            INSERT INTO account_session(token_hash,account_id,created_at,last_used_at,expires_at)
                SELECT REPEAT('a',64),id,NOW(),NOW(),DATE_ADD(NOW(),INTERVAL 1 DAY) FROM account WHERE email='member@govbiz.local';
            UPDATE application_preparation_content SET content_text='사용자가 편집한 본문';
        """)
        before = self.snapshot()
        self.query(seed.build_sql(self.ids, {}))
        self.assertEqual(before, self.snapshot())

    def test_late_failure_rolls_back_public_and_both_personal_seeds(self):
        before = self.snapshot()
        sql = seed.build_sql(self.ids, HASHES).replace("COMMIT;", "INSERT INTO production_demo_guard VALUES (FALSE);\nCOMMIT;")
        result = self.query(sql, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(before, self.snapshot())

    def test_existing_account_password_preserved_and_wrong_role_refused(self):
        self.query("INSERT INTO account(email,password_hash,role,terms_agreed_at) VALUES ('member@govbiz.local','existing','USER',NOW())")
        self.query(seed.build_sql(self.ids, HASHES))
        self.assertEqual(self.query("SELECT password_hash FROM account WHERE email='member@govbiz.local'").stdout.strip(), "existing")
        self.query("UPDATE account SET role='USER' WHERE email='admin@govbiz.local'")
        before = self.snapshot()
        self.assertNotEqual(self.query(seed.build_sql(self.ids, HASHES), check=False).returncode, 0)
        self.assertEqual(before, self.snapshot())

    def test_business_number_collision_does_not_touch_real_company(self):
        self.query("""INSERT INTO company(account_id,business_number,company_name,business_status,business_status_code,
            region,industry,founded_year,business_verified_at,created_at,updated_at)
            SELECT id,'2148812034','실제 기업','계속사업자','01','서울','IT',2020,NOW(),NOW(),NOW() FROM account WHERE email='real@example.test';""")
        before = self.snapshot()
        self.assertNotEqual(self.query(seed.build_sql(self.ids, HASHES), check=False).returncode, 0)
        self.assertEqual(before, self.snapshot())

    def test_missing_hash_or_expired_program_rolls_back_new_accounts(self):
        before = self.snapshot()
        self.assertNotEqual(self.query(seed.build_sql(self.ids, {}), check=False).returncode, 0)
        self.assertEqual(before, self.snapshot())
        self.query("UPDATE support_program SET application_end_date=CURDATE()")
        self.assertNotEqual(self.query(seed.build_sql(self.ids, HASHES), check=False).returncode, 0)
        self.assertEqual(before, self.snapshot())

    def test_simultaneous_runs_have_no_duplicates(self):
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda _: self.query(seed.build_sql(self.ids, HASHES), check=False), range(2)))
        for result in results:
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.query("SELECT COUNT(*) FROM application_preparation").stdout.strip(), "12")
        self.assertEqual(self.query("SELECT COUNT(*) FROM partner_recruitment").stdout.strip(), "5")

    def test_real_mysql_client_accepts_generated_options(self):
        with tempfile.TemporaryDirectory() as directory:
            ca = Path(directory) / "ca.pem"
            ca.touch()
            with seed.mysql_client({"user": "root", "password": "seed-test-only", "database": "seed_test"}, ca) as command:
                options = command[1].split("=", 1)[1]
                result = self.docker("cp", options, self.container + ":/tmp/production-seed-client.cnf")
                self.assertEqual(result.returncode, 0, result.stderr)
                command[1] = "--defaults-file=/tmp/production-seed-client.cnf"
                command[command.index("--protocol=TCP")] = "--protocol=SOCKET"
                # This test checks client options via a local socket, not TLS against Docker's
                # auto-generated certificate. The production command still requires VERIFY_IDENTITY.
                command[command.index("--ssl-mode=VERIFY_IDENTITY")] = "--ssl-mode=DISABLED"
                command = ["--ssl-ca=/var/lib/mysql/ca.pem" if arg.startswith("--ssl-ca=") else arg for arg in command]
                result = self.docker("exec", "-i", "-e", "MYSQL_TEST_LOGIN_FILE=/tmp/unused-login.cnf", self.container,
                                     *command, sql="SELECT 1;")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), "1")
