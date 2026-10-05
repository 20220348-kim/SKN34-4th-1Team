"""Core 저장 기록 → RAG 계약 → Ops 재평가를 외부 모델 호출 없이 검증한다."""

import json
import shutil
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import core_flow_rag as importer
import pytest
from apps.evaluations import execution_spec

RUN = Path(__file__).parent / "runs/official-flow-20260907-v2"


@pytest.fixture
def records():
    return (
        (RUN / "core/capture.json").read_bytes(),
        (RUN / "api/api-capture.json").read_bytes(),
    )


@pytest.fixture
def repository(tmp_path):
    root = importer.ROOT
    release = execution_spec.build_release(root)
    paths = {
        path
        for group in (
            "evaluation",
            "rag_evaluation",
            "generation",
            "rag_generation",
            "pipeline",
        )
        for path in release[group]["files"]
    }
    paths.update(
        execution_spec.OPS + name
        for name in (
            "capture_catalog.json",
            "execution_release.json",
            "rag_live_plans.json",
        )
    )
    for entry in json.loads(
        (root / execution_spec.OPS / "capture_catalog.json").read_bytes()
    ):
        paths.add(execution_spec.EVIDENCE + entry["fixture"])
        paths.update(
            execution_spec.EVIDENCE + item["path"] for item in entry["captures"]
        )
    target = tmp_path / "checkout"
    for name in paths:
        path = target / name
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root / name, path)
    catalog_path = target / execution_spec.OPS / "capture_catalog.json"
    catalog_path.write_bytes(
        importer.encode(
            [
                item
                for item in json.loads(catalog_path.read_bytes())
                if not item["id"].startswith("core-official-")
            ]
        )
    )
    for existing in (target / importer.EVIDENCE / "runs").glob("core-official-*"):
        shutil.rmtree(existing)
    (target / execution_spec.OPS / "execution_release.json").write_bytes(
        importer.encode(execution_spec.build_release(target))
    )
    return target


def test_preserves_actual_core_search_answers_and_historical_usage(records):
    fixture, capture, provenance = importer.convert(*records)
    original = json.loads(records[0])
    assert len(fixture["documents"]) == 2
    assert all(len(doc["chunks"]) == 1 for doc in fixture["documents"])
    for current, saved in zip(capture["cases"], original["cases"], strict=True):
        assert current["search"] == {
            key: saved["aiCalls"][1][key] for key in ("request", "response")
        }
        assert current["answer"] == {
            key: saved["aiCalls"][2][key] for key in ("request", "response")
        }
        assert current["traceId"] is None
    assert provenance["coreHttpExecuted"] and provenance["importModelApiCalls"] == 0
    assert provenance["recordedApiCalls"] == 14
    assert provenance["recordedTokens"]["answers"]["input_tokens"] == 7446
    assert provenance["recordedStartedAt"] == original["startedAt"]
    assert provenance["rankingSelectionCaseCount"] == 0
    assert not provenance["humanReviewInherited"]
    assert capture["execution"]["model"] == "gpt-5.6-luna"


def test_http_fixture_cannot_claim_a_model_or_usage(records):
    core = json.loads(records[0])
    core["aiTransport"] = "http-fixture"
    references = [
        case for document in core["fixture"]["documents"] for case in document["cases"]
    ]
    for observed, case in zip(core["cases"], references, strict=True):
        observed["publicResponse"]["answer"] = case["stubAnswer"]
        observed["aiCalls"][2]["response"]["answer"] = case["stubAnswer"]
    raw = importer.encode(core)
    _, capture, provenance = importer.convert(raw)
    assert capture["execution"] == {
        "kind": "synthetic",
        "model": None,
        "embeddingModel": None,
        "promptSha256": None,
        "recorderSha256": None,
    }
    assert provenance["recordedApiCalls"] == 0 and provenance["recordedTokens"] is None
    with pytest.raises(ValueError, match="transport"):
        importer.convert(raw, records[1])
    with pytest.raises(ValueError, match="transport"):
        importer.convert(records[0])


@pytest.mark.parametrize(
    "change",
    [
        lambda c: c.update(completed=False),
        lambda c: c["cases"].pop(),
        lambda c: c["cases"][0].update(publicStatus=503),
        lambda c: c["cases"][0]["publicRequest"].update(question="다른 질문"),
        lambda c: c["cases"][0]["publicResponse"]["citations"][0].update(
            excerpt="다른 근거"
        ),
        lambda c: c["cases"][0]["aiCalls"][1]["response"]["matches"][0].update(
            documentId="OTHER:X"
        ),
        lambda c: c["cases"][0]["aiCalls"][2]["request"]["chunks"][0].update(
            text="검색하지 않은 근거"
        ),
        lambda c: c["cases"][0]["sourceDocument"].update(contentHash="0" * 64),
    ],
)
def test_partial_or_tampered_capture_is_rejected_without_output(records, change):
    core = json.loads(records[0])
    change(core)
    with pytest.raises(ValueError):
        importer.convert(importer.encode(core), records[1])


def test_unknown_usage_stays_unknown(records):
    api = json.loads(records[1])
    api["calls"][2]["response"]["usage"] = None
    _, _, provenance = importer.convert(records[0], importer.encode(api))
    assert provenance["recordedTokens"]["combinedTotal"] is None


