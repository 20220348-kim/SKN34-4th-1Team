"""완료된 Core 캡처를 실제 Ops 테스트 DB에 예약하고 무료 worker로 정산한다."""

import json
import os
import shutil
from pathlib import Path
from uuid import uuid4

from django.db import transaction
from rag_budget_http_checks import RagBudgetHttpTestCase

from apps.evaluations.budget import BudgetUnavailable, reserve
from apps.evaluations.execution_spec import digest
from apps.evaluations.models import EvaluationRun


class CoreRagBudgetHttpTests(RagBudgetHttpTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.captures = Path(os.environ["CORE_RAG_CAPTURE_ROOT"]).absolute()
        # No fallback fixture: CI must consume the actual Core producer from this checkout.
        for version in ("v1", "v2"):
            cls.worker("core-spec", {"directory": str(cls.captures / version)})

    def select_capture(self, version="v1", *, root=None):
        directory = (root or self.captures) / version
        self.spec = self.worker("core-spec", {"directory": str(directory)})
        return directory

    def test_core_inputs_reserve_and_settle_through_real_http(self):
        for version, cases, charged, counts in (
            ("v1", 9, (18, 914, 180), {"embedding": 9, "answer": 9, "input_count": 9}),
            ("v2", 1, (3, 107, 20), {"embedding": 2, "answer": 1, "input_count": 1}),
        ):
            with self.subTest(version=version):
                before = self.amounts()
                directory = self.select_capture(version)
                self.assertEqual(len(self.spec["rag_cases"]), cases)
                self.assertTrue(all(len(case["chunks"]) == 6 for case in self.spec["rag_cases"]))
                self.new_run()
                reservation = self.run.budget_reservation
                expected = (
                    cases * 3,
                    sum(item["max_input_tokens"] for item in self.spec["model_operations"]),
                    cases * 2000,
                )
                self.assertEqual(
                    self.amounts(), tuple(a + b for a, b in zip(before, expected, strict=True))
                )
                self.assertEqual(reservation.max_calls, expected[0])
                with transaction.atomic():
                    reserve(self.run)
                self.assertEqual(
                    self.amounts(), tuple(a + b for a, b in zip(before, expected, strict=True))
                )
                result = self.run_reserved(core_capture_directory=directory)
                self.assertEqual(result["statuses"], [200] * (cases * 3))
                self.assertEqual(result["counts"], counts)
                self.assertEqual(
                    self.amounts(), tuple(a + b for a, b in zip(before, charged, strict=True))
                )
                self.assertIsNotNone(self.run.budget_reservation.closed_at)
                self.assertEqual(digest(self.run.execution_spec), self.run.execution_spec_sha256)
                calls = list(self.run.budget_reservation.calls.order_by("sequence"))
                self.assertEqual(len(calls), charged[0])
                self.assertTrue(all(call.settled_at is not None for call in calls))
                self.assertEqual(sum(call.input_tokens for call in calls), charged[1])
                self.assertEqual(sum(call.output_tokens for call in calls), charged[2])
                for call in calls:
                    operation = self.spec["model_operations"][call.sequence]
                    self.assertEqual(call.operation_id, operation["id"])
                    receipt_path = (
                        self.root / str(self.run.pk) / "capture" / f"usage-{call.sequence}.json"
                    )
                    receipt = json.loads(receipt_path.read_bytes())["payload"]
                    self.assertEqual(receipt["spec_hash"], self.run.execution_spec_sha256)
                    self.assertEqual(receipt["usage"]["input_tokens"], call.input_tokens)
                self.assertEqual(self.request("close", result["worker_id"]), 200)
                self.assertEqual(self.request("claim", uuid4()), 409)
                self.assertEqual(
                    self.amounts(), tuple(a + b for a, b in zip(before, charged, strict=True))
                )

    def test_core_cancel_and_unknown_usage_stop_later_cases(self):
        for scenario, charged, attempted, unknown in (
            ("cancel-before-answer", (2, 7, 0), 0, False),
            ("unknown-usage", (3, 32775, 2000), 1, True),
        ):
            with self.subTest(scenario=scenario):
                before = self.amounts()
                directory = self.select_capture()
                self.new_run(scenario)
                result = self.run_reserved(scenario, core_capture_directory=directory)
                self.assertEqual(result["statuses"], [200, 200, 503])
                self.assertEqual(result["blocked_status"], 503)
                self.assertEqual(result["counts"]["answer"], attempted)
                self.assertEqual(
                    self.amounts(), tuple(a + b for a, b in zip(before, charged, strict=True))
                )
                self.assertIsNotNone(self.run.budget_reservation.closed_at)
                calls = self.run.budget_reservation.calls
                self.assertEqual(calls.count(), charged[0])
                self.assertFalse(calls.filter(sequence__gt=2).exists())
                if unknown:
                    self.assertIsNone(calls.get(sequence=2).settled_at)
                    self.assertIsNone(calls.get(sequence=2).input_tokens)
                else:
                    self.assertIsNotNone(self.run.cancel_requested_at)

    def test_budget_shortage_rolls_back_core_run_and_reservation(self):
        self.select_capture("v2")
        self.budget.call_limit = 2
        self.budget.save(update_fields=["call_limit"])
        with self.assertRaises(BudgetUnavailable):
            self.new_run()
        self.assertEqual(EvaluationRun.objects.count(), 0)
        self.assertEqual(self.amounts(), (0, 0, 0))
        self.assertEqual(self.events, [])

    def test_changed_core_inputs_are_rejected_before_and_after_reservation(self):
        # Change a private copy, never the evidence generated by the Core integration.
        copied = self.root / "core-copy"
        shutil.copytree(self.captures, copied)
        directory = copied / "v2"
        path = directory / "capture.json"
        original = path.read_bytes()
        path.write_bytes(original + b"\n")
        with self.assertRaisesRegex(AssertionError, "stale or modified"):
            self.select_capture("v2", root=copied)
        self.assertEqual(EvaluationRun.objects.count(), 0)
        self.assertEqual(self.amounts(), (0, 0, 0))
        path.write_bytes(original)
        self.select_capture("v2", root=copied)
        self.new_run()
        reserved = self.amounts()
        path.write_bytes(original + b"\n")
        with self.assertRaisesRegex(AssertionError, "stale or modified"):
            self.run_reserved(core_capture_directory=directory)
        self.run.refresh_from_db()
        self.assertEqual(self.events, [])
        self.assertFalse(self.run.budget_reservation.calls.exists())
        self.assertIsNone(self.run.budget_reservation.closed_at)
        self.assertEqual(self.amounts(), reserved)
        self.assertFalse((self.root / str(self.run.pk) / "capture").exists())
