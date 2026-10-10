"""실제 MySQL·Ops·Prefect·평가 프로세스의 취소/예산을 무료 HTTP 모델 대역으로 검증한다."""

import argparse
import json
import os
import secrets
import subprocess
import sys
import tempfile
import time
from collections import deque
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener
from uuid import uuid4

from cancellation_probe import TOKEN, NoRedirect

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
TERMINAL = {"COMPLETED", "FAILED", "CANCELLED", "CRASHED", "RESULT_ERROR"}
SCENARIOS = (
    "queued",
    "dispatch_busy_once",
    "before_authorize",
    "after_settle",
    "ack_while_alive",
    "model_response_lost",
    "completion_wins",
    "response_loss_restart",
    "authorize_response_lost",
    "settle_error",
    "close_error",
    "settle_and_close_error",
    "duplicate_worker",
    "rag_completed",
    "rag_cancel_after_embedding",
    "rag_embedding_response_lost",
    "rag_answer_response_lost",
    "rag_publish_failure",
    "rag_publish_recovery",
)


def wait_for(read, accept, *, label, timeout=180):
    deadline = time.monotonic() + timeout
    while True:
        value = read()
        if accept(value):
            return value
        if time.monotonic() >= deadline:
            raise TimeoutError(label)
        time.sleep(0.2)  # 상태 관찰 간격. 경합 순서는 명시적인 barrier로 제어한다.


def request(url, data=None, *, client=None, headers=None):
    raw = json.dumps(data).encode() if data is not None else None
    try:
        response = (client or build_opener(NoRedirect())).open(
            Request(
                url,
                data=raw,
                headers={"Content-Type": "application/json", **(headers or {})},
            ),
            timeout=20,
        )
    except HTTPError as error:
        response = error
    with response:
        body = response.read()
        return response.status, json.loads(body) if body else None


def verify_budget(before, after, *, calls, output, closed, sent, events):
    delta = [b - a for a, b in zip(before["allocated"], after["allocated"], strict=True)]
    assert delta == [calls, output], f"Unexpected retained budget: {delta}"
    # 보정은 원래 미정산 호출 행을 변경하지 않는다. 별도 증거 보정 행을 함께 대조한다.
    corrections = after.get("corrections", [])
    corrected = {item["sequence"]: item for item in corrections}
    assert len(corrected) == len(corrections), "Duplicate usage corrections"
    for sequence, item in corrected.items():
        assert closed and any(
            call["sequence"] == sequence
            and call["input_tokens"] is None
            and call["output_tokens"] is None
            for call in after["calls"]
        ), "Correction must identify an originally unsettled call"
        assert type(item["correction__input_tokens"]) is int
        assert 0 <= item["correction__input_tokens"] <= 32768
        assert type(item["correction__output_tokens"]) is int
        assert 0 <= item["correction__output_tokens"] <= 2000
    retained_input = (
        sum(
            c["input_tokens"]
            if c["input_tokens"] is not None
            else corrected[c["sequence"]]["correction__input_tokens"]
            if c["sequence"] in corrected
            else 32768
            for c in after["calls"]
        )
        if closed
        else after["reserved_input_tokens"]
    )
    assert after["allocated_input"] - before["allocated_input"] == retained_input
    assert all(c["counted_input_tokens"] == 100 for c in after["calls"])
    assert after["closed"] is closed
    assert len({c["sequence"] for c in after["calls"]}) == len(after["calls"])
    assert [c["operation_id"] for c in after["calls"]] == after["operation_ids"][
        : len(after["calls"])
    ]
    assert sum(e["stage"] == "model_sent" for e in events) == sent
    assert not any(e["stage"] == "barrier_timeout" for e in events)

    def accepted(stage):
        return sum(e["stage"] == stage and e.get("status") == 200 for e in events)

    assert accepted("authorize") == len(after["calls"])
    assert accepted("settle") == sum(c["output_tokens"] is not None for c in after["calls"])
    return {
        "retained_delta": delta,
        "retained_input_delta": retained_input,
        "model_sends": sent,
        "authorizations": accepted("authorize"),
        "settlements": accepted("settle"),
    }


def verify_cleanup(record, before, after, *, unknown_calls, events_before, events_after):
    assert record["applied"] is True
    assert record["evidence"]["state_type"] in {
        "COMPLETED",
        "FAILED",
        "CRASHED",
        "CANCELLED",
    }
    assert not before["closed"] and after["closed"]
    assert before["calls"] == after["calls"]
    assert events_before == events_after, "Cleanup must not issue worker/model requests"
    assert record["after"]["unknown_calls"] == unknown_calls
    assert record["before"]["global_input_tokens"] == before["allocated_input"]
    assert record["after"]["global_input_tokens"] == after["allocated_input"]
    assert record["after"]["reservation_input_tokens"] >= unknown_calls * 32768
    assert record["after"]["unknown_output_tokens"] == unknown_calls * 2000
    assert [
        record["before"]["global_calls"],
        record["before"]["global_output_tokens"],
    ] == before["allocated"]
    assert [
        record["after"]["global_calls"],
        record["after"]["global_output_tokens"],
    ] == after["allocated"]


