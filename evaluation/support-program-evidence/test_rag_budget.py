"""실제 AI HTTP·Service·Agent·SDK·메모리 Qdrant와 무료 예산/모델 대역의 혼합 실행."""

import asyncio
import hashlib
import hmac
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Event, Thread
from time import monotonic
from unittest.mock import Mock
from uuid import uuid4

import httpx2
import pytest
import serve_flow
from budget_client import BudgetClient, BudgetUnavailable
from fastapi.testclient import TestClient
from qdrant_client import AsyncQdrantClient
from rag_budget import RagBudget, digest, make_rag_spec

PREFIX = "/internal/v1/support-program-evidence/"
TOKEN = "test-only-rag-budget-token-never-used-in-production"


def cases(count=1):
    chunks = [
        {
            "id": sha256(f"chunk-{i}".encode()).hexdigest(),
            "documentId": "BIZINFO:TEST",
            "order": i,
            "text": text,
            "contentHash": sha256(text.encode()).hexdigest(),
        }
        for i, text in enumerate(("서울 법인 지원", "사업비 백만원"))
    ]
    return [
        {"case_id": f"R{i}", "chunks": chunks, "question": "지원 대상?", "limit": 2}
        for i in range(count)
    ]


@pytest.fixture
def session(tmp_path, monkeypatch, request):
    events, attempts, actions = [], [], []
    fault = {"kind": None}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            assert self.headers["Authorization"] == "Bearer " + TOKEN
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            action = self.path.rsplit("/", 1)[1]
            if action == "settle" and body["usage"] is not None:
                assert (output / f"usage-{body['sequence']}.json").is_file()
            actions.append((action, body))
            events.append((action, body.get("sequence")))
            if (
                fault["kind"] == "concurrent-approval"
                and action == "authorize"
                and body["sequence"] == 2
            ):
                fault["entered"].set()
                fault["release"].wait(timeout=2)
            rejected = (
                (fault["kind"] == "claim" and action == "claim")
                or (
                    fault["kind"] in {"approval", "cancel"}
                    and action == "authorize"
                    and body["sequence"] == 2
                )
                or (
                    fault["kind"] == "embedding-settle"
                    and action == "settle"
                    and body["sequence"] == 0
                )
                or (
                    fault["kind"] == "answer-settle"
                    and action == "settle"
                    and body["sequence"] == 2
                )
                or (fault["kind"] == "close" and action == "close")
            )
            raw = json.dumps({"accepted": not rejected}).encode()
            self.send_response(
                (409 if fault["kind"] == "cancel" else 503) if rejected else 200
            )
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(
        target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True
    )
    thread.start()
    monkeypatch.setenv("LLMOPS_OPS_API_URL", f"http://127.0.0.1:{server.server_port}")
    monkeypatch.setenv("LLMOPS_BUDGET_TOKEN", TOKEN)
    monkeypatch.setenv("OPENAI_API_KEY", "offline-key-never-sent")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://forbidden.invalid/v1")
    original_init = httpx2.AsyncClient.__init__

    async def respond(request):
        assert str(request.url).startswith("https://api.openai.com/v1/")
        body = json.loads(request.content)
        if request.url.path.endswith("input_tokens"):
            events.append(("count", None))
            if fault["kind"] == "concurrent-count":
                fault["entered"].set()
                await asyncio.to_thread(fault["release"].wait, 2)
            if fault["kind"] == "count":
                return httpx2.Response(503, json={"error": {"message": "PRIVATE"}})
            if fault["kind"] == "count-timeout":
                raise httpx2.ReadTimeout("PRIVATE", request=request)
            return httpx2.Response(
                200,
                json={
                    "object": "response.input_tokens",
                    "input_tokens": {
                        "input-cap": 32769,
                        "count-unknown": None,
                        "count-bool": True,
                    }.get(fault["kind"], 100),
                },
            )
        attempts.append(body)
        events.append(("model", len(attempts)))
        if request.url.path.endswith("embeddings"):
            return httpx2.Response(
                200,
                headers={"x-request-id": f"req_{len(attempts)}"},
                json={
                    "model": body["model"],
                    "usage": {
                        "prompt_tokens": len(body["input"]),
                        "total_tokens": len(body["input"]),
                    },
                    "data": [
                        {"index": i, "embedding": [1.0] + [0.0] * 1535}
                        for i in range(len(body["input"]))
                    ],
                },
            )
        assert request.url.path == "/v1/responses"
        if fault["kind"] == "timeout":
            raise httpx2.ReadTimeout("PRIVATE", request=request)
        answer = {
            "answer": "서울 법인 지원입니다.",
            "answerStatus": "ANSWERED",
            "citationChunkIndexes": [999 if fault["kind"] == "citation" else 0],
        }
        usage = {"input_tokens": 100, "output_tokens": 20, "total_tokens": 120}
        if fault["kind"] == "usage-over":
            usage = {"input_tokens": 32769, "output_tokens": 20, "total_tokens": 32789}
        return httpx2.Response(
            200,
            json={
                "id": f"resp_{len(attempts)}",
                "object": "response",
                "created_at": 0,
                "model": "different"
                if fault["kind"] == "response-model"
                else body["model"],
                "status": {
                    "incomplete": "incomplete",
                    "response-status": "unexpected",
                }.get(fault["kind"], "completed"),
                "error": None,
                "incomplete_details": None,
                "parallel_tool_calls": False,
                "tool_choice": "none",
                "tools": [],
                "output": [
                    {
                        "id": "msg_fixture",
                        "type": "message",
                        "role": "assistant",
                        "status": "completed",
                        "content": [
                            {
                                "type": "output_text",
                                "annotations": [],
                                "text": json.dumps(answer),
                            }
                        ],
                    }
                ],
                "usage": None if fault["kind"] == "unknown" else usage,
            },
        )

    def init(self, *args, **kwargs):
        kwargs["transport"] = httpx2.MockTransport(respond)
        original_init(self, *args, **kwargs)

    monkeypatch.setattr(httpx2.AsyncClient, "__init__", init)
    monkeypatch.setattr(
        serve_flow.bootstrap,
        "AsyncQdrantClient",
        lambda **kwargs: AsyncQdrantClient(":memory:"),
    )
    material = cases(2)
    if getattr(request, "param", None) == "same-text":
        material = cases()
        material[0]["chunks"] = material[0]["chunks"][:1]
        material[0]["question"] = material[0]["chunks"][0]["text"]
    spec = make_rag_spec(material)
    budget = BudgetClient(str(uuid4()), str(uuid4()), digest(spec))
    output = tmp_path / "session"
    guard = RagBudget(budget, spec, receipt_directory=output)
    app = serve_flow.build_evaluation_app(
        output, "http://127.0.0.1:1", len(spec["model_operations"]), rag_budget=guard
    )
    try:
        yield app, guard, spec, events, attempts, actions, fault, output
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()


