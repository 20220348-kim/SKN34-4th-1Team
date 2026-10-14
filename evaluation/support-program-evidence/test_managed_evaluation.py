"""관리자 자료의 무료 실행·출처·고정 입력 검증. 외부 모델과 등록 API는 호출하지 않는다."""

from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest

import evaluate
import llmops
import ops_flow
from app.config import LangfuseSettings
from apps.evaluations.catalog import DATASETS, get_dataset, managed_snapshot_context
from apps.evaluations.execution_spec import build_release, digest, make_spec, read_release, verify_spec
from apps.evaluations.managed_materials import build_snapshot, encoded, materialize, release_dataset


@pytest.fixture
def snapshot():
    return build_snapshot({
        "title": "관리자 작성 사업 평가", "description": "제공 근거의 지원 조건 확인",
        "documents": [{"id": "sample", "title": "예시 사업", "source_url": "https://example.com/notice",
                       "chunks": ["서울의 중소 제조기업을 지원합니다."]}],
        "cases": [{"id": "Q01", "document_id": "sample", "question": "지원 대상은 누구인가요?",
                   "expected_status": "ANSWERED", "expected_citation_orders": [0],
                   "reference_facts": ["서울 중소 제조기업"], "forbidden_claims": ["전국 모든 기업"],
                   "answer": {"text": "서울에 있는 중소 제조기업입니다.", "status": "ANSWERED", "citation_orders": [0]}}],
    }, f"managed-{uuid4().hex}-v1")


def specification(snapshot, mode="replay"):
    release = build_release(ops_flow.ROOT)
    dataset_id = snapshot["catalog"]["id"]
    release["datasets"][dataset_id] = release_dataset(snapshot)
    config = {}
    candidate = "manual"
    if mode == "live":
        from apps.evaluations.catalog import live_config
        with managed_snapshot_context(snapshot):
            config = live_config(dataset_id)
        candidate = "new-model-response"
    return make_spec(release, dataset_id, mode, config, candidate, "manual")


def loaded(snapshot, tmp_path):
    root = materialize(snapshot, tmp_path)
    fixture = root / snapshot["catalog"]["fixture"]
    capture = root / snapshot["catalog"]["captures"][0]["path"]
    return fixture, capture


def test_manual_answers_keep_honest_provenance_and_unknown_model_metrics(snapshot, tmp_path):
    fixture, capture = loaded(snapshot, tmp_path)
    result = llmops.load_results(fixture, capture)
    assert result["summary"]["referenceSource"] == "admin-authored"
    assert result["summary"]["dataType"] == "admin-provided"
    assert result["summary"]["measurementKind"] == "admin-entered-answer"
    assert result["summary"]["modelMeasured"] is False
    assert result["summary"]["statusAccuracy"] == 1
    assert result["frame"][["elapsed_ms", "input_tokens", "output_tokens"]].isna().all().all()
    payloads = llmops.score_payloads(result, LangfuseSettings())
    assert payloads
    assert all(item["metadata"]["record_kind"] == "admin-entered-answer" for item in payloads)
    assert all(item["metadata"]["reference_source"] == "admin-authored" for item in payloads)
    assert all("trace_id" not in item for item in payloads)


@pytest.mark.parametrize("mutation", [
    lambda c: c.update(model="gpt-6-luna"),
    lambda c: c.update(modelApiCalls=1),
    lambda c: c.update(promptSha256="a" * 64),
    lambda c: c.update(startedAt="2026-10-15T00:00:00Z"),
    lambda c: c.update(modelTimeoutSeconds=25),
    lambda c: c["cases"][0].update(elapsedMs=1),
    lambda c: c["cases"][0].update(traceId="a" * 32),
])
def test_manual_answers_cannot_claim_model_measurements(snapshot, tmp_path, mutation):
    fixture, _ = loaded(snapshot, tmp_path)
    capture = deepcopy(snapshot["capture"])
    mutation(capture)
    with pytest.raises(ValueError):
        evaluate.report(*evaluate.load_fixture(fixture), capture)


@pytest.mark.parametrize("change", ["fixture", "path", "candidate", "identity", "code"])
def test_managed_spec_rejects_changed_inputs_or_runner_code(snapshot, change):
    spec = specification(snapshot)
    actual = build_release(ops_flow.ROOT)
    if change == "fixture":
        spec["dataset"]["managed_snapshot"]["fixture"]["cases"][0]["question"] = "바뀐 질문"
    elif change == "path":
        spec["dataset"]["managed_snapshot"]["catalog"]["fixture"] = "../../private"
    elif change == "candidate":
        spec["candidate_sha256"] = "a" * 64
    elif change == "identity":
        spec["dataset_id"] = f"managed-{uuid4().hex}-v1"
    else:
        actual["pipeline"]["sha256"] = "b" * 64
    with pytest.raises(ValueError):
        verify_spec(spec, digest(spec), actual, dataset_id=spec["dataset_id"], mode="replay",
                    config={}, candidate_id="manual", reference_id="manual")


