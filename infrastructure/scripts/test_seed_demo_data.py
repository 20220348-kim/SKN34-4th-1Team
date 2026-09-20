"""Exercise the demo-data seed script guards and check the SQL only replaces scoped local demo data."""

from pathlib import Path
import os
import re
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("seed-demo-data.sh")
SEED_FILE = Path(__file__).parents[1] / "seed" / "demo-data.sql"
APPLICATION_SEED_FILE = SEED_FILE.with_name("application-preparations.sql")
COMBINATION_SEED_FILE = SEED_FILE.with_name("combination-reviews.sql")
BASH = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe" if os.name == "nt" else Path("/bin/bash")
FAKE_DOCKER = r"""#!/usr/bin/env bash
printf '%s\n' "$*" >> "$SEED_DOCKER_CALLS"
case "$*" in
  *" ps --services --status running") printf '%s\n' ${SEED_RUNNING_SERVICES-mysql qdrant ai-service core-service web};;
  *" run --rm -e DEMO_SEED_FORCE=true demo-seed") :;;
esac
exit 0
"""


class SeedDemoDataTest(unittest.TestCase):
    def run_script(self, **overrides):
        with tempfile.TemporaryDirectory(prefix="seed-demo-data-test-") as directory:
            root = Path(directory)
            docker = root / "docker"
            docker.write_text(FAKE_DOCKER, encoding="utf-8")
            docker.chmod(0o700)
            env_file = root / "env"
            env_file.write_text("MYSQL_DATABASE=govbiz\n", encoding="utf-8")
            calls = root / "calls"
            stdin_copy = root / "stdin"
            environment = {
                "PATH": f"{root}:/usr/bin:/bin",
                "TMPDIR": root.as_posix(),
                "SEED_DOCKER_CALLS": str(calls),
                "SEED_STDIN_COPY": str(stdin_copy),
                "GOVBIZ_ENV_FILE": str(env_file),
                **overrides,
            }
            result = subprocess.run(
                [str(BASH), str(SCRIPT)],
                cwd=SCRIPT.parents[2],
                env=environment,
                capture_output=True,
                text=True,
                timeout=10,
            )
            calls_text = calls.read_text(encoding="utf-8") if calls.exists() else ""
            stdin_text = stdin_copy.read_text(encoding="utf-8") if stdin_copy.exists() else ""
            return result, calls_text, stdin_text

    def test_runs_the_compose_demo_seed_service_with_force_enabled(self):
        result, calls, stdin = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("run --rm -e DEMO_SEED_FORCE=true demo-seed", calls)
        self.assertEqual(stdin, "")

    def test_refuses_when_mysql_or_core_api_is_not_running(self):
        result, calls, stdin = self.run_script(SEED_RUNNING_SERVICES="mysql qdrant web")
        self.assertEqual(result.returncode, 1)
        self.assertIn("core-service", result.stderr)
        self.assertNotIn("exec", calls)
        self.assertEqual(stdin, "")

    def test_refuses_without_env_file(self):
        result, calls, _ = self.run_script(GOVBIZ_ENV_FILE="/nonexistent/env")
        self.assertEqual(result.returncode, 1)
        self.assertIn("Missing", result.stderr)
        self.assertEqual(calls, "")

    def test_seed_sql_only_deletes_demo_rows(self):
        sql = SEED_FILE.read_text(encoding="utf-8")
        deletes = re.findall(r"^DELETE[^;]*;", sql, flags=re.MULTILINE | re.DOTALL)
        self.assertEqual(len(deletes), 4, deletes)
        self.assertIn("email LIKE '%@demo.govbiz.local'", deletes[0])
        for table in ("company", "saved_support_program"):
            statement = next(delete for delete in deletes if f"DELETE {table}" in delete)
            self.assertIn("'admin@govbiz.local', 'member@govbiz.local'", statement)
        admin_actions = next(delete for delete in deletes if "account_admin_action" in delete)
        self.assertIn("email = 'admin@govbiz.local'", admin_actions)
        self.assertNotIn("DELETE combination_review", sql)
        self.assertNotIn("DELETE application_preparation", sql)
        # 모집글은 실제 공고 행에 붙으므로 공고 테이블은 읽기만 합니다.
        self.assertNotRegex(sql, r"(?i)(INSERT INTO|DELETE FROM|UPDATE)\s+support_program\b")
        demo_emails = set(re.findall(r"'([a-z.]+@demo\.govbiz\.local)'", sql))
        self.assertEqual(len(demo_emails), 4)
        # 직접 가입한 실제 이메일은 데모 자료에 넣지 않습니다. 허용 도메인은 govbiz.local뿐입니다.
        for email in re.findall(r"[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", sql):
            self.assertTrue(email.endswith("govbiz.local"), email)

    def test_seed_includes_working_review_and_application_preparation_scenarios(self):
        public_sql = SEED_FILE.read_text(encoding="utf-8")
        application_sql = APPLICATION_SEED_FILE.read_text(encoding="utf-8")
        combination_sql = COMBINATION_SEED_FILE.read_text(encoding="utf-8")
        sql = public_sql + application_sql + combination_sql
        self.assertNotIn("INSERT INTO combination_review (", public_sql)
        self.assertNotIn("INSERT INTO application_preparation (", public_sql)
        self.assertIn("INSERT INTO combination_review (", sql)
        self.assertIn("INSERT INTO combination_review_run (", sql)
        self.assertIn("INSERT INTO combination_review_run_source", sql)
        self.assertIn("'demo-seed-no-paid-call'", sql)
        for stage in ("APPLICATION", "SELECTION", "COMMITMENT", "AGREEMENT", "EXECUTION", "FUNDING"):
            self.assertIn(f"'stage', '{stage}'", sql)
        self.assertIn("INSERT INTO application_preparation (", sql)
        self.assertIn("INSERT INTO application_preparation_fact (", sql)
        self.assertIn("INSERT INTO application_preparation_content (", sql)
        self.assertIn("bizinfo-pbln-000000000118979-innovation-voucher-2026-v1", sql)
        for personal_sql in (application_sql, combination_sql):
            self.assertIn("demo_seed_target_account", personal_sql)
            self.assertIn("COALESCE(@reset_personal_demo_data, 0) = 1", personal_sql)
            self.assertRegex(personal_sql, r"DELETE (preparation|review)[\s\S]+demo_seed_key IN")
            self.assertIn("account.role IN ('USER', 'ADMIN')", personal_sql)
            self.assertIn("account.email IN ('admin@govbiz.local', 'member@govbiz.local')", personal_sql)

    def test_compose_entrypoint_waits_for_programs_and_respects_the_switch(self):
        entrypoint = SCRIPT.with_name("seed-demo-data-entrypoint.sh").read_text(encoding="utf-8")
        self.assertNotIn("\r", entrypoint, "entrypoint must stay LF-terminated for the container")
        self.assertIn('if [ "${DEMO_SEED_ENABLED:-false}" != "true" ]', entrypoint)
        self.assertIn("application_end_date >= DATE_ADD(CURDATE(), INTERVAL 21 DAY)", entrypoint)
        # 기존 계정은 보존하며 두 개인 seed만 보충합니다. 강제 실행만 공용 데이터를 다시 넣습니다.
        self.assertIn('if [ "${DEMO_SEED_FORCE:-false}" != "true" ]', entrypoint)
        self.assertIn("jihoon.park@demo.govbiz.local", entrypoint)
        self.assertIn("combination-reviews.sql", entrypoint)
        self.assertIn("DEMO_SEED_TARGET_EMAILS", entrypoint)
        self.assertIn("CONVERT(X'", entrypoint)
        self.assertIn("jihoon.park@demo.govbiz.local", SEED_FILE.read_text(encoding="utf-8"))
        compose = (SCRIPT.parents[1] / "compose.yaml").read_text(encoding="utf-8")
        self.assertIn("demo-seed:", compose)
        self.assertIn("DEMO_SEED_ENABLED: ${DEMO_SEED_ENABLED:-true}", compose)
        self.assertIn("DEMO_SEED_FORCE: ${DEMO_SEED_FORCE:-false}", compose)
        self.assertIn('DEMO_SEED_TARGET_EMAILS: "${DEMO_SEED_TARGET_EMAILS:-}"', compose)