def execute_case(client, case):
    response = client.put(PREFIX + "chunks", json={"chunks": case["chunks"]})
    if response.status_code != 200:
        return response
    response = client.post(
        PREFIX + "search",
        json={
            "question": case["question"],
            "limit": case["limit"],
            "eligibleChunks": [
                {k: v for k, v in chunk.items() if k != "text"}
                for chunk in case["chunks"]
            ],
        },
    )
    if response.status_code != 200:
        return response
    by_id = {chunk["id"]: chunk for chunk in case["chunks"]}
    selected = [
        {k: v for k, v in by_id[match["id"]].items() if k != "contentHash"}
        for match in response.json()["matches"]
    ]
    return client.post(
        PREFIX + "answers", json={"question": case["question"], "chunks": selected}
    )


def test_mixed_session_real_services_cache_and_receipts(session):
    app, guard, spec, events, attempts, actions, _, output = session
    with TestClient(app) as client:
        for case in spec["rag_cases"]:
            assert execute_case(client, case).status_code == 200, events
        assert guard.case_index == 2
        assert client.get("/health").json()["calls"] == 4
    assert [body["sequence"] for action, body in actions if action == "authorize"] == [
        0,
        1,
        2,
        5,
    ]
    assert [action for action, _ in actions] == [
        "claim",
        "authorize",
        "settle",
        "authorize",
        "settle",
        "authorize",
        "settle",
        "authorize",
        "settle",
        "close",
    ]
    assert (
        len(attempts) == 4
    )  # Second document and query slots were cached, answers never skipped.
    assert (
        events.index(("count", None))
        < events.index(("authorize", 2))
        < events.index(("model", 3))
    )
    for sequence, version in ((0, 2), (1, 2), (2, 1), (5, 1)):
        receipt = json.loads((output / f"usage-{sequence}.json").read_text())
        assert receipt["payload"]["version"] == version
        assert receipt["payload"]["spec_hash"] == digest(spec)
        assert TOKEN not in json.dumps(receipt)
    trace = json.loads((output / "api-capture.json").read_text())
    assert trace["inputTokenCountRequests"] == 2
    assert trace["calls"][2]["countedInputTokens"] == 100


