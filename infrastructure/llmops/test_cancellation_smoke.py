"""서버 없이 실행 가능한 실패 판정과 실제 SDK→HTTP 모델 대역 계약 검증."""

import asyncio
import errno
import importlib.util
import json
import socket
import subprocess
import sys
from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Event, Thread
from types import SimpleNamespace
from unittest.mock import Mock
from urllib.error import HTTPError
from uuid import UUID, uuid4

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import cancellation_probe as probe  # noqa: E402 - standalone tools live beside this test.
import cancellation_smoke as smoke  # noqa: E402


def load_runner():
    spec = importlib.util.spec_from_file_location(
        "cancellation_runner_fixture", HERE / "cancellation_runner.py"
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def server():
    state = probe.Probe()
    instance = ThreadingHTTPServer(("127.0.0.1", 0), probe.handler(state))
    thread = Thread(target=instance.serve_forever, daemon=True)
    thread.start()
    yield state, f"http://127.0.0.1:{instance.server_port}"
    instance.shutdown()
    instance.server_close()
    thread.join(timeout=2)


def test_barrier_waits_for_explicit_release(server):
    state, base = server
    run_id = str(uuid4())
    state.configure(run_id, {"hold": "model_sent"})
    finished = Event()
    errors = []

    def send():
        try:
            code, body = smoke.request(base + "/model/" + run_id, {"model": "offline"})
            assert code == 200 and body["usage"]["output_tokens"] == 50
        except Exception as error:
            errors.append(error)
        finally:
            finished.set()

    thread = Thread(target=send, daemon=True)
    thread.start()
    try:
        smoke.wait_for(
            lambda: state.snapshot(run_id)["events"],
            bool,
            label="model received",
            timeout=2,
        )
        assert not finished.is_set()
        state.release(run_id)
        assert finished.wait(2)
        assert not errors
    finally:
        state.release(run_id)
        thread.join(timeout=2)


@pytest.mark.parametrize("fault", [None, "publish_error"])
def test_publish_gate_fails_only_at_rag_publication_before_sending_scores(
    server, monkeypatch, fault
):
    state, base = server
    run_id = str(uuid4())
    state.configure(run_id, {"fault": fault})
    publish = Mock(return_value=["score-id"])
    module = SimpleNamespace(publish_payloads=publish)
    monkeypatch.setitem(sys.modules, "rag_replay_flow", module)
    runner = load_runner()
    monkeypatch.setattr(runner, "PROBE", base)
    runner.install_publish_gate(run_id)
    # 같은 장애 설정도 모델/예산 경계는 먼저 통과할 수 있어야 한다.
    runner.barrier(run_id, "after_settle_8")
    if fault:
        with pytest.raises(HTTPError) as error:
            module.publish_payloads([{"id": "score-id"}], "settings")
        assert error.value.code == 503
        publish.assert_not_called()
        assert state.snapshot(run_id)["events"][-1] == {"stage": "publish_rejected", "status": 503}
    else:
        assert module.publish_payloads([{"id": "score-id"}], "settings") == ["score-id"]
        publish.assert_called_once_with([{"id": "score-id"}], "settings")
    assert [event["stage"] for event in state.snapshot(run_id)["events"]][:2] == [
        "after_settle_8",
        "before_rag_publish",
    ]


def test_artifact_fingerprints_preserve_bytes_and_only_expose_hashes(tmp_path, monkeypatch):
    from hashlib import sha256

    runner = load_runner()
    monkeypatch.setattr(runner, "RESULTS", tmp_path)
    run_id = str(uuid4())
    folder = tmp_path / run_id
    (folder / "capture").mkdir(parents=True)
    raw = ' {"answer": "한글 응답"}\n'.encode()
    (folder / "capture/capture.json").write_bytes(raw)
    (folder / "capture/usage-0.json").write_text("signed receipt")
    (folder / "private.env").write_text("unrelated secret")
    result = runner.artifact_fingerprints(run_id)
    assert result == {
        "capture/capture.json": sha256(raw).hexdigest(),
        "capture/usage-0.json": sha256(b"signed receipt").hexdigest(),
    }
    assert (folder / "capture/capture.json").read_bytes() == raw
    with pytest.raises(ValueError):
        runner.artifact_fingerprints("../other")


def test_lost_reply_forwards_once_but_never_returns_success(monkeypatch):
    state = probe.Probe()
    run_id = str(uuid4())
    state.configure(run_id, {"fault": "authorize_lost"})
    forwarded = Mock(return_value=(200, b'{"accepted":true}'))
    monkeypatch.setattr(probe, "exchange", forwarded)
    status, _ = state.forward(
        run_id, "authorize", "http://ops-service:8000/internal", "POST", b"{}", {}
    )
    assert status is None and forwarded.call_count == 1
    assert state.snapshot(run_id)["events"] == [
        {"stage": "authorize", "status": 200, "forwarded": True}
    ]


def test_http_failure_does_not_forward_or_claim_commit(monkeypatch):
    state = probe.Probe()
    run_id = str(uuid4())
    state.configure(run_id, {"fault": "settle_error"})
    forwarded = Mock()
    monkeypatch.setattr(probe, "exchange", forwarded)
    status, _ = state.forward(
        run_id, "settle", "http://ops-service:8000/internal", "POST", b"{}", {}
    )
    assert status == 503 and not forwarded.called
    assert state.snapshot(run_id)["events"][0]["forwarded"] is False


def test_busy_creation_fault_fails_once_without_forwarding_then_uses_the_same_request(
    monkeypatch,
):
    state = probe.Probe()
    run_id, flow_id = str(uuid4()), str(uuid4())
    state.configure(run_id, {"fault": "create_busy_once"})
    forwarded = Mock(return_value=(201, json.dumps({"id": flow_id}).encode()))
    monkeypatch.setattr(probe, "exchange", forwarded)
    payload = json.dumps({"idempotency_key": "ops-" + run_id}).encode()
    args = (
        run_id,
        "create",
        "http://prefect:4200/api/deployments/test/create_flow_run",
        "POST",
        payload,
        {},
    )
    assert state.forward(*args)[0] == 503
    forwarded.assert_not_called()
    assert state.forward(*args)[0] == 201
    forwarded.assert_called_once_with(args[2], args[3], payload, {})
    assert state.flow_runs[flow_id] == run_id
    assert state.snapshot(run_id)["events"] == [
        {"stage": "create", "status": 503, "forwarded": False},
        {"stage": "create", "status": 201, "forwarded": True},
    ]


def test_timeout_is_failure(monkeypatch):
    monkeypatch.setattr(smoke.time, "monotonic", Mock(side_effect=[0, 2]))
    with pytest.raises(TimeoutError, match="still running"):
        smoke.wait_for(
            lambda: "CANCELLING",
            lambda value: value == "CANCELLED",
            label="still running",
            timeout=1,
        )


def test_barrier_timeout_is_recorded_as_failure():
    state = probe.Probe()
    run_id = str(uuid4())
    state.configure(run_id, {"hold": "model_sent"})
    state.runs[run_id]["release"] = Mock(wait=Mock(return_value=False))
    with pytest.raises(TimeoutError):
        state.gate(run_id, "model_sent")
    assert state.snapshot(run_id)["events"][-1]["stage"] == "barrier_timeout"


def accounting():
    before = {"allocated": [3, 100], "allocated_input": 100}
    after = {
        "allocated": [4, 2100],
        "allocated_input": 32868,
        "closed": True,
        "calls": [
            {
                "sequence": 0,
                "operation_id": "answer:TC01",
                "output_tokens": None,
                "input_tokens": None,
                "counted_input_tokens": 100,
            }
        ],
        "operation_ids": ["answer:TC01"],
    }
    events = [{"stage": "authorize", "status": 200}, {"stage": "model_sent"}]
    return before, after, events


def test_unknown_usage_keeps_full_cap():
    before, after, events = accounting()
    assert smoke.verify_budget(
        before, after, calls=1, output=2000, closed=True, sent=1, events=events
    )["retained_delta"] == [1, 2000]


@pytest.mark.parametrize("operation_id", [None, "answer:TC02", "query_embedding:TC01"])
def test_budget_evidence_rejects_missing_or_substituted_operation(operation_id):
    before, after, events = accounting()
    after["calls"][0]["operation_id"] = operation_id
    with pytest.raises(AssertionError):
        smoke.verify_budget(before, after, calls=1, output=2000, closed=True, sent=1, events=events)


def test_settle_and_close_failure_does_not_forward_either_write(monkeypatch):
    state = probe.Probe()
    run_id = str(uuid4())
    state.configure(run_id, {"fault": "settle_and_close_error"})
    forwarded = Mock()
    monkeypatch.setattr(probe, "exchange", forwarded)
    for action in ("settle", "close"):
        assert (
            state.forward(run_id, action, "http://ops-service:8000/internal", "POST", b"{}", {})[0]
            == 503
        )
    forwarded.assert_not_called()


@pytest.mark.parametrize(
    "defect",
    [
        None,
        "unknown_refunded",
        "calls_changed",
        "new_send",
        "not_closed",
        "not_terminal",
        "bad_global",
    ],
)
def test_cleanup_evidence_rejects_unsafe_release(defect):
    before = {
        "allocated": [6, 12000],
        "allocated_input": 196608,
        "closed": False,
        "calls": [{"sequence": 0, "output_tokens": None}],
    }
    after = {**before, "allocated": [1, 2000], "closed": True, "allocated_input": 32768}
    record = {
        "applied": True,
        "evidence": {"state_type": "FAILED"},
        "before": {
            "global_calls": 6,
            "global_output_tokens": 12000,
            "global_input_tokens": 196608,
        },
        "after": {
            "global_input_tokens": 32768,
            "reservation_input_tokens": 32768,
            "global_calls": 1,
            "global_output_tokens": 2000,
            "unknown_calls": 1,
            "unknown_output_tokens": 2000,
        },
    }
    events_before = [{"stage": "model_sent"}]
    events_after = list(events_before)
    if defect == "unknown_refunded":
        record["after"]["unknown_output_tokens"] = 0
    elif defect == "calls_changed":
        after["calls"] = []
    elif defect == "new_send":
        events_after.append({"stage": "model_sent"})
    elif defect == "not_closed":
        after["closed"] = False
    elif defect == "not_terminal":
        record["evidence"]["state_type"] = "RUNNING"
    elif defect == "bad_global":
        after["allocated"] = [0, 0]
    args = dict(unknown_calls=1, events_before=events_before, events_after=events_after)
    if defect:
        with pytest.raises(AssertionError):
            smoke.verify_cleanup(record, before, after, **args)
    else:
        smoke.verify_cleanup(record, before, after, **args)


@pytest.mark.parametrize(
    "defect",
    [
        "refund_unknown",
        "double_send",
        "false_settle",
        "duplicate_sequence",
        "timeout",
        "still_open",
    ],
)
def test_invalid_accounting_cannot_pass(defect):
    before, after, events = accounting()
    if defect == "refund_unknown":
        after["allocated"][1] = 100
    elif defect == "double_send":
        events.append({"stage": "model_sent"})
    elif defect == "false_settle":
        events.append({"stage": "settle", "status": 200})
    elif defect == "duplicate_sequence":
        after["calls"].append(dict(after["calls"][0]))
    elif defect == "timeout":
        events.append({"stage": "barrier_timeout"})
    else:
        after["closed"] = False
    with pytest.raises(AssertionError):
        smoke.verify_budget(before, after, calls=1, output=2000, closed=True, sent=1, events=events)


def test_pid_reuse_is_not_a_live_evaluation(monkeypatch, tmp_path):
    runner = load_runner()
    marker = tmp_path / "process.json"
    marker.write_text(json.dumps({"pid": 123, "birth": "100"}))
    monkeypatch.setattr(
        runner, "process_info", lambda pid: {"pid": pid, "birth": "200", "alive": True}
    )
    assert runner.alive(marker) == {"started": True, "pid": 123, "alive": False}


@pytest.mark.parametrize(
    "error", [FileNotFoundError(errno.ENOENT, "gone"), ProcessLookupError(errno.ESRCH, "exited")]
)
def test_process_disappearing_during_stat_read_is_stopped(monkeypatch, error):
    runner = load_runner()
    read = Mock(side_effect=error)
    monkeypatch.setattr(Path, "read_text", read)
    assert runner.process_info(123) == {"pid": 123, "birth": None, "alive": False}
    read.assert_called_once_with()


@pytest.mark.parametrize(
    "error", [PermissionError(errno.EACCES, "denied"), OSError(errno.EIO, "io error")]
)
def test_process_stat_failure_is_not_reported_as_exit(monkeypatch, error):
    runner = load_runner()
    monkeypatch.setattr(Path, "read_text", Mock(side_effect=error))
    with pytest.raises(type(error)) as caught:
        runner.process_info(123)
    assert caught.value is error


@pytest.mark.parametrize("state,expected_alive", [("R", True), ("Z", False)])
def test_process_stat_keeps_birth_and_zombie_detection(monkeypatch, state, expected_alive):
    runner = load_runner()
    stat = "123 (worker (test)) " + " ".join([state, *(["0"] * 18), "100", "0"])
    monkeypatch.setattr(Path, "read_text", Mock(return_value=stat))
    assert runner.process_info(123) == {"pid": 123, "birth": "100", "alive": expected_alive}


@pytest.mark.skipif(sys.platform != "linux", reason="Linux /proc open/read exit race")
def test_process_exits_after_proc_stat_open(monkeypatch, tmp_path):
    runner = load_runner()
    original_open = Path.open
    with subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"]) as child:
        try:
            marker = tmp_path / "process.json"
            marker.write_text(json.dumps(runner.process_info(child.pid)))
            stat_path = Path(f"/proc/{child.pid}/stat")

            def open_then_exit(path, *args, **kwargs):
                stream = original_open(path, *args, **kwargs)
                if path == stat_path:
                    child.terminate()
                    child.wait(timeout=5)
                return stream

            monkeypatch.setattr(Path, "open", open_then_exit)
            assert runner.alive(marker) == {"started": True, "pid": child.pid, "alive": False}
        finally:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=5)