def test_managed_replay_generates_report_without_database_or_model(snapshot, tmp_path, monkeypatch):
    spec = specification(snapshot)
    request_id = str(uuid4())
    monkeypatch.setenv("LLMOPS_RESULTS_DIR", str(tmp_path))
    monkeypatch.setenv("LLMOPS_LIVE_ENABLED", "false")
    monkeypatch.setattr(ops_flow, "flow_run", SimpleNamespace(id=str(uuid4())))
    monkeypatch.setattr(ops_flow.evaluate, "execute", lambda *a, **k: pytest.fail("No model calls"))
    monkeypatch.setattr(ops_flow, "BudgetClient", lambda *a, **k: pytest.fail("No paid reservation"))
    monkeypatch.setattr(ops_flow, "evaluate_capture", llmops.evaluate_capture.fn)
    monkeypatch.setattr(llmops, "prepare", llmops.prepare.fn)
    monkeypatch.setattr(llmops, "render", llmops.render.fn)
    monkeypatch.setattr(llmops, "publish", lambda current: [])
    result = ops_flow.evaluate_saved_capture.fn(
        request_id, snapshot["catalog"]["id"], "manual", "manual",
        execution_spec=spec, execution_spec_sha256=digest(spec),
    )
    folder = tmp_path / request_id
    assert result["status"] == "completed" and result["model_api_calls"] == 0
    assert (folder / "evaluation/report.html").is_file()
    comparison = json.loads((folder / "evaluation/comparison.json").read_bytes())
    assert comparison["candidate_execution"]["measurement_kind"] == "admin-entered-answer"
    assert comparison["candidate_execution"]["prompt_sha256"] is None
    assert (folder / "inputs" / snapshot["catalog"]["fixture"]).read_bytes() == encoded(snapshot["fixture"])
    assert comparison["candidate_execution"]["capture_sha256"] == sha256(encoded(snapshot["capture"])).hexdigest()
    with pytest.raises(FileExistsError):
        ops_flow.evaluate_saved_capture.fn(request_id, snapshot["catalog"]["id"], "manual", "manual",
                                          execution_spec=spec, execution_spec_sha256=digest(spec))


def test_managed_live_remains_disabled_and_preserves_no_call_receipt(snapshot, tmp_path, monkeypatch):
    spec = specification(snapshot, "live")
    request_id = str(uuid4())
    monkeypatch.setenv("LLMOPS_RESULTS_DIR", str(tmp_path))
    monkeypatch.setenv("LLMOPS_LIVE_ENABLED", "false")
    monkeypatch.setattr(ops_flow, "flow_run", SimpleNamespace(id=str(uuid4())))
    monkeypatch.setattr(ops_flow.evaluate, "execute", lambda *a, **k: pytest.fail("No model calls"))
    monkeypatch.setattr(ops_flow, "BudgetClient", lambda *a, **k: pytest.fail("No paid reservation"))
    with pytest.raises(ValueError):
        ops_flow.evaluate_saved_capture.fn(
            request_id, snapshot["catalog"]["id"], "new-model-response", "manual", "live", spec["live_config"],
            execution_spec=spec, execution_spec_sha256=digest(spec),
        )
    assert json.loads((tmp_path / request_id / "preflight.json").read_bytes())["model_api_calls"] == 0


