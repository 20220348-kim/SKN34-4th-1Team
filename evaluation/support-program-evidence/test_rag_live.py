"""무료 SDK 대역과 실제 Service·Agent·메모리 검색으로 Ops RAG 전체 실행을 검증한다."""
import asyncio
import json
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import httpx2
import ops_flow
import pytest
import rag_live
import rag_replay_flow
from apps.evaluations.catalog import live_config
from apps.evaluations.execution_spec import digest, make_spec, read_release
from apps.evaluations.rag_material import material_from_sources
from apps.evaluations.rag_replay import read_result, validate_live_capture
from apps.evaluations.recovery_inputs import read_recovery_inputs
from budget_client import BudgetClient, BudgetUnavailable

DATASET = "rag-synthetic-multichunk-v1"
CAPTURE = "rag-synthetic-capture-v1"
HERE = Path(__file__).parent


def parameters(dataset=DATASET, capture=CAPTURE):
    config = live_config(dataset)
    spec = make_spec(read_release(), dataset, "live", config, "new-model-response", capture)
    return dict(request_id=str(uuid4()), dataset_id=dataset, execution_mode="live", live_config=config,
                candidate_capture_id="new-model-response", reference_capture_id=capture,
                execution_spec=spec, execution_spec_sha256=digest(spec))


@pytest.fixture
def runner(tmp_path, monkeypatch):
    for key, value in {"LLMOPS_RESULTS_DIR": str(tmp_path), "LLMOPS_LIVE_ENABLED": "true",
                       "LLMOPS_RAG_LIVE_ENABLED": "true", "OPENAI_API_KEY": "test-only",
                       "LLMOPS_BUDGET_TOKEN": "test-only-token-never-used-outside-tests",
                       "LANGFUSE_ENABLED": "false"}.items():
        monkeypatch.setenv(key, value)
    calls, actions, fault = [], [], {"kind": None}
    original = httpx2.AsyncClient.__init__

    async def respond(request):
        body = json.loads(request.content)
        path = request.url.path
        if path.endswith("/input_tokens"):
            if fault["kind"] == "count":
                raise httpx2.ReadTimeout("private", request=request)
            return httpx2.Response(200, json={"object": "response.input_tokens", "input_tokens": 100})
        calls.append(body)
        if fault["kind"] == "cancelled":
            raise asyncio.CancelledError()
        if path.endswith("/embeddings"):
            return httpx2.Response(200, headers={"x-request-id": f"req_{len(calls)}"}, json={
                "model": body["model"], "usage": {"prompt_tokens": len(body["input"]), "total_tokens": len(body["input"])},
                "data": [{"index": i, "embedding": [1.0] + [0.0] * 1535} for i in range(len(body["input"]))],
            })
        assert path == "/v1/responses"
        if fault["kind"] == "timeout":
            raise httpx2.ReadTimeout("private", request=request)
        answer = {"answer": "무료 테스트 답변", "answerStatus": "ANSWERED", "citationChunkIndexes": [0]}
        return httpx2.Response(200, json={
            "id": f"resp_{len(calls)}", "object": "response", "created_at": 0, "model": body["model"],
            "status": "completed", "error": None, "incomplete_details": None, "parallel_tool_calls": False,
            "tool_choice": "none", "tools": [],
            "output": [{"id": "msg_test", "type": "message", "role": "assistant", "status": "completed",
                        "content": [{"type": "output_text", "annotations": [], "text": json.dumps(answer)}]}],
            "usage": None if fault["kind"] == "unknown" else {"input_tokens": 100, "output_tokens": 20, "total_tokens": 120},
        })

    def init(self, *args, **kwargs):
        kwargs["transport"] = httpx2.MockTransport(respond)
        original(self, *args, **kwargs)

    def request(self, action, **fields):
        actions.append((action, fields))
        if (fault["kind"] == "approval" and action == "authorize" and fields["sequence"] == 2) or (
            fault["kind"] == "settle" and action == "settle" and fields["sequence"] == 2
        ):
            raise BudgetUnavailable("test denial")

    monkeypatch.setattr(httpx2.AsyncClient, "__init__", init)
    monkeypatch.setattr(BudgetClient, "request", request)
    monkeypatch.setattr(ops_flow, "flow_run", SimpleNamespace(id=str(uuid4())))
    monkeypatch.setattr(rag_replay_flow, "flow_run", SimpleNamespace(id=str(uuid4())))
    monkeypatch.setattr(ops_flow, "evaluate_rag_capture", rag_replay_flow.evaluate_rag_capture.fn)
    monkeypatch.setattr(rag_replay_flow, "publish_payloads", lambda payloads, _: [p["id"] for p in payloads])
    monkeypatch.setattr(rag_replay_flow, "render", lambda value, path: (path / "report.html").write_text("<h1>Test report</h1>"))
    return tmp_path, calls, actions, fault