def test_real_sdk_and_evaluator_accept_http_double(monkeypatch, tmp_path, server):
    import httpx2

    evaluation_dir = HERE.parents[1] / "evaluation/support-program-evidence"
    monkeypatch.syspath_prepend(str(evaluation_dir))
    import evaluate
    from budget_client import BudgetClient

    runner = load_runner()
    state, base = server
    run_id = str(uuid4())
    state.configure(run_id, {})
    monkeypatch.setattr(runner, "PROBE", base)
    # install_http_double의 국소 교체를 반드시 원복한다.
    monkeypatch.setattr(httpx2, "AsyncClient", httpx2.AsyncClient)
    monkeypatch.setattr(BudgetClient, "authorize", BudgetClient.authorize)
    monkeypatch.setattr(BudgetClient, "settle", BudgetClient.settle)
    monkeypatch.setenv("OPENAI_API_KEY", "offline-model-double-key")
    monkeypatch.setenv("LANGFUSE_ENABLED", "false")
    monkeypatch.setenv("LLMOPS_OPS_API_URL", base)
    monkeypatch.setenv("LLMOPS_BUDGET_TOKEN", probe.TOKEN)
    budget_actions = []

    def budget_http(url, method, body, headers):
        assert url.startswith(
            f"http://ops-service:8000/internal/llmops/evaluations/{run_id}/budget/"
        )
        assert method == "POST" and headers["Authorization"] == "Bearer " + probe.TOKEN
        budget_actions.append((url.rsplit("/", 1)[-1], json.loads(body)))
        return 200, b'{"accepted":true}'

    monkeypatch.setattr(probe, "exchange", budget_http)
    runner.install_http_double(run_id)
    budget = BudgetClient(run_id, str(uuid4()), "f" * 64)
    budget.claim()
    _, prepared, fixture_hash = evaluate.load_fixture(
        evaluation_dir / "target-coverage-fixture.json"
    )

    async def run():
        capture = await evaluate.execute(
            prepared[:1],
            fixture_hash,
            tmp_path / "capture",
            max_model_calls=1,
            budget=budget,
        )
        assert capture["completed"], capture["cases"]
        assert capture["modelApiCalls"] == 1
        assert capture["apiResponses"][0]["usage"] == probe.USAGE
        async with httpx2.AsyncClient() as client:
            with pytest.raises(RuntimeError, match="non-allowlisted"):
                await client.get("https://example.com/")

    asyncio.run(run())
    budget.close()
    assert [action for action, _ in budget_actions] == [
        "claim",
        "authorize",
        "settle",
        "close",
    ]
    assert budget_actions[1][1]["sequence"] == 0
    assert budget_actions[1][1]["operation_id"] == f"answer:{prepared[0][0]['id']}"
    assert budget_actions[2][1]["operation_id"] == budget_actions[1][1]["operation_id"]
    assert budget_actions[2][1]["usage"] == probe.USAGE
    assert [event["stage"] for event in state.snapshot(run_id)["events"]] == [
        "claim",
        "before_authorize_0",
        "authorize",
        "model_sent",
        "settle",
        "after_settle_0",
        "close",
    ]


