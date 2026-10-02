"""실제 Django HTTP·MySQL과 별도 AI 프로세스의 무료 혼합 RAG 계약 검사.

Ops 기본 테스트와 별도로 manage.py test rag_budget_http_checks로 실행한다.
RAG_BUDGET_AI_PYTHON은 잠금 파일로 설치한 Python 3.12 AI 가상환경이어야 한다.
"""

import io
import json
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Barrier, Thread
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4
from wsgiref.simple_server import WSGIRequestHandler, make_server

from django.contrib.auth import get_user_model
from django.core.handlers.wsgi import WSGIHandler
from django.core.servers.basehttp import ThreadedWSGIServer
from django.db import connection, transaction
from django.test import TransactionTestCase, override_settings
from rag_budget_http_worker import TOKEN

from apps.evaluations.artifact_server import application
from apps.evaluations.budget import reserve
from apps.evaluations.budget_reporting import budget_summary
from apps.evaluations.execution_spec import digest
from apps.evaluations.models import (
    EvaluationBudget,
    EvaluationRun,
    EvaluationUsageCorrection,
)
from apps.evaluations.services import cancel_run
from apps.evaluations.test_artifact_store import ArtifactServerMixin
from apps.evaluations.usage_correction import CorrectionUnavailable, correct_usage

ROOT = Path(__file__).resolve().parents[2]
WORKER = Path(__file__).with_name("rag_budget_http_worker.py")


class QuietHandler(WSGIRequestHandler):
    def log_message(self, *args):
        pass