def test_live_runs_new_embeddings_search_answers_and_free_recovery(runner):
    root, calls, actions, _ = runner
    params = parameters()
    manifest = ops_flow.evaluate_saved_capture.fn(**params)
    folder = root / params["request_id"]
    capture = json.loads((folder / "capture/capture.json").read_text())
    usage = json.loads((folder / "capture/usage-summary.json").read_text())
    assert usage["completed"] and usage["model_api_calls"] == len(calls) == 9
    assert usage["input_token_count_requests"] == 3
    assert [body["sequence"] for action, body in actions if action == "authorize"] == list(range(9))
    assert actions[0][0] == "claim" and actions[-1][0] == "close"
    assert len(list((folder / "capture").glob("usage-*.json"))) == 10  # Nine receipts and the summary.
    validate_live_capture(capture, usage, params["execution_spec"], params["execution_spec_sha256"])
    result = read_result(params["execution_spec"], params["execution_spec_sha256"], manifest,
                         (folder / "evaluation/comparison.json").read_bytes(),
                         (folder / "evaluation/report.html").read_bytes())
    assert result[1]["liveExecutionPerformed"] and result[1]["measurementKind"] == "recorded-live-evaluation"
    assert result[1]["baselineEligible"] is False
    material = material_from_sources(json.loads((HERE / "rag-fixture.json").read_text()), capture,
                                     json.loads((HERE / "rag-synthetic-capture.json").read_text()), result[3])
    assert material["cases"][0]["candidate"]["answer"] == "무료 테스트 답변"
    _, recovery, _ = read_recovery_inputs(root, HERE, params["request_id"])
    spec = make_spec(read_release(), DATASET, "recovery", {}, "new-model-response", CAPTURE, recovery_config=recovery)
    recovered = ops_flow.evaluate_saved_capture.fn(**{
        **params, "request_id": str(uuid4()), "execution_mode": "recovery", "live_config": {},
        "recovery_config": recovery, "execution_spec": spec, "execution_spec_sha256": digest(spec),
    })
    assert recovered["status"] == "completed" and len(calls) == 9
    assert len([action for action, _ in actions if action == "claim"]) == 1
    with pytest.raises(FileExistsError):
        ops_flow.evaluate_saved_capture.fn(**params)
    assert len(calls) == 9


def test_official_paragraph_rag_uses_guarded_search_and_keeps_reference_unmeasured(runner):
    root, calls, actions, _ = runner
    params = parameters("official-rag-20261006-v1", "official-rag-not-started-v1")
    manifest = ops_flow.evaluate_saved_capture.fn(**params)
    folder = root / params["request_id"]
    capture = json.loads((folder / "capture/capture.json").read_text())
    usage = json.loads((folder / "capture/usage-summary.json").read_text())
    assert usage["completed"] and usage["model_api_calls"] == len(calls) == 18
    assert usage["input_token_count_requests"] == 6
    assert [body["sequence"] for action, body in actions if action == "authorize"] == list(range(18))
    assert actions[-1][0] == "close"
    validate_live_capture(capture, usage, params["execution_spec"], params["execution_spec_sha256"])
    result = read_result(params["execution_spec"], params["execution_spec_sha256"], manifest,
                         (folder / "evaluation/comparison.json").read_bytes(),
                         (folder / "evaluation/report.html").read_bytes())
    assert result[3]["reference"]["completed"] is False
    assert all(m["value"] is None for m in result[3]["reference"]["metrics"].values())
    assert all(len(c["search"]["response"]["matches"]) == 5 for c in capture["cases"])
    assert all(len(c["answer"]["request"]["chunks"]) == 5 for c in capture["cases"])
    material = material_from_sources(
        json.loads((HERE / "runs/official-rag-20261006-v1/fixture.json").read_text()),
        capture, json.loads((HERE / "runs/official-rag-20261006-v1/not-started.json").read_text()), result[3],
    )
    assert material["data_type"] == "official-html-snapshot"
    assert material["reference_source"] == "ai-authored-not-human-reviewed"
    assert material["baseline_eligible"] is False