@pytest.mark.parametrize(
    "fault,sent,unknown", [(None, 8, 0), ("embedding_lost", 1, 1), ("model_lost", 3, 1)]
)
def test_rag_service_and_sdk_use_http_double_and_preserve_mixed_budget(
    monkeypatch, tmp_path, server, fault, sent, unknown
):
    import httpx2

    evaluation_dir = HERE.parents[1] / "evaluation/support-program-evidence"
    monkeypatch.syspath_prepend(str(evaluation_dir))
    monkeypatch.syspath_prepend(str(HERE.parents[1] / "backend/ops-service"))
    import rag_live
    from apps.evaluations.catalog import live_config
    from apps.evaluations.execution_spec import digest, make_spec, read_release
    from apps.evaluations.rag_replay import validate_live_capture
    from budget_client import BudgetClient

    state, base = server
    run_id = str(uuid4())
    state.configure(run_id, {"fault": fault})
    runner = load_runner()
    monkeypatch.setattr(runner, "PROBE", base)
    monkeypatch.setattr(httpx2, "AsyncClient", httpx2.AsyncClient)
    monkeypatch.setattr(BudgetClient, "authorize", BudgetClient.authorize)
    monkeypatch.setattr(BudgetClient, "settle", BudgetClient.settle)
    monkeypatch.setenv("OPENAI_API_KEY", "offline-model-double-key")
    monkeypatch.setenv("LANGFUSE_ENABLED", "false")
    monkeypatch.setenv("LLMOPS_OPS_API_URL", base)
    monkeypatch.setenv("LLMOPS_BUDGET_TOKEN", probe.TOKEN)
    monkeypatch.setenv("LLMOPS_RESULTS_DIR", str(tmp_path))
    dataset = "rag-synthetic-multichunk-v1"
    spec = make_spec(
        read_release(),
        dataset,
        "live",
        live_config(dataset),
        "new-model-response",
        "rag-synthetic-capture-v1",
    )
    plan = spec["model_operations"]
    actions = []

    def budget_http(url, method, body, headers):
        assert url.startswith(
            f"http://ops-service:8000/internal/llmops/evaluations/{run_id}/budget/"
        )
        assert method == "POST" and headers["Authorization"] == "Bearer " + probe.TOKEN
        actions.append((url.rsplit("/", 1)[-1], json.loads(body)))
        return 200, b'{"accepted":true}'

    monkeypatch.setattr(probe, "exchange", budget_http)
    runner.install_http_double(run_id)
    budget = BudgetClient(run_id, str(uuid4()), digest(spec))
    budget.claim()
    capture, usage = asyncio.run(
        rag_live.execute(
            evaluation_dir / "rag-fixture.json",
            tmp_path / "capture",
            budget=budget,
            execution_spec=spec,
        )
    )
    budget.close()
    validate_live_capture(capture, usage, spec, digest(spec))
    assert usage["model_api_calls"] == sent
    assert usage["completed"] is (fault is None)
    assert len(list((tmp_path / "capture").glob("usage-*.json"))) == sent - unknown + 1
    authorized = [fields for action, fields in actions if action == "authorize"]
    assert [row["sequence"] for row in authorized] == list(range(sent))
    settlements = {
        fields["sequence"]: fields["usage"] for action, fields in actions if action == "settle"
    }
    rows = []
    for request in authorized:
        sequence = request["sequence"]
        item = plan[sequence]
        assert request["operation_id"] == item["id"]
        if item["kind"] != "answer":
            assert request["input_sha256"] == item["input_sha256"]
            assert request["dimensions"] == item["dimensions"]
        settled = settlements.get(sequence) or {}
        rows.append(
            {
                "sequence": sequence,
                "operation_id": item["id"],
                "counted_input_tokens": request["input_token_count"],
                "input_tokens": settled.get("input_tokens"),
                "output_tokens": settled.get("output_tokens"),
            }
        )
    assert sum(row["input_tokens"] is None for row in rows) == unknown
    if fault:
        failed = capture["cases"][0]["failure"]
        assert failed["stage"] == ("index" if fault == "embedding_lost" else "answer")
        assert all(case["failure"]["stage"] == "not_started" for case in capture["cases"][1:])
    assert actions[0][0] == "claim" and actions[-1][0] == "close"
    events = state.snapshot(run_id)["events"]
    assert sum(event["stage"] == "embedding_sent" for event in events) == (
        5 if fault is None else 1 if fault == "embedding_lost" else 2
    )
    assert sum(event["stage"] == "model_sent" for event in events) == (
        3 if fault is None else 0 if fault == "embedding_lost" else 1
    )