def verify_rag_budget(before, after, *, calls, output, sent, events, unknown_calls=0):
    """혼합 실행의 작업별 상한으로 계산한다. 임베딩 미확정을 답변 상한이나 0으로 바꾸지 않는다."""
    plan, rows = after["operation_plan"], after["calls"]
    assert after["closed"] and not after["corrections"]
    assert len(plan) in (6, 8, 9) and len(rows) == calls
    assert [item["kind"] for item in plan if item["kind"] != "document_embedding"] == ["query_embedding", "answer"] * 3
    assert sum(item["kind"] == "document_embedding" for item in plan) == len(plan) - 6
    assert [row["sequence"] for row in rows] == list(range(calls))
    assert [row["sequence"] for row in rows if row["input_tokens"] is None] == list(
        range(calls - unknown_calls, calls)
    )
    retained_input = retained_output = 0
    for row in rows:
        operation = plan[row["sequence"]]
        assert row["operation_id"] == operation["id"]
        assert row["counted_input_tokens"] == (
            100 if operation["kind"] == "answer" else operation["max_input_tokens"]
        )
        assert (row["input_tokens"] is None) == (row["output_tokens"] is None)
        for dimension in ("input", "output"):
            amount, limit = row[f"{dimension}_tokens"], operation[f"max_{dimension}_tokens"]
            assert amount is None or (type(amount) is int and 0 <= amount <= limit)
        retained_input += (
            row["input_tokens"]
            if row["input_tokens"] is not None
            else operation["max_input_tokens"]
        )
        retained_output += (
            row["output_tokens"]
            if row["output_tokens"] is not None
            else operation["max_output_tokens"]
        )
    assert retained_output == output
    assert after["allocated"] == [before["allocated"][0] + calls, before["allocated"][1] + output]
    assert after["allocated_input"] == before["allocated_input"] + retained_input
    assert after["reserved_input_tokens"] == sum(item["max_input_tokens"] for item in plan)
    assert after["reserved_output_tokens"] == sum(item["max_output_tokens"] for item in plan)
    assert not any(event["stage"] == "barrier_timeout" for event in events)
    assert sum(event["stage"] in {"model_sent", "embedding_sent"} for event in events) == sent
    assert sum(event["stage"] == "embedding_sent" for event in events) == sum(
        plan[row["sequence"]]["kind"] != "answer" for row in rows
    )
    assert sum(event["stage"] == "model_sent" for event in events) == sum(
        plan[row["sequence"]]["kind"] == "answer" for row in rows
    )
    assert (
        sum(event["stage"] == "authorize" and event.get("status") == 200 for event in events)
        == calls
    )
    assert sum(
        event["stage"] == "settle" and event.get("status") == 200 for event in events
    ) == sum(row["input_tokens"] is not None for row in rows)
    return {
        "retained_delta": [calls, output],
        "retained_input_delta": retained_input,
        "model_sends": sent,
        "embedding_sends": sum(event["stage"] == "embedding_sent" for event in events),
        "answer_sends": sum(event["stage"] == "model_sent" for event in events),
        "unknown_calls": sum(row["input_tokens"] is None for row in rows),
        "evidence_kind": "integration-stub-not-quality-evidence",
        "paid_model_calls": 0,
    }


def verify_correction(record, before, after, *, events_before, events_after):
    assert record["applied"] is True and record["source"] == "WORKER_RESPONSE"
    assert before["closed"] and after["closed"]
    assert before["calls"] == after["calls"], "Original settlement rows must be preserved"
    assert events_before == events_after, "Correction must not send model or worker requests"
    assert record["before"]["global_input_tokens"] == before["allocated_input"]
    assert record["after"]["global_input_tokens"] == after["allocated_input"]
    assert before["allocated_input"] - after["allocated_input"] == 32768 - 100
    assert record["input_tokens"] == 100 and record["output_tokens"] == 50
    assert before["allocated"][0] == after["allocated"][0]
    assert before["allocated"][1] - after["allocated"][1] == 1950
    assert record["after"]["unknown_calls"] == 0
    assert record["after"]["global_output_tokens"] == after["allocated"][1]
    assert record["before"]["global_output_tokens"] == before["allocated"][1]


