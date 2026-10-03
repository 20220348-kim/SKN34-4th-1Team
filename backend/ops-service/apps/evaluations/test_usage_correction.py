import hashlib
import hmac
import importlib.util
import json
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from uuid import uuid4

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import DatabaseError, close_old_connections, connection, transaction
from django.test import SimpleTestCase, TransactionTestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from . import artifact_store
from .admission import change_admission
from .artifact_server import application
from .budget import BudgetUnavailable, reserve, worker_action
from .execution_spec import digest
from .models import EvaluationBudget, EvaluationRun, EvaluationUsageCorrection
from .test_artifact_store import TOKEN as ARTIFACT_TOKEN
from .test_artifact_store import ArtifactServerMixin
from .test_budget import TOKEN, USAGE
from .usage_correction import CorrectionUnavailable, correct_usage, read_receipt

# Test the real producer/consumer contract across the runner and Ops packages.
# Keep the configured evidence path; isolated image tests may supply a test-only input.
_runner_source = Path(
    os.environ.get(
        "OPS_TEST_BUDGET_CLIENT_PATH",
        settings.LLMOPS_EVIDENCE_DIR / "budget_client.py",
    )
)
if not _runner_source.is_absolute() or not _runner_source.is_file():
    raise RuntimeError(
        "Usage receipt tests require the real runner source. Set OPS_TEST_BUDGET_CLIENT_PATH "
        "to the absolute path of the checkout's budget_client.py; tests must not be skipped."
    )
_spec = importlib.util.spec_from_file_location("receipt_budget_client", _runner_source)
_runner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_runner)


def signed(payload):
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    signature = hmac.new(
        TOKEN.encode(), b"govbiz-budget-usage-v1\n" + raw, hashlib.sha256
    ).hexdigest()
    return json.dumps({"payload": payload, "signature": signature}).encode()


@override_settings(LLMOPS_BUDGET_TOKEN=TOKEN)
class UsageReceiptTests(SimpleTestCase):
    def setUp(self):
        folder = TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        override = override_settings(LLMOPS_RESULTS_DIR=self.root, LLMOPS_ARTIFACT_URL="")
        override.enable()
        self.addCleanup(override.disable)
        self.run_id = uuid4()
        self.folder = self.root / str(self.run_id) / "capture"
        self.folder.mkdir(parents=True)
        with patch.dict(os.environ, {"LLMOPS_BUDGET_TOKEN": TOKEN}):
            self.runner = _runner.BudgetClient(str(self.run_id), str(uuid4()), "a" * 64)
        self.runner.record_usage_receipt(
            self.folder,
            0,
            "test-only",
            2000,
            200,
            {
                "id": "resp_fixture",
                "status": "completed",
                "usage": USAGE,
            },
        )
        self.path = self.folder / "usage-0.json"
        self.raw = self.path.read_bytes()

    def test_real_worker_receipt_verifies_and_preserves_only_allowlisted_metadata(self):
        raw, sha, payload, stamp = read_receipt(self.run_id, 0)
        self.assertEqual(raw.encode(), self.raw)
        self.assertEqual(sha, hashlib.sha256(self.raw).hexdigest())
        self.assertEqual(payload["usage"], USAGE)
        self.assertTrue(timezone.is_aware(stamp))
        self.assertNotIn(TOKEN, raw)
        self.assertNotIn("outputTexts", raw)

    def test_modified_signature_oversized_duplicate_or_invalid_receipts_are_rejected(self):
        original = json.loads(self.raw)
        invalid = [b"{}", b"x" * 8193, b"null", b"[]", b"\xff"]
        invalid.append(self.raw.replace(b'"output_tokens":50', b'"output_tokens":40'))
        invalid.append(self.raw[:-1] + b',"signature":"duplicate"}')
        for key, value in (
            ("version", True),
            ("sequence", True),
            ("worker_id", "invalid"),
            ("flow_id", "invalid"),
            ("run_id", str(uuid4())),
            ("response_id", "bad"),
            ("response_status", "in_progress"),
            ("observed_at", "2026-09-29"),
            ("source", "MANUAL"),
            ("spec_hash", "bad"),
            ("extra", "unexpected"),
        ):
            invalid.append(signed({**original["payload"], key: value}))
        for usage in (
            None,
            {**USAGE, "input_tokens": True},
            {**USAGE, "total_tokens": 0},
            {"input_tokens": 100, "output_tokens": 2001, "total_tokens": 2101},
        ):
            invalid.append(signed({**original["payload"], "usage": usage}))
        for raw in invalid:
            with self.subTest(raw=raw[:40]):
                self.path.write_bytes(raw)
                with self.assertRaises(CorrectionUnavailable):
                    read_receipt(self.run_id, 0)

    def test_missing_old_key_and_symlink_evidence_do_not_become_zero(self):
        with override_settings(LLMOPS_BUDGET_TOKEN="different-secret-token-long-enough-0000"):
            with self.assertRaises(CorrectionUnavailable):
                read_receipt(self.run_id, 0)
        self.path.unlink()
        with self.assertRaises(CorrectionUnavailable):
            read_receipt(self.run_id, 0)
        target = self.root / "original.json"
        target.write_bytes(self.raw)
        self.path.symlink_to(target)
        with self.assertRaises(CorrectionUnavailable):
            read_receipt(self.run_id, 0)


