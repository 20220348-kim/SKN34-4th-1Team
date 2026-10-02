"""완료 판정이 상세 API나 시간 초과를 통한 성공 처리에 의존하지 않는지 검증한다."""

import copy
import importlib.util
import json
from hashlib import sha256
from pathlib import Path
from unittest.mock import Mock

import pytest

spec = importlib.util.spec_from_file_location("ops_smoke", Path(__file__).with_name("ops_smoke.py"))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


def response(state, **overrides):
    return 200, json.dumps({"results": [{"id": "run", "status": state,
        "error_code": "", "synced_at": "confirmed", "sync_attempted_at": "attempted",
        "status_stale": False, **overrides}]}).encode(), {}


def test_waits_using_list_only(monkeypatch):
    monkeypatch.setattr(smoke.time, "sleep", Mock())
    request = Mock(side_effect=[response("QUEUED"), response("RUNNING"), response("COMPLETED")])
    assert smoke.wait_for_list_state(request, "run")["status"] == "COMPLETED"
    assert request.call_count == 3
    assert all(call.args == ("/api/v1/ops/evaluations?page=1",) for call in request.call_args_list)


@pytest.mark.parametrize("state", ["FAILED", "CRASHED", "CANCELLED", "RESULT_ERROR"])
def test_unexpected_terminal_state_fails(state):
    with pytest.raises(RuntimeError, match="Unexpected evaluation state"):
        smoke.wait_for_list_state(Mock(return_value=response(state)), "run")


def test_failure_fixture_is_observed_without_detail():
    assert smoke.wait_for_list_state(Mock(return_value=response("FAILED")), "run", "FAILED")["status"] == "FAILED"


@pytest.mark.parametrize("overrides", [{"synced_at": None}, {"sync_attempted_at": None}, {"status_stale": True}])
def test_unconfirmed_or_stale_completion_does_not_pass(overrides):
    with pytest.raises(AssertionError):
        smoke.wait_for_list_state(Mock(return_value=response("COMPLETED", **overrides)), "run")


def test_unavailable_api_and_timeout_fail(monkeypatch):
    with pytest.raises(AssertionError):
        smoke.wait_for_list_state(Mock(return_value=(503, b"{}", {})), "run")
    monkeypatch.setattr(smoke.time, "monotonic", Mock(side_effect=[0, 361]))
    with pytest.raises(RuntimeError, match="synchronization timed out"):
        smoke.wait_for_list_state(Mock(return_value=response("RUNNING")), "run")


def test_runtime_verification_requires_all_checks_and_correlated_result():
    result = {"status": "PASS", "storage_transport": "filesystem", "checks": {key: "PASS" for key in
              ("evidence", "results_directory", "prefect_deployment", "result_artifact")},
              "result_artifact_verified": True, "evaluation_executed": False}
    request = Mock(return_value=(200, json.dumps(result).encode(), {}))
    assert smoke.verify_runtime(request, "fixture-run") == result
    request.assert_called_once_with("/api/v1/ops/runtime?run_id=fixture-run")
    invalid = [
        {**result, "status": "FAIL"},
        {**result, "checks": {**result["checks"], "result_artifact": "NOT_CHECKED"}},
        {**result, "checks": {}},
        {**result, "result_artifact_verified": False},
        {**result, "evaluation_executed": True},
    ]
    for payload in invalid:
        with pytest.raises(AssertionError):
            smoke.verify_runtime(Mock(return_value=(200, json.dumps(payload).encode(), {})), "fixture-run")
    with pytest.raises(AssertionError):
        smoke.verify_runtime(Mock(return_value=(503, json.dumps(result).encode(), {})), "fixture-run")


def test_http_runtime_verification_rejects_filesystem_shortcut():
    result = {"status": "PASS", "storage_transport": "filesystem",
              "checks": {key: "PASS" for key in
              ("evidence", "results_directory", "prefect_deployment", "result_artifact")},
              "result_artifact_verified": True, "evaluation_executed": False}
    with pytest.raises(AssertionError):
        smoke.verify_runtime(Mock(return_value=(200, json.dumps(result).encode(), {})), "run", "http")
    result["storage_transport"] = "http"
    assert smoke.verify_runtime(Mock(return_value=(200, json.dumps(result).encode(), {})), "run", "http") == result


