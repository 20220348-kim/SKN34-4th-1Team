from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, override_settings
from rest_framework.exceptions import AuthenticationFailed, PermissionDenied
from rest_framework.test import APIClient, APIRequestFactory, force_authenticate

from .authentication import CoreSessionAuthentication, CoreUnavailable
from .views import api_evaluation_catalog, api_session


class SessionSeparationTests(SimpleTestCase):
    def request(self, view, *, authenticated=True):
        request = APIRequestFactory().get("/")
        if authenticated:
            force_authenticate(
                request,
                user=get_user_model()(username="core:12", email="admin@example.com"),
            )
        return view(request)

    @patch("apps.evaluations.views.public_datasets", side_effect=OSError("private store"))
    @patch("apps.evaluations.views.baseline_choices", side_effect=OSError("private result"))
    def test_session_is_independent_of_catalog_and_result_storage(self, baselines, datasets):
        for authenticated in (True, False):
            with self.subTest(authenticated=authenticated):
                response = self.request(api_session, authenticated=authenticated)
                self.assertEqual(response.status_code, 200)
                self.assertNotIn("datasets", response.data)
                self.assertTrue(response.data["csrf_token"])
                self.assertEqual(response.data["user"] is not None, authenticated)
                self.assertIn("no-store", response["Cache-Control"])
        baselines.assert_not_called()
        datasets.assert_not_called()

    @patch("apps.evaluations.views.public_datasets")
    @patch("apps.evaluations.views.baseline_choices")
    def test_catalog_failure_stays_explicit_without_blocking_session(self, baselines, datasets):
        for failing in (baselines, datasets):
            baselines.side_effect = None
            baselines.return_value = {}
            datasets.side_effect = None
            datasets.return_value = []
            failing.side_effect = OSError("private path and credentials")
            response = self.request(api_evaluation_catalog)
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.data["code"], "VECTOR_CACHE_UNAVAILABLE")
            self.assertNotIn("private", str(response.data))
            self.assertEqual(self.request(api_session).status_code, 200)

    @patch("apps.evaluations.views.public_datasets", return_value=[])
    @patch("apps.evaluations.views.baseline_choices", return_value={})
    @patch("apps.evaluations.authentication.read_core_admin")
    @patch("apps.evaluations.authentication.get_user_model")
    def test_both_endpoints_recheck_core_and_fail_closed(self, users, core, baselines, datasets):
        user = get_user_model()(username="core:12", email="admin@example.com")
        users.return_value.objects.get_or_create.return_value = (user, False)
        core.return_value = {"accountId": 12, "email": user.email, "role": "ADMIN"}
        client = APIClient()
        client.cookies["govbiz_session"] = "test-only-session"
        urls = ("/api/v1/ops/session", "/api/v1/ops/evaluation-catalog")
        for url in urls:
            self.assertEqual(client.get(url).status_code, 200)
        self.assertEqual(core.call_count, 2)
        baselines.reset_mock()
        datasets.reset_mock()
        for error, status in (
            (AuthenticationFailed(), 401),
            (PermissionDenied(), 403),
            (CoreUnavailable(), 503),
        ):
            core.side_effect = error
            for url in urls:
                self.assertEqual(client.get(url).status_code, status)
        self.assertEqual(core.call_count, 8)
        baselines.assert_not_called()
        datasets.assert_not_called()

    @override_settings(CORE_ACCOUNT_NAMESPACE="")
    @patch("apps.evaluations.authentication.perf_counter", side_effect=[10, 10.25, 10.5])
    @patch("apps.evaluations.authentication.get_user_model")
    @patch("apps.evaluations.authentication.read_core_admin")
    def test_auth_timings_separate_core_and_local_without_private_data(self, core, users, clock):
        user = get_user_model()(username="core:12", email="private@example.com")
        core.return_value = {"accountId": 12, "email": user.email, "role": "ADMIN"}
        users.return_value.objects.get_or_create.return_value = (user, False)
        request = APIRequestFactory().get("/")
        request.COOKIES["govbiz_session"] = "private-cookie"
        with self.assertLogs("apps.evaluations.authentication", level="INFO") as logs:
            result = CoreSessionAuthentication().authenticate(request)
        self.assertEqual(result, (user, None))
        self.assertEqual(len(logs.output), 1)
        self.assertIn("outcome=authenticated core_ms=250 local_ms=250 total_ms=500", logs.output[0])
        self.assertNotIn("private", logs.output[0])
        self.assertNotIn(user.username, logs.output[0])

    @patch("apps.evaluations.authentication.perf_counter", side_effect=[10, 13])
    @patch("apps.evaluations.authentication.read_core_admin", side_effect=CoreUnavailable())
    def test_auth_failure_logs_elapsed_time_and_preserves_error(self, core, clock):
        request = APIRequestFactory().get("/")
        request.COOKIES["govbiz_session"] = "private-cookie"
        with (
            self.assertLogs("apps.evaluations.authentication", level="INFO") as logs,
            self.assertRaises(CoreUnavailable),
        ):
            CoreSessionAuthentication().authenticate(request)
        self.assertIn("outcome=http_503 core_ms=3000 local_ms=0 total_ms=3000", logs.output[0])
        self.assertNotIn("private", logs.output[0])