@pytest.mark.parametrize("missing", ["specification", "snapshot"])
def test_managed_replay_requires_snapshot_before_catalog_or_database_access(snapshot, tmp_path, monkeypatch, missing):
    spec = specification(snapshot)
    if missing == "snapshot":
        spec["dataset"].pop("managed_snapshot")
    else:
        spec = None
    request_id = str(uuid4())
    monkeypatch.setenv("LLMOPS_RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(ops_flow, "flow_run", SimpleNamespace(id=str(uuid4())))
    monkeypatch.setattr(ops_flow, "evaluation_scope", lambda *a: pytest.fail("No catalog or database access"))
    monkeypatch.setattr(ops_flow, "build_release", lambda *a: pytest.fail("Missing inputs must fail before release lookup"))
    monkeypatch.setattr(ops_flow.evaluate, "execute", lambda *a, **k: pytest.fail("No model calls"))
    monkeypatch.setattr(ops_flow, "BudgetClient", lambda *a, **k: pytest.fail("No paid reservation"))
    with pytest.raises(ValueError, match="EXECUTION_SPEC_MISMATCH"):
        ops_flow.evaluate_saved_capture.fn(request_id, snapshot["catalog"]["id"], "manual", "manual",
            execution_spec=spec, execution_spec_sha256=digest(spec) if spec else None)
    receipt = json.loads((tmp_path / request_id / "preflight.json").read_bytes())
    assert receipt["phase"] == "before_model_call" and receipt["model_api_calls"] == 0


def test_managed_release_overlay_does_not_modify_static_catalog(snapshot):
    identifier = snapshot["catalog"]["id"]
    before = read_release()
    with managed_snapshot_context(snapshot):
        assert get_dataset(identifier) == snapshot["catalog"]
        release = read_release(identifier)
        assert release["datasets"][identifier] == release_dataset(snapshot)
        assert identifier not in DATASETS
        assert read_release() == before
        with pytest.raises(KeyError):
            get_dataset(f"managed-{uuid4().hex}-v1")
    assert read_release() == before


def test_database_json_key_order_preserves_hashes_and_request_contract(snapshot, tmp_path):
    # MySQL JSON 저장·조회는 객체 키 순서를 보존하지 않아도 입력 파일 해시는 같아야 한다.
    reordered = json.loads(json.dumps(snapshot, ensure_ascii=False, sort_keys=True))
    assert list(reordered["fixture"]) != list(snapshot["fixture"])
    assert release_dataset(reordered) == release_dataset(snapshot)
    fixture, capture = loaded(reordered, tmp_path)
    result = llmops.load_results(fixture, capture)
    assert result["summary"]["completed"] is True
    assert result["capture_sha256"] == sha256(encoded(snapshot["capture"])).hexdigest()


def test_managed_replay_can_reuse_reviewed_source_and_recover_report(snapshot, tmp_path, monkeypatch):
    from apps.evaluations import recovery_inputs

    release = build_release(ops_flow.ROOT)
    dataset_id = snapshot["catalog"]["id"]
    release["datasets"][dataset_id] = release_dataset(snapshot)
    monkeypatch.setattr(recovery_inputs, "read_release", lambda *args: release)
    monkeypatch.setenv("LLMOPS_RESULTS_DIR", str(tmp_path))
    monkeypatch.setenv("LLMOPS_LIVE_ENABLED", "false")
    monkeypatch.setattr(ops_flow, "flow_run", SimpleNamespace(id=str(uuid4())))
    monkeypatch.setattr(ops_flow.evaluate, "execute", lambda *a, **k: pytest.fail("No model calls"))
    monkeypatch.setattr(ops_flow, "BudgetClient", lambda *a, **k: pytest.fail("No paid reservation"))
    monkeypatch.setattr(ops_flow, "evaluate_capture", llmops.evaluate_capture.fn)
    monkeypatch.setattr(llmops, "prepare", llmops.prepare.fn)
    monkeypatch.setattr(llmops, "render", llmops.render.fn)
    monkeypatch.setattr(llmops, "publish", lambda current: [])
    source_id = str(uuid4())
    source_spec = make_spec(release, dataset_id, "replay", {}, "manual", "manual")
    ops_flow.evaluate_saved_capture.fn(source_id, dataset_id, "manual", "manual",
        execution_spec=source_spec, execution_spec_sha256=digest(source_spec))

    # 검토된 동일 버전의 기존 수동 답변을 기준으로 고정할 때 원본 바이트를 보존한다.
    reference_config = {"run_id": source_id,
        "fixture_sha256": release["datasets"][dataset_id]["fixture_sha256"],
        "capture_sha256": release["datasets"][dataset_id]["captures"]["manual"]}
    reference_id = f"run:{source_id}"
    spec = make_spec(release, dataset_id, "replay", {}, "manual", reference_id, reference_config)
    request_id = str(uuid4())
    ops_flow.evaluate_saved_capture.fn(request_id, dataset_id, "manual", reference_id,
        reference_config=reference_config, execution_spec=spec, execution_spec_sha256=digest(spec))
    assert (tmp_path / request_id / "reference-capture.json").read_bytes() == encoded(snapshot["capture"])

    # 후처리 재계산은 이미 완료된 응답 바이트를 복사하고 모델 경로를 거치지 않는다.
    with managed_snapshot_context(snapshot):
        _, recovery_config, _ = recovery_inputs.read_recovery_inputs(
            tmp_path, tmp_path / source_id / "inputs", source_id)
    recovery_spec = make_spec(release, dataset_id, "recovery", {}, "manual", "manual",
                             recovery_config=recovery_config)
    recovery_id = str(uuid4())
    result = ops_flow.evaluate_saved_capture.fn(recovery_id, dataset_id, "manual", "manual", "recovery",
        recovery_config=recovery_config, execution_spec=recovery_spec, execution_spec_sha256=digest(recovery_spec))
    assert result["status"] == "completed" and result["model_api_calls"] == 0
    assert (tmp_path / recovery_id / "capture/capture.json").read_bytes() == encoded(snapshot["capture"])
    assert (tmp_path / recovery_id / "recovery-fixture.json").read_bytes() == encoded(snapshot["fixture"])