@pytest.fixture
def rag_run():
    # Use the real offline evaluator and committed capture, without a server or model call.
    root = Path(__file__).resolve().parents[2] / "evaluation/support-program-evidence"
    module_spec = importlib.util.spec_from_file_location("smoke_rag_evaluate", root / "rag_evaluate.py")
    evaluator = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(evaluator)
    report = evaluator.evaluate(root / "rag-fixture.json", root / "rag-synthetic-capture.json")
    return {
        "dataset_id": "rag-synthetic-multichunk-v1", "execution_mode": "replay",
        "model_api_calls": 0, "trace_links": [], "summary": report,
        "execution_spec": {
            "evaluation_scope": report["scope"], "model_operations": [], "generation": None,
            "live_config": {}, "dataset": {"case_ids": ["R01", "R02", "R03"]},
        },
        "comparison": {
            "schema_version": 3, "scope": report["scope"], "baseline_eligible": False,
            "comparison": "self-replay", "case_ids": ["R01", "R02", "R03"],
            "current": copy.deepcopy(report), "reference": copy.deepcopy(report),
        },
    }


def test_rag_smoke_preserves_provenance_and_eligible_case_denominators(rag_run):
    evidence = smoke.verify_rag_replay(rag_run)
    assert evidence["scope"] == "source-chunks-retrieval-answer"
    assert evidence["case_ids"] == ["R01", "R02", "R03"]
    assert evidence["coverage"]["failedCaseCount"] == 0
    assert evidence["coverage"]["answerCaseCount"] == 3
    assert evidence["reference_source"] == "ai-authored-not-human-reviewed"
    assert evidence["baseline_eligible"] is False and evidence["live_execution_performed"] is False


def test_rag_material_http_smoke_checks_source_hashes_and_failure_contract(rag_run):
    rag_run["id"] = "test-run"
    report = rag_run["summary"]
    row = report["cases"][0]
    saved = {"answer": "stored answer", "failure": None, "trace_id": None,
             "retrieved_chunk_ids": row["retrievedChunkIds"], "cited_chunk_ids": row["citedChunkIds"]}
    material = {
        "evaluation_scope": report["scope"], "baseline_eligible": False,
        "reference_source": report["referenceSource"], "fixture_sha256": report["fixtureSha256"],
        **{f"{name}_{field}": report[key] for name in ("candidate", "reference")
           for field, key in (("capture_sha256", "captureSha256"), ("measurement_kind", "measurementKind"))},
        "cases": [{"case_id": case["caseId"], "content": "고정 원문", "content_sha256": sha256("고정 원문".encode()).hexdigest(),
                   **{name: {**saved, "retrieved_chunk_ids": case["retrievedChunkIds"], "cited_chunk_ids": case["citedChunkIds"]}
                      for name in ("candidate", "reference")}} for case in report["cases"]],
    }
    def request_for(value, status=200):
        stamp = sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        return Mock(return_value=(status, json.dumps({**value, "material_sha256": stamp}).encode(), {"Cache-Control": "no-store"}))
    request = request_for(material)
    assert smoke.verify_rag_material(request, rag_run)["case_count"] == 3
    request.assert_called_once_with("/api/v1/ops/evaluations/test-run/rag-material")
    for key, value in (("candidate_capture_sha256", "0" * 64), ("baseline_eligible", True), ("reference_source", "human-reviewed")):
        with pytest.raises(AssertionError):
            smoke.verify_rag_material(request_for({**material, key: value}), rag_run)
    with pytest.raises(AssertionError):
        smoke.verify_rag_material(request_for(material, 503), rag_run)
    material["cases"][0]["candidate"]["answer"] = None
    with pytest.raises(AssertionError):
        smoke.verify_rag_material(request_for(material), rag_run)


@pytest.mark.parametrize("field,value", [
    ("dataset_id", "target-coverage-20260907-v1"), ("execution_mode", "live"),
    ("model_api_calls", 1), ("trace_links", [{"trace_id": "unexpected"}]),
])
def test_rag_smoke_rejects_wrong_or_paid_execution(rag_run, field, value):
    rag_run[field] = value
    with pytest.raises(AssertionError):
        smoke.verify_rag_replay(rag_run)