def verify_rag_recovery(source, recovered, before, after, files, *, events):
    """무료 복구의 입력 보존·예산 불변·전송 없음·출처를 함께 확인한다."""
    assert source["status"] == "FAILED" and source["model_api_calls"] in (6, 8, 9)
    assert recovered["status"] == "COMPLETED" and recovered["execution_mode"] == "recovery"
    assert recovered["source_run_id"] == source["id"]
    assert recovered["prefect_flow_run_id"] != source["prefect_flow_run_id"]
    assert recovered["model_api_calls"] == 0
    assert after["execution_mode"] == "recovery" and after["source_run_id"] == source["id"]
    assert after["reservation_exists"] is False
    assert before["allocated"] == after["allocated"]
    assert before["allocated_input"] == after["allocated_input"]
    assert files["source_before"] == files["source_after"], "Original evidence changed"
    config = recovered["execution_spec"]["recovery_config"]
    assert recovered["execution_spec"]["model_operations"] == []
    assert recovered["execution_spec"]["generation"] is None
    assert (
        files["recovered"]["capture/capture.json"]
        == files["source_before"]["capture/capture.json"]
        == config["capture_sha256"]
    )
    assert files["source_before"]["request.json"] == config["source_request_sha256"]
    assert files["recovered"]["recovery-fixture.json"] == config["fixture_sha256"]
    assert files["recovered"]["reference-capture.json"] == config["reference_capture_sha256"]
    report = recovered["comparison"]["current"]
    assert report["captureSha256"] == config["capture_sha256"]
    assert report["execution"] == config["recorded_execution"]
    assert report["measurementKind"] == "recorded-capture-replay" and report["completed"]
    assert report["liveExecutionPerformed"] is False and report["baselineEligible"] is False
    assert not any(
        event["stage"]
        in {
            "claim",
            "authorize",
            "settle",
            "close",
            "embedding_sent",
            "model_sent",
            "barrier_timeout",
        }
        for event in events
    )
    assert sum(event["stage"] == "before_rag_publish" for event in events) == 1
    return {
        "model_sends": 0,
        "paid_model_calls": 0,
        "retained_delta": [0, 0],
        "retained_input_delta": 0,
        "reservation_created": False,
        "original_evidence_preserved": True,
        "evidence_kind": "integration-stub-not-quality-evidence",
    }


