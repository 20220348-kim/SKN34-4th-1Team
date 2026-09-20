"""Exercise smoke-test cleanup guards with a fake Docker CLI; never touch Docker."""

from pathlib import Path
import importlib.util
import os
import re
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("verify-compose.sh")
BASH = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe" if os.name == "nt" else Path("/bin/bash")
FAKE_DOCKER = """#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$VERIFY_DOCKER_CALLS"
if [[ "${VERIFY_CHECK_SAFE_UPSTREAM_ENV:-false}" == "true" ]]; then
  [[ "$KSTARTUP_SYNC_ENABLED" == "true" ]] || exit 91
  [[ "$KSTARTUP_API_BASE_URL" == "http://kstartup-stub:8003" ]] || exit 92
  [[ "$KSTARTUP_API_KEY" == "compose%2Bstartup%2Fverification%3D" ]] || exit 93
  [[ "$KSTARTUP_SYNC_SCOPE" == "RECENT_YEAR" ]] || exit 94
  [[ "$BIZINFO_API_BASE_URL" == "http://bizinfo-stub:8001" ]] || exit 95
  [[ "$OPENAI_BASE_URL" == "http://openai-stub:8002/v1" ]] || exit 96
  [[ "$OPENAI_API_KEY" == "compose-verification-key-never-sent" ]] || exit 97
  [[ "$DEMO_SEED_ENABLED" == "false" && "$DEMO_SEED_FORCE" == "false" ]] || exit 115
  [[ "$MSIT_API_BASE_URL" == "http://public-notices-stub:8004" ]] || exit 98
  [[ "$MSIT_API_KEY" == "compose%2Bnotice%2Fverification%3D" ]] || exit 99
  [[ "$MSIT_SYNC_ENABLED" == "true" ]] || exit 100
  [[ "$MSIT_SYNC_INITIAL_DELAY" == "PT0S" && "$MSIT_SYNC_FIXED_DELAY" == "PT2S" ]] || exit 101
  [[ "$CNTRADE_NOTICE_API_BASE_URL" == "http://public-notices-stub:8004" ]] || exit 102
  [[ "$CNTRADE_NOTICE_API_KEY" == "compose%2Bnotice%2Fverification%3D" ]] || exit 103
  [[ "$CNTRADE_NOTICE_SYNC_ENABLED" == "true" ]] || exit 104
  [[ "$CNTRADE_NOTICE_SYNC_INITIAL_DELAY" == "PT0S" && "$CNTRADE_NOTICE_SYNC_FIXED_DELAY" == "PT2S" ]] || exit 105
  [[ "$DATA_GO_KR_SERVICE_KEY" == "compose%2Bverification%2Fkey%3D" ]] || exit 106
  [[ "$DAILY_REPORT_ENABLED" == "false" && "$DAILY_REPORT_MAIL_ENABLED" == "false" ]] || exit 107
  [[ -z "$DAILY_REPORT_FROM$SMTP_HOST$SMTP_USERNAME$SMTP_PASSWORD" ]] || exit 108
  [[ "$DAILY_REPORT_QUEUE_ENABLED" == "true" ]] || exit 109
  [[ "$DAILY_REPORT_DELIVERY_QUEUE_ENABLED" == "true" ]] || exit 112
  [[ "$ACCOUNT_OAUTH_UNLINK_ENABLED" == "true" && "$ACCOUNT_OAUTH_UNLINK_QUEUE_ENABLED" == "true" ]] || exit 113
  [[ -z "$ACCOUNT_OAUTH_KAKAO_ADMIN_KEY$ACCOUNT_OAUTH_KAKAO_CLIENT_ID$ACCOUNT_OAUTH_KAKAO_CLIENT_SECRET$ACCOUNT_OAUTH_GOOGLE_CLIENT_ID$ACCOUNT_OAUTH_GOOGLE_CLIENT_SECRET" ]] || exit 114
  [[ "$COMBINATION_REVIEW_QUEUE_ENABLED" == "true" ]] || exit 111
  [[ "$APPLICATION_FORM_DISCOVERY_QUEUE_ENABLED" == "true" ]] || exit 112
  [[ "$APPLICATION_FORM_ANALYSIS_ENABLED" == "false" ]] || exit 116
  [[ "$RABBITMQ_USERNAME" == "govbiz-verification" && "$RABBITMQ_PASSWORD" == "govbiz-verification-not-a-secret" ]] || exit 110
fi
case "$*" in
  *" config --quiet")
    if [[ "${VERIFY_CHECK_PORTS:-false}" == "true" ]]; then
      [[ "$WEB_HOST_PORT" == "$VERIFY_EXPECTED_WEB_PORT" ]] || exit 81
      [[ "$CORE_API_HOST_PORT" == "$VERIFY_EXPECTED_CORE_PORT" ]] || exit 82
      [[ "$APP_CORS_ALLOWED_ORIGIN" == "http://127.0.0.1:$VERIFY_EXPECTED_WEB_PORT" ]] || exit 83
    fi
    exit "${VERIFY_FAKE_CONFIG_EXIT:-0}"
    ;;
  "ps "*|"network ls "*|"volume ls "*)
    if [[ "$*" == "${VERIFY_FAKE_EXISTING_KIND:-none} "* ]]; then
      printf '%s\\n' existing-resource
    fi
    exit "${VERIFY_FAKE_INSPECT_EXIT:-0}"
    ;;
  *" up --build --detach --remove-orphans") exit 42 ;;
esac
exit 0
"""


