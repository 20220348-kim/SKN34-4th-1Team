"""완료 판정이 상세 API나 시간 초과를 통한 성공 처리에 의존하지 않는지 검증한다."""

import copy
import importlib.util
import json
import socket
import threading
from hashlib import sha256
from http.cookiejar import CookieJar
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request
from unittest.mock import Mock

import pytest

spec = importlib.util.spec_from_file_location(
    "ops_smoke", Path(__file__).with_name("ops_smoke.py")
)
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


@pytest.fixture
def loopback_server():
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(self.path)
            if self.path == "/redirect":
                self.send_response(302)
                self.send_header("Location", self.server.redirect)
                self.end_headers()
                return
            self.send_response(401 if self.path == "/unauthorized" else 200)
            self.send_header("Content-Type", "application/json")
            self.send_header(
                "Set-Cookie", "govbiz_session=fixture; Path=/; HttpOnly; SameSite=Lax"
            )
            self.end_headers()
            self.wfile.write(
                json.dumps(
                    {
                        "host": self.headers.get("Host"),
                        "origin": self.headers.get("Origin"),
                        "cookie": self.headers.get("Cookie"),
                    }
                ).encode()
            )

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(
        target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True
    )
    thread.start()
    try:
        yield server, requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        assert not thread.is_alive()


@pytest.mark.parametrize("host", ["localhost", "127.0.0.1"])
def test_loopback_transport_uses_ipv4_without_changing_origin_host_or_cookies(
    monkeypatch, loopback_server, host
):
    server, requests = loopback_server
    base = f"http://{host}:{server.server_port}"
    original = socket.getaddrinfo
    addresses = []

    def only_ipv4(address, *args, **kwargs):
        addresses.append(address)
        assert address == "127.0.0.1", "Do not resolve localhost or a proxy address"
        return original(address, *args, **kwargs)

    monkeypatch.setattr(socket, "getaddrinfo", only_ipv4)
    monkeypatch.setenv("http_proxy", "http://unreachable-proxy.invalid:8080")
    monkeypatch.setenv("HTTP_PROXY", "http://unreachable-proxy.invalid:8080")
    monkeypatch.delenv("no_proxy", raising=False)
    monkeypatch.delenv("NO_PROXY", raising=False)
    cookies = CookieJar()
    client = smoke.loopback_client(base, cookies)
    for path in ("/login", "/report"):
        with client.open(
            Request(base + path, headers={"Origin": base}), timeout=1
        ) as response:
            payload = json.load(response)
            assert response.status == 200 and payload["host"] == base.removeprefix(
                "http://"
            )
            assert payload["origin"] == base
    assert payload["cookie"] == "govbiz_session=fixture"
    assert all(cookie.has_nonstandard_attr("HttpOnly") for cookie in cookies)
    assert addresses == ["127.0.0.1", "127.0.0.1"]
    assert requests == ["/login", "/report"]


@pytest.mark.parametrize(
    "base",
    [
        "https://localhost:5173",
        "http://remote.invalid:5173",
        "http://[::1]:5173",
        "http://name:password@localhost:5173",
        "http://localhost:5173/api",
        "http://localhost:5173?target=x",
        "http://localhost:5173#fragment",
        "http://localhost:0",
        "http://localhost:65536",
        "ftp://localhost:5173",
    ],
)
def test_invalid_smoke_origin_never_opens_a_connection(monkeypatch, base):
    connect = Mock(side_effect=AssertionError("Unexpected connection"))
    monkeypatch.setattr(socket, "create_connection", connect)
    with pytest.raises(ValueError):
        smoke.loopback_client(base, CookieJar())
    connect.assert_not_called()


@pytest.mark.parametrize(
    "location",
    [
        "http://outside.invalid/report",
        "https://outside.invalid/report",
        "ftp://outside.invalid/file",
        "http://localhost:1/report",
        "/report",
    ],
)
def test_smoke_redirects_are_not_followed(loopback_server, location):
    server, requests = loopback_server
    server.redirect = location
    base = f"http://localhost:{server.server_port}"
    client = smoke.loopback_client(base, CookieJar())
    with pytest.raises(URLError, match="redirects are not allowed"):
        client.open(Request(base + "/redirect", headers={"Origin": base}), timeout=1)
    assert requests == ["/redirect"]


