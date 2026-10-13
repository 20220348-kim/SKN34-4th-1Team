from copy import deepcopy
from datetime import timedelta
from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied
from rest_framework.test import APIClient

from .dashboard import RAG_SCOPE, RUN_LIMIT, dashboard_data, generation_config_fingerprint
from .models import EvaluationRun


def fixed_run(**kwargs):
    cases = ["H01", "H02"]
    comparison = {
        "schema_version": 2,
        "scope": "fixed-answer-context-only",
        "fixture_sha256": "a" * 64,
        "case_ids": cases,
        "candidate_execution": {
            "model": "model-a",
            "capture_sha256": "b" * 64,
            "prompt_sha256": "c" * 64,
        },
        "metrics": [
            {"key": "statusAccuracy", "candidate": 1.0},
            {"key": "referenceCitationRecall", "candidate": 0.0},
            {"key": "meanLatencyMs", "candidate": None},
            {"key": "meanInputTokens", "candidate": 25},
        ],
        "cases": [
            {"case_id": case, "candidate": {"status_match": 1, "citation_recall": 0}}
            for case in cases
        ],
    }
    return EvaluationRun(
        **{
            "id": uuid4(),
            "dataset_id": "test-dataset",
            "status": "COMPLETED",
            "execution_mode": "live",
            "live_config": {"model": "model-a"},
            "created_at": timezone.now(),
            "started_at": timezone.now(),
            "execution_spec": {"evaluation": {"version": "d" * 64}},
            "comparison": comparison,
            **kwargs,
        }
    )


