"""Management reads must retain every restored row and reject stale UI contracts."""

import copy
import hashlib
import json
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import ops_http_restore_probe as probe
from test_smoke_ops_backup import EXPECTED


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


class ManagementTests(unittest.TestCase):
    def setUp(self):
        self.principal = {
            "accountId": 1,
            "email": "fixture@example.invalid",
            "role": "ADMIN",
        }
        spec = {"dataset": {"case_ids": ["test"]}}
        self.expected = {
            key: {**row, "execution_spec_sha256": digest(spec)}
            for key, row in EXPECTED.items()
        }
        self.rows = [
            {
                "id": key,
                "prefect_flow_run_id": row["flow_id"],
                "execution_spec_sha256": digest(spec),
                "execution_spec": spec,
                "status": "COMPLETED",
                "model_api_calls": 0,
                "evaluation_scope": "fixed-answer-context-only",
                "requested_by_id": "core:1",
                "finished_at": "2026-10-03T00:00:00Z",
                "summary": {"caseCount": 1},
                "report_url": "/api/v1/ops/evaluations/" + key + "/report",
            }
            for key, row in self.expected.items()
        ]
        self.rows.append({"id": "fixture-cancelled"})
        self.routes = {
            "/api/v1/ops/schedules?page=1": {
                "enabled": False, "timezone": "Asia/Seoul", "page": 1, "total": 0, "results": []
            },
            "/api/v1/ops/session": {
                "user": {"id": "core:1", "username": self.principal["email"]},
                "csrf_token": "live-test-csrf",
                "datasets": [{"id": "test"}],
                "live_enabled": False,
                "rag_live_enabled": False,
            },
            "/api/v1/ops/budget/reservations?page=1": {
                "results": [],
                "summary": {"state": "consistent"},
            },
        }
        for row in self.rows[:3]:
            route = "/api/v1/ops/evaluations/" + row["id"]
            self.routes[route] = {**row, "postprocessing": {"can_recover": False}}
            self.routes[route + "/budget"] = {
                "state": "not_applicable",
                "reservation": None,
                "calls": [],
            }
            self.routes[route + "/review"] = {
                "material": {"cases": []}, "material_error": "", "reviews": [],
            }
        self.calls = []
        self.fail_status = None
        self.cache = "private, no-store"

    def response(self, route, token=None):
        self.calls.append((route, token))
        if token is None and route.endswith("/session"):
            return 200, {}, b'{"user":null,"datasets":[]}'
        if token != "admin-token":
            return (403 if token == "member-token" else 401), {}, b"{}"
        if route.startswith("/api/v1/ops/evaluations?page="):
            page = int(route.split("=")[-1])
            following = (
                f"http://127.0.0.1:8000/api/v1/ops/evaluations?page={page + 1}"
                if page * 25 < len(self.rows)
                else None
            )
            value = {
                "count": len(self.rows),
                "next": following,
                "results": self.rows[(page - 1) * 25 : page * 25],
            }
        else:
            value = self.routes[route]
        return (
            self.fail_status or 200,
            {"Cache-Control": self.cache, "Content-Type": "application/json"},
            json.dumps(value).encode(),
        )

    def verify(self, response=None, count=None):
        with (
            patch.dict(
                sys.modules,
                {"apps.evaluations.execution_spec": SimpleNamespace(digest=digest)},
            ),
            patch.object(probe, "response", side_effect=response or self.response),
        ):
            return probe.check_management(
                self.expected,
                self.principal,
                "admin-token",
                "member-token",
                len(self.rows) if count is None else count,
            )

    def test_reads_session_all_rows_details_budgets_and_redacts_csrf(self):
        result = self.verify()
        self.assertEqual(result["evidence"]["listed_run_count"], 4)
        self.assertEqual(result["evidence"]["matched_details"], 3)
        self.assertFalse(result["evidence"]["browser_rendered"])
        self.assertNotIn("live-test-csrf", json.dumps(result))
        self.assertEqual(len(result["responses"]), 13)
        for row in self.rows[:3]:
            route = "/api/v1/ops/evaluations/" + row["id"] + "/review"
            self.assertIn((route, "member-token"), self.calls)
            self.assertIn(route, result["responses"])

    def test_rag_detail_does_not_fetch_the_fixed_context_review_panel(self):
        row = self.rows[0]
        route = "/api/v1/ops/evaluations/" + row["id"]
        row["evaluation_scope"] = "source-chunks-retrieval-answer"
        self.routes[route]["evaluation_scope"] = row["evaluation_scope"]
        result = self.verify()
        self.assertNotIn(route + "/review", result["responses"])

    def test_http_200_with_missing_review_inputs_cannot_pass(self):
        route = "/api/v1/ops/evaluations/" + self.rows[0]["id"] + "/review"
        for value in (
            {"material": None, "material_error": "검토 자료 누락"},
            {"material": {"cases": []}, "material_error": "자료 무결성 오류"},
        ):
            self.routes[route] = value
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "review inputs"):
                self.verify()

    def test_follows_only_bounded_local_pages_and_counts_every_row(self):
        self.rows.extend({"id": f"row-{index}"} for index in range(25))
        result = self.verify()
        self.assertEqual(result["evidence"]["listed_run_count"], 29)
        self.assertIn(("/api/v1/ops/evaluations?page=2", "admin-token"), self.calls)

    def test_duplicate_missing_or_untrusted_pagination_fails(self):
        def broken(route, token=None):
            status, headers, raw = self.response(route, token)
            if (
                token == "admin-token"
                and "?page=" in route
                and "/evaluations?" in route
            ):
                value = json.loads(raw)
                if self.defect == "duplicate":
                    value["results"][1] = value["results"][0]
                elif self.defect == "missing":
                    value["results"].pop()
                else:
                    value["next"] = "https://untrusted.invalid/"
                raw = json.dumps(value).encode()
            return status, headers, raw

        for self.defect in ("duplicate", "missing", "next"):
            with self.subTest(defect=self.defect), self.assertRaises(ValueError):
                self.verify(broken)

    def test_session_flags_identity_and_detail_mismatch_fail(self):
        session = self.routes["/api/v1/ops/session"]
        original = copy.deepcopy(session)
        for key, value in (
            ("user", None),
            ("datasets", []),
            ("live_enabled", True),
            ("csrf_token", ""),
        ):
            session.update(original)
            session[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.verify()
        session.update(original)
        self.routes["/api/v1/ops/evaluations/" + next(iter(self.expected))][
            "status"
        ] = "RUNNING"
        with self.assertRaisesRegex(ValueError, "detail differs"):
            self.verify()

    def test_api_failure_cacheable_json_and_paid_budget_cannot_pass(self):
        for self.fail_status, self.cache in ((500, "no-store"), (None, "public")):
            with self.assertRaises(ValueError):
                self.verify()
        self.fail_status, self.cache = None, "no-store"
        self.routes["/api/v1/ops/evaluations/" + next(iter(self.expected)) + "/budget"][
            "state"
        ] = "reserved"
        with self.assertRaisesRegex(ValueError, "paid budget"):
            self.verify()

    def test_auth_bypass_or_bad_database_count_cannot_pass(self):
        for count in (True, 2, 1001):
            with self.assertRaises(ValueError):
                self.verify(count=count)

        def bypass(route, token=None):
            return self.response(
                route, "admin-token" if token == "member-token" else token
            )

        with self.assertRaisesRegex(ValueError, "unauthorized"):
            self.verify(bypass)


if __name__ == "__main__":
    unittest.main()
