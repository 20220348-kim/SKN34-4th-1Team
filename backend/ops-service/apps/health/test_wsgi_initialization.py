"""WSGI worker는 HTTP 요청을 받기 전에 실제 운영 URL을 초기화한다."""

import os
import subprocess
import sys
from pathlib import Path
from textwrap import dedent

from django.test import SimpleTestCase


class WsgiInitializationTests(SimpleTestCase):
    def test_routes_are_loaded_before_first_request_without_database_or_network(self):
        # 테스트 runner가 이미 URL을 import한 상태로 cold start 검증을 통과시키지 않는다.
        script = dedent(
            """
            import sys
            from unittest.mock import patch

            with patch("environ.Env.read_env"):
                from django.conf import settings
                settings.DATABASES = {"default": {"ENGINE": "django.db.backends.dummy"}}
                with (
                    patch("socket.socket.connect", side_effect=AssertionError("Network used")),
                    patch("django.db.backends.base.base.BaseDatabaseWrapper.ensure_connection",
                          side_effect=AssertionError("Database used")),
                ):
                    import config.wsgi
                    assert callable(config.wsgi.application)
                    assert settings.ROOT_URLCONF in sys.modules
                    views = sys.modules.get("apps.evaluations.views")
                    samples = sys.modules.get("apps.evaluations.production_views")
                    assert views is not None and samples is not None, "Views are still lazy"
                    from django.urls import resolve
                    assert resolve("/api/v1/ops/session").func is views.api_session
                    assert resolve("/api/v1/ops/production-quality").func is samples.api_samples
            print("WSGI routes initialized without external access")
            """
        )
        result = subprocess.run(
            [sys.executable, "-c", script],
            cwd=Path(__file__).resolve().parents[2],
            env={
                "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                "DJANGO_SETTINGS_MODULE": "config.settings",
                "DJANGO_SECRET_KEY": "wsgi-initialization-test-only",
                "DB_PASSWORD": "unused-test-password",
            },
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "WSGI routes initialized without external access")
