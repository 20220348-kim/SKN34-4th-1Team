"""전송된 해시 문자열이 아닌 실행 파일 변경을 감지하며 유료 경로는 호출하지 않는다."""

import json
import shutil
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest

import ops_flow
from apps.evaluations.execution_spec import (
    AI, OPS, EVIDENCE, ExecutionSpecMismatch, build_release, digest, make_spec, read_release,
)
from catalog import live_config


@pytest.fixture
def runner(monkeypatch, tmp_path):
    release = read_release()
    root = tmp_path / "image"
    names = {name for group in ("generation", "evaluation", "pipeline")
             for name in release[group]["files"]}
    names.add(OPS + "capture_catalog.json")
    catalog = json.loads((ops_flow.ROOT / OPS / "capture_catalog.json").read_text())
    for dataset in catalog:
        names.add(EVIDENCE + dataset["fixture"])
        names.update(EVIDENCE + capture["path"] for capture in dataset["captures"])
    for name in names:
        destination = root / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ops_flow.ROOT / name, destination)
    monkeypatch.setattr(ops_flow, "ROOT", root)
    monkeypatch.setattr(ops_flow, "__file__", str(root / EVIDENCE / "ops_flow.py"))
    monkeypatch.setattr(ops_flow, "flow_run", SimpleNamespace(id=str(uuid4())))
    monkeypatch.setenv("LLMOPS_RESULTS_DIR", str(tmp_path / "results"))
    monkeypatch.setenv("LLMOPS_LIVE_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "unused-test-key")
    monkeypatch.setattr(ops_flow.evaluate, "execute", lambda *a, **k: pytest.fail("No model calls"))
    return root, tmp_path / "results"


def parameters(mode="live"):
    dataset = ops_flow.DATASET_ID
    config = live_config(dataset) if mode == "live" else {}
    candidate = "new-model-response" if mode == "live" else dataset
    spec = make_spec(read_release(), dataset, mode, config, candidate, dataset)
    return dict(request_id=str(uuid4()), dataset_id=dataset, execution_mode=mode,
                candidate_capture_id=candidate, reference_capture_id=dataset, live_config=config,
                execution_spec=spec, execution_spec_sha256=digest(spec))


def test_checked_in_release_matches_repository():
    assert build_release(ops_flow.ROOT) == read_release()


@pytest.mark.parametrize("name", [
    AI + "app/support_program_evidence/prompt.py",
    AI + "app/support_program_evidence/agent.py",
    AI + "app/support_program_evidence/answer_service.py",
    AI + "app/support_program_llm.py",
    AI + "app/support_program_identity.py",
    AI + "uv.lock",
    EVIDENCE + "llmops.py",
    EVIDENCE + "target-coverage-fixture.json",
    EVIDENCE + "runs/target-coverage-20260907-v1/capture.json",
])
def test_changed_actual_bytes_block_before_model_and_preserve_receipt(runner, name):
    root, results = runner
    params = parameters()
    path = root / name
    path.write_bytes(path.read_bytes() + b"\n")
    with pytest.raises(ExecutionSpecMismatch, match="EXECUTION_SPEC_MISMATCH"):
        ops_flow.evaluate_saved_capture.fn(**params)
    folder = results / params["request_id"]
    assert json.loads((folder / "request.json").read_text())["execution_spec"] == params["execution_spec"]
    assert json.loads((folder / "preflight.json").read_text())["model_api_calls"] == 0
    assert not (folder / "capture").exists()
    with pytest.raises(FileExistsError):
        ops_flow.evaluate_saved_capture.fn(**params)


def test_reordered_cases_block_even_when_all_cases_are_present(runner):
    root, _ = runner
    path = root / OPS / "capture_catalog.json"
    catalog = json.loads(path.read_text())
    catalog[0]["case_ids"].reverse()
    path.write_text(json.dumps(catalog))
    with pytest.raises(ExecutionSpecMismatch):
        ops_flow.evaluate_saved_capture.fn(**parameters())


def test_generation_change_does_not_prevent_free_replay(runner, monkeypatch):
    root, _ = runner
    params = parameters("replay")
    path = root / AI / "app/support_program_evidence/prompt.py"
    path.write_bytes(path.read_bytes() + b"\n# future generation version\n")
    monkeypatch.setenv("LLMOPS_LIVE_MODEL", "future-model")
    calls = []
    monkeypatch.setattr(ops_flow, "evaluate_capture", lambda *a, **k: calls.append(k))
    ops_flow.evaluate_saved_capture.fn(**params)
    assert calls[0]["execution_spec_sha256"] == params["execution_spec_sha256"]


@pytest.mark.parametrize("change", ["missing", "digest", "model", "settings"])
def test_missing_or_altered_spec_never_uses_latest_defaults(runner, change):
    params = parameters()
    if change == "missing":
        params.pop("execution_spec")
        params.pop("execution_spec_sha256")
    elif change == "digest":
        params["execution_spec_sha256"] = "0" * 64
    elif change == "model":
        params["live_config"] = {**params["live_config"], "model": "different-model"}
    else:
        params["execution_spec"]["generation"]["settings"]["run_timeout_seconds"] = 999
        params["execution_spec_sha256"] = digest(params["execution_spec"])
    with pytest.raises(ExecutionSpecMismatch):
        ops_flow.evaluate_saved_capture.fn(**params)


def test_paid_failure_never_writes_zero_call_preflight_receipt(runner, monkeypatch):
    _, results = runner
    params = parameters()

    async def failed(*args, **kwargs):
        raise TimeoutError("unknown transmission outcome")

    monkeypatch.setattr(ops_flow.evaluate, "execute", failed)
    with pytest.raises(TimeoutError):
        ops_flow.evaluate_saved_capture.fn(**params)
    assert not (results / params["request_id"] / "preflight.json").exists()