@pytest.mark.parametrize("stage", ["report", "publish"])
def test_failed_postprocessing_recovers_exact_bytes_without_new_model_or_budget(runner, monkeypatch, stage):
    root, calls, actions, _ = runner
    params = parameters()
    target = "render" if stage == "report" else "publish_payloads"
    original = getattr(rag_replay_flow, target)

    def fail(*args, **kwargs):
        raise ValueError("offline postprocessing failure")

    monkeypatch.setattr(rag_replay_flow, target, fail)
    with pytest.raises(ValueError, match="offline postprocessing failure"):
        ops_flow.evaluate_saved_capture.fn(**params)
    source = root / params["request_id"]
    source_files = {p.relative_to(source): p.read_bytes() for p in source.rglob("*") if p.is_file()}
    manifest = json.loads(source_files[Path("evaluation/manifest.json")])
    assert manifest["status"] == "failed" and manifest["stage"] == stage
    assert len(calls) == 9 and actions[-1][0] == "close"
    original_actions = deepcopy(actions)
    _, recovery, inputs = read_recovery_inputs(root, HERE, params["request_id"])
    monkeypatch.setattr(rag_replay_flow, target, original)
    monkeypatch.setattr(rag_live, "execute", lambda *a, **k: pytest.fail("Recovery called the model runner"))
    spec = make_spec(read_release(), DATASET, "recovery", {}, "new-model-response", CAPTURE, recovery_config=recovery)
    recovered_id = str(uuid4())
    result = ops_flow.evaluate_saved_capture.fn(**{
        **params, "request_id": recovered_id, "execution_mode": "recovery", "live_config": {},
        "recovery_config": recovery, "execution_spec": spec, "execution_spec_sha256": digest(spec),
    })
    recovered = root / recovered_id
    assert result["status"] == "completed" and len(calls) == 9 and actions == original_actions
    assert (recovered / "capture/capture.json").read_bytes() == inputs["capture"]
    assert (recovered / "reference-capture.json").read_bytes() == inputs["reference_capture"]
    assert (recovered / "recovery-fixture.json").read_bytes() == inputs["fixture"]
    assert {p.relative_to(source): p.read_bytes() for p in source.rglob("*") if p.is_file()} == source_files
    report = json.loads((recovered / "evaluation/comparison.json").read_bytes())["current"]
    assert report["measurementKind"] == "recorded-capture-replay"
    assert report["liveExecutionPerformed"] is False and report["baselineEligible"] is False
    assert not (recovered / "capture/usage-summary.json").exists()


@pytest.mark.parametrize("kind,expected", [("count", 2), ("approval", 2), ("timeout", 3), ("unknown", 3), ("settle", 3)])
def test_partial_failure_preserves_usage_and_stops_remaining_cases(runner, kind, expected):
    root, calls, actions, fault = runner
    fault["kind"] = kind
    params = parameters()
    with pytest.raises(ValueError, match="incomplete"):
        ops_flow.evaluate_saved_capture.fn(**params)
    folder = root / params["request_id"]
    capture = json.loads((folder / "capture/capture.json").read_text())
    usage = json.loads((folder / "capture/usage-summary.json").read_text())
    assert usage["model_api_calls"] == len(calls) == expected and not usage["completed"]
    assert capture["cases"][0]["failure"]["stage"] == "answer"
    assert capture["cases"][1]["failure"]["stage"] == "not_started"
    assert actions[-1][0] == "close" and not (folder / "preflight.json").exists()
    if kind == "unknown":
        assert [fields for action, fields in actions if action == "settle"][-1]["usage"] is None
    if kind == "settle":
        assert (folder / "capture/usage-2.json").exists()
    validate_live_capture(capture, usage, params["execution_spec"], params["execution_spec_sha256"])


