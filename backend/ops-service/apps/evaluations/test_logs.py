import json
from io import BytesIO
from unittest.mock import patch
from urllib.error import URLError
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase, override_settings
from rest_framework.exceptions import PermissionDenied
from rest_framework.test import APIClient

from . import prefect_client
from .models import EvaluationRun


def log_row(flow_id, **changes):
    return {
        "id": str(uuid4()),
        "flow_run_id": str(flow_id),
        "timestamp": "2026-10-13T00:00:00Z",
        "level": 40,
        "name": "prefect.flow_runs",
        "message": "평가 실패\nTraceback: 입력 확인",
        **changes,
    }


class PrefectLogClientTests(SimpleTestCase):
    @patch("apps.evaluations.prefect_client.urlopen")
    def test_scoped_read_with_bounded_page_and_only_public_fields(self, open_url):
        flow_id = uuid4()
        rows = [log_row(flow_id, extra="not-returned") for _ in range(101)]
        open_url.side_effect = [
            BytesIO(json.dumps({"id": str(flow_id), "state_type": "FAILED"}).encode()),
            BytesIO(json.dumps(rows).encode()),
        ]
        data = prefect_client.read_logs(flow_id, 100)
        request = open_url.call_args.args[0]
        self.assertTrue(request.full_url.endswith("/api/logs/filter"))
        self.assertEqual(request.method, "POST")
        self.assertEqual(
            json.loads(request.data),
            {
                "logs": {"flow_run_id": {"any_": [str(flow_id)]}},
                "sort": "TIMESTAMP_DESC",
                "offset": 100,
                "limit": 101,
            },
        )
        self.assertEqual(len(data["results"]), 100)
        self.assertEqual(data["next_offset"], 200)
        self.assertEqual(data["results"][0]["message"], rows[0]["message"])
        self.assertNotIn("extra", data["results"][0])

    def test_empty_existing_flow_is_distinct_from_missing_or_unavailable_flow(self):
        flow_id = uuid4()
        with patch("apps.evaluations.prefect_client.request_json") as request:
            request.side_effect = [{"id": str(flow_id), "state_type": "RUNNING"}, []]
            self.assertEqual(
                prefect_client.read_logs(flow_id),
                {"offset": 0, "next_offset": None, "results": []},
            )
            request.reset_mock()
            request.side_effect = prefect_client.PrefectUnavailable
            with self.assertRaises(prefect_client.PrefectUnavailable):
                prefect_client.read_logs(flow_id)
            self.assertEqual(request.call_count, 1)

    def test_foreign_flow_or_invalid_log_is_rejected(self):
        flow_id = uuid4()
        for changes in (
            {"flow_run_id": str(uuid4())},
            {"timestamp": "invalid"},
            {"timestamp": "2026-10-13T00:00:00"},
            {"timestamp": None},
            {"level": True},
            {"message": {"private": "invalid"}},
            {"id": "invalid"},
        ):
            with (
                self.subTest(changes=changes),
                patch("apps.evaluations.prefect_client.read_run"),
                patch(
                    "apps.evaluations.prefect_client.request_json",
                    return_value=[log_row(flow_id, **changes)],
                ),
                self.assertRaises(prefect_client.PrefectUnavailable),
            ):
                prefect_client.read_logs(flow_id)

    def test_transport_failure_and_oversized_response_are_not_empty_success(self):
        for body in (b"x" * (4 * 1024 * 1024 + 1), b"{}", b"not json"):
            with (
                self.subTest(size=len(body)),
                patch("apps.evaluations.prefect_client.read_run"),
                patch("apps.evaluations.prefect_client.urlopen", return_value=BytesIO(body)),
                self.assertRaises(prefect_client.PrefectUnavailable),
            ):
                prefect_client.read_logs(uuid4())
        with (
            patch("apps.evaluations.prefect_client.read_run"),
            patch("apps.evaluations.prefect_client.urlopen", side_effect=URLError("private")),
            self.assertRaises(prefect_client.PrefectUnavailable),
        ):
            prefect_client.read_logs(uuid4())


@override_settings(ALLOWED_HOSTS=["testserver"])
class RunLogViewTests(SimpleTestCase):
    def setUp(self):
        self.run = EvaluationRun(id=uuid4(), prefect_flow_run_id=uuid4())
        self.url = f"/api/v1/ops/evaluations/{self.run.id}/logs"
        self.client = APIClient()

    def test_requires_current_core_admin(self):
        with patch("apps.evaluations.views.read_logs") as read:
            self.assertEqual(self.client.get(self.url).status_code, 401)
            self.client.cookies["govbiz_session"] = "ordinary-user"
            with patch(
                "apps.evaluations.authentication.read_core_admin", side_effect=PermissionDenied
            ):
                self.assertEqual(self.client.get(self.url).status_code, 403)
            read.assert_not_called()

    def test_uses_stored_flow_id_never_client_flow_or_url(self):
        self.client.force_authenticate(get_user_model()(username="operator"))
        logs = {"offset": 100, "next_offset": None, "results": []}
        with (
            patch("apps.evaluations.views.get_object_or_404", return_value=self.run),
            patch("apps.evaluations.views.read_logs", return_value=logs) as read,
            patch("apps.evaluations.views.sync_run") as sync,
        ):
            response = self.client.get(self.url, {"offset": 100, "flow_run_id": str(uuid4())})
            self.assertEqual(response.status_code, 200)
            read.assert_called_once_with(self.run.prefect_flow_run_id, 100)
            sync.assert_not_called()
            self.assertEqual(response.data["run_id"], str(self.run.id))
            self.assertIn("no-store", response["Cache-Control"])
            self.assertEqual(self.client.post(self.url).status_code, 405)

    def test_invalid_offset_no_dispatch_and_safe_failure_response(self):
        self.client.force_authenticate(get_user_model()(username="operator"))
        with patch("apps.evaluations.views.read_logs") as read:
            for offset in (-1, "invalid", "1.5"):
                self.assertEqual(self.client.get(self.url, {"offset": offset}).status_code, 400)
            read.assert_not_called()
            with patch("apps.evaluations.views.get_object_or_404", return_value=self.run):
                read.side_effect = prefect_client.PrefectUnavailable("private connection detail")
                response = self.client.get(self.url)
                self.assertEqual(response.status_code, 503)
                self.assertEqual(response.data, {"code": "PREFECT_LOGS_UNAVAILABLE"})
                self.run.prefect_flow_run_id = None
                read.reset_mock()
                self.assertEqual(self.client.get(self.url).status_code, 409)
                read.assert_not_called()


@override_settings(ALLOWED_HOSTS=["testserver"])
class StoredRunLogTests(TestCase):
    def test_reads_existing_run_without_changing_evaluation(self):
        user = get_user_model().objects.create_user("log-operator")
        run = EvaluationRun.objects.create(
            requested_by=user, dataset_id="target-coverage-20260907-v1", prefect_flow_run_id=uuid4()
        )
        before = EvaluationRun.objects.values().get(pk=run.pk)
        client = APIClient()
        client.force_authenticate(user)
        with patch(
            "apps.evaluations.views.read_logs",
            return_value={"offset": 0, "next_offset": None, "results": []},
        ) as read:
            self.assertEqual(client.get(f"/api/v1/ops/evaluations/{run.id}/logs").status_code, 200)
            read.assert_called_once_with(run.prefect_flow_run_id, 0)
            read.reset_mock()
            self.assertEqual(client.get(f"/api/v1/ops/evaluations/{uuid4()}/logs").status_code, 404)
            read.assert_not_called()
        self.assertEqual(EvaluationRun.objects.values().get(pk=run.pk), before)
