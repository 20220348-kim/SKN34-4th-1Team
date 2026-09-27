import json
from hashlib import sha256
from pathlib import Path
import sys
from types import SimpleNamespace
from uuid import uuid4

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ops_flow


def reviewed_source(tmp_path):
    from catalog import DATASETS
    source_id = str(uuid4())
    folder = tmp_path / source_id
    (folder / "evaluation").mkdir(parents=True)
    dataset = DATASETS["fixed-context-e01-v1"]
    candidate = dataset["captures"][1]
    raw = (Path(ops_flow.__file__).parent / candidate["path"]).read_bytes()
    config = {"run_id": source_id, "capture_sha256": sha256(raw).hexdigest(),
              "fixture_sha256": dataset["fixture_sha256"]}
    (folder / "request.json").write_text(json.dumps({
        "request_id": source_id, "dataset_id": dataset["id"],
        "candidate_capture_id": candidate["id"], "reference_capture_id": candidate["id"],
        "execution_mode": "replay",
    }))
    (folder / "evaluation/manifest.json").write_text(json.dumps({
        "status": "completed", "capture_sha256": config["capture_sha256"],
        "fixture_sha256": dataset["fixture_sha256"],
    }))
    return config, candidate["id"], raw


@pytest.mark.parametrize("source_mode", ["replay", "live"])
def test_reviewed_baseline_is_snapshotted_for_free_replay(monkeypatch, tmp_path, source_mode):
    import llmops
    config, candidate, raw = reviewed_source(tmp_path)
    if source_mode == "live":
        folder = tmp_path / config["run_id"]
        (folder / "capture").mkdir()
        (folder / "capture/capture.json").write_bytes(raw)
        marker_path = folder / "request.json"
        marker = json.loads(marker_path.read_text())
        marker.update(execution_mode="live", candidate_capture_id="new-model-response")
        marker_path.write_text(json.dumps(marker))
    request_id = str(uuid4())
    monkeypatch.setenv("LLMOPS_RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(ops_flow, "flow_run", SimpleNamespace(id=str(uuid4())))
    monkeypatch.setattr(ops_flow.evaluate, "execute", lambda *a, **k: pytest.fail("no paid calls"))
    monkeypatch.setattr(ops_flow, "evaluate_capture", llmops.evaluate_capture.fn)
    monkeypatch.setattr(llmops, "prepare", llmops.prepare.fn)
    monkeypatch.setattr(llmops, "render", llmops.render.fn)
    monkeypatch.setattr(llmops, "publish", lambda current: [])
    result = ops_flow.evaluate_saved_capture.fn(request_id, "fixed-context-e01-v1", candidate,
        f"run:{config['run_id']}", reference_config=config)
    assert (tmp_path / request_id / "reference-capture.json").read_bytes() == raw
    assert result["status"] == "completed" and result["model_api_calls"] == 0
    assert result["reference_capture_sha256"] == config["capture_sha256"]
    assert (tmp_path / request_id / "evaluation/report.html").is_file()
    marker = json.loads((tmp_path / request_id / "request.json").read_text())
    assert marker["reference_config"] == config


@pytest.mark.parametrize("failure", ["hash", "dataset", "incomplete", "path", "missing-config"])
def test_invalid_reviewed_baseline_never_spends(monkeypatch, tmp_path, failure):
    from catalog import LIVE_CAPTURE_ID, live_config
    config, _, _ = reviewed_source(tmp_path)
    reference_id = f"run:{config['run_id']}"
    folder = tmp_path / config["run_id"]
    if failure == "hash":
        config["capture_sha256"] = "0" * 64
    elif failure in {"dataset", "path"}:
        marker_path = folder / "request.json"
        marker = json.loads(marker_path.read_text())
        marker["dataset_id" if failure == "dataset" else "candidate_capture_id"] = "../../private"
        marker_path.write_text(json.dumps(marker))
    elif failure == "incomplete":
        path = folder / "evaluation/manifest.json"
        manifest = json.loads(path.read_text())
        manifest["status"] = "failed"
        path.write_text(json.dumps(manifest))
    else:
        config = None
    monkeypatch.setenv("LLMOPS_RESULTS_DIR", str(tmp_path))
    monkeypatch.setenv("LLMOPS_LIVE_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "fake-key")
    monkeypatch.setattr(ops_flow.evaluate, "execute", lambda *a, **k: pytest.fail("no paid calls"))
    request_id = str(uuid4())
    with pytest.raises(ValueError):
        ops_flow.evaluate_saved_capture.fn(request_id, "fixed-context-e01-v1", LIVE_CAPTURE_ID,
            reference_id, "live", live_config("fixed-context-e01-v1"), config)
    assert not (tmp_path / request_id).exists()


def test_registered_entrypoint_uses_saved_inputs_and_correlates_request(monkeypatch, tmp_path):
    request_id, flow_id = str(uuid4()), str(uuid4())
    calls = []
    monkeypatch.setenv("LLMOPS_RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(ops_flow, "flow_run", SimpleNamespace(id=flow_id))
    monkeypatch.setattr(ops_flow, "evaluate_capture", lambda *args, **kwargs: calls.append((args, kwargs)) or {"status": "completed"})
    assert ops_flow.evaluate_saved_capture.fn(request_id, ops_flow.DATASET_ID)["status"] == "completed"
    marker = json.loads((tmp_path / request_id / "request.json").read_text())
    assert marker["prefect_flow_run_id"] == flow_id
    (fixture, capture, reference, output), options = calls[0]
    assert options["case_ids"] == [f"TC0{i}" for i in range(1, 7)]
    assert Path(fixture).is_file() and Path(capture).is_file()
    assert capture == reference
    assert output == str(tmp_path / request_id / "evaluation")
    with pytest.raises(FileExistsError):
        ops_flow.evaluate_saved_capture.fn(request_id, ops_flow.DATASET_ID)
    assert len(calls) == 1


@pytest.mark.parametrize("request_id,dataset", [("../../private", ops_flow.DATASET_ID), (str(uuid4()), "unknown")])
def test_untrusted_paths_are_rejected_before_execution(monkeypatch, tmp_path, request_id, dataset):
    monkeypatch.setenv("LLMOPS_RESULTS_DIR", str(tmp_path))
    with pytest.raises(ValueError):
        ops_flow.evaluate_saved_capture.fn(request_id, dataset)
    assert list(tmp_path.iterdir()) == []


def test_pipeline_failure_propagates_and_keeps_request_marker(monkeypatch, tmp_path):
    request_id = str(uuid4())
    monkeypatch.setenv("LLMOPS_RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(ops_flow, "flow_run", SimpleNamespace(id=str(uuid4())))
    def fail(*args, **kwargs):
        raise ValueError("Invalid capture")
    monkeypatch.setattr(ops_flow, "evaluate_capture", fail)
    with pytest.raises(ValueError, match="Invalid capture"):
        ops_flow.evaluate_saved_capture.fn(request_id, ops_flow.DATASET_ID)
    assert (tmp_path / request_id / "request.json").is_file()


def test_different_captures_share_explicit_cases_and_reject_cross_dataset(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setenv("LLMOPS_RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(ops_flow, "flow_run", SimpleNamespace(id=str(uuid4())))
    monkeypatch.setattr(ops_flow, "evaluate_capture", lambda *args, **kwargs: calls.append((args, kwargs)))
    reference = "fixed-context-20260906-diagnostic-v1"
    candidate = "fixed-context-20260907-index-v1"
    request_id = str(uuid4())
    ops_flow.evaluate_saved_capture.fn(request_id, "fixed-context-e01-v1", candidate, reference)
    args, options = calls[0]
    assert candidate in args[1] and reference in args[2]
    assert options == {"case_ids": ["E01"]}
    marker = json.loads((tmp_path / request_id / "request.json").read_text())
    assert marker["candidate_capture_id"] == candidate and marker["reference_capture_id"] == reference
    for invalid in ["../../private", ops_flow.DATASET_ID]:
        rejected_id = str(uuid4())
        with pytest.raises(ValueError):
            ops_flow.evaluate_saved_capture.fn(rejected_id, "fixed-context-e01-v1", invalid, reference)
        assert not (tmp_path / rejected_id).exists()


def test_live_generates_selected_cases_once_and_checks_baseline_before_spending(monkeypatch, tmp_path):
    from catalog import LIVE_CAPTURE_ID, live_config
    request_id = str(uuid4())
    config = live_config("fixed-context-e01-v1")
    calls = []
    monkeypatch.setenv("LLMOPS_RESULTS_DIR", str(tmp_path))
    monkeypatch.setenv("LLMOPS_LIVE_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "stub-key")
    monkeypatch.setattr(ops_flow, "flow_run", SimpleNamespace(id=str(uuid4())))

    async def execute(prepared, fixture_hash, output, **options):
        assert [case["id"] for case, _ in prepared] == ["E01"]
        assert fixture_hash == config["fixture_sha256"]
        assert options == {"model": config["model"], "max_model_calls": 1}
        calls.append("model")
        output.mkdir()
        (output / "capture.json").write_text('{}')
        return {"completed": True}

    def compare(*args, **kwargs):
        assert args[1] == str(tmp_path / request_id / "capture/capture.json")
        assert "diagnostic" in args[2]
        calls.append("compare")
        return {"status": "completed"}

    monkeypatch.setattr(ops_flow.evaluate, "execute", execute)
    monkeypatch.setattr(ops_flow, "evaluate_capture", compare)
    args = (request_id, "fixed-context-e01-v1", LIVE_CAPTURE_ID,
            "fixed-context-20260906-diagnostic-v1", "live", config)
    assert ops_flow.evaluate_saved_capture.fn(*args)["status"] == "completed"
    with pytest.raises(FileExistsError):
        ops_flow.evaluate_saved_capture.fn(*args)
    assert calls == ["model", "compare"]
    marker = json.loads((tmp_path / request_id / "request.json").read_text())
    assert marker["live_config"] == config and marker["execution_mode"] == "live"


@pytest.mark.parametrize("failure", ["disabled", "missing-key", "budget", "fixture", "baseline", "model"])
def test_live_preflight_rejects_unapproved_or_invalid_inputs_without_calls(monkeypatch, tmp_path, failure):
    from catalog import DATASETS, LIVE_CAPTURE_ID, live_config
    dataset = "fixed-context-e01-v1"
    monkeypatch.setenv("LLMOPS_RESULTS_DIR", str(tmp_path))
    monkeypatch.setenv("LLMOPS_LIVE_ENABLED", "false" if failure == "disabled" else "true")
    monkeypatch.setenv("OPENAI_API_KEY", "" if failure == "missing-key" else "stub-key")
    config = live_config(dataset)
    if failure == "budget":
        config["max_model_calls"] = 2
    elif failure == "model":
        config["model"] = "unapproved-model"
    elif failure == "fixture":
        monkeypatch.setitem(DATASETS[dataset], "fixture_sha256", "0" * 64)
        config = live_config(dataset)
    elif failure == "baseline":
        monkeypatch.setattr(ops_flow, "load_results", lambda *args: {"summary": {"completed": False}})
    monkeypatch.setattr(ops_flow.evaluate, "execute", lambda *args, **kwargs: pytest.fail("must not spend"))
    with pytest.raises(ValueError):
        ops_flow.evaluate_saved_capture.fn(str(uuid4()), dataset, LIVE_CAPTURE_ID,
            "fixed-context-20260906-diagnostic-v1", "live", config)
    assert list(tmp_path.iterdir()) == []


def test_live_failure_preserves_capture_and_never_reexecutes(monkeypatch, tmp_path):
    from catalog import LIVE_CAPTURE_ID, live_config
    monkeypatch.setenv("LLMOPS_RESULTS_DIR", str(tmp_path))
    monkeypatch.setenv("LLMOPS_LIVE_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "stub-key")
    monkeypatch.setattr(ops_flow, "flow_run", SimpleNamespace(id=str(uuid4())))
    monkeypatch.setattr(ops_flow, "evaluate_capture", lambda *args, **kwargs: pytest.fail("incomplete evaluation"))
    calls = []
    async def execute(prepared, fixture_hash, output, **options):
        calls.append(1)
        output.mkdir()
        (output / "capture.json").write_text('{"completed":false,"modelApiCalls":1}')
        return {"completed": False}
    monkeypatch.setattr(ops_flow.evaluate, "execute", execute)
    request_id = str(uuid4())
    args = (request_id, ops_flow.DATASET_ID, LIVE_CAPTURE_ID, ops_flow.DATASET_ID,
            "live", live_config(ops_flow.DATASET_ID))
    with pytest.raises(ValueError, match="partial capture preserved"):
        ops_flow.evaluate_saved_capture.fn(*args)
    with pytest.raises(FileExistsError):
        ops_flow.evaluate_saved_capture.fn(*args)
    assert calls == [1]
    assert json.loads((tmp_path / request_id / "capture/capture.json").read_text())["modelApiCalls"] == 1


def test_live_response_to_report_pipeline_uses_only_stub_transport(monkeypatch, tmp_path):
    import httpx2
    import llmops
    from catalog import LIVE_CAPTURE_ID, live_config

    monkeypatch.setenv("LLMOPS_RESULTS_DIR", str(tmp_path))
    monkeypatch.setenv("LLMOPS_LIVE_ENABLED", "true")
    monkeypatch.setenv("LANGFUSE_ENABLED", "false")
    monkeypatch.setenv("OPENAI_API_KEY", "fake-key-never-sent")
    monkeypatch.setattr(ops_flow, "flow_run", SimpleNamespace(id=str(uuid4())))
    # 실제 Agent/직렬화/사용량 캡처/표 검증/보고서를 연결하되 네트워크 경계만 대체한다.
    requests = []
    def handler(request):
        body = json.loads(request.content)
        assert body["model"] == "gpt-6-luna"
        assert body["max_output_tokens"] == 2000
        requests.append(body)
        return httpx2.Response(200, json={
            "id": "resp_stub", "created_at": 0, "object": "response", "status": "completed",
            "model": "gpt-6-luna", "error": None, "incomplete_details": None,
            "output": [{"id": "msg_stub", "type": "message", "role": "assistant", "status": "completed",
                        "content": [{"type": "output_text", "annotations": [], "text": json.dumps({
                            "answerStatus": "ANSWERED", "answer": "무료 스텁 응답", "citationChunkIndexes": [0],
                        })}]}],
            "parallel_tool_calls": False, "tool_choice": "none", "tools": [],
            "usage": {"input_tokens": 120, "output_tokens": 40, "total_tokens": 160},
        })
    real_client = httpx2.AsyncClient
    class MockClient(real_client):
        def __init__(self, **kwargs):
            super().__init__(transport=httpx2.MockTransport(handler), **kwargs)
    monkeypatch.setattr(httpx2, "AsyncClient", MockClient)
    monkeypatch.setattr(ops_flow, "evaluate_capture", llmops.evaluate_capture.fn)
    monkeypatch.setattr(llmops, "prepare", llmops.prepare.fn)
    monkeypatch.setattr(llmops, "render", llmops.render.fn)
    monkeypatch.setattr(llmops, "publish", lambda current: [])
    request_id = str(uuid4())
    result = ops_flow.evaluate_saved_capture.fn(request_id, "fixed-context-e01-v1", LIVE_CAPTURE_ID,
        "fixed-context-20260906-diagnostic-v1", "live", live_config("fixed-context-e01-v1"))
    assert len(requests) == 1 and result["status"] == "completed"
    capture = json.loads((tmp_path / request_id / "capture/capture.json").read_text())
    assert capture["modelApiCalls"] == 1 and capture["caseIds"] == ["E01"]
    assert capture["cases"][0]["apiResponseIndexes"] == [0]
    comparison = json.loads((tmp_path / request_id / "evaluation/comparison.json").read_text())
    assert comparison["candidate_execution"]["model"] == "gpt-6-luna"
    assert comparison["reference_execution"]["model"] == "gpt-5.6-luna"
    tokens = next(metric for metric in comparison["metrics"] if metric["key"] == "meanInputTokens")
    assert tokens == {"key": "meanInputTokens", "reference": None, "candidate": 120.0, "delta": None}
    assert (tmp_path / request_id / "evaluation/report.html").is_file()