@pytest.mark.parametrize("session", ["same-text"], indirect=True)
def test_cached_document_and_identical_query_use_query_operation(session):
    app, _, spec, _, attempts, actions, _, output = session
    chunk = spec["rag_cases"][0]["chunks"][0]
    service = app.state.container.support_program_evidence_service
    service._chunk_embedding_cache[chunk["contentHash"]] = (
        monotonic() + 60,
        tuple([1.0] + [0.0] * 1535),
    )
    with TestClient(app) as client:
        assert execute_case(client, spec["rag_cases"][0]).status_code == 200
    assert len(attempts) == 2
    assert [body["sequence"] for action, body in actions if action == "authorize"] == [
        1,
        2,
    ]
    receipt = json.loads((output / "usage-1.json").read_text())
    assert receipt["payload"]["operation_kind"] == "query_embedding"
    assert not (output / "usage-0.json").exists()


@pytest.mark.parametrize("phase", ["count", "approval"])
def test_concurrent_request_stops_answer_even_while_awaiting_count_or_approval(
    session, phase
):
    app, _, spec, _, attempts, actions, fault, _ = session
    fault.update(kind="concurrent-" + phase, entered=Event(), release=Event())
    with TestClient(app) as client, ThreadPoolExecutor(max_workers=1) as executor:
        result = executor.submit(execute_case, client, spec["rag_cases"][0])
        try:
            assert fault["entered"].wait(timeout=5)
            assert client.post(PREFIX + "answers", json={}).status_code == 503
        finally:
            fault["release"].set()
        assert result.result(timeout=5).status_code == 503
    assert len(attempts) == 2  # Approval may exist, but no answer was sent after stop.
    assert len([body for action, body in actions if action == "settle"]) == 2
    assert actions[-1][0] == "close"


@pytest.mark.parametrize(
    "kind,expected_calls,has_answer_receipt",
    [
        ("count", 2, False),
        ("count-unknown", 2, False),
        ("count-bool", 2, False),
        ("count-timeout", 2, False),
        ("input-cap", 2, False),
        ("approval", 2, False),
        ("cancel", 2, False),
        ("embedding-settle", 1, False),
        ("answer-settle", 3, True),
        ("timeout", 3, False),
        ("unknown", 3, False),
        ("usage-over", 3, False),
        ("response-model", 3, False),
        ("response-status", 3, False),
        ("incomplete", 3, True),
        ("receipt-write", 3, False),
        ("citation", 3, True),
    ],
)
def test_failure_never_retries_or_advances_and_preserves_observed_usage(
    session, kind, expected_calls, has_answer_receipt
):
    app, guard, spec, _, attempts, actions, fault, output = session
    fault["kind"] = kind
    if kind == "receipt-write":
        guard.client.record_usage_receipt = Mock(
            side_effect=BudgetUnavailable("disk full")
        )
    with TestClient(app, raise_server_exceptions=False) as client:
        assert execute_case(client, spec["rag_cases"][0]).status_code == 503
        assert (
            client.put(
                PREFIX + "chunks", json={"chunks": spec["rag_cases"][1]["chunks"]}
            ).status_code
            == 503
        )
        assert client.get("/health").json()["stopped"]
    assert len(attempts) == expected_calls
    assert actions[-1][0] == "close"
    assert (output / "usage-2.json").exists() is has_answer_receipt
    assert (
        output / "usage-0.json"
    ).exists()  # Settlement failure retains the durable embedding receipt.
    assert guard.stopped
    if kind in {"unknown", "usage-over", "response-model", "response-status"}:
        assert [body for action, body in actions if action == "settle"][-1][
            "usage"
        ] is None
    if kind in {"timeout", "receipt-write"}:
        assert len([action for action, _ in actions if action == "settle"]) == 2