@override_settings(
    LLMOPS_LIVE_ENABLED=True,
    LLMOPS_BUDGET_TOKEN=TOKEN,
    ALLOWED_HOSTS=["127.0.0.1", "testserver"],
)
class RagBudgetHttpTests(ArtifactServerMixin, TransactionTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        if connection.vendor != "mysql" or connection.mysql_version[:2] != (8, 4):
            raise RuntimeError("These checks require an isolated MySQL 8.4 test database")
        if not connection.settings_dict["NAME"].startswith("test_"):
            raise RuntimeError("Only Django's isolated test database is allowed")
        cls.ai_python = Path(os.environ["RAG_BUDGET_AI_PYTHON"]).absolute()
        if not cls.ai_python.is_file():
            raise RuntimeError(
                "The locked AI Python environment is required; do not skip this check"
            )
        cls.spec = cls.worker("spec")

    @classmethod
    def worker(cls, command, data=None):
        environment = {
            key: os.environ[key]
            for key in ("PATH", "SYSTEMROOT", "TIKTOKEN_CACHE_DIR")
            if key in os.environ
        }
        environment["PYTHONUNBUFFERED"] = "1"
        process = subprocess.run(
            [str(cls.ai_python), "-X", "utf8", "-B", str(WORKER), command],
            input=json.dumps(data) if data is not None else None,
            capture_output=True,
            text=True,
            encoding="utf-8",
            cwd=ROOT / "backend/ai-service",
            env=environment,
            timeout=60,
            check=False,
        )
        if process.returncode:
            raise AssertionError(
                f"Offline AI worker failed ({process.returncode}): {process.stderr[-6000:]}"
            )
        return json.loads(process.stdout)

    def setUp(self):
        directory = TemporaryDirectory(prefix="rag-http-test-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.user = get_user_model().objects.create_user("rag-http-test")
        self.budget = EvaluationBudget.objects.create(
            call_limit=100, input_token_limit=2_000_000, output_token_limit=100_000
        )
        self.faults, self.events = {}, []
        django = WSGIHandler()

        def fault_boundary(environ, respond):
            # All normal requests reach the real middleware, serializer, transaction and DB.
            parts = environ["PATH_INFO"].split("/")
            run_id, action = parts[-3], parts[-1]
            raw = environ["wsgi.input"].read(int(environ.get("CONTENT_LENGTH") or 0))
            environ["wsgi.input"] = io.BytesIO(raw)
            body = json.loads(raw or b"{}")
            fault = self.faults.get(run_id, {})
            scenario = fault.get("scenario")
            sequence = body.get("sequence")
            self.events.append((run_id, action, sequence))
            if (scenario, action, sequence) in {
                ("cancel-before-answer", "authorize", 2),
                ("cancel-after-answer", "settle", 2),
            }:
                cancel_run(EvaluationRun.objects.get(pk=run_id), self.user)
            target = (
                (scenario, action, sequence)
                in {
                    ("embedding-settle-before-commit", "settle", 0),
                    ("query-settle-before-commit", "settle", 1),
                }
                or (
                    scenario in {"settle-before-commit", "settle-after-commit"}
                    and action == "settle"
                    and sequence == 2
                )
                or (
                    scenario == "lost-authorize-response"
                    and action == "authorize"
                    and sequence == 2
                )
                or (scenario == "close-failure" and action == "close")
            ) and not fault.get("fired")
            if target:
                fault["fired"] = True
                if scenario in {"settle-after-commit", "lost-authorize-response"}:
                    statuses = []
                    result = django(
                        environ,
                        lambda status, headers, exc_info=None: statuses.append(status),
                    )
                    try:
                        list(result)
                    finally:
                        result.close()
                    if statuses != ["200 OK"]:
                        raise AssertionError(
                            f"Expected committed HTTP success, received {statuses}"
                        )
                payload = b'{"code":"TEST_RESPONSE_LOST"}'
                respond(
                    "503 Service Unavailable",
                    [
                        ("Content-Type", "application/json"),
                        ("Content-Length", str(len(payload))),
                    ],
                )
                return [payload]
            return django(environ, respond)

        server = make_server("127.0.0.1", 0, fault_boundary, ThreadedWSGIServer, QuietHandler)
        thread = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()

        def stop():
            server.shutdown()
            thread.join(timeout=5)
            server.server_close()

        self.addCleanup(stop)
        self.ops_url = f"http://127.0.0.1:{server.server_port}"

    def new_run(self, scenario="success"):
        self.run = EvaluationRun.objects.create(
            requested_by=self.user,
            status="RUNNING",
            execution_mode="live",
            execution_spec=self.spec,
            execution_spec_sha256=digest(self.spec),
            live_config=self.spec["live_config"],
            prefect_flow_run_id=uuid4(),
        )
        with transaction.atomic():
            reserve(self.run)
        self.faults[str(self.run.pk)] = {"scenario": scenario}
        return self.run

    def execute(self, scenario="success"):
        self.new_run(scenario)
        result = self.worker(
            "run",
            {
                "scenario": scenario,
                "ops_url": self.ops_url,
                "results": str(self.root),
                "run_id": str(self.run.pk),
                "flow_id": str(self.run.prefect_flow_run_id),
                "spec": self.spec,
                "spec_hash": self.run.execution_spec_sha256,
            },
        )
        # reserve() cached the reverse relation before the HTTP worker changed it.
        self.run.refresh_from_db()
        for call in self.run.budget_reservation.calls.all():
            operation = self.spec["model_operations"][call.sequence]
            self.assertEqual(call.operation_id, operation["id"])
            self.assertEqual(call.max_input_tokens, operation["max_input_tokens"])
            self.assertEqual(call.max_output_tokens, operation["max_output_tokens"])
        return result

    def amounts(self):
        self.budget.refresh_from_db()
        self.assertEqual(budget_summary(self.budget)["state"], "consistent")
        return (
            self.budget.allocated_calls,
            self.budget.allocated_input_tokens,
            self.budget.allocated_output_tokens,
        )

    def request(self, action, worker_id, *, token=TOKEN, **fields):
        body = {
            "worker_id": str(worker_id),
            "flow_id": str(self.run.prefect_flow_run_id),
            "spec_hash": self.run.execution_spec_sha256,
            **fields,
        }
        request = Request(
            f"{self.ops_url}/internal/llmops/evaluations/{self.run.pk}/budget/{action}",
            data=json.dumps(body).encode(),
            headers={
                "Authorization": "Bearer " + token,
                "Content-Type": "application/json",
            },
        )
        try:
            with urlopen(request, timeout=5) as response:
                self.assertEqual(json.load(response), {"accepted": True})
                return response.status
        except HTTPError as error:
            with error:
                return error.code

    def test_mixed_execution_cache_and_http_close_match_real_ledger(self):
        result = self.execute()
        self.assertEqual(result["statuses"], [200] * 6)
        self.assertEqual(result["counts"], {"embedding": 2, "answer": 2, "input_count": 2})
        self.assertEqual(self.amounts(), (4, 203, 40))
        reservation = self.run.budget_reservation
        self.assertIsNotNone(reservation.closed_at)
        calls = list(reservation.calls.order_by("sequence"))
        self.assertEqual([call.sequence for call in calls], [0, 1, 2, 5])
        self.assertTrue(all(call.settled_at is not None for call in calls))
        self.assertEqual(
            [call.counted_input_tokens for call in calls if call.sequence in (2, 5)],
            [100, 100],
        )
        for call in calls:
            path = self.root / str(self.run.pk) / "capture" / f"usage-{call.sequence}.json"
            receipt = json.loads(path.read_bytes())["payload"]
            self.assertEqual(receipt["spec_hash"], self.run.execution_spec_sha256)
            self.assertEqual(receipt["version"], 2 if call.sequence < 2 else 1)
            self.assertEqual(receipt["usage"]["input_tokens"], call.input_tokens)
            self.assertEqual(receipt["usage"]["output_tokens"], call.output_tokens)
            if call.sequence < 2:
                self.assertEqual(receipt["operation_id"], call.operation_id)
        self.assertEqual(self.request("claim", uuid4()), 409)
        self.assertEqual(self.request("close", result["worker_id"]), 200)
        self.assertEqual(self.amounts(), (4, 203, 40))

    def test_failures_stop_calls_and_keep_confirmed_or_unknown_usage(self):
        doc_cap = self.spec["model_operations"][0]["max_input_tokens"]
        query_cap = self.spec["model_operations"][1]["max_input_tokens"]
        cases = (
            ("cancel-before-answer", (2, 3, 0), (2, 0), None),
            ("cancel-after-answer", (3, 103, 20), (2, 1), None),
            ("lost-authorize-response", (3, 32771, 2000), (2, 0), 2),
            ("settle-before-commit", (3, 32771, 2000), (2, 1), 2),
            ("settle-after-commit", (3, 103, 20), (2, 1), None),
            ("embedding-settle-before-commit", (1, doc_cap, 0), (1, 0), 0),
            ("query-settle-before-commit", (2, 2 + query_cap, 0), (2, 0), 1),
            ("query-unknown-usage", (2, 2 + query_cap, 0), (2, 0), 1),
            ("model-timeout", (3, 32771, 2000), (2, 1), 2),
            ("unknown-usage", (3, 32771, 2000), (2, 1), 2),
            ("invalid-citation", (3, 103, 20), (2, 1), None),
        )
        for scenario, charged, calls, unknown in cases:
            with self.subTest(scenario=scenario):
                before = self.amounts()
                result = self.execute(scenario)
                self.assertEqual(result["statuses"][-1], 503)
                self.assertEqual(result["blocked_status"], 503)
                self.assertEqual((result["counts"]["embedding"], result["counts"]["answer"]), calls)
                self.assertEqual(
                    self.amounts(),
                    tuple(a + b for a, b in zip(before, charged, strict=True)),
                )
                reservation = self.run.budget_reservation
                self.assertIsNotNone(reservation.closed_at)
                self.assertEqual(
                    list(
                        reservation.calls.filter(settled_at__isnull=True).values_list(
                            "sequence", flat=True
                        )
                    ),
                    [] if unknown is None else [unknown],
                )
                if scenario in {"lost-authorize-response", "query-unknown-usage"}:
                    self.assertFalse(
                        (
                            self.root / str(self.run.pk) / "capture" / f"usage-{unknown}.json"
                        ).exists()
                    )
                if scenario.startswith("cancel-"):
                    self.run.refresh_from_db()
                    self.assertIsNotNone(self.run.cancel_requested_at)
                    self.assertEqual(self.run.status, "CANCELLING")

    def test_close_failure_keeps_reservation_until_same_owner_closes(self):
        result = self.execute("close-failure")
        self.assertTrue(result["lifecycle_error"])
        self.assertEqual(result["statuses"], [200] * 6)
        self.assertIsNone(self.run.budget_reservation.closed_at)
        self.assertEqual(
            self.amounts(),
            (
                6,
                sum(item["max_input_tokens"] for item in self.spec["model_operations"]),
                4000,
            ),
        )
        self.assertEqual(self.request("claim", uuid4()), 409)
        self.assertEqual(self.request("close", result["worker_id"]), 200)
        self.assertEqual(self.amounts(), (4, 203, 40))
        self.assertEqual(self.request("close", result["worker_id"]), 200)
        self.assertEqual(self.amounts(), (4, 203, 40))

    def test_parallel_claims_and_authorizations_issue_only_one_call(self):
        self.new_run()
        workers = [uuid4(), uuid4()]
        barrier = Barrier(2)

        def claim(worker):
            barrier.wait(timeout=5)
            return self.request("claim", worker)

        with ThreadPoolExecutor(max_workers=2) as pool:
            statuses = list(pool.map(claim, workers))
        self.assertEqual(sorted(statuses), [200, 409])
        owner = workers[statuses.index(200)]
        item = self.spec["model_operations"][0]
        fields = {
            "sequence": 0,
            "operation_id": item["id"],
            "model": item["model"],
            "max_output_tokens": 0,
            "input_token_count": item["max_input_tokens"],
            "input_sha256": item["input_sha256"],
            "dimensions": item["dimensions"],
        }
        self.assertEqual(self.request("authorize", owner, token="incorrect", **fields), 403)
        self.assertEqual(
            self.request("authorize", owner, **{**fields, "input_sha256": "b" * 64}),
            409,
        )

        def authorize(_):
            barrier.wait(timeout=5)
            return self.request("authorize", owner, **fields)

        with ThreadPoolExecutor(max_workers=2) as pool:
            statuses = list(pool.map(authorize, range(2)))
        self.assertEqual(sorted(statuses), [200, 409])
        self.assertEqual(self.run.budget_reservation.calls.count(), 1)
        self.assertEqual(self.request("close", owner), 200)
        self.assertEqual(self.amounts(), (1, item["max_input_tokens"], 0))

    def test_observed_receipts_correct_only_the_difference_through_artifact_http(self):
        artifact_token = "rag-artifact-test-" + "b" * 40
        url = self.serve(application(self.root, self.root / "unused-evidence", artifact_token))
        for scenario, sequence, used_input, used_output in (
            ("embedding-settle-before-commit", 0, 2, 0),
            ("query-settle-before-commit", 1, 1, 0),
            ("settle-before-commit", 2, 100, 20),
        ):
            with self.subTest(scenario=scenario):
                self.execute(scenario)
                path = self.root / str(self.run.pk) / "capture" / f"usage-{sequence}.json"
                raw = path.read_bytes()
                call = self.run.budget_reservation.calls.get(sequence=sequence)
                before = self.amounts()
                request = {
                    "run_id": self.run.pk,
                    "sequence": sequence,
                    "actor": "통합 검증",
                    "reason": "실제 HTTP 정산 실패 후 서명 증거 대조",
                    "request_id": uuid4(),
                    "evidence_sha256": sha256(raw).hexdigest(),
                }
                with override_settings(
                    LLMOPS_ARTIFACT_URL=url,
                    LLMOPS_ARTIFACT_TOKEN=artifact_token,
                    LLMOPS_RESULTS_DIR=self.root / "not-mounted",
                ):
                    self.assertFalse(correct_usage(**request)["applied"])
                    with self.assertRaises(CorrectionUnavailable):
                        correct_usage(**{**request, "evidence_sha256": "0" * 64}, apply=True)
                    self.assertEqual(self.amounts(), before)
                    self.assertTrue(correct_usage(**request, apply=True)["applied"])
                    after = (
                        before[0],
                        before[1] - call.max_input_tokens + used_input,
                        before[2] - call.max_output_tokens + used_output,
                    )
                    self.assertEqual(self.amounts(), after)
                    path.unlink()
                    self.assertTrue(correct_usage(**request, apply=True)["replayed"])
                    self.assertEqual(self.amounts(), after)
                call.refresh_from_db()
                self.assertIsNone(call.input_tokens)
                self.assertIsNone(call.settled_at)
                self.assertEqual(
                    EvaluationUsageCorrection.objects.get(call=call).evidence_raw.encode(),
                    raw,
                )
