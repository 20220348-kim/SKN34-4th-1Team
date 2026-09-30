"""실제 실행기 영수증과 Ops 소비자·MySQL 단발성 보정 계약."""

import hashlib
import hmac
import json
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Barrier
from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.db import DatabaseError, IntegrityError, close_old_connections, transaction
from django.test import TransactionTestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from .budget import reserve, worker_action
from .budget_reporting import budget_summary
from .execution_spec import digest
from .models import EvaluationBudget, EvaluationRun, EvaluationUsageCorrection
from .test_budget import TOKEN
from .test_embedding_budget import mixed_spec
from .test_usage_correction import _runner
from .usage_correction import CorrectionUnavailable, correct_usage, read_receipt


def signed(payload, version=2):
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    signature = hmac.new(
        TOKEN.encode(), f"govbiz-budget-usage-v{version}\n".encode() + canonical, hashlib.sha256
    ).hexdigest()
    return json.dumps({"payload": payload, "signature": signature}).encode()


@override_settings(LLMOPS_LIVE_ENABLED=True, LLMOPS_BUDGET_TOKEN=TOKEN)
class EmbeddingReceiptTests(TransactionTestCase):
    def setUp(self):
        folder = TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        override = override_settings(LLMOPS_RESULTS_DIR=self.root)
        override.enable()
        self.addCleanup(override.disable)
        self.user = get_user_model().objects.create_user("embedding-receipt")
        self.budget = EvaluationBudget.objects.create(
            call_limit=9, output_token_limit=6000, input_token_limit=99954
        )
        self.run, self.path = self.unknown_run("req_embedding_original")
        self.raw = self.path.read_bytes()
        self.request = dict(
            run_id=self.run.pk,
            sequence=0,
            actor="operator",
            reason="정산 응답 유실 확인",
            request_id=uuid4(),
            evidence_sha256=hashlib.sha256(self.raw).hexdigest(),
        )

    def unknown_run(self, request_id, sequence=0):
        spec = mixed_spec()
        run = EvaluationRun.objects.create(
            requested_by=self.user,
            execution_mode="live",
            execution_spec=spec,
            execution_spec_sha256=digest(spec),
            live_config=spec["live_config"],
            prefect_flow_run_id=uuid4(),
        )
        worker = uuid4()

        def action(name, **fields):
            worker_action(
                run.pk, worker, run.prefect_flow_run_id, run.execution_spec_sha256, name, **fields
            )

        with transaction.atomic():
            reserve(run)
        action("claim")
        operation = spec["model_operations"][sequence]
        tokens = min(100, operation["max_input_tokens"])
        action(
            "authorize",
            sequence=sequence,
            operation_id=operation["id"],
            model=operation["model"],
            max_output_tokens=0,
            input_token_count=tokens,
            input_sha256=operation["input_sha256"],
            dimensions=1536,
        )
        directory = self.root / str(run.pk) / "capture"
        directory.mkdir(parents=True)
        with patch.dict(os.environ, {"LLMOPS_BUDGET_TOKEN": TOKEN}):
            client = _runner.BudgetClient(
                str(run.pk), str(run.prefect_flow_run_id), run.execution_spec_sha256
            )
        client.identity["worker_id"] = str(worker)
        client.record_embedding_usage_receipt(
            directory,
            sequence,
            operation,
            request_id,
            {"input_tokens": tokens, "output_tokens": 0, "total_tokens": tokens},
        )
        action("close")
        return run, directory / f"usage-{sequence}.json"

    def test_query_receipt_matches_its_slot_and_cannot_replace_an_answer(self):
        run, path = self.unknown_run("req_query", sequence=1)
        request = {
            **self.request,
            "request_id": uuid4(),
            "run_id": run.pk,
            "sequence": 1,
            "evidence_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        }
        result = correct_usage(**request, apply=True)
        self.assertEqual(result["input_tokens"], 50)
        self.assertEqual(result["provider_request_id"], "req_query")

        # A signed v2 receipt must also fail if the approved call is an answer.
        reservation = self.run.budget_reservation
        reservation.refresh_from_db()
        call = reservation.calls.get()
        operation = self.run.execution_spec["model_operations"][2]
        call.sequence, call.operation_id = 2, operation["id"]
        call.max_input_tokens, call.max_output_tokens = 32768, 2000
        call.save()
        reservation.allocated_input_tokens, reservation.allocated_output_tokens = 32768, 2000
        reservation.save()
        self.budget.allocated_input_tokens, self.budget.allocated_output_tokens = 32818, 2000
        self.budget.allocated_calls = 2
        self.budget.save()
        payload = json.loads(self.raw)["payload"]
        payload["sequence"] = 2
        raw = signed(payload)
        (self.path.parent / "usage-2.json").write_bytes(raw)
        with self.assertRaisesMessage(CorrectionUnavailable, "임베딩 배치의 승인 명세"):
            correct_usage(
                **{
                    **self.request,
                    "sequence": 2,
                    "evidence_sha256": hashlib.sha256(raw).hexdigest(),
                },
                apply=True,
            )

    def amounts(self):
        self.budget.refresh_from_db()
        return (
            self.budget.allocated_calls,
            self.budget.allocated_input_tokens,
            self.budget.allocated_output_tokens,
        )

    def test_preview_apply_retry_and_public_ledger_preserve_original(self):
        output = StringIO()
        call_command("correct_evaluation_usage", **self.request, stdout=output)
        preview = json.loads(output.getvalue())
        self.assertFalse(preview["applied"])
        self.assertEqual(self.amounts(), (1, 500, 0))
        self.assertEqual(preview["after"]["reservation_input_tokens"], 100)
        result = correct_usage(**self.request, apply=True)
        self.assertEqual(self.amounts(), (1, 100, 0))
        self.assertEqual(result["source"], "WORKER_EMBEDDING_RESPONSE")
        self.assertIsNone(result["response_id"])
        self.assertEqual(result["provider_request_id"], "req_embedding_original")
        record = EvaluationUsageCorrection.objects.get()
        self.assertEqual(record.evidence_raw.encode(), self.raw)
        call = self.run.budget_reservation.calls.get()
        self.assertIsNone(call.input_tokens)
        self.assertIsNone(call.settled_at)
        self.assertEqual(budget_summary(self.budget)["state"], "consistent")
        client = APIClient()
        client.force_authenticate(self.user)
        response = client.get(f"/api/v1/ops/evaluations/{self.run.pk}/budget")
        detail = response.json()
        self.assertIn("no-store", response["Cache-Control"])
        self.assertEqual(detail["corrections"][0]["provider_request_id"], "req_embedding_original")
        self.assertEqual(detail["reservation"]["breakdown"]["confirmed_input_tokens"], 100)
        for secret in (TOKEN, "signature", "evidence_raw", "input_sha256", "worker_id"):
            self.assertNotIn(secret, json.dumps(detail))
        self.path.unlink()
        with override_settings(LLMOPS_BUDGET_TOKEN=""):
            self.assertTrue(correct_usage(**self.request, apply=True)["replayed"])
        self.assertEqual(self.amounts(), (1, 100, 0))
        with self.assertRaises(CorrectionUnavailable):
            correct_usage(**{**self.request, "request_id": uuid4()}, apply=True)

    def test_mismatched_batch_signature_usage_and_time_never_release_budget(self):
        original = json.loads(self.raw)["payload"]
        changes = [
            ("operation_id", "document_embedding:OTHER:0"),
            ("operation_kind", "query_embedding"),
            ("input_sha256", "b" * 64),
            ("dimensions", 2),
            ("model", "text-embedding-3-large"),
            ("max_input_tokens", 501),
            ("max_output_tokens", 1),
            ("provider_request_id", "bad id"),
            ("worker_id", str(uuid4())),
            ("flow_id", str(uuid4())),
            ("spec_hash", "c" * 64),
            ("observed_at", (timezone.now() + timedelta(days=1)).isoformat()),
            ("observed_at", (timezone.now() - timedelta(days=1)).isoformat()),
            ("usage", {"input_tokens": True, "output_tokens": 0, "total_tokens": 1}),
            ("usage", {"input_tokens": 100, "output_tokens": 1, "total_tokens": 101}),
            ("usage", {"input_tokens": 501, "output_tokens": 0, "total_tokens": 501}),
            ("usage", None),
            ("response_id", "resp_invented"),
        ]
        for field, value in changes:
            raw = signed({**original, field: value})
            self.path.write_bytes(raw)
            with self.subTest(field=field), self.assertRaises(CorrectionUnavailable):
                correct_usage(
                    **{**self.request, "evidence_sha256": hashlib.sha256(raw).hexdigest()},
                    apply=True,
                )
        self.path.write_bytes(signed(original, version=1))
        with self.assertRaises(CorrectionUnavailable):
            read_receipt(self.run.pk, 0)
        self.path.write_bytes(self.raw + b"\n")
        with self.assertRaises(CorrectionUnavailable):
            correct_usage(**self.request, apply=True)
        self.assertEqual(self.amounts(), (1, 500, 0))
        self.assertFalse(EvaluationUsageCorrection.objects.exists())

    def test_zero_is_known_but_missing_evidence_and_failed_audit_keep_reservation(self):
        with patch.object(EvaluationUsageCorrection, "save", side_effect=DatabaseError):
            with self.assertRaises(DatabaseError):
                correct_usage(**self.request, apply=True)
        self.assertEqual(self.amounts(), (1, 500, 0))
        self.path.unlink()
        with self.assertRaises(CorrectionUnavailable):
            correct_usage(**self.request, apply=True)
        self.assertEqual(self.amounts(), (1, 500, 0))
        payload = json.loads(self.raw)["payload"]
        payload["usage"] = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
        raw = signed(payload)
        self.path.write_bytes(raw)
        correct_usage(
            **{**self.request, "evidence_sha256": hashlib.sha256(raw).hexdigest()}, apply=True
        )
        self.assertEqual(self.amounts(), (1, 0, 0))

    def test_provider_request_identity_is_global_and_database_constrained(self):
        correct_usage(**self.request, apply=True)
        run, path = self.unknown_run("req_embedding_second")
        request = {
            **self.request,
            "run_id": run.pk,
            "request_id": uuid4(),
            "evidence_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        }
        correct_usage(**request, apply=True)
        self.assertEqual(
            EvaluationUsageCorrection.objects.filter(response_id__isnull=True).count(), 2
        )
        run, path = self.unknown_run("req_embedding_original")
        with self.assertRaises(CorrectionUnavailable):
            correct_usage(
                **{
                    **request,
                    "run_id": run.pk,
                    "request_id": uuid4(),
                    "evidence_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                },
                apply=True,
            )
        second = EvaluationUsageCorrection.objects.get(provider_request_id="req_embedding_second")
        for fields in (
            {"provider_request_id": "req_embedding_original"},
            {"provider_request_id": None},
            {"response_id": "resp_wrong_kind"},
        ):
            with (
                self.subTest(fields=fields),
                self.assertRaises(IntegrityError),
                transaction.atomic(),
            ):
                EvaluationUsageCorrection.objects.filter(pk=second.pk).update(**fields)
        self.assertEqual(self.amounts(), (3, 700, 0))

    def test_concurrent_corrections_release_input_once(self):
        barrier = Barrier(2)

        def apply(_):
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                correct_usage(**{**self.request, "request_id": uuid4()}, apply=True)
                return True
            except CorrectionUnavailable:
                return False
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertCountEqual(list(pool.map(apply, range(2))), [True, False])
        self.assertEqual(self.amounts(), (1, 100, 0))
        self.assertEqual(EvaluationUsageCorrection.objects.count(), 1)