def test_loopback_transport_preserves_auth_errors_and_timeout(
    monkeypatch, loopback_server
):
    server, _ = loopback_server
    base = f"http://localhost:{server.server_port}"
    client = smoke.loopback_client(base, CookieJar())
    with pytest.raises(HTTPError) as rejected:
        client.open(base + "/unauthorized", timeout=1)
    assert rejected.value.code == 401
    rejected.value.close()
    connect = Mock(side_effect=TimeoutError("fixture timeout"))
    monkeypatch.setattr(socket, "create_connection", connect)
    with pytest.raises(URLError) as failed:
        client.open(base + "/report", timeout=0.25)
    assert isinstance(failed.value.reason, TimeoutError)
    assert connect.call_args.args[:2] == (("127.0.0.1", server.server_port), 0.25)
    assert connect.call_count == 1


@pytest.fixture
def replay_session():
    return {
        "live_enabled": False,
        "rag_live_enabled": False,
        "datasets": [{
            "id": "rag-synthetic-multichunk-v1",
            "live_config": {"answer_model": "metadata-only"},
            "execution_profiles": {"replay": "a" * 64, "live": "b" * 64},
        }],
    }


@pytest.mark.parametrize("has_live_metadata", [False, True])
def test_free_request_does_not_select_advertised_live_profile(replay_session, has_live_metadata):
    dataset = replay_session["datasets"][0]
    if not has_live_metadata:
        dataset["live_config"] = dataset["execution_profiles"]["live"] = None
    before = copy.deepcopy(replay_session)
    assert smoke.replay_selection(replay_session, dataset["id"]) == {
        "execution_mode": "replay", "execution_profile": "a" * 64,
        "live_config": {}, "confirm_paid_run": False,
    }
    assert replay_session == before


@pytest.mark.parametrize("flag", ["live_enabled", "rag_live_enabled"])
@pytest.mark.parametrize("value", [True, None, 0, "false"])
def test_free_smoke_rejects_enabled_or_unconfirmed_live_execution(replay_session, flag, value):
    replay_session[flag] = value
    with pytest.raises(AssertionError):
        smoke.replay_selection(replay_session, "rag-synthetic-multichunk-v1")


@pytest.mark.parametrize("profile", [None, "", "a" * 63, "z" * 64, 123])
def test_missing_replay_profile_never_falls_back_to_live(replay_session, profile):
    replay_session["datasets"][0]["execution_profiles"]["replay"] = profile
    with pytest.raises(AssertionError):
        smoke.replay_selection(replay_session, "rag-synthetic-multichunk-v1")


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


@pytest.mark.parametrize("planned", [True, False])
def test_rag_replay_accepts_published_plan_but_requires_live_disabled(planned):
    dataset = {"live_config": {"source_mode": "fixed-source-and-chunks"} if planned else None,
               "execution_profiles": {"live": "a" * 64 if planned else None}}
    request = Mock(side_effect=[(400, b'{"code":"INVALID_REFERENCE"}', {}), (404, b"{}", {})])
    payload = {"request_id": "replay-id", "dataset_id": "rag", "reference_capture_id": "saved"}
    smoke.verify_rag_live_disabled(request, {"rag_live_enabled": False}, dataset, payload)
    assert request.call_count == (2 if planned else 0)
    assert payload["request_id"] == "replay-id"
    if planned:
        body = request.call_args_list[0].args[1]
        assert body["execution_mode"] == "live" and body["confirm_paid_run"]
        assert body["live_config"] == dataset["live_config"]
        assert body["execution_profile"] == dataset["execution_profiles"]["live"]
        assert body["request_id"] != payload["request_id"]
        assert request.call_args_list[1].args == (f'/api/v1/ops/evaluations/{body["request_id"]}',)


@pytest.mark.parametrize("defect", ["enabled", "unplanned_profile", "missing_profile", "wrong_source"])
def test_rag_replay_refuses_unsafe_or_inconsistent_session_before_sending(defect):
    session = {"rag_live_enabled": defect == "enabled"}
    dataset = {"live_config": {"source_mode": "fixed-source-and-chunks"}, "execution_profiles": {"live": "a" * 64}}
    if defect == "unplanned_profile":
        dataset["live_config"] = None
    elif defect == "missing_profile":
        dataset["execution_profiles"]["live"] = None
    elif defect == "wrong_source":
        dataset["live_config"]["source_mode"] = "other"
    request = Mock()
    with pytest.raises(AssertionError):
        smoke.verify_rag_live_disabled(request, session, dataset, {})
    request.assert_not_called()


