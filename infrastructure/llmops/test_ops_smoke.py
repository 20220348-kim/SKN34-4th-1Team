"""완료 판정이 상세 API나 시간 초과를 통한 성공 처리에 의존하지 않는지 검증한다."""

import importlib.util
import json
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
