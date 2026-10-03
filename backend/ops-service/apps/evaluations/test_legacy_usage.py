import json
import threading
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from hashlib import sha256
from io import StringIO
from unittest.mock import patch
from uuid import uuid4

from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import DatabaseError, close_old_connections, connection, transaction
from django.db.migrations.executor import MigrationExecutor
from django.test import SimpleTestCase, TestCase, TransactionTestCase, override_settings

from .budget import BudgetUnavailable, reserve, worker_action
from .budget_reporting import budget_summary, change_limits
from .legacy_usage import LegacyUsageUnavailable, capture_usage, reconcile_legacy_usage
from .models import EvaluationBudget, EvaluationLegacyUsage, EvaluationRun
from .test_budget import TOKEN, USAGE
from .test_reviews import ReviewFixture


def sample_capture():
    return {
        "completed": True,
        "modelApiCalls": 1,
        "caseIds": ["E01"],
        "cases": [{"caseId": "E01", "outcome": "success", "apiResponseIndexes": [0]}],
        "apiResponses": [{"httpStatus": 200, "responseStatus": "completed", "usage": USAGE}],
    }


def seed_legacy_usage(budget, user):
    """기존 정리·보정 회귀 테스트에 별도의 과거 사용량 몫을 추가한다."""
    budget.refresh_from_db()
    before = {
        key: getattr(budget, "allocated_" + key)
        for key in ("calls", "input_tokens", "output_tokens")
    }
    after = {key: value + 1 for key, value in before.items()}
    run = EvaluationRun.objects.create(
        requested_by=user, dataset_id="legacy-test", execution_mode="live", status="COMPLETED"
    )
    EvaluationLegacyUsage.objects.create(
        run=run,
        budget=budget,
        request_id=uuid4(),
        actor="테스트",
        reason="회귀 검증",
        capture_sha256="c" * 64,
        evidence_sha256="d" * 64,
        evidence={"test_only": True},
        calls=1,
        input_tokens=1,
        output_tokens=1,
        before=before,
        after=after,
    )
    budget.call_limit += 1
    budget.output_token_limit += 1
    for key, value in after.items():
        setattr(budget, "allocated_" + key, value)
    budget.save()