def test_signed_mixed_receipts_survive_answer_settlement_loss(session):
    app, guard, spec, _, _, _, fault, output = session
    fault["kind"] = "answer-settle"
    with TestClient(app) as client:
        assert execute_case(client, spec["rag_cases"][0]).status_code == 503
        assert execute_case(client, spec["rag_cases"][1]).status_code == 503
    assert guard.stopped
    for sequence, version in ((0, 2), (1, 2), (2, 1)):
        path = output / f"usage-{sequence}.json"
        raw = path.read_text(encoding="utf-8")
        receipt = json.loads(raw)
        payload = receipt["payload"]
        assert payload["sequence"] == sequence and payload["version"] == version
        assert payload["run_id"] == guard.client.run_id
        assert payload["worker_id"] == guard.client.identity["worker_id"]
        canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        expected = hmac.new(
            TOKEN.encode(),
            f"govbiz-budget-usage-v{version}\n".encode() + canonical,
            hashlib.sha256,
        ).hexdigest()
        assert hmac.compare_digest(receipt["signature"], expected)
        assert path.stat().st_mode & 0o777 == 0o600
        assert spec["rag_cases"][0]["question"] not in raw and TOKEN not in raw
    assert not (output / "usage-3.json").exists()


@pytest.mark.parametrize(
    "change",
    [
        "question",
        "text",
        "index",
        "duplicate",
        "prompt",
        "model",
        "tools",
        "tokens",
        "schema",
        "endpoint",
        "unrequested-count",
    ],
)
def test_modified_answer_sdk_payload_is_rejected_before_count_or_approval(
    session, monkeypatch, change
):
    app, guard, spec, events, attempts, actions, _, _ = session
    original = guard.before_request

    async def tamper(request):
        if request.url.path != "/v1/responses":
            return await original(request)
        body = json.loads(request.content)
        url = str(request.url)
        if change in {"question", "text", "index", "duplicate"}:
            payload = json.loads(body["input"][1]["content"])
            if change == "question":
                payload["question"] = "unapproved"
            elif change == "duplicate":
                payload["chunks"][1] = {**payload["chunks"][0], "index": 1}
            else:
                payload["chunks"][0][change] = (
                    True if change == "index" else "unapproved"
                )
            body["input"][1]["content"] = json.dumps(payload, ensure_ascii=False)
        elif change == "prompt":
            body["input"][0]["content"] = "unapproved instruction"
        elif change == "model":
            body["model"] = "other"
        elif change == "tools":
            body["tools"] = []
        elif change == "tokens":
            body["max_output_tokens"] = 2000.0
        elif change == "schema":
            body["text"] = {"format": {"type": "json_object"}}
        elif change == "endpoint":
            url = "https://unapproved.invalid/v1/responses"
        else:
            url += "/input_tokens"
        await original(httpx2.Request(request.method, url, json=body))

    monkeypatch.setattr(guard, "before_request", tamper)
    with TestClient(app) as client:
        assert execute_case(client, spec["rag_cases"][0]).status_code == 503
        assert client.get("/health").json()["stopped"]
    assert len(attempts) == 2
    assert not any(event[0] == "count" for event in events)
    assert [body["sequence"] for action, body in actions if action == "authorize"] == [
        0,
        1,
    ]


def test_count_request_cannot_be_reused_for_a_second_transmission(session):
    _, guard, _, _, _, _, _, _ = session
    guard.busy = True
    guard.count_payload = {"model": "test", "input": []}
    request = httpx2.Request(
        "POST",
        "https://api.openai.com/v1/responses/input_tokens",
        json=guard.count_payload,
    )

    async def run():
        await guard.before_request(request)
        with pytest.raises(BudgetUnavailable):
            await guard.before_request(request)

    asyncio.run(run())