@pytest.mark.parametrize("status,code,detail_status", [(202, "INVALID_REFERENCE", 404), (400, "LIVE_BUDGET_UNAVAILABLE", 404), (400, "INVALID_REFERENCE", 200)])
def test_rag_disabled_check_rejects_acceptance_budget_rejection_or_created_run(status, code, detail_status):
    request = Mock(side_effect=[(status, json.dumps({"code": code}).encode(), {}), (detail_status, b"{}", {})])
    dataset = {"live_config": {"source_mode": "fixed-source-and-chunks"}, "execution_profiles": {"live": "a" * 64}}
    with pytest.raises(AssertionError):
        smoke.verify_rag_live_disabled(request, {"rag_live_enabled": False}, dataset, {})


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


@pytest.fixture
def review_exchange(rag_run):
    """서버의 단계별 계약 응답. 검증기가 잘못된 응답도 성공으로 기록하는지 변조한다."""
    rag_run.update(id="test-run", status="COMPLETED", prefect_flow_run_id="original-flow", execution_spec_sha256="fixed-spec")
    actor = "reviewer@example.com"
    original = {
        "review_version": 0, "case_reviews": [], "rubric": {"version": "rag-case-review-v1"},
        "material": {"candidate_measurement_kind": "synthetic-contract-check", "reference_source": "ai-authored-not-human-reviewed",
                     "fixture_sha256": "f" * 64, "material_sha256": "a" * 64,
                     "cases": [{"case_id": case, "candidate": {"retrieved_chunk_ids": [], "answer": "합성 답변"}} for case in ("R01", "R02", "R03")]},
        "reference_review": {"history": [], "rubric": {"version": "rag-reference-review-v1"}, "approved": False},
        "quality": {"history": [], "status": "NOT_EVALUATED", "input_sha256": "before"},
        "baseline": {"run_id": None, "version": 0, "history": []},
    }
    approved = copy.deepcopy(original)
    approved["review_version"] = 1
    approved["reference_review"].update(approved=True, can_revoke=True, history=[{
        "id": 10, "decision": "APPROVED", "is_current": True, "reviewed_by": actor,
        "comment": "자동 통합 검증용 기록: 실제 사람 검토·모델 품질 승인 아님", "created_at": "2026-10-02T00:00:00Z",
    }])
    cases = []
    for index in range(3):
        value = copy.deepcopy(cases[-1] if cases else approved)
        value["review_version"] += 1
        value["case_reviews"].insert(0, {"id": index + 1, "case_id": f"R0{index + 1}", "reviewed_by": actor, "is_current": True})
        value["quality"]["input_sha256"] = f"case-{index}"
        cases.append(value)
    assessed = copy.deepcopy(cases[-1])
    record = {"id": 20, "reasons": [{"code": "NON_MODEL_CAPTURE"}], "assessed_by": actor,
              "inputs": {"reference_review": copy.deepcopy(approved["reference_review"])}}
    assessed["quality"].update(status="NEEDS_REVIEW", is_current=True, baseline_eligible=False, current_id=20, history=[record])
    revoked = copy.deepcopy(assessed)
    revoked["review_version"] += 1
    revoked["reference_review"]["history"][0]["is_current"] = False
    revoked["reference_review"].update(approved=False, can_revoke=False)
    revoked["reference_review"]["history"].insert(0, {"id": 11, "decision": "REVOKED", "is_current": True, "revoked_review_id": 10})
    revoked["quality"].update(status="NOT_EVALUATED", is_current=False, input_sha256="revoked", current_id=None)
    reassessed = copy.deepcopy(revoked)
    reassessed["quality"].update(status="NEEDS_REVIEW", is_current=True, current_id=21)
    reassessed["quality"]["history"].insert(0, {"id": 21, "reasons": [{"code": "REFERENCE_REVOKED"}, {"code": "NON_MODEL_CAPTURE"}]})
    frames = []

    def frame(name, value=None, status=200):
        frames.append([name, status, copy.deepcopy(value or {})])

    frame("initial", original)
    frame("reference_csrf", status=403)
    frame("partial", status=409)
    frame("no_partial_write", original)
    frame("approved", approved)
    frame("approval_retry", approved)
    frame("stale_approval", status=409)
    frame("case_csrf", status=403)
    for index, value in enumerate(cases):
        frame(f"case_{index}", value)
        frame(f"case_retry_{index}", value)
    frame("stale_quality", status=409)
    frame("quality_csrf", status=403)
    frame("assessed", assessed)
    frame("quality_retry", assessed)
    frame("baseline_csrf", status=403)
    frame("baseline_rejected", status=409)
    frame("baseline_unchanged", assessed)
    frame("revoked", revoked)
    frame("old_approval_retry", revoked)
    frame("old_quality", status=409)
    frame("reassessed", reassessed)
    frame("persisted", reassessed)
    frame("original_run", rag_run)
    return rag_run, actor, frames