class CaptureUsageTests(SimpleTestCase):
    def test_all_responses_are_summed_without_inference(self):
        capture = sample_capture()
        capture["modelApiCalls"] = 2
        capture["apiResponses"].append(deepcopy(capture["apiResponses"][0]))
        capture["cases"][0]["apiResponseIndexes"] = [0, 1]
        self.assertEqual(
            capture_usage(capture, 2, 2000),
            {"calls": 2, "input_tokens": 200, "output_tokens": 100},
        )

    def test_missing_partial_negative_boolean_duplicate_and_unlinked_usage_is_rejected(self):
        for field, value in (
            ("input_tokens", None),
            ("input_tokens", True),
            ("output_tokens", -1),
            ("total_tokens", 149),
            ("input_tokens", 2**53),
            ("output_tokens", 2001),
        ):
            capture = deepcopy(sample_capture())
            capture["apiResponses"][0]["usage"][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(LegacyUsageUnavailable):
                capture_usage(capture, 1, 2000)
        for indexes in ([], [0, 0], [True], [1], "0"):
            capture = sample_capture()
            capture["cases"][0]["apiResponseIndexes"] = indexes
            with self.subTest(indexes=indexes), self.assertRaises(LegacyUsageUnavailable):
                capture_usage(capture, 1, 2000)
        for field, value in (("httpStatus", 500), ("responseStatus", "incomplete"), ("usage", {})):
            capture = sample_capture()
            capture["apiResponses"][0][field] = value
            with self.subTest(field=field), self.assertRaises(LegacyUsageUnavailable):
                capture_usage(capture, 1, 2000)
        for capture in (None, {}, {**sample_capture(), "completed": False}):
            with self.assertRaises(LegacyUsageUnavailable):
                capture_usage(capture, 1, 2000)


class LegacyFixture(ReviewFixture):
    def setUp(self):
        super().setUp()
        self.budget = EvaluationBudget.objects.create(call_limit=20, output_token_limit=40000)
        self.prepare(self.run)
        self.arguments = {
            "run_id": self.run.pk,
            "request_id": uuid4(),
            "actor": "검토 담당자",
            "reason": "저장 응답의 전체 호출과 사용량 검토",
        }

    def prepare(self, run):
        run.model_api_calls = 1
        run.evaluation_run_id = "a" * 32
        run.save()
        folder = self.root / str(run.pk)
        capture = json.loads((folder / "capture/capture.json").read_bytes())
        capture["apiResponses"] = sample_capture()["apiResponses"]
        capture["cases"][0]["apiResponseIndexes"] = [0]
        capture["cases"][0]["outcome"] = "success"
        # Distinct saved response for each original run, as real captures contain trace IDs.
        capture["cases"][0]["traceId"] = run.pk.hex
        self.write_capture(run, capture)

    def write_capture(self, run, capture):
        folder = self.root / str(run.pk)
        raw = json.dumps(capture).encode()
        (folder / "capture/capture.json").write_bytes(raw)
        fingerprint = sha256(raw).hexdigest()
        comparison = json.loads((folder / "evaluation/comparison.json").read_bytes())
        comparison["candidate_execution"]["capture_sha256"] = fingerprint
        raw_comparison = json.dumps(comparison).encode()
        (folder / "evaluation/comparison.json").write_bytes(raw_comparison)
        manifest = json.loads((folder / "evaluation/manifest.json").read_bytes())
        manifest["capture_sha256"] = fingerprint
        manifest["artifact_sha256"]["comparison.json"] = sha256(raw_comparison).hexdigest()
        (folder / "evaluation/manifest.json").write_text(json.dumps(manifest))

    def preview(self, **kwargs):
        return reconcile_legacy_usage(**{**self.arguments, **kwargs})

    def apply(self, **kwargs):
        arguments = {**self.arguments, **kwargs}
        preview = reconcile_legacy_usage(**arguments)
        return reconcile_legacy_usage(
            **arguments, evidence_sha256=preview["evidence_sha256"], apply=True
        )

    def amounts(self):
        self.budget.refresh_from_db()
        return (
            self.budget.allocated_calls,
            self.budget.allocated_input_tokens,
            self.budget.allocated_output_tokens,
        )


@override_settings(LLMOPS_ARTIFACT_URL="", LLMOPS_BUDGET_TOKEN=TOKEN, LLMOPS_LIVE_ENABLED=True)
class LegacyUsageTests(LegacyFixture, TestCase):
    def test_preview_is_read_only_and_apply_keeps_original_and_provenance(self):
        original = EvaluationRun.objects.filter(pk=self.run.pk).values().get()
        preview = self.preview()
        self.assertTrue(preview["can_apply"])
        self.assertEqual(preview["usage"], {"calls": 1, "input_tokens": 100, "output_tokens": 50})
        self.assertFalse(EvaluationLegacyUsage.objects.exists())
        self.assertEqual(self.amounts(), (0, 0, 0))
        result = self.apply()
        self.assertEqual(self.amounts(), (1, 100, 50))
        self.assertFalse(result["provider_receipt_verified"])
        self.assertEqual(result["source"], "SAVED_CAPTURE")
        self.assertEqual(EvaluationRun.objects.filter(pk=self.run.pk).values().get(), original)
        self.assertFalse(hasattr(EvaluationRun.objects.get(pk=self.run.pk), "budget_reservation"))
        self.assertNotIn("outputTexts", json.dumps(EvaluationLegacyUsage.objects.get().evidence))
        summary = budget_summary(self.budget)
        self.assertEqual(summary["state"], "consistent")
        self.assertEqual(summary["legacy_live_run_count"], 0)
        self.assertEqual(summary["legacy_accounted_run_count"], 1)
        self.assertEqual(summary["breakdown"]["settled_calls"], 0)
        self.assertEqual(summary["breakdown"]["legacy_calls"], 1)
        detail = self.client.get(self.url + "/budget")
        self.assertEqual(detail.status_code, 200)
        self.assertIn("no-store", detail["Cache-Control"])
        self.assertEqual(detail.json()["state"], "legacy_recorded")
        self.assertEqual(detail.json()["calls"], [])
        self.assertIsNone(detail.json()["reservation"])
        self.assertEqual(detail.json()["legacy_usage"]["usage"], preview["usage"])
        self.assertEqual(self.client.post(self.url + "/budget", {}, format="json").status_code, 405)

    def test_unconfigured_preview_does_not_create_budget_or_treat_missing_usage_as_zero(self):
        self.budget.delete()
        preview = self.preview()
        self.assertFalse(preview["can_apply"])
        self.assertIsNone(preview["before"])
        self.assertEqual(budget_summary(None)["input_state"], "legacy_unknown")
        with self.assertRaises(LegacyUsageUnavailable):
            self.apply()
        self.assertFalse(EvaluationBudget.objects.exists())
        self.assertFalse(EvaluationLegacyUsage.objects.exists())

    def test_explicit_hash_required_and_changed_source_or_metadata_rejected(self):
        preview = self.preview()
        for fingerprint in (None, "f" * 64, 123):
            with self.assertRaises(LegacyUsageUnavailable):
                self.preview(evidence_sha256=fingerprint, apply=True)
        capture = json.loads((self.root / str(self.run.pk) / "capture/capture.json").read_bytes())
        capture["apiResponses"][0]["usage"] = {
            "input_tokens": 110,
            "output_tokens": 50,
            "total_tokens": 160,
        }
        self.write_capture(self.run, capture)
        with self.assertRaises(LegacyUsageUnavailable):
            self.preview(evidence_sha256=preview["evidence_sha256"], apply=True)
        self.assertEqual(self.amounts(), (0, 0, 0))

    def test_artifact_hash_and_duplicate_json_keys_fail_closed(self):
        path = self.root / str(self.run.pk) / "capture/capture.json"
        raw = path.read_bytes()
        for changed in (raw + b" ", raw[:-1] + b',"modelApiCalls":1}'):
            path.write_bytes(changed)
            with self.assertRaises(LegacyUsageUnavailable):
                self.preview()
        self.assertFalse(EvaluationLegacyUsage.objects.exists())

    def test_replay_same_request_after_response_loss_is_not_recharged(self):
        result = self.apply()
        EvaluationBudget.objects.filter(pk=1).update(call_limit=30)
        with patch("apps.evaluations.legacy_usage.read_artifact", side_effect=AssertionError):
            replay = self.preview(evidence_sha256=result["evidence_sha256"], apply=True)
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["after"], result["after"])
        self.assertEqual(self.amounts(), (1, 100, 50))
        for kwargs in ({"actor": "다른 담당자"}, {"reason": "변경"}, {"request_id": uuid4()}):
            with self.assertRaises(LegacyUsageUnavailable):
                self.preview(evidence_sha256=result["evidence_sha256"], apply=True, **kwargs)

    def test_partial_current_replay_or_reserved_runs_cannot_use_legacy_path(self):
        for fields in (
            {"status": "FAILED"},
            {"error_code": "FAILED"},
            {"execution_mode": "replay"},
            {"execution_spec": {"schema_version": 1}},
            {"execution_spec_sha256": "a" * 64},
            {"source_run_id": self.run.pk},
            {"model_api_calls": 0},
        ):
            original = {key: getattr(self.run, key) for key in fields}
            EvaluationRun.objects.filter(pk=self.run.pk).update(**fields)
            with self.subTest(fields=fields), self.assertRaises(LegacyUsageUnavailable):
                self.preview()
            EvaluationRun.objects.filter(pk=self.run.pk).update(**original)
        reserve(self.run)
        with self.assertRaises(LegacyUsageUnavailable):
            self.preview()

    def test_duplicate_capture_cannot_be_charged_for_second_run(self):
        self.apply()
        other = self.completed_run()
        self.prepare(other)
        capture = json.loads((self.root / str(self.run.pk) / "capture/capture.json").read_bytes())
        self.write_capture(other, capture)
        with self.assertRaises(LegacyUsageUnavailable):
            self.apply(run_id=other.pk, request_id=uuid4())
        self.assertEqual(self.amounts(), (1, 100, 50))

    def test_limit_changes_and_inconsistent_global_totals_block_atomic_apply(self):
        preview = self.preview()
        for fields in (
            {"call_limit": 0},
            {"output_token_limit": 49},
            {"input_token_limit": 99},
            {"allocated_calls": 1},
        ):
            EvaluationBudget.objects.filter(pk=1).update(**fields)
            self.assertFalse(self.preview()["can_apply"])
            with self.subTest(fields=fields), self.assertRaises(LegacyUsageUnavailable):
                self.preview(evidence_sha256=preview["evidence_sha256"], apply=True)
            EvaluationBudget.objects.filter(pk=1).update(
                call_limit=20, output_token_limit=40000, input_token_limit=None, allocated_calls=0
            )
        self.assertEqual(self.amounts(), (0, 0, 0))
        self.assertFalse(EvaluationLegacyUsage.objects.exists())
        with patch.object(EvaluationBudget, "save", side_effect=DatabaseError("test rollback")):
            with self.assertRaises(DatabaseError):
                self.apply()
        self.assertEqual(self.amounts(), (0, 0, 0))
        self.assertFalse(EvaluationLegacyUsage.objects.exists())

    def test_input_limit_requires_all_missing_runs_accounted_and_new_budget_keeps_history(self):
        other = self.completed_run()
        self.prepare(other)
        limits = {
            "calls": 20,
            "input_tokens": 10000,
            "output_tokens": 40000,
            "actor": "운영자",
            "reason": "테스트 한도",
            "request_id": uuid4(),
        }
        self.apply()
        with self.assertRaises(ValueError):
            change_limits(**limits)
        self.apply(run_id=other.pk, request_id=uuid4())
        change_limits(**limits)
        self.budget.refresh_from_db()
        self.assertEqual(budget_summary(self.budget)["input_state"], "enforced")
        with self.assertRaises(BudgetUnavailable):
            reserve(self.run)
        # Existing reserve/settle/close must preserve the independently recorded legacy usage.
        run = EvaluationRun.objects.create(
            requested_by=self.user,
            dataset_id="new",
            execution_mode="live",
            live_config={"max_model_calls": 1, "max_output_tokens": 2000, "model": "test-only"},
            prefect_flow_run_id=uuid4(),
            execution_spec={"test": True},
            execution_spec_sha256="b" * 64,
        )
        # Old-style fixture without input caps cannot run with the new input limit.
        EvaluationBudget.objects.filter(pk=1).update(input_token_limit=None)
        reserve(run)
        worker = uuid4()
        args = (run.pk, worker, run.prefect_flow_run_id, "b" * 64)
        worker_action(*args, "claim")
        worker_action(*args, "authorize", sequence=0, model="test-only", max_output_tokens=2000)
        worker_action(*args, "settle", sequence=0, usage=USAGE)
        worker_action(*args, "close")
        self.assertEqual(self.amounts(), (3, 300, 150))
        summary = budget_summary(self.budget)
        self.assertEqual(summary["state"], "consistent")
        self.assertEqual(summary["breakdown"]["legacy_calls"], 2)
        self.assertEqual(summary["breakdown"]["settled_calls"], 1)

    def test_command_defaults_to_preview_and_apply_requires_review_hash(self):
        output = StringIO()
        args = [
            "--run-id",
            str(self.run.pk),
            "--actor",
            self.arguments["actor"],
            "--reason",
            self.arguments["reason"],
            "--request-id",
            str(self.arguments["request_id"]),
        ]
        call_command("reconcile_legacy_evaluation_usage", *args, stdout=output)
        preview = json.loads(output.getvalue())
        self.assertFalse(preview["applied"])
        self.assertFalse(EvaluationLegacyUsage.objects.exists())
        with self.assertRaises(CommandError):
            call_command("reconcile_legacy_evaluation_usage", *args, "--apply", stdout=StringIO())
        call_command(
            "reconcile_legacy_evaluation_usage",
            *args,
            "--apply",
            "--evidence-sha256",
            preview["evidence_sha256"],
            stdout=StringIO(),
        )
        self.assertEqual(EvaluationLegacyUsage.objects.count(), 1)