class Smoke:
    def __init__(self, compose):
        self.compose = compose
        self.cookies = {}
        self.probe = "http://cancellation-probe:8099"
        self.ops = "http://ops-service:8000"
        self.prefect = "http://prefect:4200/api"
        self.csrf = None
        self.records = []
        self.active = None
        self.recent_requests = deque(maxlen=32)

    def dc(self, *args):
        result = self.compose(*args, capture=True)
        return result.stdout.strip()

    def request(self, url, data=None, *, headers=None):
        # Keep bounded metadata, never URLs, headers, cookies, bodies or exception messages.
        # Duration includes Docker exec: it is not the server's HTTP processing time.
        observation = {
            "service": next(
                (
                    name
                    for name, base in (
                        ("ops", self.ops),
                        ("probe", self.probe),
                        ("prefect", self.prefect),
                    )
                    if url.startswith(base + "/")
                ),
                "unknown",
            ),
            "method": "GET" if data is None else "POST",
            "status": None,
        }
        started = time.monotonic()
        try:
            result = self.compose(
                "exec",
                "-T",
                "cancellation-probe",
                "python",
                "/test/cancellation_probe.py",
                "request",
                capture=True,
                input=json.dumps({"url": url, "data": data, "headers": headers or {}}),
            )
            reply = json.loads(result.stdout)
            status = reply.get("status")
            if type(status) is int and 100 <= status <= 599:
                observation["status"] = status
            if "transport_error" in reply:
                reason = reply["transport_error"]
                observation["transport_error"] = (
                    reason
                    if reason
                    in {
                        "URLError",
                        "OSError",
                        "TimeoutError",
                        "ConnectionResetError",
                        "ConnectionRefusedError",
                        "RemoteDisconnected",
                        "BrokenPipeError",
                    }
                    else "unknown"
                )
                raise URLError(reason)
            if "response_error" in reply:
                raise ValueError(f"Invalid JSON response: HTTP {reply['status']}")
            if url.startswith(self.ops + "/"):
                self.cookies.update(reply["cookies"])
            return reply["status"], reply["body"]
        except Exception as error:
            observation["error"] = type(error).__name__
            raise
        finally:
            observation["elapsed_ms"] = round((time.monotonic() - started) * 1000)
            self.recent_requests.append(observation)

    def ready(self):
        def langfuse():
            try:
                return self.request(self.probe + "/langfuse-health")
            except (URLError, OSError, ValueError):
                return 0, {}

        wait_for(langfuse, lambda r: r[0] == 200, label="Langfuse readiness", timeout=300)

        def session():
            try:
                return self.api("/api/v1/ops/session")
            except (URLError, OSError, ValueError):
                return 0, {}

        _, body = wait_for(session, lambda r: r[0] == 200, label="Ops readiness")
        assert body["live_enabled"] and body["user"]
        self.csrf = body["csrf_token"]
        self.dataset = next(d for d in body["datasets"] if d["id"] == "target-coverage-20260907-v1")
        self.rag_dataset = next(
            d for d in body["datasets"] if d["id"] == "rag-synthetic-multichunk-v1"
        )
        assert self.rag_dataset["live_config"] and self.rag_dataset["execution_profiles"]["live"]

        def deployment():
            try:
                return self.request(
                    self.prefect + "/deployments/name/govbiz-ops-evidence-evaluation/saved-capture"
                )
            except (URLError, OSError, ValueError):
                return 0, {}

        wait_for(
            deployment,
            lambda r: r[0] == 200,
            label="Real serve deployment registration",
        )

    def api(self, path, data=None):
        cookies = ["govbiz_session=offline-admin-session"]
        cookies.extend(f"{name}={value}" for name, value in self.cookies.items())
        headers = {"Cookie": "; ".join(cookies), "Origin": self.ops}
        if self.csrf:
            headers["X-CSRFToken"] = self.csrf
        return self.request(self.ops + path, data, headers=headers)

    def control(self, action, data=None):
        status, body = self.request(
            f"{self.probe}/control/{self.active['request_id']}/{action}", data
        )
        assert status == 200, f"Probe {action}: HTTP {status}"
        return body

    def db(self, run_id=None):
        args = (run_id,) if run_id else ()
        return json.loads(
            self.dc(
                "exec",
                "-T",
                "ops-service",
                "python",
                "/test/cancellation_probe.py",
                "snapshot",
                *args,
            )
        )

    def runner(self, *args):
        return self.dc(
            "exec",
            "-T",
            "evaluation-runner",
            ".venv/bin/python",
            "/test/cancellation_runner.py",
            *args,
        )

    def process(self):
        return json.loads(self.runner("alive", self.active["request_id"]))

    def pause(self):
        self.runner("signal-parent", "STOP")

    def resume(self):
        self.runner("signal-parent", "CONT")

    def start(self, name, *, dataset=None, **config):
        dataset = self.dataset if dataset is None else dataset
        if dataset["id"] == self.rag_dataset["id"]:
            status, session = self.api("/api/v1/ops/session")
            assert status == 200
            dataset = next(item for item in session["datasets"] if item["id"] == dataset["id"])
        self.active = {
            "scenario": name,
            "request_id": str(uuid4()),
            "before": self.db(),
            "states": [],
        }
        self.control("configure", config)
        payload = {
            "request_id": self.active["request_id"],
            "dataset_id": dataset["id"],
            "candidate_capture_id": "new-model-response",
            "reference_capture_id": dataset["captures"][0]["id"],
            "execution_mode": "live",
            "confirm_paid_run": True,
            "live_config": dataset["live_config"],
            "execution_profile": dataset["execution_profiles"]["live"],
        }
        self.active["payload"] = payload
        status, run = self.api("/api/v1/ops/evaluations", payload)
        self.active["dispatch_http_status"] = status
        expected = 503 if config.get("fault") == "create_lost" else 202
        assert status == expected, f"{name} dispatch: HTTP {status}"
        self.observe(run)
        return run

    def observe(self, run):
        self.active["states"].append({"status": run["status"], "error_code": run["error_code"]})
        if run["prefect_flow_run_id"]:
            self.active["flow_id"] = run["prefect_flow_run_id"]
        return run

    def read(self):
        status, run = self.api(f"/api/v1/ops/evaluations/{self.active['request_id']}")
        assert status == 200
        return self.observe(run)

    def cancel(self):
        status, run = self.api(f"/api/v1/ops/evaluations/{self.active['request_id']}/cancel", {})
        assert status in (200, 202), f"Cancel: HTTP {status}"
        return self.observe(run)

    def stage(self, stage):
        wait_for(
            lambda: self.control("state"),
            lambda state: any(e["stage"] == stage for e in state["events"]),
            label=f"{self.active['scenario']}: {stage}",
        )

    def terminal(self, expected):
        run = wait_for(
            self.read,
            lambda r: r["status"] in TERMINAL,
            label=f"{self.active['scenario']}: terminal state",
            timeout=360,
        )
        assert run["status"] == expected, (
            f"{self.active['scenario']}: {run['status']} / {run['error_code']}"
        )
        return run

    def finish(self, *, calls, output, sent, closed=True, rag=False, unknown_calls=0):
        stopped = wait_for(self.process, lambda p: not p["alive"], label="Child process exit")
        before = self.active["before"]
        after = self.db(self.active["request_id"])
        events = self.control("state")["events"]
        counters = (
            verify_rag_budget(
                before,
                after,
                calls=calls,
                output=output,
                sent=sent,
                events=events,
                unknown_calls=unknown_calls,
            )
            if rag
            else verify_budget(
                before, after, calls=calls, output=output, closed=closed, sent=sent, events=events
            )
        )
        # 반복 조회/취소 확인으로도 중복 환급이 없어야 한다.
        self.read()
        assert self.db(self.active["request_id"])["allocated"] == after["allocated"]
        status, flows = self.request(
            self.prefect + "/flow_runs/filter",
            {"flow_runs": {"idempotency_key": {"any_": ["ops-" + self.active["request_id"]]}}},
        )
        assert status == 200 and len(flows) == 1
        assert flows[0]["id"] == self.active["flow_id"]
        self.records.append(
            {key: value for key, value in self.active.items() if key != "payload"}
            | {
                "after": after,
                "events": events,
                "process": stopped,
                "counts": counters,
                "prefect_state": flows[0]["state_type"],
                "passed": True,
            }
        )
        print(f"Passed cancellation scenario: {self.active['scenario']}", flush=True)
        self.active = None

    def cleanup(self, *, unknown_calls):
        wait_for(self.process, lambda process: not process["alive"], label="Failed child exit")
        run_id = self.active["request_id"]
        before = self.db(run_id)
        assert before["allocated"] == [
            self.active["before"]["allocated"][0] + before["reserved_calls"],
            self.active["before"]["allocated"][1] + before["reserved_output_tokens"],
        ]
        events = self.control("state")["events"]
        args = (
            "exec",
            "-T",
            "ops-service",
            "python",
            "manage.py",
            "cleanup_evaluation_budget",
            "--run-id",
            run_id,
            "--actor",
            "offline-ci-operator",
            "--reason",
            "Failed close cleanup",
            "--request-id",
            str(uuid4()),
        )
        preview = json.loads(self.dc(*args))
        assert preview["applied"] is False
        assert self.db(run_id) == before
        applied = json.loads(self.dc(*args, "--apply"))
        after = self.db(run_id)
        verify_cleanup(
            applied,
            before,
            after,
            unknown_calls=unknown_calls,
            events_before=events,
            events_after=self.control("state")["events"],
        )
        replay = json.loads(self.dc(*args, "--apply"))
        assert replay == {**applied, "replayed": True}
        assert self.db(run_id) == after
        status, detail = self.api(f"/api/v1/ops/evaluations/{run_id}/budget")
        assert status == 200 and detail["cleanup"]["request_id"] == applied["request_id"]
        self.active["cleanup"] = applied

    def correct_usage(self):
        wait_for(self.process, lambda process: not process["alive"], label="Correction child exit")
        run_id = self.active["request_id"]
        before = self.db(run_id)
        events = self.control("state")["events"]
        assert before["allocated"] == [
            self.active["before"]["allocated"][0] + 1,
            self.active["before"]["allocated"][1] + 2000,
        ]
        args = (
            "exec",
            "-T",
            "ops-service",
            "python",
            "manage.py",
            "correct_evaluation_usage",
            "--run-id",
            run_id,
            "--sequence",
            "0",
            "--actor",
            "offline-ci-operator",
            "--reason",
            "Preserved response after settlement failure",
            "--request-id",
            str(uuid4()),
        )
        preview = json.loads(self.dc(*args))
        assert preview["applied"] is False and self.db(run_id) == before
        args += ("--evidence-sha256", preview["evidence_sha256"], "--apply")
        applied = json.loads(self.dc(*args))
        after = self.db(run_id)
        verify_correction(
            applied,
            before,
            after,
            events_before=events,
            events_after=self.control("state")["events"],
        )
        replay = json.loads(self.dc(*args))
        assert replay == {**applied, "replayed": True} and self.db(run_id) == after
        status, detail = self.api(f"/api/v1/ops/evaluations/{run_id}/budget")
        assert status == 200 and detail["corrections"] == [
            {key: value for key, value in applied.items() if key not in {"applied", "replayed"}}
        ]
        assert detail["calls"][0]["output_tokens"] is None
        assert detail["reservation"]["breakdown"]["confirmed_output_tokens"] == 50
        assert detail["reservation"]["breakdown"]["unknown_calls"] == 0
        self.active["correction"] = applied

    def run(self):
        self.pause()
        try:
            for name, config in (
                ("queued", {}),
                ("dispatch_busy_once", {"fault": "create_busy_once"}),
            ):
                self.start(name, **config)
                if config:
                    creates = [e for e in self.control("state")["events"] if e["stage"] == "create"]
                    assert 2 <= len(creates) <= 3
                    assert creates[0] == {
                        "stage": "create",
                        "status": 503,
                        "forwarded": False,
                    }
                    assert all(e["forwarded"] and e["status"] == 503 for e in creates[1:-1])
                    assert creates[-1]["forwarded"] and creates[-1]["status"] in (
                        200,
                        201,
                    )
                self.cancel()
                self.terminal("CANCELLED")
                assert not self.process()["started"]
                self.finish(calls=0, output=0, sent=0)
        finally:
            self.resume()

        for name, stage, calls, output in (
            ("before_authorize", "before_authorize_0", 0, 0),
            ("after_settle", "after_settle_0", 1, 50),
            ("ack_while_alive", "model_sent", 1, 2000),
        ):
            self.start(name, hold=stage)
            self.stage(stage)
            self.pause()
            try:
                process = self.process()
                assert process["started"] and process["alive"]
                self.active["process_before_cancel"] = process
                run = self.cancel()
                assert run["status"] == "CANCELLING" and not run["error_code"]
                assert self.process()["alive"], (
                    "ACK must be observed while the child is still alive"
                )
                assert not self.db(self.active["request_id"])["closed"]
            finally:
                self.resume()
            self.terminal("CANCELLED")
            self.control("release", {})
            self.finish(calls=calls, output=output, sent=calls)

        self.start("model_response_lost", fault="model_lost")
        self.terminal("FAILED")
        self.finish(calls=1, output=2000, sent=1)

        self.start("completion_wins")
        # 상세 조회를 하지 않아 Ops는 아직 QUEUED다. 실제 Prefect 완료를 먼저 확인한다.
        wait_for(
            lambda: self.request(self.prefect + "/flow_runs/" + self.active["flow_id"])[1],
            lambda flow: flow["state_type"] in TERMINAL,
            label="Completion winner",
            timeout=360,
        )
        run = self.cancel()
        assert run["status"] == "COMPLETED"
        self.terminal("COMPLETED")
        self.finish(calls=6, output=300, sent=6)

        self.pause()
        try:
            self.start("response_loss_restart", fault="create_lost")
            self.compose("restart", "ops-service")
            self.ready()
            run = self.read()
            assert run["prefect_flow_run_id"] and run["status"] == "QUEUED"
            self.control("fault", {"fault": "cancel_lost"})
            run = self.cancel()
            assert (
                run["status"] == "CANCELLING" and run["error_code"] == "PREFECT_CANCEL_UNCONFIRMED"
            )
            self.compose("restart", "ops-service")
            self.ready()
            self.terminal("CANCELLED")
            status, replay = self.api("/api/v1/ops/evaluations", self.active["payload"])
            assert status == 200 and replay["prefect_flow_run_id"] == self.active["flow_id"]
            self.finish(calls=0, output=0, sent=0)
        finally:
            self.resume()

        for name, fault, calls, output, sent, closed in (
            ("authorize_response_lost", "authorize_lost", 1, 2000, 0, True),
            ("settle_error", "settle_error", 1, 2000, 1, True),
            ("close_error", "close_error", 6, 300, 6, True),
            ("settle_and_close_error", "settle_and_close_error", 1, 2000, 1, True),
        ):
            self.start(name, fault=fault)
            self.terminal("FAILED")
            if name in {"close_error", "settle_and_close_error"}:
                self.cleanup(unknown_calls=1 if name == "settle_and_close_error" else 0)
            if name in {"settle_error", "settle_and_close_error"}:
                self.correct_usage()
                output = 50
            self.finish(calls=calls, output=output, sent=sent, closed=closed)

        self.start("duplicate_worker", hold="model_sent")
        self.stage("model_sent")
        record = self.db(self.active["request_id"])
        rejected = json.loads(
            self.runner(
                "duplicate",
                self.active["request_id"],
                record["flow_id"],
                record["spec_hash"],
            )
        )
        assert rejected == {"duplicate_claim_rejected": True}
        # 같은 owner/sequence의 승인 응답도 재발급하지 않는다.
        status, _ = self.request(
            self.ops + f"/internal/llmops/evaluations/{self.active['request_id']}/budget/authorize",
            {
                "worker_id": record["worker_id"],
                "flow_id": record["flow_id"],
                "spec_hash": record["spec_hash"],
                "sequence": 0,
                "model": self.dataset["live_config"]["model"],
                "max_output_tokens": 2000,
            },
            headers={"Authorization": "Bearer " + TOKEN},
        )
        assert status == 409
        self.active["duplicate_claim_rejected"] = True
        self.active["duplicate_authorize_status"] = status
        self.control("release", {})
        self.terminal("COMPLETED")
        self.finish(calls=6, output=300, sent=6)
        self.run_rag()
        assert [r["scenario"] for r in self.records] == list(SCENARIOS)

    def run_rag(self):
        self.start("rag_completed", dataset=self.rag_dataset)
        run = self.terminal("COMPLETED")
        assert run["model_api_calls"] == 8
        report = run["comparison"]["current"]
        assert report["measurementKind"] == "recorded-live-evaluation"
        assert report["liveExecutionPerformed"] and report["completed"]
        assert report["coverage"] == {
            "retrievalCaseCount": 3,
            "answerCaseCount": 3,
            "traceCaseCount": 3,
            "failedCaseCount": 0,
        }
        status, reviews = self.api(f"/api/v1/ops/evaluations/{run['id']}/rag-reviews")
        assert status == 200 and reviews["case_reviews"] == []
        assert reviews["quality"]["status"] == "NOT_EVALUATED"
        assert (
            not reviews["quality"]["baseline_eligible"]
            and not reviews["reference_review"]["approved"]
        )
        self.active["review_state"] = {"quality": "NOT_EVALUATED", "reference_approved": False}
        status, retry = self.api("/api/v1/ops/evaluations", self.active["payload"])
        assert status == 200 and retry["prefect_flow_run_id"] == run["prefect_flow_run_id"]
        self.finish(calls=8, output=150, sent=8, rag=True)

        self.start("rag_cancel_after_embedding", dataset=self.rag_dataset, hold="after_settle_0")
        self.stage("after_settle_0")
        self.cancel()
        self.terminal("CANCELLED")
        self.control("release", {})
        self.finish(calls=1, output=0, sent=1, rag=True)

        for name, fault, calls, output in (
            ("rag_embedding_response_lost", "embedding_lost", 1, 0),
            ("rag_answer_response_lost", "model_lost", 2, 2000),
        ):
            self.start(name, dataset=self.rag_dataset, fault=fault)
            self.terminal("FAILED")
            self.finish(calls=calls, output=output, sent=calls, rag=True, unknown_calls=1)
        self.run_rag_recovery()

    def run_rag_recovery(self):
        self.start("rag_publish_failure", dataset=self.rag_dataset, fault="publish_error")
        source = self.terminal("FAILED")
        assert source["model_api_calls"] == 6
        assert source["postprocessing"]["inputs_ready"] and source["postprocessing"]["can_recover"]
        assert source["postprocessing"]["stage"] == "publish"
        assert sum(e["stage"] == "publish_rejected" for e in self.control("state")["events"]) == 1
        self.finish(calls=6, output=150, sent=6, rag=True)
        source_files = json.loads(self.runner("artifacts", source["id"]))
        source_budget = self.db(source["id"])
        source_events = self.records[-1]["events"]
        self.active = {
            "scenario": "rag_publish_recovery",
            "request_id": str(uuid4()),
            "source_run_id": source["id"],
            "before": self.db(),
            "states": [],
        }
        self.control("configure", {"hold": "before_rag_publish"})
        path = f"/api/v1/ops/evaluations/{source['id']}/recover"
        payload = {"request_id": self.active["request_id"]}
        status, first = self.api(path, payload)
        assert status == 202
        self.observe(first)
        self.stage("before_rag_publish")
        status, repeated = self.api(path, payload)
        assert status == 200 and repeated["prefect_flow_run_id"] == first["prefect_flow_run_id"]
        status, rejected = self.api(path, {"request_id": str(uuid4())})
        assert status == 409 and rejected["code"] == "RECOVERY_CONFLICT"
        self.active["duplicate_request_status"] = 200
        self.active["concurrent_recovery_status"] = 409
        self.control("release", {})
        recovered = self.terminal("COMPLETED")
        stopped = wait_for(self.process, lambda p: not p["alive"], label="Recovery child exit")
        after, events = self.db(self.active["request_id"]), self.control("state")["events"]
        files = {
            "source_before": source_files,
            "source_after": json.loads(self.runner("artifacts", source["id"])),
            "recovered": json.loads(self.runner("artifacts", recovered["id"])),
        }
        counts = verify_rag_recovery(
            source, recovered, self.active["before"], after, files, events=events
        )
        assert self.db(source["id"]) == source_budget
        status, state = self.request(f"{self.probe}/control/{source['id']}/state")
        assert status == 200 and state["events"] == source_events
        status, original = self.api(f"/api/v1/ops/evaluations/{source['id']}")
        assert status == 200 and original["status"] == "FAILED"
        assert original["postprocessing"]["attempts"] == [
            {
                "id": recovered["id"],
                "status": "COMPLETED",
                "status_label": recovered["status_label"],
            }
        ]
        status, reviews = self.api(f"/api/v1/ops/evaluations/{recovered['id']}/rag-reviews")
        assert status == 200 and reviews["quality"]["status"] == "NOT_EVALUATED"
        assert not reviews["reference_review"]["approved"] and reviews["case_reviews"] == []
        assert reviews["quality"]["baseline_eligible"] is False
        status, flows = self.request(
            self.prefect + "/flow_runs/filter",
            {
                "flow_runs": {"idempotency_key": {"any_": ["ops-" + recovered["id"]]}},
            },
        )
        assert status == 200 and len(flows) == 1 and flows[0]["id"] == self.active["flow_id"]
        assert self.db() == self.active["before"]
        self.records.append(
            self.active
            | {
                "after": after,
                "events": events,
                "process": stopped,
                "counts": counts,
                "artifact_sha256": files,
                "prefect_state": flows[0]["state_type"],
                "passed": True,
            }
        )
        print("Passed cancellation scenario: rag_publish_recovery", flush=True)
        self.active = None


