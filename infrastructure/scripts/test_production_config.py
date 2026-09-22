"""운영 Compose 정적 계약. config 해석만 하며 Docker Engine/외부 API를 사용하지 않는다."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import unittest

SCRIPT_DIR = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("check_production", SCRIPT_DIR / "check-production.py")
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class ProductionConfigTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Docker Desktop locates CLI plugins through the Windows user profile.
        # Retain OS paths without inheriting any application credentials.
        system_paths = {"PATH", "HOME", "DOCKER_CONFIG", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "TEMP", "TMP"}
        cls.env = {key: value for key, value in os.environ.items() if key.upper() in system_paths}
        cls.env.update({
            "CORE_API_IMAGE": "example/core:test-release", "AI_SERVICE_IMAGE": "example/ai:test-release",
            "ELASTICSEARCH_IMAGE": "example/nori:test-release", "NGINX_IMAGE": "nginx:test-release",
            "GOVBIZ_FRONTEND_ORIGIN": "https://govbiz-test.vercel.app", "EC2_PRIVATE_IP": "10.0.1.20",
            "RDS_HOST": "govbiz.test.ap-southeast-2.rds.amazonaws.com", "MYSQL_USER": "govbiz",
            "MYSQL_PASSWORD": "test-database-password", "RDS_TRUSTSTORE_PATH": "/tmp/not-a-real-truststore.p12",
            "GOVBIZ_PROXY_SECRET": "a" * 64, "ACCOUNT_JWT_SECRET": "b" * 64,
            "REDIS_PASSWORD": "c" * 64, "RABBITMQ_PASSWORD": "d" * 64, "QDRANT_API_KEY": "e" * 64,
            "OPENAI_API_KEY": "test-never-sent",
        })
        result = subprocess.run(["docker", "compose", "--env-file", os.devnull, "-f", str(checker.COMPOSE),
                                 "config", "--format", "json"], env=cls.env, capture_output=True, text=True, encoding="utf-8")
        if result.returncode:
            raise AssertionError("더미 값으로 운영 Compose를 해석하지 못했습니다: " + result.stderr)
        cls.config = json.loads(result.stdout)

    def test_valid_config(self):
        self.assertEqual(checker.validate(self.config), [])

    def test_document_token_reaches_core_and_ai_without_a_windows_bridge(self):
        token = "document-test-only-" * 3
        result = subprocess.run(["docker", "compose", "--env-file", os.devnull, "-f", str(checker.COMPOSE),
                                 "config", "--format", "json"], env={**self.env, "DOCUMENT_INTERNAL_TOKEN": token},
                                capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0)
        services = json.loads(result.stdout)["services"]
        for name, service in services.items():
            environment = service.get("environment", {})
            if name in {"core-service", "ai-service"}:
                self.assertEqual(environment["DOCUMENT_INTERNAL_TOKEN"], token)
            else:
                self.assertNotIn("DOCUMENT_INTERNAL_TOKEN", environment)
            self.assertNotIn("DOCUMENT_HWP_BRIDGE_URL", environment)
            self.assertNotIn("DOCUMENT_HWP_BRIDGE_TOKEN", environment)

    def test_assistant_disabled_by_default(self):
        self.assertEqual(self.config["services"]["core-service"]["environment"]["ASSISTANT_AGENT_ENABLED"], "false")
        for name in ("core-service", "ai-service"):
            self.assertEqual(self.config["services"][name]["environment"]["ASSISTANT_TOOLS_TOKEN"], "")

    def test_assistant_server_token_is_forwarded_to_both_services_only(self):
        token = "dummy-server-only-assistant-token-" * 2
        result = subprocess.run(["docker", "compose", "--env-file", os.devnull, "-f", str(checker.COMPOSE),
                                 "config", "--format", "json"],
                                env={**self.env, "ASSISTANT_AGENT_ENABLED": "true", "ASSISTANT_TOOLS_TOKEN": token},
                                capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0)
        config = json.loads(result.stdout)
        self.assertEqual(checker.validate(config), [])
        for name, service in config["services"].items():
            if name in {"core-service", "ai-service"}:
                self.assertEqual(service["environment"]["ASSISTANT_TOOLS_TOKEN"], token)
            else:
                self.assertNotIn("ASSISTANT_TOOLS_TOKEN", service.get("environment", {}))
        for name, key, value in [("core-service", "ASSISTANT_TOOLS_TOKEN", "short"),
                                 ("ai-service", "ASSISTANT_TOOLS_TOKEN", "different-token-" * 3),
                                 ("ai-service", "ASSISTANT_TOOLS_BASE_URL", "http://127.0.0.1:8080"),
                                 ("core-service", "ASSISTANT_AGENT_ENABLED", "yes")]:
            with self.subTest(service=name, key=key):
                invalid = copy.deepcopy(config)
                invalid["services"][name]["environment"][key] = value
                self.assertTrue(checker.validate(invalid))

    def test_default_schedulers_do_not_start_paid_work(self):
        env = self.config["services"]["core-service"]["environment"]
        for key in ["BIZINFO_SYNC_ENABLED", "KSTARTUP_SYNC_ENABLED", "MSIT_SYNC_ENABLED",
                    "CNTRADE_NOTICE_SYNC_ENABLED", "SUPPORT_PROGRAM_INDEX_ENABLED", "DAILY_REPORT_ENABLED",
                    "DAILY_REPORT_MAIL_ENABLED", "ACCOUNT_PASSWORD_RESET_MAIL_ENABLED", "ACCOUNT_EMAIL_VERIFICATION_MAIL_ENABLED",
                    "DAILY_REPORT_QUEUE_ENABLED", "DAILY_REPORT_DELIVERY_QUEUE_ENABLED",
                    "COMBINATION_REVIEW_QUEUE_ENABLED", "APPLICATION_FORM_DISCOVERY_QUEUE_ENABLED",
                    "ACCOUNT_OAUTH_UNLINK_QUEUE_ENABLED", "ACCOUNT_OAUTH_UNLINK_ENABLED"]:
            self.assertEqual(env[key], "false", key)

    def test_document_token_is_empty_by_default(self):
        for name in ("core-service", "ai-service"):
            self.assertEqual(self.config["services"][name]["environment"]["DOCUMENT_INTERNAL_TOKEN"], "")

    def test_document_token_is_forwarded_to_core_and_ai_only(self):
        token = "dummy-document-token-for-config-test-" * 2
        result = subprocess.run(["docker", "compose", "--env-file", os.devnull, "-f", str(checker.COMPOSE),
                                 "config", "--format", "json"],
                                env={**self.env, "DOCUMENT_INTERNAL_TOKEN": token},
                                capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0)
        config = json.loads(result.stdout)
        self.assertEqual(checker.validate(config), [])
        for name, service in config["services"].items():
            if name in {"core-service", "ai-service"}:
                self.assertEqual(service["environment"]["DOCUMENT_INTERNAL_TOKEN"], token)
            else:
                self.assertNotIn("DOCUMENT_INTERNAL_TOKEN", service.get("environment", {}))
        for name, value in [("core-service", ""), ("ai-service", ""),
                            ("core-service", "short"), ("ai-service", "different-token-" * 3)]:
            with self.subTest(service=name):
                invalid = copy.deepcopy(config)
                invalid["services"][name]["environment"]["DOCUMENT_INTERNAL_TOKEN"] = value
                self.assertTrue(checker.validate(invalid))
        for value in ("short", " " * 64):
            invalid = copy.deepcopy(config)
            for name in ("core-service", "ai-service"):
                invalid["services"][name]["environment"]["DOCUMENT_INTERNAL_TOKEN"] = value
            self.assertTrue(checker.validate(invalid))

    def mail_config(self):
        environment = {**self.env,
                       "ACCOUNT_EMAIL_VERIFICATION_MAIL_ENABLED": "true",
                       "ACCOUNT_EMAIL_VERIFICATION_FROM": "sender@example.com",
                       "ACCOUNT_PASSWORD_RESET_MAIL_ENABLED": "true",
                       "ACCOUNT_PASSWORD_RESET_FROM": "sender@example.com",
                       "SMTP_HOST": "smtp.example.com", "SMTP_PORT": "587",
                       "SMTP_USERNAME": "sender@example.com", "SMTP_PASSWORD": "dummy-$# password",
                       "SMTP_AUTH": "true", "SMTP_STARTTLS_ENABLED": "true", "SMTP_SSL_ENABLED": "false"}
        result = subprocess.run(["docker", "compose", "--env-file", os.devnull, "-f", str(checker.COMPOSE),
                                 "config", "--format", "json"], env=environment, capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0)
        config = json.loads(result.stdout)
        core = config["services"]["core-service"]["environment"]
        for key in environment.keys() - self.env.keys():
            # Compose config는 다시 파싱할 수 있도록 리터럴 $를 $$로 직렬화한다.
            self.assertEqual(core[key], environment[key].replace("$", "$$"), key)
        return config

    def test_account_mail_configuration_is_forwarded(self):
        config = self.mail_config()
        self.assertEqual(checker.validate(config), [])
        core = config["services"]["core-service"]["environment"]
        self.assertEqual(core["ACCOUNT_PASSWORD_RESET_FRONTEND_BASE_URL"], self.env["GOVBIZ_FRONTEND_ORIGIN"])
        self.assertEqual(core["ACCOUNT_DEV_LOGIN_ENABLED"], "false")
        self.assertEqual(core["ACCOUNT_COOKIE_SECURE"], "true")
        self.assertEqual(core["DAILY_REPORT_MAIL_ENABLED"], "false")

    def test_incomplete_or_unencrypted_mail_is_rejected(self):
        base = self.mail_config()
        for key, value in [("SMTP_HOST", ""), ("SMTP_USERNAME", ""), ("SMTP_PASSWORD", " "),
                           ("SMTP_PORT", "0"), ("SMTP_PORT", "65536"), ("SMTP_PORT", "smtp"),
                           ("SMTP_AUTH", "false"), ("SMTP_STARTTLS_ENABLED", "false"),
                           ("SMTP_SSL_ENABLED", "true"), ("ACCOUNT_EMAIL_VERIFICATION_FROM", ""),
                           ("ACCOUNT_PASSWORD_RESET_FROM", "a@b.com,c@d.com"),
                           ("ACCOUNT_EMAIL_VERIFICATION_MAIL_ENABLED", "yes")]:
            with self.subTest(key=key, value=value):
                config = copy.deepcopy(base)
                config["services"]["core-service"]["environment"][key] = value
                self.assertTrue(checker.validate(config))
        ssl_config = copy.deepcopy(base)
        ssl_config["services"]["core-service"]["environment"].update(
            SMTP_PORT="465", SMTP_STARTTLS_ENABLED="false", SMTP_SSL_ENABLED="true")
        self.assertEqual(checker.validate(ssl_config), [])

    def test_separate_named_volumes_and_no_dev_mounts(self):
        self.assertEqual(self.config["name"], "govbiz-prod")
        self.assertTrue(all(v["name"].startswith("govbiz-prod_") for v in self.config["volumes"].values()))
        for service in self.config["services"].values():
            self.assertNotIn("build", service)
            self.assertEqual(service["restart"], "unless-stopped")
            self.assertIn("max-size", service["logging"]["options"])
        self.assertEqual(self.config["services"]["nginx"]["networks"]["proxy"]["ipv4_address"], "172.30.254.2")

    def test_unsafe_changes_are_rejected(self):
        for key, value in [("ACCOUNT_DEV_LOGIN_ENABLED", "true"), ("ACCOUNT_COOKIE_SECURE", "false"),
                           ("APP_CORS_ALLOWED_ORIGIN", "*"), ("SERVER_TOMCAT_REMOTEIP_INTERNAL_PROXIES", ""),
                           ("ACCOUNT_JWT_SECRET", "govbiz-local"), ("ACCOUNT_OAUTH_UNLINK_ENABLED", "true"),
                           ("SPRING_DATASOURCE_URL", "jdbc:mysql://mysql:3306/govbiz")]:
            with self.subTest(key=key):
                config = copy.deepcopy(self.config)
                config["services"]["core-service"]["environment"][key] = value
                self.assertTrue(checker.validate(config))

    def test_internal_ports_and_public_binding_are_rejected(self):
        for name in ["core-service", "qdrant", "redis", "rabbitmq", "elasticsearch", "ai-service"]:
            config = copy.deepcopy(self.config)
            config["services"][name]["ports"] = [{"published": "9999", "target": 9999}]
            self.assertTrue(checker.validate(config), name)
        for address in ["0.0.0.0", "127.0.0.1", "203.0.113.1"]:
            config = copy.deepcopy(self.config)
            config["services"]["nginx"]["ports"][0]["host_ip"] = address
            self.assertTrue(checker.validate(config), address)

    def test_missing_secrets_fail_during_compose_interpolation(self):
        for key in ["GOVBIZ_PROXY_SECRET", "MYSQL_PASSWORD", "ACCOUNT_JWT_SECRET", "OPENAI_API_KEY"]:
            environment = dict(self.env)
            environment.pop(key)
            result = subprocess.run(["docker", "compose", "--env-file", os.devnull, "-f", str(checker.COMPOSE),
                                     "config", "--quiet"], env=environment, capture_output=True)
            self.assertNotEqual(result.returncode, 0, key)

    def test_nginx_rejects_invalid_template_secrets(self):
        script = SCRIPT_DIR.parent / "nginx/15-validate-secret.sh"
        for secret in ["", 'x"; return 200;', "a" * 63, "a" * 65, "a" * 64 + '\n"; return 200;']:
            result = subprocess.run(["sh", str(script)], env={**os.environ, "GOVBIZ_PROXY_SECRET": secret}, capture_output=True)
            self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
