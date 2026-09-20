"""Opt-in MySQL 8.4 checks for per-account application and combination-review demo seeds.

RUN_SEED_MYSQL_TESTS=1 python -m unittest discover -s infrastructure/scripts -p test_application_seed_mysql.py
"""
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import subprocess
import time
import unittest
import uuid


ROOT = Path(__file__).resolve().parents[2]
APPLICATION_SEED = ROOT / "infrastructure/seed/application-preparations.sql"
COMBINATION_SEED = ROOT / "infrastructure/seed/combination-reviews.sql"


@unittest.skipUnless(os.environ.get("RUN_SEED_MYSQL_TESTS") == "1", "requires explicit disposable Docker MySQL test")
class PersonalDemoSeedMySqlTest(unittest.TestCase):
    @classmethod
    def docker(cls, *args, sql=None):
        return subprocess.run(
            [os.environ.get("SEED_TEST_DOCKER", "docker"), *args],
            input=sql,
            text=True,
            encoding="utf-8",
            capture_output=True,
            timeout=90,
        )

    @classmethod
    def query(cls, sql, check=True):
        result = cls.docker(
            "exec", "-i", cls.container, "mysql", "-uroot", "-pseed-test-only",
            "--default-character-set=utf8mb4", "-N", "-B", "seed_test", sql=sql,
        )
        if check and result.returncode:
            raise AssertionError(result.stderr)
        return result

    @classmethod
    def setUpClass(cls):
        cls.container = "govbiz-personal-demo-seed-test-" + uuid.uuid4().hex[:10]
        result = cls.docker(
            "run", "-d", "--name", cls.container, "--tmpfs", "/var/lib/mysql",
            "-e", "MYSQL_ROOT_PASSWORD=seed-test-only", "-e", "MYSQL_DATABASE=seed_test", "mysql:8.4",
        )
        if result.returncode:
            raise AssertionError(result.stderr)
        cls.addClassCleanup(cls.docker, "rm", "-f", "-v", cls.container)
        for _ in range(60):
            if cls.query("SELECT 1", check=False).returncode == 0:
                break
            time.sleep(1)
        else:
            raise AssertionError("MySQL did not become ready")

        migrations = ROOT / "backend/core-service/src/main/resources/db/migration"
        for version in (1, 5, 10, 11, 15, 16, 25, 30, 31, 35, 37):
            path, = migrations.glob(f"V{version}__*.sql")
            cls.query(path.read_text(encoding="utf-8"))
        cls.query("""
            INSERT INTO support_program (
                source_code, source_program_id, title, organization, summary, categories, regions,
                target_description, application_period_raw, application_end_date, source_url
            ) VALUES
                ('BIZINFO', 'PROGRAM-1', '공고 1', '기관', '요약', JSON_ARRAY(), JSON_ARRAY(), '대상', '상시', '2027-12-31', 'https://example.test/1'),
                ('BIZINFO', 'PROGRAM-2', '공고 2', '기관', '요약', JSON_ARRAY(), JSON_ARRAY(), '대상', '상시', '2027-11-30', 'https://example.test/2'),
                ('BIZINFO', 'PROGRAM-3', '공고 3', '기관', '요약', JSON_ARRAY(), JSON_ARRAY(), '대상', '상시', '2027-10-31', 'https://example.test/3'),
                ('BIZINFO', 'PROGRAM-4', '공고 4', '기관', '요약', JSON_ARRAY(), JSON_ARRAY(), '대상', '상시', '2027-09-30', 'https://example.test/4');
        """)

    def setUp(self):
        self.query("""
            DELETE FROM account;
            INSERT INTO account(email, password_hash, role, terms_agreed_at) VALUES
                ('member@govbiz.local', 'test', 'USER', NOW()),
                ('alpha@demo.govbiz.local', 'test', 'USER', NOW()),
                ('beta@demo.govbiz.local', 'test', 'USER', NOW()),
                ('other@example.test', 'test', 'USER', NOW()),
                ('admin@govbiz.local', 'test', 'ADMIN', NOW());
        """)

    @staticmethod
    def seed_variables(target_emails="", reset=False):
        target_hex = target_emails.encode("utf-8").hex()
        return (
            f"SET @demo_seed_target_emails = CONVERT(X'{target_hex}' USING utf8mb4);\n"
            f"SET @reset_personal_demo_data = {1 if reset else 0};\n"
        )

    def seed(self, target_emails="", reset=False, check=True):
        prefix = self.seed_variables(target_emails, reset)
        return self.query(
            prefix + APPLICATION_SEED.read_text(encoding="utf-8")
            + prefix + COMBINATION_SEED.read_text(encoding="utf-8"),
            check=check,
        )

    def snapshot(self):
        return self.query("""
            SELECT * FROM account ORDER BY id;
            SELECT * FROM application_preparation ORDER BY id;
            SELECT * FROM application_preparation_fact ORDER BY id;
            SELECT * FROM application_preparation_content ORDER BY id;
            SELECT * FROM combination_review ORDER BY id;
            SELECT * FROM combination_review_program ORDER BY review_id, position;
            SELECT * FROM combination_review_run ORDER BY id;
            SELECT * FROM combination_review_run_source ORDER BY run_id, document_index;
        """).stdout

    def count_by_email(self, table):
        return self.query(f"""
            SELECT account.email, COUNT(item.id)
            FROM account
            LEFT JOIN {table} item ON item.owner_account_id = account.id AND item.demo_seed_key IS NOT NULL
            WHERE account.email IN (
                'admin@govbiz.local', 'member@govbiz.local',
                'alpha@demo.govbiz.local', 'beta@demo.govbiz.local'
            )
            GROUP BY account.id, account.email ORDER BY account.email;
        """).stdout.strip().splitlines()

    def test_default_mode_creates_independent_complete_demos_for_admin_and_member(self):
        self.seed()
        expected = [
            "admin@govbiz.local\t2",
            "alpha@demo.govbiz.local\t0",
            "beta@demo.govbiz.local\t0",
            "member@govbiz.local\t2",
        ]
        self.assertEqual(self.count_by_email("application_preparation"), expected)
        self.assertEqual(self.count_by_email("combination_review"), expected)
        counts = self.query("""
            SELECT
                (SELECT COUNT(*) FROM application_preparation_fact),
                (SELECT COUNT(*) FROM application_preparation_content),
                (SELECT COUNT(*) FROM combination_review_program),
                (SELECT COUNT(*) FROM combination_review_run),
                (SELECT COUNT(*) FROM combination_review_run_source);
        """).stdout.strip()
        self.assertEqual(counts, "22\t4\t8\t2\t4")
        self.assertEqual(
            self.query("SELECT JSON_LENGTH(analysis_json->'$.pairs[0].stages') FROM combination_review_run").stdout.strip(),
            "6\n6",
        )
        self.assertEqual(
            self.query("""SELECT COUNT(DISTINCT owner_account_id) FROM combination_review
                WHERE demo_seed_key = 'combination-review-completed-v1'""").stdout.strip(),
            "2",
        )

    def test_repeated_seed_is_idempotent_and_preserves_every_existing_row(self):
        self.seed()
        before = self.snapshot()
        self.seed()
        self.assertEqual(self.snapshot(), before)

    def test_null_key_user_data_and_existing_demo_edits_are_preserved(self):
        self.seed("member@govbiz.local")
        owner = self.query("SELECT id FROM account WHERE email='member@govbiz.local'").stdout.strip()
        self.query(f"""
            INSERT INTO application_preparation (
                owner_account_id, source_code, source_program_id, form_version_id, service_field,
                input_revision, progress_stage, progress_revision, progress_stage_updated_at, created_at, updated_at
            ) VALUES ({owner}, 'BIZINFO', 'USER-PROGRAM', 'user-form', 'MARKETING', 7, 'APPLIED', 2, NOW(), NOW(), NOW());
            INSERT INTO combination_review (owner_account_id, title, input_revision, created_at, updated_at)
            VALUES ({owner}, '사용자가 만든 검토', 3, NOW(), NOW());
            UPDATE application_preparation
            SET input_revision=99, progress_stage='APPLIED'
            WHERE owner_account_id={owner} AND demo_seed_key='innovation-voucher-marketing-v1';
            UPDATE combination_review
            SET title='사용자가 수정한 목업 제목', input_revision=9
            WHERE owner_account_id={owner} AND demo_seed_key='combination-review-draft-v1';
        """)
        before = self.snapshot()
        self.seed("member@govbiz.local")
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(
            self.query("SELECT COUNT(*) FROM application_preparation WHERE demo_seed_key IS NULL").stdout.strip(), "1"
        )
        self.assertEqual(
            self.query("SELECT COUNT(*) FROM combination_review WHERE demo_seed_key IS NULL").stdout.strip(), "1"
        )

    def test_override_targets_only_requested_accounts_and_keeps_previous_targets(self):
        self.seed("member@govbiz.local")
        self.assertEqual(
            self.count_by_email("application_preparation"),
            ["admin@govbiz.local\t0", "alpha@demo.govbiz.local\t0", "beta@demo.govbiz.local\t0", "member@govbiz.local\t2"],
        )
        member_before = self.snapshot()
        self.seed(" alpha@demo.govbiz.local ")
        self.assertEqual(
            self.count_by_email("combination_review"),
            ["admin@govbiz.local\t0", "alpha@demo.govbiz.local\t2", "beta@demo.govbiz.local\t0", "member@govbiz.local\t2"],
        )
        for line in member_before.splitlines():
            self.assertIn(line, self.snapshot().splitlines())

    def test_multiple_override_targets_are_supported_and_missing_target_fails_without_writes(self):
        self.seed("member@govbiz.local, alpha@demo.govbiz.local")
        self.assertEqual(
            self.count_by_email("combination_review"),
            ["admin@govbiz.local\t0", "alpha@demo.govbiz.local\t2", "beta@demo.govbiz.local\t0", "member@govbiz.local\t2"],
        )
        before = self.snapshot()
        result = self.seed("missing@govbiz.local", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.snapshot(), before)

    def test_deleted_demo_parents_and_children_are_recreated(self):
        self.seed()
        admin_before = self.query("""SELECT review.id, review.title FROM combination_review review
            JOIN account ON account.id=review.owner_account_id
            WHERE account.email='admin@govbiz.local' ORDER BY review.id""").stdout
        self.query("""
            DELETE preparation FROM application_preparation preparation
            JOIN account ON account.id=preparation.owner_account_id
            WHERE account.email='member@govbiz.local'
              AND preparation.demo_seed_key='innovation-voucher-marketing-v1';
            DELETE review FROM combination_review review
            JOIN account ON account.id=review.owner_account_id
            WHERE account.email='member@govbiz.local'
              AND review.demo_seed_key='combination-review-completed-v1';
        """)
        self.seed("member@govbiz.local")
        self.assertEqual(self.count_by_email("application_preparation")[-1], "member@govbiz.local\t2")
        self.assertEqual(self.count_by_email("combination_review")[-1], "member@govbiz.local\t2")
        restored = self.query("""
            SELECT
                (SELECT COUNT(*) FROM combination_review_program program WHERE program.review_id=review.id),
                (SELECT COUNT(*) FROM combination_review_run run WHERE run.review_id=review.id),
                (SELECT COUNT(*) FROM combination_review_run_source source
                    JOIN combination_review_run run ON run.id=source.run_id WHERE run.review_id=review.id)
            FROM combination_review review
            JOIN account ON account.id=review.owner_account_id
            WHERE account.email='member@govbiz.local'
              AND review.demo_seed_key='combination-review-completed-v1';
        """).stdout.strip()
        self.assertEqual(restored, "2\t1\t2")
        self.assertEqual(
            self.query("""SELECT review.id, review.title FROM combination_review review
                JOIN account ON account.id=review.owner_account_id
                WHERE account.email='admin@govbiz.local' ORDER BY review.id""").stdout,
            admin_before,
        )

    def test_force_reset_replaces_only_keyed_rows_for_selected_account(self):
        self.seed()
        owner = self.query("SELECT id FROM account WHERE email='member@govbiz.local'").stdout.strip()
        self.query(f"""INSERT INTO combination_review (owner_account_id, title, created_at, updated_at)
            VALUES ({owner}, '보존할 실제 검토', NOW(), NOW())""")
        admin_before = self.query("""SELECT * FROM combination_review review JOIN account
            ON account.id=review.owner_account_id WHERE account.email='admin@govbiz.local' ORDER BY review.id""").stdout
        self.seed("member@govbiz.local", reset=True)
        self.assertEqual(
            self.query(f"SELECT COUNT(*) FROM combination_review WHERE owner_account_id={owner} AND demo_seed_key IS NULL").stdout.strip(),
            "1",
        )
        self.assertEqual(
            self.query("""SELECT * FROM combination_review review JOIN account
                ON account.id=review.owner_account_id WHERE account.email='admin@govbiz.local' ORDER BY review.id""").stdout,
            admin_before,
        )

    def test_mid_application_seed_error_rolls_back_and_retry_succeeds(self):
        sql = APPLICATION_SEED.read_text(encoding="utf-8").replace(
            "INSERT INTO application_preparation_content (",
            "INSERT INTO nonexistent_seed_table VALUES (1);\nINSERT INTO application_preparation_content (",
            1,
        )
        before = self.snapshot()
        result = self.query(self.seed_variables("member@govbiz.local") + sql, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.snapshot(), before)
        self.seed("member@govbiz.local")
        self.assertEqual(self.count_by_email("application_preparation")[-1], "member@govbiz.local\t2")

    def test_concurrent_seed_does_not_duplicate(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.seed(), range(2)))
        self.assertTrue(all(result.returncode == 0 for result in results))
        self.assertEqual(
            self.query("SELECT COUNT(*) FROM application_preparation WHERE demo_seed_key IS NOT NULL").stdout.strip(), "4"
        )
        self.assertEqual(
            self.query("SELECT COUNT(*) FROM combination_review WHERE demo_seed_key IS NOT NULL").stdout.strip(), "4"
        )


if __name__ == "__main__":
    unittest.main()