@pytest.mark.parametrize("field,value", [
    ("measurementKind", "recorded"), ("referenceSource", "human-reviewed"),
    ("baselineEligible", True), ("liveExecutionPerformed", True), ("completed", False),
    ("semanticFaithfulness", 1), ("caseCount", 2),
])
def test_rag_smoke_rejects_misleading_candidate_and_reference(rag_run, field, value):
    for target in ("current", "reference"):
        changed = copy.deepcopy(rag_run)
        changed["comparison"][target][field] = value
        if target == "current":
            changed["summary"][field] = value
        with pytest.raises(AssertionError):
            smoke.verify_rag_replay(changed)


@pytest.mark.parametrize("mutation", [
    lambda report: report["metrics"]["retrievalRecallAtK"].update(eligibleCaseCount=3),
    lambda report: report["metrics"]["answerCitationRecall"].update(value=1),
    lambda report: report["metrics"]["answerStatusAccuracy"].update(eligibleCaseCount=2),
    lambda report: report["coverage"].update(failedCaseCount=1),
    lambda report: report["cases"][2].update(failure={"stage": "answer", "code": "failed"}),
    lambda report: report["cases"][2].update(retrievalRecallAtK=0),
    lambda report: report["cases"].pop(),
])
def test_rag_smoke_rejects_failed_cases_or_changed_measurements(rag_run, mutation):
    mutation(rag_run["summary"])
    rag_run["comparison"]["current"] = copy.deepcopy(rag_run["summary"])
    with pytest.raises(AssertionError):
        smoke.verify_rag_replay(rag_run)


@pytest.fixture(params=["v1", "v2"])
def core_rag_run(request):
    version = request.param
    root = Path(__file__).resolve().parents[2] / "evaluation/support-program-evidence"
    module_spec = importlib.util.spec_from_file_location("core_smoke_evaluator", root / "rag_evaluate.py")
    evaluator = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(evaluator)
    folder = root / f"runs/core-rag-20261002/{version}"
    report = evaluator.evaluate(folder / "fixture.json", folder / "capture.json")
    cases = [case["caseId"] for case in report["cases"]]
    return version, {
        "dataset_id": f"core-rag-20261002-{version}", "execution_mode": "replay",
        "status": "COMPLETED", "model_api_calls": 0, "summary": report,
        "trace_links": [{"case_id": c["caseId"], "url": "https://traces.invalid/traces/" + c["traceId"]}
                        for c in report["cases"]],
        "execution_spec": {
            "evaluation_scope": report["scope"], "model_operations": [], "generation": None,
            "live_config": {}, "dataset": {"case_ids": cases, "fixture_sha256": report["fixtureSha256"]},
            "candidate_sha256": report["captureSha256"], "reference_sha256": report["captureSha256"],
        },
        "comparison": {
            "schema_version": 3, "scope": report["scope"], "baseline_eligible": False,
            "comparison": "self-replay", "case_ids": cases,
            "current": copy.deepcopy(report), "reference": copy.deepcopy(report),
        },
    }


def test_core_rag_smoke_preserves_saved_failures_and_provenance(core_rag_run):
    version, run = core_rag_run
    evidence = smoke.verify_core_snapshot_replay(run, version)
    assert evidence["source_completed"] is (version == "v2")
    assert evidence["coverage"]["failedCaseCount"] == (4 if version == "v1" else 0)
    assert evidence["measurement_kind"] == "integration-stub-replay"


@pytest.mark.parametrize("mutation", [
    lambda run: run.update(status="FAILED"),
    lambda run: run.update(model_api_calls=1),
    lambda run: run.update(trace_links=[]),
    lambda run: run["summary"].update(completed=not run["summary"]["completed"]),
    lambda run: run["summary"].update(baselineEligible=True),
    lambda run: run["summary"]["execution"].update(kind="recorded", paidModelApiCalls=1),
    lambda run: run["summary"]["metrics"]["retrievalRecallAtK"].update(eligibleCaseCount=99),
    lambda run: run["summary"].update(fixtureSha256="0" * 64),
])
def test_core_rag_smoke_rejects_success_promotion_or_lost_evidence(core_rag_run, mutation):
    version, run = core_rag_run
    mutation(run)
    # Keep self-replay equality; semantic checks must reject internally consistent forgery too.
    run["comparison"]["current"] = copy.deepcopy(run["summary"])
    run["comparison"]["reference"] = copy.deepcopy(run["summary"])
    with pytest.raises(AssertionError):
        smoke.verify_core_snapshot_replay(run, version)