def review_request(frames):
    return Mock(side_effect=[(status, json.dumps(value).encode(), {"Cache-Control": "no-store"}) for _, status, value in frames])


def test_review_smoke_verifies_explicit_writes_and_keeps_synthetic_provenance(review_exchange):
    run, actor, frames = review_exchange
    request = review_request(frames)
    evidence = smoke.verify_rag_review_lifecycle(request, run, actor)
    assert request.call_count == len(frames)
    assert evidence["evidence_kind"] == "automated-isolated-review-check-not-human-review"
    assert evidence["synthetic_baseline_rejected"] and evidence["revocation_preserved"]
    assert evidence["reference_approved"] is False and evidence["final_quality_status"] == "NEEDS_REVIEW"
    assert evidence["new_model_calls"] == 0
    assert evidence["case_review_count"] == 3 and evidence["assessment_count"] == 2
    csrf_calls = [call for call in request.call_args_list if call.kwargs.get("csrf") is False]
    assert {call.args[0].rsplit("/", 1)[-1] for call in csrf_calls} == {"rag-reviews", "rag-reference-review", "rag-quality", "rag-baseline"}
    assert all(call.args[0].startswith("/api/v1/ops/evaluations/test-run") for call in request.call_args_list)


@pytest.mark.parametrize("frame_name,mutate", [
    ("initial", lambda v: v.update(review_version=1)),
    ("initial", lambda v: v["baseline"].update(run_id="existing-baseline")),
    ("approved", lambda v: v["reference_review"]["history"][0].update(reviewed_by="wrong-account")),
    ("approval_retry", lambda v: v.update(review_version=2)),
    ("assessed", lambda v: v["quality"].update(status="PASS")),
    ("assessed", lambda v: v["quality"].update(baseline_eligible=True)),
    ("assessed", lambda v: v["quality"]["history"][0].update(reasons=[])),
    ("revoked", lambda v: v["reference_review"]["history"][0].update(revoked_review_id=99)),
    ("revoked", lambda v: v["quality"].update(is_current=True)),
    ("old_approval_retry", lambda v: v["reference_review"].update(approved=True)),
    ("reassessed", lambda v: v["quality"].update(history=v["quality"]["history"][:1])),
    ("reassessed", lambda v: v["material"].update(reference_source="human-reviewed")),
    ("persisted", lambda v: v["reference_review"]["history"][0].update(id=999)),
    ("original_run", lambda v: v.update(model_api_calls=1)),
    ("original_run", lambda v: v.update(prefect_flow_run_id="new-unexpected-flow")),
])
def test_review_smoke_rejects_false_success_and_changed_history(review_exchange, frame_name, mutate):
    run, actor, frames = review_exchange
    mutate(next(value for name, _, value in frames if name == frame_name))
    with pytest.raises(AssertionError):
        smoke.verify_rag_review_lifecycle(review_request(frames), run, actor)


@pytest.mark.parametrize("frame_name", ["reference_csrf", "partial", "case_csrf", "stale_quality", "quality_csrf", "baseline_csrf", "baseline_rejected", "old_quality"])
def test_review_smoke_rejects_unprotected_writes(review_exchange, frame_name):
    run, actor, frames = review_exchange
    frame = next(item for item in frames if item[0] == frame_name)
    frame[1] = 200
    with pytest.raises(AssertionError):
        smoke.verify_rag_review_lifecycle(review_request(frames), run, actor)


@pytest.mark.parametrize("mode,enabled", [(False, False), (False, True), (True, False)])
def test_review_write_cli_requires_isolated_environment_and_synthetic_mode(monkeypatch, tmp_path, mode, enabled):
    monkeypatch.setattr("sys.argv", ["ops_smoke.py", "--rag-review-check", "--output", str(tmp_path / "result.json"), *(["--rag-replay"] if mode else [])])
    monkeypatch.delenv("LLMOPS_ISOLATED_REVIEW_TEST", raising=False)
    if enabled:
        monkeypatch.setenv("LLMOPS_ISOLATED_REVIEW_TEST", "1")
    client = Mock()
    monkeypatch.setattr(smoke, "build_opener", client)
    with pytest.raises(SystemExit) as error:
        smoke.main()
    assert error.value.code == 2
    client.assert_not_called()
