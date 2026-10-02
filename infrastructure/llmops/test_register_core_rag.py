"""Core 등록은 격리 파일 트리에서 검사한다. 서버·모델 호출은 하지 않는다."""

import json
import shutil
import sys
from copy import deepcopy
from types import SimpleNamespace
from uuid import uuid4

import pytest
import register_core_rag as registration
from test_core_rag_budget import completed_capture as completed_capture

from apps.evaluations import execution_spec


@pytest.fixture
def repository(tmp_path):
    root = registration.planner.ROOT
    release = execution_spec.build_release(root)
    paths = {
        path
        for group in ("evaluation", "rag_evaluation", "generation", "rag_generation", "pipeline")
        for path in release[group]["files"]
    }
    paths.update(
        (
            execution_spec.OPS + "capture_catalog.json",
            execution_spec.OPS + "rag_live_plans.json",
            execution_spec.OPS + "execution_release.json",
            "infrastructure/llmops/core_rag_budget.py",
            "infrastructure/llmops/core_rag_capture.py",
        )
    )
    from core_rag_capture import CHUNKER

    paths.add(str(CHUNKER.relative_to(root)))
    for item in json.loads((root / execution_spec.OPS / "capture_catalog.json").read_bytes()):
        paths.add(execution_spec.EVIDENCE + item["fixture"])
        paths.update(execution_spec.EVIDENCE + c["path"] for c in item["captures"])
    target = tmp_path / "checkout"
    for name in paths:
        path = target / name
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root / name, path)
    return target


def test_register_preserves_bytes_and_existing_catalog_and_pins_free_replay(
    repository, completed_capture
):
    catalog_path = repository / execution_spec.OPS / "capture_catalog.json"
    before = json.loads(catalog_path.read_bytes())
    receipt_path = registration.register(completed_capture, repository)
    receipt = json.loads(receipt_path.read_bytes())
    catalog = json.loads(catalog_path.read_bytes())
    assert catalog[:-1] == before
    entry = catalog[-1]
    assert entry["id"] == receipt["dataset_id"]
    assert entry["fixture"] == f"runs/{entry['id']}/source/fixture.json"
    assert entry["captures"][0]["path"] == f"runs/{entry['id']}/source/capture.json"
    assert not (repository / execution_spec.OPS / ".core-rag-registration.lock").exists()
    for name in ("fixture", "capture", "wire"):
        assert (receipt_path.parent / "source" / f"{name}.json").read_bytes() == (
            completed_capture / f"{name}.json"
        ).read_bytes()
    release = execution_spec.build_release(repository)
    assert release == json.loads(
        (repository / execution_spec.OPS / "execution_release.json").read_bytes()
    )
    spec = execution_spec.make_spec(release, entry["id"], "replay", {}, entry["id"], entry["id"])
    assert spec["model_operations"] == [] and spec["generation"] is None
    assert spec["quality_policy"]["definition"]["baseline_eligible"] is False
    assert spec["dataset"]["capture_kinds"][entry["id"]] == "integration-stub"
    with pytest.raises(ValueError, match="approved call plan"):
        execution_spec.make_spec(release, entry["id"], "live", {}, entry["id"], entry["id"])
    saved = catalog_path.read_bytes()
    with pytest.raises(ValueError, match="already registered"):
        registration.register(completed_capture, repository)
    assert catalog_path.read_bytes() == saved
    assert receipt_path.is_file()