def rag_accounting():
    plan = []
    for case in range(3):
        for kind in ("document_embedding", "query_embedding", "answer"):
            plan.append(
                {
                    "id": f"{kind}:R0{case + 1}",
                    "kind": kind,
                    "max_input_tokens": 32768 if kind == "answer" else 243,
                    "max_output_tokens": 2000 if kind == "answer" else 0,
                }
            )
    before = {"allocated": [5, 200], "allocated_input": 700}
    after = {
        "allocated": [8, 2200],
        "allocated_input": 700 + 4 + 32768,
        "closed": True,
        "corrections": [],
        "operation_plan": plan,
        "reserved_input_tokens": sum(row["max_input_tokens"] for row in plan),
        "reserved_output_tokens": 6000,
        "calls": [
            {
                "sequence": i,
                "operation_id": plan[i]["id"],
                "counted_input_tokens": 100 if i == 2 else 243,
                "input_tokens": None if i == 2 else 2,
                "output_tokens": None if i == 2 else 0,
            }
            for i in range(3)
        ],
    }
    events = [{"stage": "authorize", "status": 200}] * 3 + [{"stage": "settle", "status": 200}] * 2
    events += [{"stage": "embedding_sent"}] * 2 + [{"stage": "model_sent"}]
    return before, after, events


def test_rag_accounting_keeps_unknown_answer_cap_and_zero_embedding_output():
    before, after, events = rag_accounting()
    result = smoke.verify_rag_budget(
        before, after, calls=3, output=2000, sent=3, events=events, unknown_calls=1
    )
    assert result["unknown_calls"] == 1 and result["retained_input_delta"] == 32772
    assert result["evidence_kind"] == "integration-stub-not-quality-evidence"


@pytest.mark.parametrize(
    "defect",
    [
        "input_refund",
        "output_refund",
        "wrong_operation",
        "duplicate_sequence",
        "not_closed",
        "missing_send",
        "wrong_send_kind",
        "missing_settle",
        "negative_usage",
        "wrong_reservation",
    ],
)
def test_rag_accounting_rejects_false_success(defect):
    before, after, events = deepcopy(rag_accounting())
    if defect == "input_refund":
        after["allocated_input"] -= 32768
    elif defect == "output_refund":
        after["allocated"][1] -= 2000
    elif defect == "wrong_operation":
        after["calls"][1]["operation_id"] = "answer:R01"
    elif defect == "duplicate_sequence":
        after["calls"][1]["sequence"] = 0
    elif defect == "not_closed":
        after["closed"] = False
    elif defect == "missing_send":
        events.pop()
    elif defect == "wrong_send_kind":
        events[-1] = {"stage": "embedding_sent"}
    elif defect == "missing_settle":
        events[:] = [event for event in events if event["stage"] != "settle"]
    elif defect == "negative_usage":
        after["calls"][0]["input_tokens"] = -1
    else:
        after["reserved_output_tokens"] = 18000  # Every operation incorrectly charged as an answer.
    with pytest.raises(AssertionError):
        smoke.verify_rag_budget(
            before, after, calls=3, output=2000, sent=3, events=events, unknown_calls=1
        )


