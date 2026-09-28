"""보고서·전송 실패 복구는 완료된 응답을 재사용하며 모델 호출은 금지한다."""

import json
from hashlib import sha256
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest

import llmops
import ops_flow
from apps.evaluations.recovery_inputs import read_recovery_inputs


@pytest.fixture
def source(monkeypatch, tmp_path):
    here = Path(ops_flow.__file__).parent
    dataset, candidate, _ = ops_flow.selection(ops_flow.DATASET_ID, ops_flow.DATASET_ID, ops_flow.DATASET_ID)
    source_id = str(uuid4())
    folder = tmp_path / source_id
    (folder / "evaluation").mkdir(parents=True)
    marker = {
        "request_id": source_id, "prefect_flow_run_id": str(uuid4()),
        "dataset_id": dataset["id"], "candidate_capture_id": candidate["id"],
        "reference_capture_id": candidate["id"], "execution_mode": "replay", "live_config": {},
    }
    (folder / "request.json").write_text(json.dumps(marker))
    capture_hash = sha256((here / candidate["path"]).read_bytes()).hexdigest()
    manifest = {"evaluator_version": llmops.EVALUATOR_VERSION, "status": "failed", "model_api_calls": 0, "stage": "publish",
                "capture_sha256": capture_hash, "reference_capture_sha256": capture_hash,
                "fixture_sha256": dataset["fixture_sha256"]}
    (folder / "evaluation/manifest.json").write_text(json.dumps(manifest))
    monkeypatch.setenv("LLMOPS_RESULTS_DIR", str(tmp_path))
    monkeypatch.setenv("LLMOPS_LIVE_ENABLED", "false")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setattr(ops_flow.evaluate, "execute", lambda *a, **k: pytest.fail("Model execution is forbidden"))
    monkeypatch.setattr(ops_flow, "flow_run", SimpleNamespace(id=str(uuid4())))
    monkeypatch.setattr(ops_flow, "evaluate_capture", llmops.evaluate_capture.fn)
    monkeypatch.setattr(llmops, "prepare", llmops.prepare.fn)
    monkeypatch.setattr(llmops, "render", llmops.render.fn)
    monkeypatch.setattr(llmops, "publish", lambda current: [])
    _, config, _ = read_recovery_inputs(tmp_path, here, source_id)
    return source_id, config


def recover(config, request_id=None):
    return ops_flow.evaluate_saved_capture.fn(
        request_id or str(uuid4()), ops_flow.DATASET_ID, execution_mode="recovery", recovery_config=config,
    )


@pytest.mark.parametrize("failure_stage", ["report", "publish"])
def test_recovery_after_failure_preserves_source_and_never_calls_model(source, monkeypatch, tmp_path, failure_stage):
    source_id, config = source
    source_manifest = (tmp_path / source_id / "evaluation/manifest.json").read_bytes()
    attempt_id = str(uuid4())
    seen = set()

    def fail(*args, **kwargs):
        if failure_stage == "publish":
            seen.add(args[0]["run_id"])  # 서버 저장 뒤 응답이 유실된 상황.
        raise RuntimeError("postprocessing interrupted")

    original_render = llmops.render
    monkeypatch.setattr(llmops, "render" if failure_stage == "report" else "publish", fail)
    with pytest.raises(RuntimeError, match="interrupted"):
        recover(config, attempt_id)
    manifest_path = tmp_path / attempt_id / "evaluation/manifest.json"
    manifest = json.loads(manifest_path.read_text())
    assert manifest["status"] == "failed" and manifest["stage"] == failure_stage
    assert manifest["model_api_calls"] == 0
    # 프로세스 재시작으로 running manifest만 남아도 입력 해시는 이미 저장되어 있다.
    manifest["status"] = "running"
    manifest_path.write_text(json.dumps(manifest))
    _, next_config, _ = read_recovery_inputs(tmp_path, Path(ops_flow.__file__).parent, attempt_id)
    monkeypatch.setattr(llmops, "render", original_render)
    monkeypatch.setattr(llmops, "publish", lambda current: seen.add(current["run_id"]) or [])
    retry_id = str(uuid4())
    result = recover(next_config, retry_id)
    assert result["status"] == "completed" and result["model_api_calls"] == 0
    assert len(seen) == 1
    assert (tmp_path / source_id / "evaluation/manifest.json").read_bytes() == source_manifest
    assert (tmp_path / retry_id / "evaluation/report.html").is_file()
    assert json.loads((tmp_path / retry_id / "request.json").read_text())["recovery_config"] == next_config
    with pytest.raises(FileExistsError):
        recover(next_config, retry_id)


@pytest.mark.parametrize("key", ["capture_sha256", "reference_capture_sha256", "fixture_sha256", "source_request_sha256"])
def test_changed_dispatch_hashes_preserve_rejection_without_evaluation(source, tmp_path, key):
    _, config = source
    request_id = str(uuid4())
    with pytest.raises(ValueError, match="EXECUTION_SPEC_MISMATCH"):
        recover({**config, key: "0" * 64}, request_id)
    assert (tmp_path / request_id / "preflight.json").is_file()
    assert not (tmp_path / request_id / "evaluation").exists()