def isolated_environment():
    names = (
        "POSTGRES_PASSWORD",
        "CLICKHOUSE_PASSWORD",
        "REDIS_PASSWORD",
        "MINIO_PASSWORD",
        "LANGFUSE_SALT",
        "LANGFUSE_ENCRYPTION_KEY",
        "LANGFUSE_NEXTAUTH_SECRET",
        "LANGFUSE_ADMIN_PASSWORD",
        "OPS_DB_PASSWORD",
        "OPS_DB_ROOT_PASSWORD",
        "OPS_DJANGO_SECRET_KEY",
        "OPS_ADMIN_PASSWORD",
    )
    values = {name: secrets.token_hex(32) for name in names}
    values.update(
        LANGFUSE_PUBLIC_KEY="pk-lf-" + secrets.token_hex(16),
        LANGFUSE_SECRET_KEY="sk-lf-" + secrets.token_hex(32),
        LLMOPS_LIVE_ENABLED="true",
        LLMOPS_RAG_LIVE_ENABLED="true",
        LLMOPS_LIVE_MODEL="gpt-6-luna",
        LLMOPS_BUDGET_TOKEN=TOKEN,
        OPENAI_API_KEY="offline-model-double-key",
    )
    return values


def verify_isolation(config):
    bootstrap = config.get("services", {}).get("ops-bootstrap", {})
    if bootstrap.get("environment", {}).get("LLMOPS_LOCAL_SEED_ENABLED") != "false":
        raise ValueError("Cancellation smoke must disable shared review seed before startup")
    if bootstrap.get("command") != ["python", "manage.py", "migrate", "--noinput"]:
        raise ValueError("Cancellation smoke bootstrap must only apply migrations")
    networks = config.get("networks", {})
    if set(networks) != {"default"} or networks["default"].get("internal") is not True:
        raise ValueError("Cancellation smoke requires only an internal network")
    for name, service in config["services"].items():
        if (
            set(service.get("networks", {})) != {"default"}
            or service.get("network_mode")
            or service.get("ports")
        ):
            raise ValueError(
                f"Cancellation service must stay internal without published ports: {name}"
            )