@pytest.mark.parametrize("false_zero_usage", [False, True])
def test_rag_accounting_preserves_unknown_embedding_even_with_zero_output(false_zero_usage):
    before, after, _ = rag_accounting()
    after["calls"] = after["calls"][:1]
    after["calls"][0].update(input_tokens=None, output_tokens=None)
    after["allocated"] = [before["allocated"][0] + 1, before["allocated"][1]]
    after["allocated_input"] = before["allocated_input"] + 243
    events = [{"stage": "authorize", "status": 200}, {"stage": "embedding_sent"}]
    if false_zero_usage:
        # 전체 장부까지 0으로 잘못 정산하면 합계만 비교하는 검사로는 탐지하지 못한다.
        after["calls"][0].update(input_tokens=0, output_tokens=0)
        after["allocated_input"] = before["allocated_input"]
        events.append({"stage": "settle", "status": 200})
        with pytest.raises(AssertionError):
            smoke.verify_rag_budget(
                before, after, calls=1, output=0, sent=1, events=events, unknown_calls=1
            )
    else:
        result = smoke.verify_rag_budget(
            before, after, calls=1, output=0, sent=1, events=events, unknown_calls=1
        )
        assert result["retained_input_delta"] == 243 and result["unknown_calls"] == 1


def recovery_evidence():
    source = {
        "id": "source",
        "status": "FAILED",
        "model_api_calls": 9,
        "prefect_flow_run_id": "flow-source",
    }
    config = {
        "capture_sha256": "a" * 64,
        "fixture_sha256": "b" * 64,
        "source_request_sha256": "c" * 64,
        "reference_capture_sha256": "d" * 64,
        "recorded_execution": {"kind": "recorded"},
    }
    run = {
        "status": "COMPLETED",
        "execution_mode": "recovery",
        "source_run_id": "source",
        "model_api_calls": 0,
        "prefect_flow_run_id": "flow-recovered",
        "execution_spec": {"recovery_config": config, "model_operations": [], "generation": None},
        "comparison": {
            "current": {
                "captureSha256": "a" * 64,
                "execution": {"kind": "recorded"},
                "measurementKind": "recorded-capture-replay",
                "completed": True,
                "liveExecutionPerformed": False,
                "baselineEligible": False,
            }
        },
    }
    before = {"allocated": [9, 150], "allocated_input": 330}
    after = {
        **deepcopy(before),
        "execution_mode": "recovery",
        "source_run_id": "source",
        "reservation_exists": False,
    }
    original = {
        "capture/capture.json": "a" * 64,
        "request.json": "c" * 64,
        "capture/usage-0.json": "e" * 64,
    }
    files = {
        "source_before": original,
        "source_after": deepcopy(original),
        "recovered": {
            "capture/capture.json": "a" * 64,
            "recovery-fixture.json": "b" * 64,
            "reference-capture.json": "d" * 64,
        },
    }
    return source, run, before, after, files


@pytest.mark.parametrize(
    "defect",
    [
        None,
        "model_call",
        "budget_call",
        "reservation",
        "input_delta",
        "output_delta",
        "source_receipt",
        "copied_capture",
        "reference",
        "source_request",
        "live_report",
        "approved",
        "same_flow",
        "missing_publish",
    ],
)
def test_recovery_checker_rejects_regeneration_mutation_and_false_quality(defect):
    source, run, before, after, files = recovery_evidence()
    events = [{"stage": "before_rag_publish"}]
    if defect == "model_call":
        events.append({"stage": "embedding_sent"})
    elif defect == "budget_call":
        events.append({"stage": "claim", "status": 200})
    elif defect == "reservation":
        after["reservation_exists"] = True
    elif defect == "input_delta":
        after["allocated_input"] += 1
    elif defect == "output_delta":
        after["allocated"][1] += 1
    elif defect == "source_receipt":
        files["source_after"]["capture/usage-0.json"] = "f" * 64
    elif defect == "copied_capture":
        files["recovered"]["capture/capture.json"] = "f" * 64
    elif defect == "reference":
        files["recovered"]["reference-capture.json"] = "f" * 64
    elif defect == "source_request":
        run["execution_spec"]["recovery_config"]["source_request_sha256"] = "f" * 64
    elif defect == "live_report":
        run["comparison"]["current"]["liveExecutionPerformed"] = True
    elif defect == "approved":
        run["comparison"]["current"]["baselineEligible"] = True
    elif defect == "same_flow":
        run["prefect_flow_run_id"] = source["prefect_flow_run_id"]
    elif defect == "missing_publish":
        events.clear()
    if defect:
        with pytest.raises(AssertionError):
            smoke.verify_rag_recovery(source, run, before, after, files, events=events)
    else:
        result = smoke.verify_rag_recovery(source, run, before, after, files, events=events)
        assert result["original_evidence_preserved"] and result["model_sends"] == 0


def test_readiness_checks_real_langfuse_endpoint_without_model_calls(server, monkeypatch):
    state, base = server
    forwarded = Mock(return_value=(200, b'{"status":"OK"}'))
    monkeypatch.setattr(probe, "exchange", forwarded)
    assert smoke.request(base + "/health") == (200, {"ready": True})
    assert not forwarded.called
    assert smoke.request(base + "/langfuse-health") == (200, {"status": "OK"})
    forwarded.assert_called_once_with("http://langfuse-web:3000/api/public/health", "GET")
    assert not state.runs


@pytest.fixture
def control_server(monkeypatch):
    received = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            self.handle_request()

        def do_POST(self):
            self.handle_request()

        def handle_request(self):
            data = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            received.append({"path": self.path, "headers": dict(self.headers), "body": data})
            status = {"/redirect": 302, "/unavailable": 503}.get(self.path, 200)
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            if self.path == "/session":
                self.send_header("Set-Cookie", "csrftoken=csrf-cookie; Path=/; SameSite=Lax")
            if self.path == "/redirect":
                self.send_header("Location", "https://example.com/should-not-be-called")
            self.end_headers()
            self.wfile.write(
                b"<html>private failure detail</html>"
                if self.path == "/invalid"
                else b'{"csrf_token":"csrf-header"}'
            )

    instance = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=instance.serve_forever, daemon=True)
    resolve = socket.getaddrinfo

    def local_only(host, port, *args, **kwargs):
        assert (host, port) == ("ops-service", 8000), "Unexpected outbound destination"
        return resolve("127.0.0.1", instance.server_port, *args, **kwargs)

    monkeypatch.setattr(socket, "getaddrinfo", local_only)
    thread.start()
    try:
        yield received
    finally:
        instance.shutdown()
        instance.server_close()
        thread.join(timeout=2)