@pytest.mark.parametrize(
    "failure", ["partial", "stale-release", "changed-evaluator", "changed-input", "write-release"]
)
def test_failed_registration_preserves_catalog_release_and_no_partial_bundle(
    repository, completed_capture, monkeypatch, failure
):
    paths = [
        repository / execution_spec.OPS / name
        for name in ("capture_catalog.json", "execution_release.json")
    ]
    runs = repository / execution_spec.EVIDENCE / "runs"
    original_bundles = {path: path.read_bytes() for path in runs.rglob("*") if path.is_file()}
    if failure == "partial":
        path = completed_capture.parent / "integration.json"
        data = json.loads(path.read_bytes())
        data["status"] = "failed"
        path.write_bytes(registration.encode(data))
    elif failure == "stale-release":
        paths[1].write_bytes(b"{}")
    elif failure == "changed-evaluator":
        model = repository / "backend/ai-service/app/support_program_evidence/models.py"
        with model.open("ab") as target:
            target.write(b"\n# different deployment contract\n")
        paths[1].write_bytes(registration.encode(execution_spec.build_release(repository)))
    elif failure == "changed-input":
        original = registration.planner.build_plan

        def changed(path):
            result = original(path)
            with (path / "capture.json").open("ab") as target:
                target.write(b"\n")
            return result

        monkeypatch.setattr(registration.planner, "build_plan", changed)
    else:
        original = registration.build_release
        count = 0

        def failed(root):
            nonlocal count
            count += 1
            if count == 2:
                raise OSError("injected release failure")
            return original(root)

        monkeypatch.setattr(registration, "build_release", failed)
    before = [p.read_bytes() for p in paths]
    with pytest.raises((ValueError, OSError)):
        registration.register(completed_capture, repository)
    assert [p.read_bytes() for p in paths] == before
    assert {
        path: path.read_bytes() for path in runs.rglob("*") if path.is_file()
    } == original_bundles
    assert not (repository / execution_spec.OPS / ".core-rag-registration.lock").exists()


def test_registration_refuses_concurrent_writer(repository, completed_capture):
    lock = repository / execution_spec.OPS / ".core-rag-registration.lock"
    lock.write_text("other writer")
    with pytest.raises(FileExistsError):
        registration.register(completed_capture, repository)
    assert lock.read_text() == "other writer"


