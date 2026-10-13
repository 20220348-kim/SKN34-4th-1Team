import os
import runpy
from pathlib import Path
from unittest.mock import patch

from django.core.exceptions import ImproperlyConfigured
from django.test import SimpleTestCase, override_settings

from .authentication import CoreUnavailable, read_core_admin


class CoreAuthTimeoutTests(SimpleTestCase):
    @override_settings(CORE_AUTH_TIMEOUT_SECONDS=10)
    @patch("apps.evaluations.authentication.build_opener")
    def test_configured_timeout_is_used_and_each_call_rechecks_core(self, opener):
        response = opener.return_value.open.return_value.__enter__.return_value
        response.status = 200
        response.read.return_value = b'{"accountId":12,"email":"admin@example.com","role":"ADMIN"}'
        read_core_admin("signed-session")
        read_core_admin("signed-session")
        self.assertEqual(opener.return_value.open.call_count, 2)
        self.assertTrue(
            all(call.kwargs["timeout"] == 10 for call in opener.return_value.open.call_args_list)
        )

    @override_settings(CORE_AUTH_TIMEOUT_SECONDS=10)
    @patch("apps.evaluations.authentication.build_opener")
    def test_timeout_fails_closed_without_retry(self, opener):
        opener.return_value.open.side_effect = TimeoutError("private connection details")
        with self.assertRaises(CoreUnavailable) as caught:
            read_core_admin("signed-session")
        opener.return_value.open.assert_called_once()
        self.assertEqual(caught.exception.status_code, 503)
        self.assertNotIn("private connection details", str(caught.exception))

    def read_timeout_setting(self, value=None):
        environment = {"DJANGO_SECRET_KEY": "offline-settings-test", "DB_PASSWORD": "unused"}
        if value is not None:
            environment["CORE_AUTH_TIMEOUT_SECONDS"] = value
        settings_path = Path(__file__).resolve().parents[2] / "config/settings.py"
        with patch.dict(os.environ, environment, clear=True), patch("environ.Env.read_env"):
            return runpy.run_path(str(settings_path))["CORE_AUTH_TIMEOUT_SECONDS"]

    def test_settings_keep_default_and_accept_both_boundaries(self):
        self.assertEqual(self.read_timeout_setting(), 3)
        self.assertEqual(self.read_timeout_setting("1"), 1)
        self.assertEqual(self.read_timeout_setting("10"), 10)

    def test_settings_reject_invalid_values_before_serving_requests(self):
        for value in ["0", "11", "-1", "1.5", "NaN", "inf", "", "true"]:
            with (
                self.subTest(value=value),
                self.assertRaisesRegex(ImproperlyConfigured, "CORE_AUTH_TIMEOUT_SECONDS"),
            ):
                self.read_timeout_setting(value)