def test_internal_client_preserves_real_http_csrf_cookies_and_failure(control_server):
    commands = []

    def compose(*parts, **kwargs):
        commands.append((parts, kwargs))
        payload = json.loads(kwargs["input"])
        reply = probe.control_request(payload)
        return subprocess.CompletedProcess(parts, 0, stdout=json.dumps(reply))

    client = smoke.Smoke(compose)
    status, session = client.api("/session")
    assert status == 200
    client.csrf = session["csrf_token"]
    assert client.api("/unavailable", {"test": "한글"})[0] == 503
    request = control_server[-1]
    assert request["headers"]["Origin"] == "http://ops-service:8000"
    assert request["headers"]["X-Csrftoken"] == "csrf-header"
    assert (
        request["headers"]["Cookie"]
        == "govbiz_session=offline-admin-session; csrftoken=csrf-cookie"
    )
    assert json.loads(request["body"]) == {"test": "한글"}
    for parts, kwargs in commands:
        assert parts == (
            "exec",
            "-T",
            "cancellation-probe",
            "python",
            "/test/cancellation_probe.py",
            "request",
        )
        assert kwargs["capture"] is True
        assert "csrf-cookie" not in str(parts)  # Credentials travel through stdin only.


def test_internal_client_does_not_follow_redirects_or_use_ambient_proxy(
    control_server, monkeypatch
):
    monkeypatch.setenv("http_proxy", "http://unexpected-proxy.invalid:8080")
    monkeypatch.setenv("HTTP_PROXY", "http://unexpected-proxy.invalid:8080")
    monkeypatch.setenv("no_proxy", "")
    monkeypatch.setenv("NO_PROXY", "")
    reply = probe.control_request({"url": "http://ops-service:8000/redirect"})
    assert reply["status"] == 302 and len(control_server) == 1


@pytest.mark.parametrize(
    "url",
    [
        "https://api.openai.com/v1/responses",
        "http://169.254.169.254/",
        "http://ops-service:8000.evil.test/path",
        "http://ops-service:8001/path",
        "http://user@ops-service:8000/path",
        "https://ops-service:8000/path",
        "http://ops-service:8000/path#fragment",
    ],
)
def test_internal_client_rejects_other_destinations(url, monkeypatch):
    opener = Mock()
    monkeypatch.setattr(probe, "build_opener", opener)
    with pytest.raises(ValueError, match="Only cancellation test services"):
        probe.control_request({"url": url})
    assert not opener.called


def test_transport_failure_never_becomes_http_success():
    compose = Mock(
        return_value=subprocess.CompletedProcess([], 0, stdout='{"transport_error":"URLError"}')
    )
    with pytest.raises(smoke.URLError):
        smoke.Smoke(compose).api("/session")


@pytest.mark.parametrize("method", ["GET", "POST"])
def test_timeout_records_bounded_metadata_without_retry_or_secrets(monkeypatch, method):
    compose = Mock(
        return_value=subprocess.CompletedProcess([], 0, stdout='{"transport_error":"TimeoutError"}')
    )
    clock = iter((10.0, 30.125))
    monkeypatch.setattr(smoke.time, "monotonic", lambda: next(clock))
    client = smoke.Smoke(compose)
    with pytest.raises(smoke.URLError):
        client.request(
            client.ops + "/private-path?token=secret-query",
            {"private": "secret-body"} if method == "POST" else None,
            headers={"Cookie": "secret-cookie"},
        )
    assert compose.call_count == 1
    assert list(client.recent_requests) == [
        {
            "service": "ops",
            "method": method,
            "status": None,
            "transport_error": "TimeoutError",
            "error": "URLError",
            "elapsed_ms": 20125,
        }
    ]


@pytest.mark.parametrize(
    ("reply", "error", "status"),
    [
        ('{"transport_error":"private network exception"}', "URLError", None),
        ('{"status":502,"response_error":"private HTTP body"}', "ValueError", 502),
        ("private invalid json", "JSONDecodeError", None),
        (subprocess.TimeoutExpired(["private-command"], 120), "TimeoutExpired", None),
        (
            subprocess.CalledProcessError(1, ["private-command"], output="private stdout"),
            "CalledProcessError",
            None,
        ),
    ],
)
def test_request_diagnostics_preserve_failure_type_without_private_content(reply, error, status):
    compose = (
        Mock(side_effect=reply)
        if isinstance(reply, Exception)
        else Mock(return_value=subprocess.CompletedProcess([], 0, stdout=reply))
    )
    client = smoke.Smoke(compose)
    with pytest.raises(Exception) as failure:
        client.request("http://private-host/private-path")
    assert type(failure.value).__name__ == error
    record = client.recent_requests[-1]
    assert record["error"] == error and record["status"] == status
    assert record["service"] == "unknown" and record["elapsed_ms"] >= 0
    assert "private" not in json.dumps(record)
    assert compose.call_count == 1


def test_recent_request_diagnostics_keep_only_last_32_outcomes():
    replies = [
        subprocess.CompletedProcess(
            [],
            0,
            stdout=json.dumps({"status": status, "cookies": {}, "body": "private body"}),
        )
        for status in range(200, 233)
    ]
    client = smoke.Smoke(Mock(side_effect=replies))
    for _ in replies:
        client.request(client.prefect + "/private-path")
    assert len(client.recent_requests) == 32
    assert [item["status"] for item in client.recent_requests] == list(range(201, 233))
    assert all(item["service"] == "prefect" for item in client.recent_requests)
    assert all("error" not in item for item in client.recent_requests)
    assert "private" not in json.dumps(list(client.recent_requests))


def isolated_config():
    return {
        "networks": {"default": {"internal": True}},
        "services": {
            "ops-service": {"networks": {"default": None}},
            "ops-bootstrap": {
                "networks": {"default": None},
                "environment": {"LLMOPS_LOCAL_SEED_ENABLED": "false"},
                "command": ["python", "manage.py", "migrate", "--noinput"],
            },
        },
    }


@pytest.mark.parametrize("seed_enabled", ["true", None])
def test_shared_review_seed_is_rejected_before_budget_setup(seed_enabled):
    config = isolated_config()
    if seed_enabled is None:
        del config["services"]["ops-bootstrap"]["environment"]["LLMOPS_LOCAL_SEED_ENABLED"]
    else:
        config["services"]["ops-bootstrap"]["environment"]["LLMOPS_LOCAL_SEED_ENABLED"] = (
            seed_enabled
        )
    with pytest.raises(ValueError, match="disable shared review seed"):
        smoke.verify_isolation(config)


def test_bootstrap_must_migrate_without_importing_shared_reviews():
    config = isolated_config()
    config["services"]["ops-bootstrap"]["command"] = [
        "python",
        "manage.py",
        "bootstrap_local_reviews",
    ]
    with pytest.raises(ValueError, match="only apply migrations"):
        smoke.verify_isolation(config)