@pytest.mark.parametrize("source_failed", [False, True])
def test_registered_core_capture_uses_existing_ops_flow_and_preserves_failures(
    repository, completed_capture, monkeypatch, tmp_path, source_failed
):
    import core_rag_capture as collector
    import ops_smoke

    sys.path.insert(0, str(registration.planner.ROOT / execution_spec.EVIDENCE))
    import ops_flow
    import rag_replay_flow

    from apps.evaluations import catalog, rag_replay

    if source_failed:
        wire_path = completed_capture / "wire.json"
        wire = json.loads(wire_path.read_bytes())
        saved = wire["cases"][0]
        saved["publicStatus"] = 503
        saved["aiCalls"][2].update(status=503, response={"detail": {"code": "timeout"}})
        wire_path.write_bytes(registration.encode(wire))
        integration_path = completed_capture.parent / "integration.json"
        integration = json.loads(integration_path.read_bytes())
        integration["versions"] = [wire]
        integration_path.write_bytes(registration.encode(integration))
        capture_path = completed_capture / "capture.json"
        capture = json.loads(capture_path.read_bytes())
        fixture = json.loads((completed_capture / "fixture.json").read_bytes())
        doc = fixture["documents"][0]
        capture["cases"][0] = collector.observation(
            saved["id"],
            saved["traceId"],
            doc["content"],
            doc["chunks"],
            saved["aiCalls"],
            saved["publicStatus"],
            saved["publicResponse"],
        )
        capture_path.write_bytes(registration.encode(capture))
    receipt = json.loads(registration.register(completed_capture, repository).read_bytes())
    identifier = receipt["dataset_id"]
    release = execution_spec.build_release(repository)
    datasets = {
        item["id"]: item
        for item in json.loads(
            (repository / execution_spec.OPS / "capture_catalog.json").read_bytes()
        )
    }
    monkeypatch.setattr(catalog, "DATASETS", datasets)
    monkeypatch.setattr(execution_spec, "read_release", lambda: release)
    monkeypatch.setattr(ops_flow, "ROOT", repository)
    monkeypatch.setattr(
        ops_flow, "__file__", str(repository / execution_spec.EVIDENCE / "ops_flow.py")
    )
    monkeypatch.setattr(rag_replay_flow, "ROOT", repository)
    monkeypatch.setenv("LLMOPS_RESULTS_DIR", str(tmp_path / "results"))
    monkeypatch.setattr(ops_flow, "flow_run", SimpleNamespace(id=str(uuid4())))
    monkeypatch.setattr(rag_replay_flow, "flow_run", SimpleNamespace(id=str(uuid4())))
    monkeypatch.setattr(ops_flow, "evaluate_rag_capture", rag_replay_flow.evaluate_rag_capture.fn)
    monkeypatch.setattr(
        ops_flow.evaluate, "execute", lambda *a, **kw: pytest.fail("No model calls")
    )
    monkeypatch.setattr(ops_flow, "BudgetClient", lambda *a: pytest.fail("No paid reservation"))
    monkeypatch.setattr(
        rag_replay_flow.LangfuseSettings,
        "from_environment",
        lambda: SimpleNamespace(environment="test"),
    )
    scores = []
    monkeypatch.setattr(
        rag_replay_flow,
        "publish_payloads",
        lambda payloads, _: scores.extend(payloads) or [p["id"] for p in payloads],
    )
    item = next(item for item in catalog.public_datasets() if item["id"] == identifier)
    assert item["execution_profiles"]["live"] is None and item["live_config"] is None
    spec = execution_spec.make_spec(release, identifier, "replay", {}, identifier, identifier)
    run_id = str(uuid4())
    manifest = ops_flow.evaluate_saved_capture.fn(
        request_id=run_id,
        dataset_id=identifier,
        candidate_capture_id=identifier,
        reference_capture_id=identifier,
        execution_spec=spec,
        execution_spec_sha256=execution_spec.digest(spec),
    )
    output = tmp_path / "results" / run_id / "evaluation"
    _, summary, _, comparison = rag_replay.read_result(
        spec,
        execution_spec.digest(spec),
        manifest,
        (output / "comparison.json").read_bytes(),
        (output / "report.html").read_bytes(),
    )
    assert summary == receipt["report"]
    assert manifest["status"] == "completed" and manifest["model_api_calls"] == 0
    assert summary["completed"] is not source_failed
    assert summary["coverage"]["failedCaseCount"] == int(source_failed)
    assert all("trace_id" in score for score in scores)
    run = {
        "dataset_id": identifier,
        "candidate_capture_id": identifier,
        "reference_capture_id": identifier,
        "execution_mode": "replay",
        "model_api_calls": 0,
        "execution_spec": spec,
        "summary": summary,
        "comparison": comparison,
        "trace_links": [
            {"case_id": c["caseId"], "url": "http://localhost/traces/" + c["traceId"]}
            for c in summary["cases"]
        ],
    }
    assert ops_smoke.verify_core_rag_replay(run, receipt)["coverage"] == summary["coverage"]
    for field, value in (
        ("completed", not summary["completed"]),
        ("baselineEligible", True),
        ("referenceSource", "human-reviewed"),
    ):
        altered = deepcopy(run)
        altered["summary"][field] = value
        with pytest.raises(AssertionError):
            ops_smoke.verify_core_rag_replay(altered, receipt)
    # A valid registration does not authorize altered bytes at execution time.
    capture = repository / execution_spec.EVIDENCE / datasets[identifier]["captures"][0]["path"]
    with capture.open("ab") as target:
        target.write(b"\n")
    rejected_id = str(uuid4())
    previous_scores = deepcopy(scores)
    with pytest.raises(execution_spec.ExecutionSpecMismatch):
        ops_flow.evaluate_saved_capture.fn(
            request_id=rejected_id,
            dataset_id=identifier,
            candidate_capture_id=identifier,
            reference_capture_id=identifier,
            execution_spec=spec,
            execution_spec_sha256=execution_spec.digest(spec),
        )
    rejected = tmp_path / "results" / rejected_id
    assert not (rejected / "evaluation").exists()
    assert json.loads((rejected / "preflight.json").read_bytes())["model_api_calls"] == 0
    assert scores == previous_scores
