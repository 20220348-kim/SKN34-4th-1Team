from unittest.mock import patch

from django.db import OperationalError
from django.test import SimpleTestCase, TestCase


class HealthTests(SimpleTestCase):
    def test_liveness_does_not_need_database(self):
        # SimpleTestCase는 DB 접근을 금지하므로 실수로 추가한 질의도 실패합니다.
        response = self.client.get("/api/v1/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "UP", "service": "govbiz-ops-service"})

    def test_health_is_read_only(self):
        self.assertEqual(self.client.post("/api/v1/health").status_code, 405)
        self.assertEqual(self.client.post("/api/v1/health/ready").status_code, 405)

    def test_readiness_returns_503_without_exposing_database_error(self):
        with patch("apps.health.views.connection") as database:
            database.cursor.side_effect = OperationalError("private-database-address")
            response = self.client.get("/api/v1/health/ready")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"status": "DOWN", "checks": {"database": "DOWN"}})
        self.assertNotIn(b"private-database-address", response.content)

    def test_unrecognized_host_is_rejected(self):
        response = self.client.get("/api/v1/health", HTTP_HOST="unrecognized.invalid")
        self.assertEqual(response.status_code, 400)


class DatabaseReadinessTests(TestCase):
    def test_readiness_against_real_mysql(self):
        response = self.client.get("/api/v1/health/ready")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "UP", "checks": {"database": "UP"}})