def test_missing_baseline_does_not_fall_back_or_generate(source, tmp_path):
    source_id, config = source
    marker_path = tmp_path / source_id / "request.json"
    marker = json.loads(marker_path.read_text())
    reference_id = str(uuid4())
    marker.update(reference_capture_id=f"run:{reference_id}", reference_config={
        "run_id": reference_id, "capture_sha256": config["reference_capture_sha256"],
        "fixture_sha256": config["fixture_sha256"],
    })
    marker_path.write_text(json.dumps(marker))
    with pytest.raises(ValueError, match="EXECUTION_SPEC_MISMATCH"):
        recover(config)


def test_source_request_symlink_outside_directory_is_rejected(source, tmp_path):
    source_id, config = source
    path = tmp_path / source_id / "request.json"
    outside = tmp_path / "request-copy.json"
    path.rename(outside)
    path.symlink_to(outside)
    with pytest.raises(ValueError, match="EXECUTION_SPEC_MISMATCH"):
        recover(config)


def test_recovery_cannot_accept_live_parameters(source):
    _, config = source
    with pytest.raises(ValueError, match="EXECUTION_SPEC_MISMATCH"):
        ops_flow.evaluate_saved_capture.fn(str(uuid4()), ops_flow.DATASET_ID, execution_mode="recovery",
                                           live_config={"model": "anything"}, recovery_config=config)


def test_completed_live_capture_recovers_with_live_disabled_and_changed_default_model(source, monkeypatch, tmp_path):
    from catalog import live_config
    source_id, _ = source
    folder = tmp_path / source_id
    here = Path(ops_flow.__file__).parent
    _, _, inputs = read_recovery_inputs(tmp_path, here, source_id)
    approved = live_config(ops_flow.DATASET_ID)
    capture = json.loads(inputs["capture"])
    capture.update(model=approved["model"], modelApiCalls=6, maxModelCalls=6, maxOutputTokens=2000,
                   caseIds=[f"TC0{i}" for i in range(1, 7)])
    raw = json.dumps(capture).encode()
    (folder / "capture").mkdir()
    (folder / "capture/capture.json").write_bytes(raw)
    marker = json.loads((folder / "request.json").read_text())
    marker.update(execution_mode="live", candidate_capture_id="new-model-response", live_config=approved)
    (folder / "request.json").write_text(json.dumps(marker))
    manifest = json.loads((folder / "evaluation/manifest.json").read_text())
    manifest["capture_sha256"] = sha256(raw).hexdigest()
    (folder / "evaluation/manifest.json").write_text(json.dumps(manifest))
    _, config, _ = read_recovery_inputs(tmp_path, here, source_id)
    monkeypatch.setenv("LLMOPS_LIVE_MODEL", "different-default")
    recovery_id = str(uuid4())
    result = ops_flow.evaluate_saved_capture.fn(
        recovery_id, ops_flow.DATASET_ID, "new-model-response", ops_flow.DATASET_ID,
        execution_mode="recovery", recovery_config=config,
    )
    assert result["status"] == "completed" and result["model_api_calls"] == 0
    assert (tmp_path / recovery_id / "capture/capture.json").read_bytes() == raw
    assert json.loads(raw)["modelApiCalls"] == 6  # 원본의 과거 호출 횟수는 변경하지 않는다.


def test_reviewed_baseline_uses_source_snapshot_even_after_baseline_changes(source, tmp_path):
    source_id, config = source
    folder = tmp_path / source_id
    here = Path(ops_flow.__file__).parent
    _, _, inputs = read_recovery_inputs(tmp_path, here, source_id)
    baseline_id = str(uuid4())
    reference_id = f"run:{baseline_id}"
    reference_config = {"run_id": baseline_id, "fixture_sha256": config["fixture_sha256"],
                        "capture_sha256": config["reference_capture_sha256"]}
    marker = json.loads((folder / "request.json").read_text())
    marker.update(reference_capture_id=reference_id, reference_config=reference_config)
    (folder / "request.json").write_text(json.dumps(marker))
    (folder / "reference-capture.json").write_bytes(inputs["reference_capture"])
    _, config, _ = read_recovery_inputs(tmp_path, here, source_id)
    result = ops_flow.evaluate_saved_capture.fn(str(uuid4()), ops_flow.DATASET_ID,
        reference_capture_id=reference_id, reference_config=reference_config,
        execution_mode="recovery", recovery_config=config)
    assert result["status"] == "completed"
    assert result["reference_capture_sha256"] == reference_config["capture_sha256"]
    assert not (tmp_path / baseline_id).exists()


@pytest.mark.parametrize('version', [None, '0' * 64])
def test_unknown_or_different_evaluator_blocks_recovery(source, tmp_path, version):
    source_id, config = source
    path = tmp_path / source_id / 'evaluation/manifest.json'
    manifest = json.loads(path.read_text())
    manifest['evaluator_version'] = version
    path.write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match='EXECUTION_SPEC_MISMATCH'):
        recover(config)