def test_missing_bootstrap_is_rejected_before_startup():
    config = isolated_config()
    del config["services"]["ops-bootstrap"]
    with pytest.raises(ValueError, match="disable shared review seed"):
        smoke.verify_isolation(config)


def test_review_seed_configuration_failure_never_starts_containers(monkeypatch, tmp_path):
    output = tmp_path / "configuration.json"
    monkeypatch.setattr(sys, "argv", ["cancellation_smoke", "--output", str(output)])
    config = isolated_config()
    config["services"]["ops-bootstrap"]["environment"]["LLMOPS_LOCAL_SEED_ENABLED"] = "true"
    run = Mock(return_value=subprocess.CompletedProcess([], 0, stdout=json.dumps(config)))
    monkeypatch.setattr(smoke.subprocess, "run", run)
    with pytest.raises(ValueError, match="disable shared review seed"):
        smoke.main()
    commands = [call.args[0] for call in run.call_args_list]
    operations = [command[command.index("evaluation") + 1] for command in commands]
    assert operations == ["config", "ps", "down"]
    report = json.loads(output.read_text())
    assert report["passed"] is False and report["scenarios"] == []
    assert report["diagnostics"]["phase"] == "configuration"


@pytest.mark.parametrize("defect", ["egress", "extra_network", "host", "port"])
def test_network_regression_is_rejected_before_startup(defect):
    config = isolated_config()
    smoke.verify_isolation(config)
    if defect == "egress":
        config["networks"]["default"]["internal"] = False
    elif defect == "extra_network":
        config["networks"]["egress"] = {}
    elif defect == "host":
        config["services"]["ops-service"]["network_mode"] = "host"
    else:
        config["services"]["ops-service"]["ports"] = [{"target": 8000, "published": "18001"}]
    with pytest.raises(ValueError):
        smoke.verify_isolation(config)


def test_startup_failure_records_safe_diagnostics_and_cleans_only_own_project(
    monkeypatch, tmp_path
):
    output = tmp_path / "failure.json"
    monkeypatch.setattr(sys, "argv", ["cancellation_smoke", "--output", str(output)])
    secret = "do-not-include-password"
    monkeypatch.setattr(smoke, "isolated_environment", lambda: {"OPS_DB_PASSWORD": secret})
    commands = []

    def run(command, **kwargs):
        commands.append(command)
        parts = command[command.index("evaluation") + 1 :]
        if parts[0] == "config":
            return subprocess.CompletedProcess(command, 0, stdout=json.dumps(isolated_config()))
        if parts[0] == "up":
            raise subprocess.CalledProcessError(
                1, command, output="private HTTP body", stderr=f"startup failed: {secret}"
            )
        if parts[0] == "ps":
            row = {
                "Service": "ops-service",
                "State": "exited",
                "ExitCode": 1,
                "Command": secret,
                "Env": [secret],
            }
            return subprocess.CompletedProcess(command, 0, stdout=json.dumps(row) + "\n")
        assert parts == ["down", "--volumes", "--remove-orphans", "--timeout", "5"]
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(smoke.subprocess, "run", run)
    with pytest.raises(subprocess.CalledProcessError):
        smoke.main()
    raw = output.read_text(encoding="utf-8")
    report = json.loads(raw)
    assert report["passed"] is False and report["scenarios"] == []
    assert report["diagnostics"]["phase"] == "startup"
    assert report["diagnostics"]["error"]["exit_code"] == 1
    assert report["diagnostics"]["services"][0]["State"] == "exited"
    assert secret not in raw and "private HTTP body" not in raw
    assert "[REDACTED]" in raw
    assert len({c[c.index("--project-name") + 1] for c in commands}) == 1
    assert commands[-1][-5:] == ["down", "--volumes", "--remove-orphans", "--timeout", "5"]


def test_diagnostic_collection_failure_does_not_hide_primary_failure():
    states = smoke.service_states(Mock(side_effect=RuntimeError("private detail")))
    assert states == {"unavailable": "RuntimeError"}


def test_scenario_timeout_is_saved_before_cleanup_without_becoming_success(monkeypatch, tmp_path):
    output = tmp_path / "timeout.json"
    monkeypatch.setattr(sys, "argv", ["cancellation_smoke", "--output", str(output)])
    monkeypatch.setattr(smoke.Smoke, "ready", lambda self: None)
    monkeypatch.setattr(smoke.Smoke, "run", lambda self: self.api("/private-path"))
    commands = []

    def run(command, **kwargs):
        parts = command[command.index("evaluation") + 1 :]
        commands.append(parts)
        if parts[0] == "config":
            result = json.dumps(isolated_config())
        elif parts[-1] == "request":
            result = '{"transport_error":"TimeoutError"}'
        elif parts[0] == "ps":
            result = "[]"
        else:
            result = ""
        return subprocess.CompletedProcess(command, 0, stdout=result)

    monkeypatch.setattr(smoke.subprocess, "run", run)
    with pytest.raises(smoke.URLError):
        smoke.main()
    report = json.loads(output.read_text())
    assert report["passed"] is False and report["failure"] == "URLError"
    assert report["diagnostics"]["phase"] == "scenarios"
    record = report["diagnostics"]["recent_requests"][-1]
    assert record["service"] == "ops" and record["transport_error"] == "TimeoutError"
    assert record["status"] is None
    assert "private" not in output.read_text()
    assert commands[-1] == ["down", "--volumes", "--remove-orphans", "--timeout", "5"]


def test_smoke_budget_setup_passes_required_audit_metadata(monkeypatch, tmp_path):
    monkeypatch.setattr(
        sys, "argv", ["cancellation_smoke", "--output", str(tmp_path / "result.json")]
    )
    commands = []

    def run(command, **kwargs):
        commands.append(command)
        return subprocess.CompletedProcess(command, 0, stdout=json.dumps(isolated_config()))

    monkeypatch.setattr(smoke.subprocess, "run", run)
    # Stop before scenarios: this verifies the CLI contract, not cancellation behavior.
    monkeypatch.setattr(
        smoke.Smoke, "ready", Mock(side_effect=RuntimeError("stop-before-scenarios"))
    )
    with pytest.raises(RuntimeError, match="stop-before-scenarios"):
        smoke.main()
    setup = next(command for command in commands if "set_evaluation_budget" in command)
    assert setup[setup.index("--actor") + 1] == "cancellation-smoke"
    assert setup[setup.index("--reason") + 1] == "Isolated offline cancellation scenarios"
    assert UUID(setup[setup.index("--request-id") + 1]).version == 4