@pytest.mark.parametrize("kind", ["claim", "close"])
def test_lifecycle_failures_are_explicit(session, kind):
    app, _, spec, _, attempts, actions, fault, _ = session
    fault["kind"] = kind
    with pytest.raises(BudgetUnavailable), TestClient(app) as client:
        assert execute_case(client, spec["rag_cases"][0]).status_code == 200
    assert len(attempts) == (0 if kind == "claim" else 3)
    assert actions[-1][0] == kind


@pytest.mark.parametrize("change", ["question", "chunk", "phase"])
def test_unapproved_material_and_phase_never_reach_sdk(session, change):
    app, _, spec, _, attempts, actions, _, _ = session
    case = deepcopy(spec["rag_cases"][0])
    if change == "chunk":
        case["chunks"][0]["text"] = "unapproved"
    with TestClient(app) as client:
        if change == "question":
            assert (
                client.put(
                    PREFIX + "chunks", json={"chunks": case["chunks"]}
                ).status_code
                == 200
            )
            response = client.post(PREFIX + "search", json={"question": "unapproved"})
        elif change == "phase":
            response = client.post(PREFIX + "answers", json={})
        else:
            response = client.put(PREFIX + "chunks", json={"chunks": case["chunks"]})
        assert response.status_code == 503
    assert len(attempts) == (1 if change == "question" else 0)
    assert actions[-1][0] == "close"


def test_spec_is_pinned_and_modified_model_source_or_material_is_rejected(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("LLMOPS_BUDGET_TOKEN", TOKEN)
    original = make_rag_spec(cases())
    for key in ("live_config", "runtime_sha256", "rag_cases", "model_operations"):
        changed = deepcopy(original)
        if key == "live_config":
            changed[key]["model"] = "other"
        elif key == "runtime_sha256":
            changed[key][next(iter(changed[key]))] = "a" * 64
        elif key == "rag_cases":
            changed[key][0]["question"] = "changed"
        else:
            changed[key][0]["input_sha256"] = "b" * 64
        client = BudgetClient(str(uuid4()), str(uuid4()), digest(changed))
        with pytest.raises(BudgetUnavailable):
            RagBudget(client, changed, receipt_directory=tmp_path)


@pytest.mark.parametrize("mode", ["no-execute", "partial", "wrong-hash", "valid"])
def test_cli_requires_explicit_execution_and_complete_reserved_identity(
    tmp_path, monkeypatch, mode
):
    import uvicorn

    spec = make_rag_spec(cases())
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec), encoding="utf-8")
    request_id, flow_id = str(uuid4()), str(uuid4())
    arguments = [
        "serve_flow.py",
        "--output-dir",
        str(tmp_path / "capture"),
        "--qdrant-url",
        "http://127.0.0.1:6333",
        "--max-api-calls",
        "3",
        "--budget-spec",
        str(spec_path),
    ]
    if mode != "no-execute":
        arguments.append("--execute")
    if mode != "partial":
        arguments.extend(
            [
                "--request-id",
                request_id,
                "--flow-id",
                flow_id,
                "--spec-sha256",
                "0" * 64 if mode == "wrong-hash" else digest(spec),
            ]
        )
    monkeypatch.setattr(sys, "argv", arguments)
    monkeypatch.setenv("LLMOPS_BUDGET_TOKEN", TOKEN)
    monkeypatch.setenv("LLMOPS_OPS_API_URL", "http://127.0.0.1:1")
    build, run = Mock(), Mock()
    monkeypatch.setattr(serve_flow, "build_evaluation_app", build)
    monkeypatch.setattr(uvicorn, "run", run)
    if mode == "valid":
        serve_flow.main()
        guard = build.call_args.kwargs["rag_budget"]
        assert guard.spec == spec and guard.client.run_id == request_id
        assert guard.client.identity["flow_id"] == flow_id
        run.assert_called_once_with(
            build.return_value,
            host="127.0.0.1",
            port=18009,
            access_log=False,
            log_level="warning",
        )
    else:
        with pytest.raises(BudgetUnavailable if mode == "wrong-hash" else SystemExit):
            serve_flow.main()
        build.assert_not_called()
        run.assert_not_called()