@override_settings(LLMOPS_ARTIFACT_URL="")
class LegacyConcurrencyTests(LegacyFixture, TransactionTestCase):
    def test_two_operators_cannot_charge_same_run_twice(self):
        preview = self.preview()
        barrier = threading.Barrier(2)

        def execute(request_id):
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                return self.preview(
                    request_id=request_id, apply=True, evidence_sha256=preview["evidence_sha256"]
                )["applied"]
            except LegacyUsageUnavailable:
                return False
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(execute, [uuid4(), uuid4()]))
        self.assertEqual(sorted(results), [False, True])
        self.assertEqual(self.amounts(), (1, 100, 50))
        self.assertEqual(EvaluationLegacyUsage.objects.count(), 1)

    def test_two_runs_cannot_overrun_shared_limit(self):
        other = self.completed_run()
        self.prepare(other)
        previews = [self.preview(run_id=run.pk) for run in (self.run, other)]
        EvaluationBudget.objects.filter(pk=1).update(call_limit=1)
        barrier = threading.Barrier(2)

        def execute(preview):
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                return self.preview(
                    run_id=preview["run_id"],
                    request_id=uuid4(),
                    apply=True,
                    evidence_sha256=preview["evidence_sha256"],
                )["applied"]
            except LegacyUsageUnavailable:
                return False
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(execute, previews))
        self.assertEqual(sorted(results), [False, True])
        self.assertEqual(self.amounts(), (1, 100, 50))

    def test_waiting_apply_rechecks_run_identity_after_lock(self):
        preview = self.preview()
        ready = threading.Event()
        from .legacy_usage import read_candidate

        def observed(run):
            result = read_candidate(run)
            ready.set()
            return result

        def execute():
            close_old_connections()
            try:
                with self.assertRaises(LegacyUsageUnavailable):
                    self.preview(apply=True, evidence_sha256=preview["evidence_sha256"])
            finally:
                close_old_connections()

        with patch("apps.evaluations.legacy_usage.read_candidate", side_effect=observed):
            with ThreadPoolExecutor(max_workers=1) as pool:
                with transaction.atomic():
                    run = EvaluationRun.objects.select_for_update().get(pk=self.run.pk)
                    result = pool.submit(execute)
                    self.assertTrue(ready.wait(timeout=10))
                    run.status = "FAILED"
                    run.save(update_fields=["status"])
                result.result(timeout=10)
        self.assertEqual(self.amounts(), (0, 0, 0))


class LegacyMigrationTests(TransactionTestCase):
    def test_forward_migration_preserves_old_usage_without_automatic_backfill(self):
        old = [("evaluations", "0023_rag_baselines")]
        executor = MigrationExecutor(connection)
        latest = executor.loader.graph.leaf_nodes()
        executor.migrate(old)
        try:
            apps = executor.loader.project_state(old).apps
            user = apps.get_model("auth", "User").objects.create(username="legacy-migration-test")
            run = apps.get_model("evaluations", "EvaluationRun").objects.create(
                requested_by_id=user.pk,
                dataset_id="legacy",
                status="COMPLETED",
                execution_mode="live",
                model_api_calls=1,
            )
            apps.get_model("evaluations", "EvaluationBudget").objects.create(
                call_limit=10,
                output_token_limit=20000,
            )
            before = apps.get_model("evaluations", "EvaluationRun").objects.values().get()
            MigrationExecutor(connection).migrate(latest)
            self.assertEqual(EvaluationRun.objects.filter(pk=run.pk).values().get(), before)
            self.assertEqual(EvaluationBudget.objects.get().allocated_calls, 0)
            self.assertFalse(EvaluationLegacyUsage.objects.exists())
        finally:
            MigrationExecutor(connection).migrate(latest)