def test_non_json_http_response_preserves_failure_without_body(control_server):
    reply = probe.control_request({"url": "http://ops-service:8000/invalid"})
    assert reply == {"status": 200, "response_error": "invalid_json"}
    compose = Mock(return_value=subprocess.CompletedProcess([], 0, stdout=json.dumps(reply)))
    with pytest.raises(ValueError, match="Invalid JSON response: HTTP 200"):
        smoke.Smoke(compose).api("/invalid")


def test_readiness_waits_for_valid_langfuse_json(monkeypatch):
    client = smoke.Smoke(Mock())
    session = {
        "live_enabled": True,
        "user": {"id": 1},
        "csrf_token": "csrf",
        "datasets": [
            {"id": "target-coverage-20260907-v1"},
            {
                "id": "rag-synthetic-multichunk-v1",
                "live_config": {"model": "test"},
                "execution_profiles": {"live": "test-profile"},
            },
        ],
    }
    client.request = Mock(
        side_effect=[
            ValueError("Invalid JSON response: HTTP 500"),
            (200, {"status": "OK"}),
            (200, session),
            (200, {}),
        ]
    )
    monkeypatch.setattr(smoke.time, "sleep", Mock())
    client.ready()
    assert client.request.call_count == 4 and client.csrf == "csrf"


def test_wrong_python_version_fails_before_docker(monkeypatch, tmp_path):
    monkeypatch.setattr(
        sys, "argv", ["cancellation_smoke.py", "--output", str(tmp_path / "x.json")]
    )
    monkeypatch.setattr(smoke.sys, "version_info", (3, 9, 6))
    docker = Mock()
    monkeypatch.setattr(smoke.subprocess, "run", docker)
    with pytest.raises(SystemExit) as raised:
        smoke.main()
    assert raised.value.code == 2 and not docker.called


@pytest.mark.parametrize("recovers", [True, False])
def test_readiness_retries_non_json_startup_response_but_still_times_out(monkeypatch, recovers):
    instance = smoke.Smoke(Mock())
    monkeypatch.setattr(instance, "request", Mock(return_value=(200, {})))
    monkeypatch.setattr(smoke.time, "sleep", Mock())
    monkeypatch.setattr(
        smoke.time, "monotonic", Mock(side_effect=[0, 0, 1, 1] if recovers else [0, 0, 181])
    )
    unavailable = json.JSONDecodeError("Not JSON", "<html>Upstream not ready</html>", 0)
    ready = (
        200,
        {
            "live_enabled": True,
            "user": {"id": 1},
            "csrf_token": "test-csrf",
            "datasets": [
                {"id": "target-coverage-20260907-v1"},
                {
                    "id": "rag-synthetic-multichunk-v1",
                    "live_config": {"model": "test"},
                    "execution_profiles": {"live": "test-profile"},
                },
            ],
        },
    )
    api = Mock(side_effect=[unavailable, ready] if recovers else unavailable)
    monkeypatch.setattr(instance, "api", api)
    if recovers:
        instance.ready()
        assert instance.csrf == "test-csrf" and api.call_count == 2
    else:
        with pytest.raises(TimeoutError, match="Ops readiness"):
            instance.ready()
        assert instance.csrf is None


@pytest.mark.parametrize(
    "fault",
    [None, "extra-send", "over-release", "changed-original", "unknown", "source"],
)
def test_usage_correction_preserves_originals_and_does_not_hide_unknown_or_resend(
    fault,
):
    import copy

    before = {
        "closed": True,
        "calls": [{"sequence": 0, "output_tokens": None}],
        "allocated": [1, 2000],
        "allocated_input": 32768,
    }
    after = {**copy.deepcopy(before), "allocated": [1, 50], "allocated_input": 100}
    record = {
        "applied": True,
        "source": "WORKER_RESPONSE",
        "input_tokens": 100,
        "output_tokens": 50,
        "before": {"global_output_tokens": 2000, "global_input_tokens": 32768},
        "after": {
            "global_output_tokens": 50,
            "unknown_calls": 0,
            "global_input_tokens": 100,
        },
    }
    events = [{"stage": "model_sent"}]
    events_after = copy.deepcopy(events)
    if fault == "extra-send":
        events_after.append({"stage": "model_sent"})
    if fault == "over-release":
        after["allocated"] = [1, 0]
    if fault == "changed-original":
        after["calls"][0]["output_tokens"] = 50
    if fault == "unknown":
        record["after"]["unknown_calls"] = 1
    if fault == "source":
        record["source"] = "MANUAL"
    if fault:
        with pytest.raises(AssertionError):
            smoke.verify_correction(
                record, before, after, events_before=events, events_after=events_after
            )
    else:
        smoke.verify_correction(
            record, before, after, events_before=events, events_after=events_after
        )


def test_unknown_input_cannot_be_refunded_as_zero():
    before, after, events = accounting()
    after["allocated_input"] = before["allocated_input"]
    with pytest.raises(AssertionError):
        smoke.verify_budget(before, after, calls=1, output=2000, closed=True, sent=1, events=events)


@pytest.mark.parametrize(
    "fault",
    [None, "missing", "duplicate", "wrong-call", "refund-zero", "mutated-original"],
)
def test_final_budget_accounts_for_separate_usage_correction(fault):
    before, after, events = accounting()
    after.update(
        allocated=[4, 150],
        allocated_input=200,
        corrections=[
            {
                "sequence": 0,
                "correction__input_tokens": 100,
                "correction__output_tokens": 50,
            }
        ],
    )
    if fault == "missing":
        after["corrections"] = []
    if fault == "duplicate":
        after["corrections"] *= 2
    if fault == "wrong-call":
        after["corrections"][0]["sequence"] = 1
    if fault == "refund-zero":
        after["allocated_input"] = before["allocated_input"]
    if fault == "mutated-original":
        after["calls"][0]["input_tokens"] = 100
    if fault:
        with pytest.raises(AssertionError):
            smoke.verify_budget(
                before, after, calls=1, output=50, closed=True, sent=1, events=events
            )
    else:
        result = smoke.verify_budget(
            before, after, calls=1, output=50, closed=True, sent=1, events=events
        )
        assert result["retained_input_delta"] == 100
        assert result["settlements"] == 0  # signed correction never rewrites settlement history
