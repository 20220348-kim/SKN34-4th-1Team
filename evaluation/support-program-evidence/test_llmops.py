"""모델·Langfuse·Prefect 네트워크 없이 데이터 계약과 실패 전파를 검증한다."""

from copy import deepcopy
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pandas as pd
import pandera.pandas as pa
import pytest
from filelock import FileLock, Timeout

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import llmops
from app.config import LangfuseSettings

FIXTURE = HERE / "target-coverage-fixture.json"
CAPTURE = HERE / "runs/target-coverage-20260907-v1/capture.json"


@pytest.fixture(autouse=True)
def isolate_lock_directory(monkeypatch, tmp_path):
    monkeypatch.setattr(llmops, "ROOT", tmp_path)


def test_replay_preserves_existing_metrics_and_unknown_usage():
    result = llmops.load_results(FIXTURE, CAPTURE)
    original = json.loads(CAPTURE.with_name("report.json").read_text())
    assert result["summary"] == original
    assert result["frame"].shape == (6, 9)
    assert result["frame"].input_tokens.isna().all()
    assert result["summary"]["semanticFaithfulness"] is None
    assert result["run_id"] == llmops.load_results(FIXTURE, CAPTURE)["run_id"]


@pytest.mark.parametrize("mutation", ["duplicate", "out-of-range", "missing-status", "wrong-failure"])
def test_result_schema_rejects_invalid_rows(mutation):
    frame = llmops.load_results(FIXTURE, CAPTURE)["frame"].copy()
    if mutation == "duplicate":
        frame = pd.concat([frame, frame.iloc[:1]])
    elif mutation == "out-of-range":
        frame.loc[0, "citation_recall"] = 1.1
    elif mutation == "missing-status":
        frame.loc[0, "status_match"] = float("nan")
    else:
        frame.loc[0, "failed"] = 1.0
    with pytest.raises(pa.errors.SchemaErrors):
        llmops.RESULT_SCHEMA.validate(frame, lazy=True)


def partial_capture(tmp_path):
    capture = json.loads(CAPTURE.read_text())
    capture["completed"] = False
    capture["cases"] = [capture["cases"][0], {
        "caseId": capture["cases"][1]["caseId"], "requestSha256": capture["cases"][1]["requestSha256"],
        "outcome": "error", "errorType": "SupportProgramEvidenceError",
    }]
    target = tmp_path / "partial.json"
    target.write_text(json.dumps(capture))
    return target


def test_partial_capture_preserves_missing_rows_and_no_overall_quality(tmp_path):
    current = llmops.load_results(FIXTURE, partial_capture(tmp_path))
    assert current["frame"].outcome.tolist() == ["success", "error", "missing", "missing", "missing", "missing"]
    assert current["summary"]["statusAccuracy"] is None
    assert current["frame"].status_match.notna().sum() == 1
    report = llmops.create_report(current, llmops.load_results(FIXTURE, CAPTURE), tmp_path)
    assert "status_match" not in report["reported_columns"]
    assert "citation_recall" not in report["reported_columns"]
    assert report["current"]["completed"] is False


def test_report_detects_known_change_and_preserves_run_ids(tmp_path):
    baseline = llmops.load_results(FIXTURE, CAPTURE)
    capture = json.loads(CAPTURE.read_text())
    capture["cases"][0]["response"].update(answerStatus="INSUFFICIENT_EVIDENCE", citationChunkIds=[])
    candidate = tmp_path / "candidate.json"
    candidate.write_text(json.dumps(capture))
    current = llmops.load_results(FIXTURE, candidate)
    report = llmops.create_report(current, baseline, tmp_path)
    assert report["current"]["statusAccuracy"] == pytest.approx(5 / 6)
    assert report["reference"]["statusAccuracy"] == 1
    assert report["evaluation_run_id"] != report["reference_run_id"]
    assert (tmp_path / "report.html").stat().st_size > 1000
    snapshot = json.loads((tmp_path / "evidently.json").read_text())
    assert "0.8333333333333334" in json.dumps(snapshot)


def test_comparison_rejects_different_cases_before_writing(tmp_path):
    current = llmops.load_results(FIXTURE, CAPTURE)
    other = deepcopy(current)
    other["frame"] = other["frame"].iloc[:1]
    with pytest.raises(ValueError, match="cases differ"):
        llmops.create_report(current, other, tmp_path)
    assert not (tmp_path / "report.html").exists()


def test_score_retry_uses_stable_ids_without_inventing_model_traces(monkeypatch):
    result = llmops.load_results(FIXTURE, CAPTURE)
    settings = LangfuseSettings(enabled=True, base_url="http://localhost:13000", public_key="test", secret_key="test")
    store = {}
    def create(**payload):
        assert "trace_id" not in payload
        assert payload["session_id"] == result["run_id"]
        store[payload["id"]] = SimpleNamespace(id=payload["id"], name=payload["name"], value=payload["value"])
    client = SimpleNamespace(
        scores=SimpleNamespace(create=create),
        scores_v3=SimpleNamespace(get_many_v3=lambda **kwargs: SimpleNamespace(data=list(store.values()))),
    )
    monkeypatch.setattr(llmops, "LangfuseAPI", lambda **kwargs: client)
    first = llmops.publish_scores(result, settings)
    second = llmops.publish_scores(result, settings)
    assert first == second
    assert len(store) == len(first)
    payloads = json.dumps(llmops.score_payloads(result, settings))
    assert result["capture"]["cases"][0]["response"]["answer"] not in payloads


@pytest.mark.parametrize("stage", ["prepare", "render", "publish"])
def test_required_step_failure_is_not_marked_completed(monkeypatch, tmp_path, stage):
    for name in ["prepare", "render", "publish"]:
        monkeypatch.setattr(llmops, name, getattr(llmops, name).fn)
    def fail(*args):
        raise RuntimeError("test failure")
    monkeypatch.setattr(llmops, stage, fail)
    output = tmp_path / "run"
    with pytest.raises(RuntimeError, match="test failure"):
        llmops.evaluate_capture.fn(str(FIXTURE), str(CAPTURE), str(CAPTURE), str(output))
    assert json.loads((output / "manifest.json").read_text())["status"] == "failed"


def test_overlapping_manual_run_is_rejected_before_writes(tmp_path):
    directory = llmops.ROOT / "work/llmops"
    directory.mkdir(parents=True, exist_ok=True)
    with FileLock(str(directory / "evaluation.lock")):
        with pytest.raises(Timeout):
            llmops.evaluate_capture.fn(str(FIXTURE), str(CAPTURE), str(CAPTURE), str(tmp_path / "run"))
    assert not (tmp_path / "run").exists()


@pytest.mark.parametrize("value", [-1, float("inf"), True, "100"])
def test_invalid_recorded_duration_is_rejected(tmp_path, value):
    data = json.loads(CAPTURE.read_text())
    data["cases"][0]["elapsedMs"] = value
    path = tmp_path / "invalid.json"
    path.write_text(json.dumps(data))
    with pytest.raises(ValueError, match="duration"):
        llmops.load_results(FIXTURE, path)