class DashboardAggregationTests(SimpleTestCase):
    def test_only_live_and_live_origin_recovery_count_without_duplicate_answers(self):
        live = fixed_run()
        recovery = fixed_run(execution_mode="recovery", source_run=live, live_config={})
        replay = fixed_run(execution_mode="replay")
        replay_recovery = fixed_run(execution_mode="recovery", source_run=replay)
        failed = fixed_run(status="FAILED")
        data = dashboard_data([recovery, live, replay, replay_recovery, failed], 5)
        self.assertEqual(
            data["excluded"], {"replay": 1, "incomplete": 1, "unverifiable": 1, "duplicate": 1}
        )
        point = data["series"][0]["points"][0]
        self.assertEqual(point["run_id"], str(recovery.id))
        self.assertEqual(point["measured_at"], live.started_at.isoformat())
        self.assertEqual(point["source_run_id"], str(live.id))
        self.assertEqual(data["states"]["failed"], 1)

    def test_separate_changed_fixture_model_case_set_scope_and_evaluator(self):
        base = fixed_run()
        changed = []
        for field in ("fixture", "model", "cases", "evaluator"):
            run = deepcopy(base)
            run.id = uuid4()
            if field == "fixture":
                run.comparison["fixture_sha256"] = "e" * 64
            elif field == "model":
                run.live_config["model"] = "other"
                run.comparison["candidate_execution"]["model"] = "other"
            elif field == "cases":
                run.comparison["case_ids"] = ["H01"]
            else:
                run.execution_spec["evaluation"]["version"] = "f" * 64
            changed.append(run)
        data = dashboard_data([base, *changed], 5)
        self.assertEqual(len(data["series"]), 5)

    def test_prompt_changes_can_trend_but_missing_values_never_become_zero(self):
        old = fixed_run(started_at=timezone.now() - timedelta(days=1))
        new = fixed_run()
        new.comparison["candidate_execution"].update(
            capture_sha256="e" * 64, prompt_sha256="f" * 64
        )
        new.comparison["metrics"][0]["candidate"] = 0.5
        data = dashboard_data([new, old], 2)
        points = data["series"][0]["points"]
        self.assertEqual([point["values"]["status"] for point in points], [1.0, 0.5])
        self.assertIsNone(points[-1]["values"]["latency"])
        self.assertIsNone(points[-1]["values"]["retrieval"])
        self.assertEqual(points[-1]["values"]["citation"], 0)
        self.assertEqual(points[-1]["samples"]["citation"], 2)

    def test_different_measured_cases_have_different_coverage_even_with_same_count(self):
        first, second = fixed_run(), fixed_run()
        first.comparison["cases"][0]["candidate"]["citation_recall"] = None
        second.comparison["cases"][1]["candidate"]["citation_recall"] = None
        second.comparison["candidate_execution"]["capture_sha256"] = "e" * 64
        points = dashboard_data([first, second], 2)["series"][0]["points"]
        self.assertEqual(points[0]["samples"]["citation"], points[1]["samples"]["citation"])
        self.assertNotEqual(points[0]["coverage"]["citation"], points[1]["coverage"]["citation"])

    def test_missing_provenance_or_model_mismatch_is_excluded(self):
        for mutate in (
            lambda run: run.execution_spec.clear(),
            lambda run: run.live_config.update(model="changed"),
            lambda run: run.comparison.update(scope="unknown"),
            lambda run: setattr(run, "live_config", None),
            lambda run: setattr(run, "live_config", []),
            lambda run: setattr(run, "execution_spec", None),
        ):
            run = fixed_run()
            mutate(run)
            self.assertEqual(dashboard_data([run], 1)["excluded"]["unverifiable"], 1)

    def test_generation_fingerprint_preserves_conditions_but_excludes_model_and_cache(self):
        run = fixed_run()
        run.execution_spec["generation"] = {
            "sha256": "a" * 64,
            "settings": {"reasoning": {"effort": "none"}},
        }
        run.live_config.update(
            max_input_tokens=32768,
            max_output_tokens=2000,
            embedding_model="text-embedding-3-small",
            embedding_dimensions=1536,
            source_mode="fixed-source-and-chunks",
        )
        initial = generation_config_fingerprint(run, RAG_SCOPE)
        self.assertIsNotNone(initial)
        unchanged = deepcopy(run)
        unchanged.live_config.update(
            model="model-b",
            document_vectors={"case": {"sha256": "b" * 64}},
            max_model_calls=1,
            max_total_input_tokens=1234,
            max_total_output_tokens=2000,
        )
        unchanged.execution_spec["reference_sha256"] = "c" * 64
        self.assertEqual(generation_config_fingerprint(unchanged, RAG_SCOPE), initial)
        for field, value in (
            ("max_input_tokens", 16384),
            ("max_output_tokens", 1000),
            ("embedding_model", "text-embedding-3-large"),
            ("embedding_dimensions", 3072),
        ):
            with self.subTest(field=field):
                changed = deepcopy(run)
                changed.live_config[field] = value
                self.assertNotEqual(generation_config_fingerprint(changed, RAG_SCOPE), initial)
        for generation in (
            {"sha256": "b" * 64, "settings": {"reasoning": {"effort": "none"}}},
            {"sha256": "a" * 64, "settings": {"reasoning": {"effort": "low"}}},
        ):
            changed = deepcopy(run)
            changed.execution_spec["generation"] = generation
            self.assertNotEqual(generation_config_fingerprint(changed, RAG_SCOPE), initial)

    def test_recovery_uses_original_generation_and_missing_conditions_stay_unknown(self):
        origin = fixed_run()
        self.assertIsNone(
            dashboard_data([origin], 1)["series"][0]["points"][0]["generation_config_sha256"]
        )
        origin.execution_spec["generation"] = {"sha256": "a" * 64, "settings": {"max_retries": 0}}
        origin.live_config.update(max_input_tokens=32768, max_output_tokens=2000)
        recovery = fixed_run(execution_mode="recovery", source_run=origin, live_config={})
        expected = dashboard_data([origin], 1)["series"][0]["points"][0]["generation_config_sha256"]
        self.assertIsNotNone(expected)
        self.assertEqual(
            dashboard_data([recovery], 1)["series"][0]["points"][0]["generation_config_sha256"],
            expected,
        )
        for field in ("max_input_tokens", "max_output_tokens"):
            changed = deepcopy(origin)
            changed.live_config.pop(field)
            self.assertIsNone(generation_config_fingerprint(changed, "fixed-answer-context-only"))
        for field in ("live_config", "execution_spec"):
            for value in (None, [], "legacy-unavailable"):
                with self.subTest(field=field, value=value):
                    changed = deepcopy(origin)
                    setattr(changed, field, value)
                    self.assertIsNone(generation_config_fingerprint(changed, RAG_SCOPE))
        self.assertIsNone(generation_config_fingerprint(origin, RAG_SCOPE))

    def test_invalid_numbers_are_unmeasured_and_window_is_explicit(self):
        for value in (True, float("nan"), float("inf"), -1, 2):
            run = fixed_run()
            run.comparison["metrics"][0]["candidate"] = value
            data = dashboard_data([run], 500)
            self.assertIsNone(data["series"][0]["points"][0]["values"]["status"])
            self.assertTrue(data["window"]["truncated"])
            self.assertEqual(data["window"]["limit"], RUN_LIMIT)

    def test_rag_recovery_retains_partial_metric_coverage_and_search_k(self):
        origin = fixed_run()
        run = fixed_run(execution_mode="recovery", source_run=origin)
        run.comparison = {
            "schema_version": 3,
            "scope": "source-chunks-retrieval-answer",
            "fixture_sha256": "a" * 64,
            "case_ids": ["H01", "H02"],
            "current": {
                "measurementKind": "recorded-capture-replay",
                "completed": True,
                "execution": {"model": "model-a", "promptSha256": "c" * 64},
                "captureSha256": "b" * 64,
                "metrics": {"retrievalRecallAtK": {"value": 0.5, "measuredCaseCount": 1}},
                "cases": [
                    {"caseId": "H01", "k": 5, "retrievalRecallAtK": 0.5},
                    {"caseId": "H02", "k": 5},
                ],
            },
        }
        group = dashboard_data([run], 1)["series"][0]
        self.assertEqual(group["points"][0]["samples"]["retrieval"], 1)
        self.assertEqual(group["points"][0]["values"]["retrieval"], 0.5)
        changed = deepcopy(run)
        changed.comparison["current"]["cases"][0]["k"] = 3
        self.assertEqual(len(dashboard_data([run, changed], 2)["series"]), 2)
        for kind in ("synthetic-contract-check", "integration-stub-replay"):
            run.comparison["current"]["measurementKind"] = kind
            self.assertEqual(dashboard_data([run], 1)["series"], [])

    def test_anonymous_and_non_admin_requests_are_rejected_before_querying(self):
        self.assertEqual(APIClient().get("/api/v1/ops/dashboard").status_code, 401)
        client = APIClient()
        client.cookies["govbiz_session"] = "test-session"
        with patch("apps.evaluations.authentication.read_core_admin", side_effect=PermissionDenied):
            self.assertEqual(client.get("/api/v1/ops/dashboard").status_code, 403)


class DashboardApiTests(TestCase):
    def test_authenticated_read_is_bounded_and_does_not_write_or_sync(self):
        user = get_user_model().objects.create_user(username="dashboard-reader")
        run = fixed_run(requested_by=user)
        run.save()
        other = fixed_run(requested_by=user, execution_mode="replay")
        other.save()
        client = APIClient()
        client.force_authenticate(user)
        with patch("apps.evaluations.dashboard.RUN_LIMIT", 1), self.assertNumQueries(2):
            response = client.get("/api/v1/ops/dashboard")
        self.assertEqual(response.status_code, 200)
        self.assertIn("no-store", response["Cache-Control"])
        self.assertEqual(
            response.json()["window"], {"loaded": 1, "limit": 1, "total": 2, "truncated": True}
        )
        self.assertEqual(response.json()["excluded"]["replay"], 1)
        self.assertEqual(EvaluationRun.objects.count(), 2)
        run.refresh_from_db()
        self.assertIsNone(run.synced_at)
        self.assertEqual(client.post("/api/v1/ops/dashboard", {}).status_code, 405)