def failure_details(error, credentials):
    result = {"type": type(error).__name__}
    if isinstance(error, subprocess.CalledProcessError):
        result["exit_code"] = error.returncode
        # Never retain stdout: it may be an HTTP body, cookie or database snapshot.
        message = error.stderr or ""
        for value in sorted(set(credentials.values()), key=len, reverse=True):
            if value:
                message = message.replace(value, "[REDACTED]")
        result["stderr"] = message[:4000]
    return result


def service_states(compose):
    """Capture state only, excluding container env, commands and healthcheck logs."""
    try:
        raw = compose("ps", "--all", "--format", "json", capture=True).stdout.strip()
        rows = (
            json.loads(raw)
            if raw.startswith("[")
            else [json.loads(line) for line in raw.splitlines()]
        )
        return [
            {key: row.get(key) for key in ("Service", "State", "Health", "ExitCode", "Publishers")}
            for row in rows
        ]
    except Exception as error:
        return {"unavailable": type(error).__name__}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "work/llmops-ci/cancellation.json")
    args = parser.parse_args()
    if sys.version_info[:2] != (3, 12):
        parser.error("Python 3.12 is required; use backend/ai-service/.venv/bin/python")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    project = "govbiz-cancel-test-" + uuid4().hex[:12]
    values = isolated_environment()
    # Ambient credentials must not override the disposable env-file through Compose interpolation.
    environment = {k: v for k, v in os.environ.items() if k not in values}
    environment.update(values)
    smoke = None
    failure = None
    detail = None
    phase = "configuration"
    with tempfile.TemporaryDirectory(prefix="cancellation-", dir=args.output.parent) as temporary:
        env_file = Path(temporary) / "isolated.env"
        env_file.write_text("".join(f"{k}={v}\n" for k, v in values.items()), encoding="utf-8")
        command = [
            "docker",
            "compose",
            "--project-name",
            project,
            "--env-file",
            str(env_file.resolve()),
        ]
        for name in ("compose.yaml", "compose.ops.yaml", "compose.cancel-test.yaml"):
            command.extend(["-f", str(HERE / name)])
        command.extend(["--profile", "evaluation"])

        def compose(*parts, capture=False, input=None):
            return subprocess.run(
                command + list(parts),
                cwd=ROOT,
                env=environment,
                check=True,
                text=True,
                encoding="utf-8",
                capture_output=capture,
                input=input,
                timeout=900 if parts[0] == "up" else 120,
            )

        try:
            verify_isolation(json.loads(compose("config", "--format", "json", capture=True).stdout))
            phase = "startup"
            # No ops-sync: race tests explicitly control the timing of the real detail/cancel API.
            compose(
                "up",
                "-d",
                "--build",
                "langfuse-web",
                "langfuse-worker",
                "prefect",
                "ops-service",
                "cancellation-probe",
                "evaluation-runner",
            )
            phase = "migrations"
            compose(
                "exec",
                "-T",
                "ops-service",
                "python",
                "manage.py",
                "migrate",
                "--noinput",
            )
            phase = "budget_setup"
            compose(
                "exec",
                "-T",
                "ops-service",
                "python",
                "manage.py",
                "set_evaluation_budget",
                "--calls",
                "200",
                "--output-tokens",
                "400000",
                "--input-tokens",
                "6553600",
                "--actor",
                "cancellation-smoke",
                "--reason",
                "Isolated offline cancellation scenarios",
                "--request-id",
                str(uuid4()),
            )
            smoke = Smoke(compose)
            phase = "readiness"
            smoke.ready()
            phase = "scenarios"
            smoke.run()
        except Exception as error:
            failure = type(error).__name__  # HTTP bodies and credentials must not enter artifacts.
            detail = failure_details(error, values)
            raise
        finally:
            report = {
                "schema": "llmops-cancellation-smoke-v1",
                "project": project,
                "passed": failure is None
                and smoke is not None
                and len(smoke.records) == len(SCENARIOS),
                "failure": failure,
                "scenarios": smoke.records if smoke else [],
            }
            if failure:
                report["diagnostics"] = {
                    "phase": phase,
                    "error": detail,
                    "services": service_states(compose),
                    "recent_requests": list(smoke.recent_requests) if smoke else [],
                }
            if smoke and smoke.active:
                unfinished = {k: v for k, v in smoke.active.items() if k != "payload"}
                for name, read in (
                    ("probe", lambda: smoke.control("state")),
                    ("after", lambda: smoke.db(smoke.active["request_id"])),
                    ("process", smoke.process),
                ):
                    try:
                        unfinished[name] = read()
                    except Exception as error:
                        unfinished[name] = {"unavailable": type(error).__name__}
                report["unfinished"] = unfinished
            args.output.write_text(
                json.dumps(report, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            # Remove only this invocation's random project, including its disposable volumes.
            try:
                compose("down", "--volumes", "--remove-orphans", "--timeout", "5")
            except Exception as error:
                report["passed"] = False
                report["cleanup_failure"] = type(error).__name__
                args.output.write_text(
                    json.dumps(report, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
                if failure is None:
                    raise
    print(f"Passed {len(SCENARIOS)} cancellation/budget scenarios. Evidence: {args.output}")


if __name__ == "__main__":
    main()
