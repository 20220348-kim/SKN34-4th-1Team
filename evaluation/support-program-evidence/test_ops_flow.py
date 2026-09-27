import json
from pathlib import Path
import sys
from types import SimpleNamespace
from uuid import uuid4

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ops_flow


def test_registered_entrypoint_uses_saved_inputs_and_correlates_request(monkeypatch, tmp_path):
    request_id, flow_id = str(uuid4()), str(uuid4())
    calls = []
    monkeypatch.setenv("LLMOPS_RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(ops_flow, "flow_run", SimpleNamespace(id=flow_id))
    monkeypatch.setattr(ops_flow, "evaluate_capture", lambda *args: calls.append(args) or {"status": "completed"})
    assert ops_flow.evaluate_saved_capture.fn(request_id, ops_flow.DATASET_ID)["status"] == "completed"
    marker = json.loads((tmp_path / request_id / "request.json").read_text())
    assert marker["prefect_flow_run_id"] == flow_id
    fixture, capture, reference, output = calls[0]
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
    def fail(*args):
        raise ValueError("Invalid capture")
    monkeypatch.setattr(ops_flow, "evaluate_capture", fail)
    with pytest.raises(ValueError, match="Invalid capture"):
        ops_flow.evaluate_saved_capture.fn(request_id, ops_flow.DATASET_ID)
    assert (tmp_path / request_id / "request.json").is_file()