class SeedEntrypointTest(unittest.TestCase):
    @staticmethod
    def personal_seed_input(path, target_emails="", reset=False):
        target_hex = target_emails.encode("utf-8").hex()
        return (
            f"SET @demo_seed_target_emails = CONVERT(X'{target_hex}' USING utf8mb4);\n"
            f"SET @reset_personal_demo_data = {1 if reset else 0};\n"
            + path.read_text(encoding="utf-8")
        )

    def run_entrypoint(
        self, existing="1", query_failure=False, load_failure=False, enabled="true", force="false",
        target_emails="",
    ):
        with tempfile.TemporaryDirectory(prefix="seed-entrypoint-") as directory:
            root = Path(directory)
            mysql = root / "mysql"
            mysql.write_text('''#!/usr/bin/env bash
case "$*" in
  *" -e "*)
    [ "$QUERY_FAILURE" = true ] && exit 9
    case "$*" in *"FROM account"*) echo "$EXISTING";; *) echo 6;; esac;;
  *) cat >> "$CAPTURE"; [ "$LOAD_FAILURE" = true ] && exit 8;;
esac
exit 0
''', encoding="utf-8")
            mysql.chmod(0o700)
            capture = root / "capture"
            env = {
                "PATH": f"{root}:/usr/bin:/bin", "CAPTURE": str(capture), "EXISTING": existing,
                "QUERY_FAILURE": str(query_failure).lower(), "LOAD_FAILURE": str(load_failure).lower(),
                "DEMO_SEED_ENABLED": enabled, "DEMO_SEED_FORCE": force,
                "DEMO_SEED_TARGET_EMAILS": target_emails,
                "DEMO_SEED_FILE": SEED_FILE.as_posix(),
                "MYSQL_USER": "test", "MYSQL_PASSWORD": "test", "MYSQL_DATABASE": "test",
            }
            result = subprocess.run([str(BASH), str(SCRIPT.with_name("seed-demo-data-entrypoint.sh"))],
                                    env=env, capture_output=True, text=True, timeout=10)
            return result, capture.read_text(encoding="utf-8") if capture.exists() else ""

    def test_existing_account_loads_both_incremental_seeds(self):
        result, sql = self.run_entrypoint()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            sql,
            self.personal_seed_input(APPLICATION_SEED_FILE)
            + self.personal_seed_input(COMBINATION_SEED_FILE),
        )
        self.assertNotIn(SEED_FILE.read_text(encoding="utf-8"), sql)

    def test_new_database_and_force_load_all_three_files_in_order(self):
        for options in ({"existing": "0"}, {"force": "true"}):
            with self.subTest(options=options):
                result, sql = self.run_entrypoint(**options)
                self.assertEqual(result.returncode, 0, result.stderr)
                reset = options.get("force") == "true"
                self.assertEqual(
                    sql,
                    SEED_FILE.read_text(encoding="utf-8")
                    + self.personal_seed_input(APPLICATION_SEED_FILE, reset=reset)
                    + self.personal_seed_input(COMBINATION_SEED_FILE, reset=reset),
                )

    def test_target_emails_are_hex_encoded_before_reaching_sql(self):
        targets = "presentation@govbiz.local,member@govbiz.local"
        result, sql = self.run_entrypoint(target_emails=targets)
        self.assertEqual(result.returncode, 0, result.stderr)
        expected_prefix = f"SET @demo_seed_target_emails = CONVERT(X'{targets.encode('utf-8').hex()}' USING utf8mb4);"
        self.assertEqual(sql.count(expected_prefix), 2)

    def test_disabled_does_not_load(self):
        result, sql = self.run_entrypoint(enabled="false")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(sql, "")

    def test_query_failure_never_falls_through_to_destructive_seed(self):
        result, sql = self.run_entrypoint(query_failure=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(sql, "")

    def test_incremental_load_failure_is_reported(self):
        result, _ = self.run_entrypoint(load_failure=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("ready", result.stdout)


if __name__ == "__main__":
    unittest.main()