def test_registration_preserves_sources_and_is_idempotent_replay_only(repository):
    receipt = importer.register(
        RUN / "core/capture.json", RUN / "api/api-capture.json", repository=repository
    )
    before = (repository / importer.OPS / "capture_catalog.json").read_bytes()
    entry = json.loads(before)[-1]
    assert entry["replay_only"]
    assert (receipt.parent / "core-capture.json").read_bytes() == (
        RUN / "core/capture.json"
    ).read_bytes()
    release = execution_spec.build_release(repository)
    assert "live_plan" not in release["datasets"][entry["id"]]
    capture_id = entry["captures"][0]["id"]
    with pytest.raises(ValueError, match="approved call plan"):
        execution_spec.make_spec(
            release, entry["id"], "live", {}, capture_id, capture_id
        )
    assert (
        importer.register(
            RUN / "core/capture.json",
            RUN / "api/api-capture.json",
            repository=repository,
        )
        == receipt
    )
    assert (repository / importer.OPS / "capture_catalog.json").read_bytes() == before
    (receipt.parent / "core-capture.json").write_text("{}")
    with pytest.raises(ValueError, match="Registered source"):
        importer.register(
            RUN / "core/capture.json",
            RUN / "api/api-capture.json",
            repository=repository,
        )


def test_failed_registration_rolls_back_catalog_and_new_files(repository, monkeypatch):
    catalog = repository / importer.OPS / "capture_catalog.json"
    release = repository / importer.OPS / "execution_release.json"
    before = (catalog.read_bytes(), release.read_bytes())
    original = execution_spec.build_release
    count = 0

    def fail_second(root):
        nonlocal count
        count += 1
        if count == 2:
            raise RuntimeError("release failure")
        return original(root)

    monkeypatch.setattr(execution_spec, "build_release", fail_second)
    with pytest.raises(RuntimeError, match="release failure"):
        importer.register(
            RUN / "core/capture.json",
            RUN / "api/api-capture.json",
            repository=repository,
        )
    assert (catalog.read_bytes(), release.read_bytes()) == before
    assert not list((repository / importer.EVIDENCE / "runs").glob("core-official-*"))
    assert not (repository / importer.OPS / ".core-rag-registration.lock").exists()


def test_imported_capture_reaches_ops_pandera_evidently_and_score_contract(
    repository, monkeypatch, tmp_path
):
    import ops_flow
    import rag_replay_flow
    from apps.evaluations import catalog, rag_replay

    importer.register(
        RUN / "core/capture.json", RUN / "api/api-capture.json", repository=repository
    )
    datasets = json.loads(
        (repository / importer.OPS / "capture_catalog.json").read_bytes()
    )
    item = datasets[-1]
    release = execution_spec.build_release(repository)
    monkeypatch.setattr(catalog, "DATASETS", {item["id"]: item for item in datasets})
    monkeypatch.setattr(execution_spec, "read_release", lambda: release)
    monkeypatch.setattr(ops_flow, "ROOT", repository)
    monkeypatch.setattr(
        ops_flow, "__file__", str(repository / importer.EVIDENCE / "ops_flow.py")
    )
    monkeypatch.setattr(rag_replay_flow, "ROOT", repository)
    monkeypatch.setenv("LLMOPS_RESULTS_DIR", str(tmp_path / "results"))
    monkeypatch.setattr(ops_flow, "flow_run", SimpleNamespace(id=str(uuid4())))
    monkeypatch.setattr(rag_replay_flow, "flow_run", SimpleNamespace(id=str(uuid4())))
    monkeypatch.setattr(
        ops_flow, "evaluate_rag_capture", rag_replay_flow.evaluate_rag_capture.fn
    )
    monkeypatch.setattr(
        ops_flow, "BudgetClient", lambda *a: pytest.fail("No paid reservation")
    )
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
    public = next(row for row in catalog.public_datasets() if row["id"] == item["id"])
    assert (
        public["live_config"] is None and public["execution_profiles"]["live"] is None
    )
    capture_id = item["captures"][0]["id"]
    spec = execution_spec.make_spec(
        release, item["id"], "replay", {}, capture_id, capture_id
    )
    run_id = str(uuid4())
    manifest = ops_flow.evaluate_saved_capture.fn(
        request_id=run_id,
        dataset_id=item["id"],
        candidate_capture_id=capture_id,
        reference_capture_id=capture_id,
        execution_spec=spec,
        execution_spec_sha256=execution_spec.digest(spec),
    )
    output = tmp_path / "results" / run_id / "evaluation"
    _, summary, _, _ = rag_replay.read_result(
        spec,
        execution_spec.digest(spec),
        manifest,
        (output / "comparison.json").read_bytes(),
        (output / "report.html").read_bytes(),
    )
    assert manifest["status"] == "completed" and manifest["model_api_calls"] == 0
    assert summary["measurementKind"] == "recorded-capture-replay"
    assert summary["completed"] and not summary["liveExecutionPerformed"]
    assert summary["semanticFaithfulness"] is None and not summary["baselineEligible"]
    assert len(scores) == 16
    assert all("session_id" in score and "trace_id" not in score for score in scores)