class VerifyComposeSafetyTest(unittest.TestCase):
    def test_rabbit_healthcheck_does_not_create_a_root_owned_cookie_during_startup(self):
        compose = SCRIPT.parents[1] / "compose.yaml"
        self.assertIn('["CMD", "su-exec", "rabbitmq", "rabbitmq-diagnostics", "-q", "check_running"]',
                      compose.read_text(encoding="utf-8"))

    def test_http_checks_only_send_member_cookie_when_explicitly_selected(self):
        function = re.search(r"(?ms)^wait_for_http\(\) \{\n.*?^\}", SCRIPT.read_text(encoding="utf-8")).group()
        with tempfile.TemporaryDirectory(prefix="verify-http-test-") as directory:
            root = Path(directory)
            curl = root / "curl"
            curl.write_text("""#!/usr/bin/env bash
printf '%s\\n' "$@" > "$VERIFY_CURL_ARGS"
while (($#)); do
  if [[ "$1" == "--output" ]]; then printf '%s' '{"ok":true}' > "$2"; shift 2; else shift; fi
done
printf '%s' '200'
""", encoding="utf-8")
            curl.chmod(0o700)
            for member in ("false", "true"):
                with self.subTest(member=member):
                    result = subprocess.run(
                        [str(BASH), "-eu", "-c", function + '\nwait_for_http "fixture" "http://unused.invalid" 200'],
                        env={"PATH": f"{root}:/usr/bin:/bin", "RESPONSE_DIR": str(root),
                             "LAST_RESPONSE_FILE": str(root / "response"), "VERIFY_CURL_ARGS": str(root / "args"),
                             "WAIT_TIMEOUT_SECONDS": "3", "WAIT_INTERVAL_SECONDS": "1", "VERIFY_HTTP_MEMBER": member},
                        capture_output=True, text=True, timeout=5,
                    )
                    self.assertEqual(0, result.returncode, result.stderr)
                    arguments = (root / "args").read_text(encoding="utf-8").splitlines()
                    # The same helper checks Vite HTML as well as JSON API responses.
                    self.assertIn("Accept: */*", arguments)
                    self.assertEqual(member == "true", "--cookie" in arguments)

    def run_script(self, **overrides):
        with tempfile.TemporaryDirectory(prefix="verify-compose-test-") as directory:
            root = Path(directory)
            docker = root / "docker"
            docker.write_text(FAKE_DOCKER, encoding="utf-8")
            docker.chmod(0o700)
            calls = root / "calls"
            environment = {
                "PATH": f"{root}:/usr/bin:/bin",
                "TMPDIR": root.as_posix(),
                "VERIFY_DOCKER_CALLS": str(calls),
                "VERIFY_COMPOSE_PROJECT_NAME": "govbiz-safety-test",
                **overrides,
            }
            result = subprocess.run(
                [str(BASH), str(SCRIPT)], env=environment,
                capture_output=True, text=True, timeout=10,
            )
            return result, calls.read_text(encoding="utf-8") if calls.exists() else ""

    def assert_no_stack_mutation(self, calls):
        self.assertNotIn(" up ", calls)
        self.assertNotIn(" down ", calls)
        self.assertNotIn(" logs ", calls)

    def test_existing_project_resources_are_never_reused_or_deleted(self):
        for kind in ("ps", "network ls", "volume ls"):
            with self.subTest(kind=kind):
                result, calls = self.run_script(VERIFY_FAKE_EXISTING_KIND=kind)
                self.assertNotEqual(0, result.returncode)
                self.assertIn("already has", result.stderr)
                self.assert_no_stack_mutation(calls)

    def test_resource_inspection_failure_aborts_without_cleanup(self):
        result, calls = self.run_script(VERIFY_FAKE_INSPECT_EXIT="37")
        self.assertNotEqual(0, result.returncode)
        self.assert_no_stack_mutation(calls)

    def test_invalid_config_does_not_run_cleanup(self):
        result, calls = self.run_script(VERIFY_FAKE_CONFIG_EXIT="38")
        self.assertNotEqual(0, result.returncode)
        self.assert_no_stack_mutation(calls)

    def test_partially_started_new_project_is_cleaned_up(self):
        result, calls = self.run_script()
        self.assertEqual(42, result.returncode)
        self.assertIn(" up --build --detach --remove-orphans", calls)
        self.assertIn(" down --volumes --remove-orphans", calls)

    def test_keep_running_preserves_new_project_after_failure(self):
        result, calls = self.run_script(VERIFY_COMPOSE_KEEP_RUNNING="true")
        self.assertEqual(42, result.returncode)
        self.assertIn(" up --build --detach --remove-orphans", calls)
        self.assertNotIn(" down ", calls)

    def test_verification_overrides_all_developer_upstream_settings_before_compose(self):
        result, calls = self.run_script(
            VERIFY_CHECK_SAFE_UPSTREAM_ENV="true",
            KSTARTUP_SYNC_ENABLED="false",
            KSTARTUP_API_BASE_URL="https://must-not-call.invalid",
            KSTARTUP_API_KEY="must-not-use-real-startup-key",
            KSTARTUP_SYNC_SCOPE="OPEN",
            DATA_GO_KR_SERVICE_KEY="must-not-use-real-portal-key",
            MSIT_API_BASE_URL="https://must-not-call.invalid",
            MSIT_API_KEY="must-not-use-real-msit-key",
            MSIT_SYNC_ENABLED="false",
            MSIT_SYNC_INITIAL_DELAY="PT1H",
            MSIT_SYNC_FIXED_DELAY="PT12H",
            CNTRADE_NOTICE_API_BASE_URL="https://must-not-call.invalid",
            CNTRADE_NOTICE_API_KEY="must-not-use-real-cntrade-key",
            CNTRADE_NOTICE_SYNC_ENABLED="false",
            CNTRADE_NOTICE_SYNC_INITIAL_DELAY="PT1H",
            CNTRADE_NOTICE_SYNC_FIXED_DELAY="PT12H",
            BIZINFO_API_BASE_URL="https://must-not-call.invalid",
            OPENAI_BASE_URL="https://must-not-call.invalid/v1",
            OPENAI_API_KEY="must-not-use-real-model-key",
            DEMO_SEED_ENABLED="true",
            DEMO_SEED_FORCE="true",
            DAILY_REPORT_ENABLED="true",
            DAILY_REPORT_QUEUE_ENABLED="false",
            DAILY_REPORT_DELIVERY_QUEUE_ENABLED="false",
            ACCOUNT_OAUTH_UNLINK_ENABLED="false",
            ACCOUNT_OAUTH_UNLINK_QUEUE_ENABLED="false",
            ACCOUNT_OAUTH_KAKAO_ADMIN_KEY="must-not-use-real-admin-key",
            ACCOUNT_OAUTH_KAKAO_CLIENT_ID="must-not-use-real-kakao-id",
            ACCOUNT_OAUTH_KAKAO_CLIENT_SECRET="must-not-use-real-kakao-secret",
            ACCOUNT_OAUTH_GOOGLE_CLIENT_ID="must-not-use-real-google-id",
            ACCOUNT_OAUTH_GOOGLE_CLIENT_SECRET="must-not-use-real-google-secret",
            RABBITMQ_USERNAME="must-not-use-real-rabbit-user",
            RABBITMQ_PASSWORD="must-not-use-real-rabbit-password",
            DAILY_REPORT_MAIL_ENABLED="true",
            DAILY_REPORT_FROM="reports@example.org",
            SMTP_HOST="must-not-call.invalid",
            SMTP_USERNAME="must-not-use-real-smtp-user",
            SMTP_PASSWORD="must-not-use-real-smtp-password",
        )
        self.assertEqual(42, result.returncode)
        self.assertIn(" up --build --detach --remove-orphans", calls)
        self.assertIn(" down --volumes --remove-orphans", calls)

    def test_default_verification_ports_do_not_inherit_developer_service_ports(self):
        result, calls = self.run_script(
            VERIFY_CHECK_PORTS="true",
            VERIFY_EXPECTED_WEB_PORT="15173",
            VERIFY_EXPECTED_CORE_PORT="18080",
            WEB_HOST_PORT="5173",
            CORE_API_HOST_PORT="8080",
            APP_CORS_ALLOWED_ORIGIN="http://127.0.0.1:5173",
        )
        self.assertEqual(42, result.returncode)
        self.assertIn(" up --build --detach --remove-orphans", calls)

    def test_explicit_verification_ports_are_exported_with_matching_origin(self):
        result, calls = self.run_script(
            VERIFY_CHECK_PORTS="true",
            VERIFY_COMPOSE_WEB_HOST_PORT="25173",
            VERIFY_COMPOSE_CORE_API_HOST_PORT="28080",
            VERIFY_EXPECTED_WEB_PORT="25173",
            VERIFY_EXPECTED_CORE_PORT="28080",
        )
        self.assertEqual(42, result.returncode)
        self.assertIn(" up --build --detach --remove-orphans", calls)

    def test_all_http_probes_and_post_origin_use_the_verification_web_base_url(self):
        script = SCRIPT.read_text(encoding="utf-8")
        self.assertNotIn("http://127.0.0.1:5173", script)
        self.assertIn('--header "Origin: ${WEB_BASE_URL}"', script)
        for line in script.splitlines():
            if "/api/v1/" in line:
                self.assertIn("${WEB_BASE_URL}/api/v1/", line)

    def test_application_preparation_reads_forms_and_empty_list_before_creation(self):
        script = SCRIPT.read_text(encoding="utf-8")
        forms = '${WEB_BASE_URL}/api/v1/application-preparations/forms'
        listing = '${WEB_BASE_URL}/api/v1/application-preparations")'
        creation = '--data \'{"sourceCode":"BIZINFO"'

        self.assertIn(forms, script)
        self.assertIn(listing, script)
        self.assertLess(script.index(forms), script.index(creation))
        self.assertLess(script.index(listing), script.index(creation))


class PublicNoticeFixtureTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = SCRIPT.parent.parent / "stubs" / "public-notices" / "server.py"
        spec = importlib.util.spec_from_file_location("public_notice_fixture", path)
        cls.fixture = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.fixture)

    def query(self, page, msit):
        result = {"serviceKey": [self.fixture.EXPECTED_KEY], "pageNo": [str(page)],
                  "numOfRows": ["10" if msit else "1000"]}
        if msit:
            result["returnType"] = ["json"]
        return result

    def test_msit_fixture_preserves_split_envelope_and_complete_ten_plus_one_pages(self):
        pages = []
        for page in (1, 2):
            status, body = self.fixture.response_for(self.fixture.MSIT_PATH, self.query(page, True))
            self.assertEqual(200, status)
            self.assertEqual("00", body["response"][0]["header"]["resultCode"])
            value = body["response"][1]["body"]
            self.assertEqual(str(page), value["pageNo"])
            self.assertEqual(11, value["totalCount"])
            self.assertEqual(10, value["numOfRows"])
            pages.append(value["items"])
        self.assertEqual([10, 1], [len(page) for page in pages])
        self.assertEqual(11, len({item["item"]["viewUrl"] for page in pages for item in page}))
        self.assertEqual(1, sum("AI" in item["item"]["subject"] for page in pages for item in page))

    def test_cntrade_fixture_uses_documented_contract_and_server_capped_page_size(self):
        ids = []
        for page in (1, 2):
            status, body = self.fixture.response_for(self.fixture.CNTRADE_PATH, self.query(page, False))
            self.assertEqual(200, status)
            self.assertEqual("09", body["resultCode"])
            self.assertEqual("RETURN_SUCCESS", body["resultMsg"])
            self.assertEqual((page, 1, 2), (body["pageNo"], body["numOfRows"], body["totalCount"]))
            self.assertEqual(1, len(body["items"]))
            ids.extend(item["lbbNo"] for item in body["items"])
        self.assertEqual([900001, 900002], ids)

    def test_fixture_rejects_unexpected_credentials_parameters_pages_and_paths_without_echoing_secrets(self):
        for path, msit in ((self.fixture.MSIT_PATH, True), (self.fixture.CNTRADE_PATH, False)):
            invalid_queries = [
                {**self.query(1, msit), "serviceKey": ["secret-that-must-not-be-echoed"]},
                {**self.query(1, msit), "extra": ["secret-that-must-not-be-echoed"]},
                self.query(3, msit),
            ]
            for query in invalid_queries:
                status, response = self.fixture.response_for(path, query)
                self.assertEqual(400, status)
                self.assertNotIn("secret-that-must-not-be-echoed", str(response))
        self.assertEqual(404, self.fixture.response_for("/unexpected", {})[0])
        self.assertEqual((200, {"status": "up"}), self.fixture.response_for("/health", {}))


if __name__ == "__main__":
    unittest.main()
