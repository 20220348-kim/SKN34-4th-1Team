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
    assert report["scope"] == "fixed-answer-context-only"
    assert report["retrieval_evaluated"] is False
    assert report["current"]["statusAccuracy"] == pytest.approx(5 / 6)
    assert report["reference"]["statusAccuracy"] == 1
    assert report["evaluation_run_id"] != report["reference_run_id"]
    metric = next(item for item in report["metrics"] if item["key"] == "statusAccuracy")
    assert metric["delta"] == pytest.approx(-1 / 6)
    assert report["cases"][0]["candidate"]["status_match"] == 0
    assert report["cases"][0]["reference"]["status_match"] == 1
    unmeasured = next(item for item in report["metrics"] if item["key"] == "semanticFaithfulness")
    assert unmeasured["delta"] is unmeasured["candidate"] is unmeasured["reference"] is None
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


@pytest.mark.parametrize("scope", [None, "full-rag", "core-http-mysql-frozen-html-ai-evidence-flow"])
def test_other_capture_scopes_are_not_relabeled_as_fixed_context(tmp_path, scope):
    capture = json.loads(CAPTURE.read_text())
    capture["scope"] = scope
    target = tmp_path / "capture.json"
    target.write_text(json.dumps(capture))
    with pytest.raises(ValueError, match="capture scope"):
        llmops.load_results(FIXTURE, target)


def test_mixed_scopes_never_produce_reports_or_scores(tmp_path):
    fixed = llmops.load_results(FIXTURE, CAPTURE)
    other = deepcopy(fixed)
    other["summary"]["scope"] = "full-rag"
    with pytest.raises(ValueError, match="scopes"):
        llmops.create_report(fixed, other, tmp_path)
    with pytest.raises(ValueError, match="score scope"):
        llmops.score_payloads(other, LangfuseSettings())
    assert not (tmp_path / "report.html").exists()


def test_other_fixture_scope_is_rejected_before_loading_capture(tmp_path):
    fixture = json.loads(FIXTURE.read_text())
    fixture["scope"] = "full-rag"
    target = tmp_path / "fixture.json"
    target.write_text(json.dumps(fixture))
    with pytest.raises(ValueError, match="fixture scope"):
        llmops.load_results(target, tmp_path / "absent-capture.json")


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


def test_existing_prompt_versions_compare_same_case_without_editing_source(tmp_path):
    from hashlib import sha256
    fixture = HERE / "fixture.json"
    old_path = HERE / "runs/fixed-context-20260906-diagnostic-v1/capture.json"
    new_path = HERE / "runs/fixed-context-20260907-index-v1/capture.json"
    before = new_path.read_bytes()
    old = llmops.load_results(fixture, old_path, ["E01"])
    new = llmops.load_results(fixture, new_path, ["E01"])
    report = llmops.create_report(new, old, tmp_path)
    assert report["comparison"] == "candidate-reference"
    assert report["case_ids"] == ["E01"]
    assert report["current"]["caseCount"] == report["reference"]["caseCount"] == 1
    assert report["candidate_execution"]["source_case_ids"] == ["E01", "E07", "E10", "E12"]
    assert report["candidate_execution"]["prompt_sha256"] != report["reference_execution"]["prompt_sha256"]
    tokens = next(item for item in report["metrics"] if item["key"] == "meanOutputTokens")
    # 과거 캡처에는 사례→API 응답 연결이 없어 토큰을 순서로 추정하지 않는다.
    assert tokens == {"key": "meanOutputTokens", "reference": None, "candidate": None, "delta": None}
    latency = next(item for item in report["metrics"] if item["key"] == "meanLatencyMs")
    assert latency["reference"] == 4007.205 and latency["candidate"] == 4124.682
    assert latency["delta"] == pytest.approx(117.477)
    assert new["capture_sha256"] == sha256(before).hexdigest()
    assert new_path.read_bytes() == before
    full = llmops.load_results(fixture, new_path)
    assert full["run_id"] != new["run_id"]
    with pytest.raises(ValueError, match="cases differ"):
        llmops.create_report(full, old, tmp_path)
    with pytest.raises(ValueError, match="absent"):
        llmops.load_results(fixture, old_path, ["E02"])


def test_projection_cannot_hide_failed_or_tampered_source(tmp_path):
    with pytest.raises(ValueError, match="incomplete"):
        llmops.load_results(FIXTURE, partial_capture(tmp_path), ["TC01"])
    capture = json.loads(CAPTURE.read_text())
    capture["cases"][-1]["requestSha256"] = "0" * 64
    path = tmp_path / "tampered.json"
    path.write_text(json.dumps(capture))
    with pytest.raises(ValueError, match="hash"):
        llmops.load_results(FIXTURE, path, ["TC01"])


def test_unknown_usage_is_not_zero_or_a_partial_average(tmp_path):
    data = json.loads(CAPTURE.read_text())
    for index, record in enumerate(data["cases"]):
        record["apiResponseIndexes"] = [index]
    baseline = tmp_path / "mapped-usage.json"
    baseline.write_text(json.dumps(data))
    data["apiResponses"][0]["usage"] = None
    path = tmp_path / "missing-usage.json"
    path.write_text(json.dumps(data))
    result = llmops.load_results(FIXTURE, path)
    report = llmops.create_report(result, llmops.load_results(FIXTURE, baseline), tmp_path)
    metric = next(item for item in report["metrics"] if item["key"] == "meanInputTokens")
    assert metric["reference"] > 0 and metric["candidate"] is None and metric["delta"] is None
    assert "input_tokens" not in report["reported_columns"]