@override_settings(LLMOPS_LIVE_ENABLED=True, LLMOPS_BUDGET_TOKEN=TOKEN)
class UsageCorrectionTests(ArtifactServerMixin, TransactionTestCase):
    def setUp(self):
        folder = TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        override = override_settings(LLMOPS_RESULTS_DIR=self.root, LLMOPS_ARTIFACT_URL="")
        override.enable()
        self.addCleanup(override.disable)
        self.user = get_user_model().objects.create_user("correction-operator")
        self.budget = EvaluationBudget.objects.create(call_limit=12, output_token_limit=24000)
        self.run = EvaluationRun.objects.create(
            requested_by=self.user,
            dataset_id="correction-fixture",
            execution_mode="live",
            status="RUNNING",
            prefect_flow_run_id=uuid4(),
            execution_spec={"version": 1},
            execution_spec_sha256=digest({"version": 1}),
            live_config={"model": "test-only", "max_model_calls": 6, "max_output_tokens": 2000},
        )
        with transaction.atomic():
            reserve(self.run)
        self.worker = uuid4()
        self.action("claim")
        self.action("authorize", sequence=0, model="test-only", max_output_tokens=2000)
        directory = self.root / str(self.run.pk) / "capture"
        directory.mkdir(parents=True)
        with patch.dict(os.environ, {"LLMOPS_BUDGET_TOKEN": TOKEN}):
            runner = _runner.BudgetClient(
                str(self.run.pk), str(self.run.prefect_flow_run_id), self.run.execution_spec_sha256
            )
        runner.identity["worker_id"] = str(self.worker)
        runner.record_usage_receipt(
            directory,
            0,
            "test-only",
            2000,
            200,
            {
                "id": "resp_fixture",
                "status": "completed",
                "usage": USAGE,
            },
        )
        self.path = directory / "usage-0.json"
        self.raw = self.path.read_bytes()
        self.action("close")
        self.run.refresh_from_db()
        self.request = dict(
            run_id=self.run.pk,
            sequence=0,
            actor="김 운영자",
            reason="정산 전달 실패 검토",
            request_id=uuid4(),
            evidence_sha256=hashlib.sha256(self.raw).hexdigest(),
        )

    def action(self, action, **kwargs):
        return worker_action(
            self.run.pk,
            self.worker,
            self.run.prefect_flow_run_id,
            self.run.execution_spec_sha256,
            action,
            **kwargs,
        )

    def apply(self, **changes):
        return correct_usage(**{**self.request, "apply": True, **changes})

    def amounts(self):
        self.budget.refresh_from_db()
        return self.budget.allocated_calls, self.budget.allocated_output_tokens

    def test_remote_correction_while_paused_preserves_unknown_until_verified(self):
        change_admission(
            accepting=False,
            expected_version=0,
            request_id=uuid4(),
            actor="operator",
            reason="갱신 중 기존 미확인 사용량 보정",
        )
        url = self.serve(application(self.root, self.root, ARTIFACT_TOKEN))
        remote_read = artifact_store.remote_read

        def read_without_transaction(*args, **kwargs):
            self.assertFalse(connection.in_atomic_block)
            return remote_read(*args, **kwargs)

        with (
            override_settings(
                LLMOPS_ARTIFACT_URL=url,
                LLMOPS_ARTIFACT_TOKEN=ARTIFACT_TOKEN,
                LLMOPS_RESULTS_DIR=self.root / "not-mounted-results",
            ),
            patch.object(artifact_store, "remote_read", side_effect=read_without_transaction),
        ):
            with override_settings(LLMOPS_ARTIFACT_TOKEN="wrong"):
                with self.assertRaises(CorrectionUnavailable):
                    self.apply()
            self.assertEqual(self.amounts(), (1, 2000))
            self.assertFalse(EvaluationUsageCorrection.objects.exists())
            preview = correct_usage(**self.request)
            self.assertFalse(preview["applied"])
            self.path.write_bytes(self.raw + b"\n")
            with self.assertRaises(CorrectionUnavailable):
                self.apply()
            self.assertEqual(self.amounts(), (1, 2000))
            self.path.write_bytes(self.raw)
            self.apply()
            self.assertEqual(self.amounts(), (1, 50))
            self.assertEqual(
                EvaluationUsageCorrection.objects.get().evidence_raw.encode(), self.raw
            )
            self.assertIsNone(self.run.budget_reservation.calls.get().settled_at)
            with patch.object(artifact_store, "build_opener") as build:
                self.assertTrue(self.apply()["replayed"])
                build.assert_not_called()
            self.assertEqual(EvaluationUsageCorrection.objects.count(), 1)

    def test_preview_and_cli_default_never_change_budget_or_calls(self):
        output = StringIO()
        call_command("correct_evaluation_usage", **self.request, stdout=output)
        preview = json.loads(output.getvalue())
        self.assertFalse(preview["applied"])
        self.assertEqual(preview["after"]["reservation_output_tokens"], 50)
        self.assertEqual(self.amounts(), (1, 2000))
        self.assertFalse(EvaluationUsageCorrection.objects.exists())
        with self.assertRaises(CommandError):
            call_command(
                "correct_evaluation_usage",
                **{**self.request, "evidence_sha256": None},
                apply=True,
                stdout=StringIO(),
            )

    def test_usage_correction_preserves_independently_accounted_legacy_usage(self):
        from .test_legacy_usage import seed_legacy_usage

        seed_legacy_usage(self.budget, self.user)
        self.apply()
        self.assertEqual(self.amounts(), (2, 51))
        self.assertEqual(self.budget.allocated_input_tokens, 101)

    def test_apply_preserves_original_call_raw_evidence_and_ledger_consistency(self):
        with patch("apps.evaluations.prefect_client.create_run") as create:
            result = self.apply()
        self.assertEqual(self.amounts(), (1, 50))
        call = self.run.budget_reservation.calls.get()
        self.assertIsNone(call.settled_at)
        self.assertIsNone(call.output_tokens)
        record = EvaluationUsageCorrection.objects.get()
        self.assertEqual(record.evidence_raw.encode(), self.raw)
        self.assertEqual(record.original_call["worker_id"], str(self.worker))
        self.assertEqual(result["after"]["unknown_calls"], 0)
        self.assertEqual(result["before"]["global_calls"], result["after"]["global_calls"])
        create.assert_not_called()
        client = APIClient()
        client.force_authenticate(self.user)
        summary = client.get("/api/v1/ops/budget").json()
        self.assertEqual(summary["state"], "consistent")
        self.assertEqual(summary["breakdown"]["confirmed_input_tokens"], 100)
        self.assertEqual(summary["breakdown"]["confirmed_output_tokens"], 50)
        self.assertEqual(summary["breakdown"]["unknown_calls"], 0)
        detail_response = client.get(f"/api/v1/ops/evaluations/{self.run.pk}/budget")
        detail = detail_response.json()
        self.assertIn("no-store", detail_response["Cache-Control"])
        self.assertEqual(detail["reservation"]["breakdown"], summary["breakdown"])
        self.assertIsNone(detail["calls"][0]["output_tokens"])
        self.assertEqual(detail["corrections"][0]["output_tokens"], 50)
        for field in ("worker_id", "signature", "evidence_raw", "original_call"):
            self.assertNotIn(field, json.dumps(detail))
        page = client.get("/api/v1/ops/budget/reservations").json()
        self.assertEqual(page["results"][0]["breakdown"], summary["breakdown"])

    def test_identical_retry_uses_original_audit_even_if_file_or_key_is_lost(self):
        original = self.apply()
        self.path.unlink()
        with override_settings(LLMOPS_BUDGET_TOKEN=""):
            replay = self.apply()
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["before"], original["before"])
        self.assertEqual(self.amounts(), (1, 50))
        for changed in (
            {"actor": "other"},
            {"reason": "other"},
            {"sequence": 1},
            {"run_id": uuid4()},
            {"evidence_sha256": "a" * 64},
        ):
            with self.assertRaises(CorrectionUnavailable):
                self.apply(**changed)

    def test_duplicate_evidence_and_conflicting_usage_cannot_release_twice(self):
        self.apply()
        with self.assertRaises(CorrectionUnavailable):
            self.apply(request_id=uuid4())
        payload = json.loads(self.raw)["payload"]
        payload["usage"] = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
        raw = signed(payload)
        self.path.write_bytes(raw)
        with self.assertRaises(CorrectionUnavailable):
            self.apply(request_id=uuid4(), evidence_sha256=hashlib.sha256(raw).hexdigest())
        self.assertEqual(EvaluationUsageCorrection.objects.count(), 1)
        self.assertEqual(self.amounts(), (1, 50))

    def test_changed_file_after_preview_requires_new_review(self):
        self.path.write_bytes(self.raw + b"\n")
        with self.assertRaises(CorrectionUnavailable):
            self.apply()
        self.assertEqual(self.amounts(), (1, 2000))

    def test_unbound_or_out_of_interval_signed_evidence_is_rejected(self):
        original = json.loads(self.raw)["payload"]
        for field, value in (
            ("worker_id", str(uuid4())),
            ("flow_id", str(uuid4())),
            ("spec_hash", "a" * 64),
            ("model", "other"),
            ("max_output_tokens", 3000),
            ("observed_at", (timezone.now() + timedelta(days=1)).isoformat()),
            ("observed_at", (timezone.now() - timedelta(days=1)).isoformat()),
        ):
            with self.subTest(field=field):
                raw = signed({**original, field: value})
                self.path.write_bytes(raw)
                with self.assertRaises(CorrectionUnavailable):
                    self.apply(evidence_sha256=hashlib.sha256(raw).hexdigest())
        self.assertEqual(self.amounts(), (1, 2000))

    def test_open_reservation_and_already_settled_call_are_rejected(self):
        reservation = self.run.budget_reservation
        closed = reservation.closed_at
        reservation.closed_at = None
        reservation.save()
        with self.assertRaises(CorrectionUnavailable):
            self.apply()
        reservation.closed_at = closed
        reservation.save()
        reservation.calls.update(input_tokens=100, output_tokens=50, settled_at=timezone.now())
        with self.assertRaises(CorrectionUnavailable):
            self.apply()
        self.assertFalse(EvaluationUsageCorrection.objects.exists())

    def test_missing_call_and_inconsistent_global_ledger_are_rejected(self):
        self.run.budget_reservation.calls.update(sequence=2)
        with self.assertRaises(CorrectionUnavailable):
            self.apply()
        self.run.budget_reservation.calls.update(sequence=0)
        EvaluationBudget.objects.filter(pk=1).update(allocated_output_tokens=1999)
        with self.assertRaises(CorrectionUnavailable):
            self.apply()
        self.assertEqual(self.amounts(), (1, 1999))

    def test_audit_failure_rolls_back_budget_release(self):
        with patch.object(EvaluationUsageCorrection, "save", side_effect=DatabaseError):
            with self.assertRaises(DatabaseError):
                self.apply()
        self.assertEqual(self.amounts(), (1, 2000))
        self.assertFalse(EvaluationUsageCorrection.objects.exists())
        self.assertIsNone(self.run.budget_reservation.calls.get().settled_at)

    def test_verified_zero_usage_remains_distinct_from_unknown(self):
        payload = json.loads(self.raw)["payload"]
        payload["usage"] = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
        raw = signed(payload)
        self.path.write_bytes(raw)
        result = self.apply(evidence_sha256=hashlib.sha256(raw).hexdigest())
        self.assertEqual(self.amounts(), (1, 0))
        self.assertEqual(result["after"]["unknown_calls"], 0)

    def race(self, first, second):
        barrier = threading.Barrier(2)

        def attempt(action):
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                try:
                    return action()
                except (CorrectionUnavailable, BudgetUnavailable):
                    return "blocked"
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as executor:
            return list(executor.map(attempt, [first, second]))

    def test_concurrent_identical_request_returns_one_audit(self):
        results = self.race(self.apply, self.apply)
        self.assertTrue(all(result != "blocked" for result in results))
        self.assertEqual(EvaluationUsageCorrection.objects.count(), 1)
        self.assertEqual(self.amounts(), (1, 50))

    def test_concurrent_different_requests_cannot_release_twice(self):
        results = self.race(self.apply, lambda: self.apply(request_id=uuid4()))
        self.assertEqual(results.count("blocked"), 1)
        self.assertEqual(EvaluationUsageCorrection.objects.count(), 1)
        self.assertEqual(self.amounts(), (1, 50))

    def test_late_worker_settle_close_or_claim_cannot_overwrite_correction(self):
        results = self.race(self.apply, lambda: self.action("settle", sequence=0, usage=USAGE))
        self.assertEqual(results.count("blocked"), 1)
        self.action("close")
        for action in ("claim", "authorize", "settle"):
            with self.assertRaises(BudgetUnavailable):
                self.action(action, sequence=0, usage=USAGE)
        self.assertEqual(self.amounts(), (1, 50))

    def test_exact_output_cap_confirms_usage_without_releasing_capacity(self):
        payload = json.loads(self.raw)["payload"]
        payload["usage"] = {"input_tokens": 100, "output_tokens": 2000, "total_tokens": 2100}
        raw = signed(payload)
        self.path.write_bytes(raw)
        result = self.apply(evidence_sha256=hashlib.sha256(raw).hexdigest())
        self.assertEqual(self.amounts(), (1, 2000))
        self.assertEqual(result["after"]["unknown_calls"], 0)

    def test_one_response_cannot_correct_two_different_runs(self):
        self.apply()
        other = EvaluationRun.objects.create(
            requested_by=self.user,
            dataset_id=self.run.dataset_id,
            execution_mode="live",
            status="RUNNING",
            prefect_flow_run_id=uuid4(),
            execution_spec=self.run.execution_spec,
            execution_spec_sha256=self.run.execution_spec_sha256,
            live_config=self.run.live_config,
        )
        with transaction.atomic():
            reserve(other)
        worker = uuid4()

        def action(name, **kwargs):
            worker_action(
                other.pk,
                worker,
                other.prefect_flow_run_id,
                other.execution_spec_sha256,
                name,
                **kwargs,
            )

        action("claim")
        action("authorize", sequence=0, model="test-only", max_output_tokens=2000)
        payload = json.loads(self.raw)["payload"]
        payload.update(
            run_id=str(other.pk),
            worker_id=str(worker),
            flow_id=str(other.prefect_flow_run_id),
            observed_at=timezone.now().isoformat(),
        )
        directory = self.root / str(other.pk) / "capture"
        directory.mkdir(parents=True)
        raw = signed(payload)
        (directory / "usage-0.json").write_bytes(raw)
        action("close")
        with self.assertRaisesMessage(CorrectionUnavailable, "다른 호출"):
            self.apply(
                run_id=other.pk, request_id=uuid4(), evidence_sha256=hashlib.sha256(raw).hexdigest()
            )
        self.assertEqual(self.amounts(), (2, 2050))
        self.assertEqual(EvaluationUsageCorrection.objects.count(), 1)

    def test_correction_keeps_cleanup_evidence_as_historical_snapshot(self):
        from .budget_cleanup import cleanup_reservation
        from .test_budget_cleanup import terminal

        # Reconstruct an unclosed reservation to exercise the real C1 -> C2 path.
        reservation = self.run.budget_reservation
        reservation.closed_at = None
        reservation.save()
        EvaluationBudget.objects.filter(pk=1).update(
            allocated_calls=6, allocated_output_tokens=12000
        )
        with patch("apps.evaluations.prefect_client.read_run", return_value=terminal(self.run)):
            cleanup = cleanup_reservation(
                run_id=self.run.pk,
                request_id=uuid4(),
                actor="operator",
                reason="failed close",
                apply=True,
            )
        self.apply()
        reservation.cleanup.refresh_from_db()
        self.assertEqual(reservation.cleanup.after, cleanup["after"])
        self.assertEqual(reservation.cleanup.after["unknown_output_tokens"], 2000)
        self.assertEqual(self.amounts(), (1, 50))