def test_cancellation_preserves_transmission_and_closes_worker(runner):
    root, calls, actions, fault = runner
    fault["kind"] = "cancelled"
    params = parameters()
    with pytest.raises(asyncio.CancelledError):
        ops_flow.evaluate_saved_capture.fn(**params)
    usage = json.loads((root / params["request_id"] / "capture/usage-summary.json").read_text())
    assert usage["model_api_calls"] == len(calls) == 1 and not usage["completed"]
    assert actions[-1][0] == "close"
    assert not any(action == "settle" for action, _ in actions)


@pytest.mark.parametrize("change", ["disabled", "spec", "fixture", "plan"])
def test_invalid_approval_is_rejected_before_claim_and_model(runner, monkeypatch, change):
    root, calls, actions, _ = runner
    params = parameters()
    if change == "disabled":
        monkeypatch.setenv("LLMOPS_RAG_LIVE_ENABLED", "false")
    else:
        spec = deepcopy(params["execution_spec"])
        if change == "spec":
            spec["generation"]["prompt_sha256"] = "0" * 64
        elif change == "fixture":
            spec["dataset"]["fixture_sha256"] = "0" * 64
        else:
            spec["model_operations"][0]["input_sha256"] = "0" * 64
        params.update(execution_spec=spec, execution_spec_sha256=digest(spec))
    with pytest.raises(ValueError):
        ops_flow.evaluate_saved_capture.fn(**params)
    assert not calls and not actions
    assert json.loads((root / params["request_id"] / "preflight.json").read_text())["model_api_calls"] == 0


def test_generated_plans_match_current_tokenizer_and_fixtures():
    assert rag_live.catalog_plans() == json.loads(rag_live.PLANS.read_text())


@pytest.mark.parametrize("change", ["count", "sequence", "operation", "spec", "model", "prompt", "completed"])
def test_usage_or_generation_tampering_is_rejected(runner, change):
    root, _, _, _ = runner
    params = parameters()
    ops_flow.evaluate_saved_capture.fn(**params)
    folder = root / params["request_id"] / "capture"
    capture = json.loads((folder / "capture.json").read_text())
    usage = json.loads((folder / "usage-summary.json").read_text())
    if change == "count":
        usage["model_api_calls"] = 0
    elif change == "sequence":
        usage["operations"][1]["sequence"] = 0
    elif change == "operation":
        usage["operations"][0]["operation_id"] = "answer:other"
    elif change == "spec":
        usage["execution_spec_sha256"] = "0" * 64
    elif change == "model":
        capture["execution"]["embeddingModel"] = "unapproved"
    elif change == "prompt":
        capture["execution"]["promptSha256"] = "0" * 64
    else:
        usage["completed"] = False
    with pytest.raises(ValueError):
        validate_live_capture(capture, usage, params["execution_spec"], params["execution_spec_sha256"])


def test_pinned_recorded_reference_can_be_compared_without_regenerating_it(runner):
    root, calls, _, _ = runner
    original = parameters()
    manifest = ops_flow.evaluate_saved_capture.fn(**original)
    reference = {"run_id": original["request_id"], "capture_sha256": manifest["capture_sha256"],
                 "fixture_sha256": manifest["fixture_sha256"], "assessment_id": 1,
                 "assessment_input_sha256": "a" * 64}
    params = parameters()
    spec = make_spec(read_release(), DATASET, "live", params["live_config"], "new-model-response",
                     "run:" + original["request_id"], reference_config=reference)
    params.update(reference_capture_id=spec["reference_capture_id"], reference_config=reference,
                  execution_spec=spec, execution_spec_sha256=digest(spec))
    ops_flow.evaluate_saved_capture.fn(**params)
    value = json.loads((root / params["request_id"] / "evaluation/comparison.json").read_text())
    assert value["reference"]["measurementKind"] == "recorded-capture-replay"
    assert value["reference"]["captureSha256"] == manifest["capture_sha256"]
    assert value["current"]["measurementKind"] == "recorded-live-evaluation" and len(calls) == 18
