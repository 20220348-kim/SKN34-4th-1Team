"""기존 Core 관리자 로그인·Django CSRF·평가 접수·재전송·보고서 HTTP 경로를 무료로 검증한다."""

import argparse
import json
import os
import time
from hashlib import sha256
from http.cookiejar import CookieJar
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPCookieProcessor, Request, build_opener
from uuid import UUID, uuid4


def wait_for_list_state(request, run_id, expected="COMPLETED"):
    # 상세 API 호출로 상태 갱신을 유발하지 않는다. ops-sync의 DB 반영을 검증한다.
    deadline = time.monotonic() + 360
    while True:
        status, body, _ = request("/api/v1/ops/evaluations?page=1")
        assert status == 200, f"Ops list returned HTTP {status}"
        run = next((item for item in json.loads(body)["results"] if item["id"] == run_id), None)
        if run and run["status"] == expected:
            assert run["synced_at"] and run["sync_attempted_at"] and not run["status_stale"]
            return run
        if run and run["status"] in {"FAILED", "CRASHED", "CANCELLED", "RESULT_ERROR", "COMPLETED"}:
            raise RuntimeError(f'Unexpected evaluation state: {run["status"]} / {run["error_code"]}')
        if time.monotonic() >= deadline:
            raise RuntimeError("Background evaluation synchronization timed out")
        time.sleep(3)


def verify_runtime(request, run_id, expected_transport="filesystem"):
    status, body, _ = request("/api/v1/ops/runtime?run_id=" + run_id)
    runtime = json.loads(body)
    assert status == 200 and runtime["status"] == "PASS"
    assert runtime["storage_transport"] == expected_transport
    assert set(runtime["checks"]) == {"evidence", "results_directory", "prefect_deployment", "result_artifact"}
    assert all(value == "PASS" for value in runtime["checks"].values())
    assert runtime["result_artifact_verified"] is True and runtime["evaluation_executed"] is False
    return runtime


def verify_rag_live_disabled(request, session, dataset, payload):
    """호출 계획 공개와 실행 활성화를 구분한다. 이 smoke는 비활성 환경에서만 실행한다."""
    assert session["rag_live_enabled"] is False
    config, profile = dataset["live_config"], dataset["execution_profiles"]["live"]
    if config is None:
        assert profile is None
        return
    assert config["source_mode"] == "fixed-source-and-chunks"
    assert isinstance(profile, str) and len(profile) == 64
    run_id = str(uuid4())
    status, raw, _ = request("/api/v1/ops/evaluations", {
        **payload, "request_id": run_id, "execution_mode": "live",
        "candidate_capture_id": "new-model-response", "live_config": config,
        "execution_profile": profile, "confirm_paid_run": True,
    })
    assert status == 400 and json.loads(raw) == {"code": "INVALID_REFERENCE"}
    assert request(f"/api/v1/ops/evaluations/{run_id}")[0] == 404


def verify_rag_replay(run):
    """Keep synthetic provenance and the different eligible-case denominators explicit."""
    scope = "source-chunks-retrieval-answer"
    comparison, summary, spec = run["comparison"], run["summary"], run["execution_spec"]
    assert run["dataset_id"] == "rag-synthetic-multichunk-v1"
    assert run["execution_mode"] == "replay" and type(run["model_api_calls"]) is int
    assert run["model_api_calls"] == 0 and run["trace_links"] == []
    assert comparison["schema_version"] == 3 and comparison["scope"] == scope
    assert comparison["baseline_eligible"] is False and comparison["comparison"] == "self-replay"
    assert spec["evaluation_scope"] == scope and spec["model_operations"] == []
    assert spec["generation"] is None and not spec["live_config"]
    assert comparison["case_ids"] == spec["dataset"]["case_ids"] == ["R01", "R02", "R03"]
    assert summary == comparison["current"]
    for report in (summary, comparison["reference"]):
        assert report["scope"] == scope and report["caseCount"] == 3
        assert report["measurementKind"] == "synthetic-contract-check"
        assert report["execution"]["kind"] == "synthetic"
        assert report["referenceSource"] == "ai-authored-not-human-reviewed"
        assert report["baselineEligible"] is False and report["liveExecutionPerformed"] is False
        assert report["semanticFaithfulness"] is None and report["completed"] is True
        assert [case["caseId"] for case in report["cases"]] == ["R01", "R02", "R03"]
        assert all(case["failure"] is None for case in report["cases"])
        assert all(case["traceId"] is None for case in report["cases"])
        assert report["coverage"] == {
            "retrievalCaseCount": 3, "answerCaseCount": 3, "traceCaseCount": 0, "failedCaseCount": 0,
        }
        for name, value in (("retrievalRecallAtK", 0.5), ("answerCitationRecall", 0.25)):
            assert report["metrics"][name] == {
                "value": value, "measuredCaseCount": 2, "eligibleCaseCount": 2,
            }
        assert report["metrics"]["answerStatusAccuracy"] == {
            "value": 1, "measuredCaseCount": 3, "eligibleCaseCount": 3,
        }
        assert report["cases"][2]["retrievalRecallAtK"] is None
        assert report["cases"][2]["answerCitationRecall"] is None
    return {
        "scope": scope, "measurement_kind": summary["measurementKind"],
        "baseline_eligible": summary["baselineEligible"],
        "live_execution_performed": summary["liveExecutionPerformed"],
        "reference_source": summary["referenceSource"],
        "case_ids": comparison["case_ids"], "coverage": summary["coverage"],
    }


def verify_core_rag_replay(run, registration):
    """등록 직전 계산한 원본과 실제 Ops의 재평가 결과·실패 사례·추적을 대조한다."""
    expected = registration["report"]
    spec, comparison = run["execution_spec"], run["comparison"]
    assert registration["schema_version"] == 1
    assert run["dataset_id"] == registration["dataset_id"]
    assert run["candidate_capture_id"] == run["reference_capture_id"] == registration["capture_id"]
    assert run["execution_mode"] == "replay" and type(run["model_api_calls"]) is int
    assert run["model_api_calls"] == 0
    assert comparison["schema_version"] == 3 and comparison["comparison"] == "self-replay"
    assert comparison["scope"] == spec["evaluation_scope"] == "source-chunks-retrieval-answer"
    assert comparison["baseline_eligible"] is False
    assert spec["generation"] is None and spec["model_operations"] == [] and not spec["live_config"]
    assert spec["dataset"]["fixture_sha256"] == registration["source_sha256"]["fixture"]
    assert spec["candidate_sha256"] == spec["reference_sha256"] == registration["source_sha256"]["capture"]
    assert run["summary"] == comparison["current"] == comparison["reference"] == expected
    assert expected["measurementKind"] == "integration-stub-replay"
    assert expected["execution"]["kind"] == "integration-stub"
    assert type(expected["execution"]["paidModelApiCalls"]) is int
    assert expected["execution"]["paidModelApiCalls"] == 0
    assert expected["baselineEligible"] is False and expected["liveExecutionPerformed"] is False
    assert expected["semanticFaithfulness"] is None and expected["semanticReviewRequired"] is True
    assert expected["referenceSource"] == "ai-authored-not-human-reviewed"
    assert comparison["case_ids"] == spec["dataset"]["case_ids"] == [c["caseId"] for c in expected["cases"]]
    assert {link["case_id"]: urlsplit(link["url"]).path.rsplit("/", 1)[-1] for link in run["trace_links"]} == {
        case["caseId"]: case["traceId"] for case in expected["cases"]
    }
    assert len(run["trace_links"]) == expected["caseCount"]
    return {
        "scope": expected["scope"], "measurement_kind": expected["measurementKind"],
        "baseline_eligible": False, "live_execution_performed": False,
        "source_completed": expected["completed"], "coverage": expected["coverage"],
        "source_sha256": registration["source_sha256"],
        "case_ids": comparison["case_ids"], "reference_source": expected["referenceSource"],
    }


def verify_core_snapshot_replay(run, version):
    """재평가 완료와 원본 대역 실행의 실패를 구분하고 등록된 분모를 확인한다."""
    assert version in {"v1", "v2"}
    cases = (["ok", "hit", "miss", "citation-miss", "insufficient", "fail", "timeout",
              "invalid-citation", "search-fail"] if version == "v1" else ["ok"])
    failures = ({"fail": "answer", "timeout": "answer", "invalid-citation": "answer",
                 "search-fail": "search"} if version == "v1" else {})
    coverage = ({"retrievalCaseCount": 8, "answerCaseCount": 5, "traceCaseCount": 9,
                 "failedCaseCount": 4} if version == "v1" else
                {"retrievalCaseCount": 1, "answerCaseCount": 1, "traceCaseCount": 1,
                 "failedCaseCount": 0})
    metrics = ((6 / 7, 7, 8), (0.625, 4, 8), (1, 5, 9)) if version == "v1" else ((1, 1, 1),) * 3
    comparison, summary, spec = run["comparison"], run["summary"], run["execution_spec"]
    assert run["dataset_id"] == f"core-rag-20261002-{version}"
    assert run["status"] == "COMPLETED" and run["execution_mode"] == "replay"
    assert type(run["model_api_calls"]) is int and run["model_api_calls"] == 0
    assert comparison["schema_version"] == 3 and comparison["comparison"] == "self-replay"
    assert comparison["baseline_eligible"] is False
    assert comparison["case_ids"] == spec["dataset"]["case_ids"] == cases
    assert spec["evaluation_scope"] == comparison["scope"] == "source-chunks-retrieval-answer"
    assert spec["model_operations"] == [] and spec["generation"] is None and not spec["live_config"]
    assert summary == comparison["current"] == comparison["reference"]
    assert summary["schemaVersion"] == "support-program-rag-report-v2"
    assert summary["scope"] == spec["evaluation_scope"] and summary["caseCount"] == len(cases)
    assert summary["fixtureSha256"] == spec["dataset"]["fixture_sha256"]
    assert summary["captureSha256"] == spec["candidate_sha256"] == spec["reference_sha256"]
    assert summary["measurementKind"] == "integration-stub-replay"
    assert summary["execution"]["kind"] == "integration-stub"
    assert type(summary["execution"]["paidModelApiCalls"]) is int
    assert summary["execution"]["paidModelApiCalls"] == 0
    assert summary["referenceSource"] == "ai-authored-not-human-reviewed"
    assert summary["baselineEligible"] is False and summary["liveExecutionPerformed"] is False
    assert summary["semanticFaithfulness"] is None and summary["semanticReviewRequired"] is True
    assert summary["completed"] is (version == "v2") and summary["coverage"] == coverage
    assert [case["caseId"] for case in summary["cases"]] == cases
    for name, (value, measured, eligible) in zip(
        ("retrievalRecallAtK", "answerCitationRecall", "answerStatusAccuracy"), metrics, strict=True
    ):
        assert summary["metrics"][name] == {
            "value": value, "measuredCaseCount": measured, "eligibleCaseCount": eligible,
        }
    assert [link["case_id"] for link in run["trace_links"]] == cases
    for case, link in zip(summary["cases"], run["trace_links"], strict=True):
        expected = failures.get(case["caseId"])
        assert case["failure"] == ({"stage": expected, "code": "EVIDENCE_UNAVAILABLE"} if expected else None)
        assert case["traceId"] and link["url"].endswith("/traces/" + case["traceId"])
    return {
        "scope": summary["scope"], "measurement_kind": summary["measurementKind"],
        "baseline_eligible": False, "live_execution_performed": False,
        "reference_source": summary["referenceSource"], "case_ids": cases,
        "coverage": coverage, "source_completed": summary["completed"],
        "fixture_sha256": summary["fixtureSha256"], "capture_sha256": summary["captureSha256"],
    }


def verify_rag_material(request, run):
    status, raw, headers = request(f'/api/v1/ops/evaluations/{run["id"]}/rag-material')
    assert status == 200 and "no-store" in headers["Cache-Control"]
    material = json.loads(raw)
    fingerprint = material.pop("material_sha256")
    assert fingerprint == sha256(json.dumps(material, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    assert material["evaluation_scope"] == "source-chunks-retrieval-answer"
    assert material["baseline_eligible"] is False
    assert material["reference_source"] == "ai-authored-not-human-reviewed"
    assert [case["case_id"] for case in material["cases"]] == run["comparison"]["case_ids"]
    for name, key in (("candidate", "current"), ("reference", "reference")):
        report = run["comparison"][key]
        assert material["fixture_sha256"] == report["fixtureSha256"]
        assert material[f"{name}_capture_sha256"] == report["captureSha256"]
        assert material[f"{name}_measurement_kind"] == report["measurementKind"]
        for case, measured in zip(material["cases"], report["cases"], strict=True):
            saved = case[name]
            assert saved["failure"] == measured["failure"] and saved["trace_id"] == measured["traceId"]
            assert saved["retrieved_chunk_ids"] == measured["retrievedChunkIds"]
            assert saved["cited_chunk_ids"] == measured["citedChunkIds"]
            assert (saved["answer"] is not None) == measured["answerMeasured"]
            assert sha256(case["content"].encode()).hexdigest() == case["content_sha256"]
    return {"material_sha256": fingerprint, "case_count": len(material["cases"]), "baseline_eligible": False}


def verify_rag_review_lifecycle(request, run, actor):
    """새 합성 실행에서만 자동 검토를 저장한다. 실제 사람 검토·모델 품질 증거가 아니다."""
    verify_rag_replay(run)
    path = f'/api/v1/ops/evaluations/{run["id"]}'

    def read(suffix, data=None):
        status, raw, headers = request(path + suffix, data)
        assert status == 200, f"RAG review {suffix}: HTTP {status}"
        assert "no-store" in headers["Cache-Control"]
        return json.loads(raw)

    state = read("/rag-reviews")
    assert state["review_version"] == 0 and state["case_reviews"] == []
    assert state["reference_review"]["history"] == [] and state["quality"]["history"] == []
    assert state["baseline"]["run_id"] is None
    material = state["material"]
    assert material["candidate_measurement_kind"] == "synthetic-contract-check"
    assert material["reference_source"] == "ai-authored-not-human-reviewed"
    case_ids = [case["case_id"] for case in material["cases"]]
    assert case_ids == run["comparison"]["case_ids"]
    baseline_before = state["baseline"]
    original_input = state["quality"]["input_sha256"]
    comment = "자동 통합 검증용 기록: 실제 사람 검토·모델 품질 승인 아님"
    approval = {
        "decision": "APPROVED", "comment": comment, "confirmed_all_cases": True,
        "fixture_sha256": material["fixture_sha256"], "case_ids": case_ids,
        "rubric_version": state["reference_review"]["rubric"]["version"], "review_version": 0,
    }
    assert request(path + "/rag-reference-review", approval, csrf=False)[0] == 403
    assert request(path + "/rag-reference-review", {**approval, "case_ids": case_ids[:1]})[0] == 409
    assert read("/rag-reviews")["review_version"] == 0
    state = read("/rag-reference-review", approval)
    approved_record = state["reference_review"]["history"][0]
    assert state["reference_review"]["approved"] and state["review_version"] == 1
    assert approved_record["reviewed_by"] == actor and approved_record["comment"] == comment
    assert read("/rag-reference-review", approval) == state
    assert request(path + "/rag-reference-review", {**approval, "comment": "다른 판단"})[0] == 409

    for index, case in enumerate(material["cases"]):
        assert case["candidate"]["retrieved_chunk_ids"] is not None
        assert case["candidate"]["answer"] is not None
        body = {
            "case_id": case["case_id"], "retrieval_decision": "SUITABLE",
            "answer_decision": "SUITABLE", "citation_decision": "SUITABLE", "comment": comment,
            "material_sha256": material["material_sha256"], "rubric_version": state["rubric"]["version"],
            "review_version": state["review_version"],
        }
        if index == 0:
            assert request(path + "/rag-reviews", body, csrf=False)[0] == 403
        state = read("/rag-reviews", body)
        assert state["review_version"] == index + 2 and len(state["case_reviews"]) == index + 1
        assert state["case_reviews"][0]["case_id"] == case["case_id"]
        assert state["case_reviews"][0]["reviewed_by"] == actor
        assert state["case_reviews"][0]["is_current"]
        assert read("/rag-reviews", body) == state
    assert state["quality"]["status"] == "NOT_EVALUATED" and state["quality"]["history"] == []
    assert request(path + "/rag-quality", {"input_sha256": original_input})[0] == 409
    quality_request = {"input_sha256": state["quality"]["input_sha256"]}
    assert request(path + "/rag-quality", quality_request, csrf=False)[0] == 403
    state = read("/rag-quality", quality_request)
    quality = state["quality"]
    assert quality["status"] == "NEEDS_REVIEW" and quality["is_current"]
    assert quality["baseline_eligible"] is False and len(quality["history"]) == 1
    assessment = quality["history"][0]
    assert {reason["code"] for reason in assessment["reasons"]} == {"NON_MODEL_CAPTURE"}
    assert assessment["assessed_by"] == actor
    assert assessment["inputs"]["reference_review"]["approved"] is True
    assert read("/rag-quality", quality_request) == state
    promotion = {
        "assessment_id": quality["current_id"], "input_sha256": quality["input_sha256"],
        "baseline_version": state["baseline"]["version"], "reason": comment,
    }
    assert request(path + "/rag-baseline", promotion, csrf=False)[0] == 403
    assert request(path + "/rag-baseline", promotion)[0] == 409
    assert read("/rag-reviews")["baseline"] == baseline_before

    state = read("/rag-reference-review", {
        **approval, "decision": "REVOKED", "review_version": state["review_version"],
    })
    reference = state["reference_review"]
    assert reference["approved"] is False and reference["can_revoke"] is False
    assert len(reference["history"]) == 2
    revoked_record = reference["history"][0]
    assert revoked_record["decision"] == "REVOKED" and revoked_record["is_current"]
    assert revoked_record["revoked_review_id"] == approved_record["id"]
    assert reference["history"][1] == {**approved_record, "is_current": False}
    assert state["quality"]["status"] == "NOT_EVALUATED" and not state["quality"]["is_current"]
    assert state["quality"]["history"] == quality["history"]
    assert read("/rag-reference-review", approval) == state  # 과거 재전송이 철회를 되돌리면 실패한다.
    assert request(path + "/rag-quality", quality_request)[0] == 409
    state = read("/rag-quality", {"input_sha256": state["quality"]["input_sha256"]})
    assert state["quality"]["status"] == "NEEDS_REVIEW" and state["quality"]["is_current"]
    assert state["quality"]["baseline_eligible"] is False
    assert len(state["quality"]["history"]) == 2
    assert {r["code"] for r in state["quality"]["history"][0]["reasons"]} == {
        "NON_MODEL_CAPTURE", "REFERENCE_REVOKED",
    }
    assert state["quality"]["history"][1] == assessment
    assert state["material"] == material and state["baseline"] == baseline_before
    assert state["review_version"] == len(case_ids) + 2
    assert read("/rag-reviews") == state
    final = read("")
    for key in ("status", "model_api_calls", "prefect_flow_run_id", "execution_spec", "execution_spec_sha256"):
        assert final[key] == run[key]
    return {
        "evidence_kind": "automated-isolated-review-check-not-human-review",
        "case_review_count": len(case_ids), "reference_review_count": 2, "assessment_count": 2,
        "review_version": state["review_version"], "final_quality_status": state["quality"]["status"],
        "reference_approved": False, "synthetic_baseline_rejected": True,
        "csrf_enforced": True, "idempotent_retry": True, "revocation_preserved": True,
        "old_assessment_preserved": True, "material_sha256": material["material_sha256"],
        "new_model_calls": 0,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://localhost:5173")
    parser.add_argument("--seed-dev-accounts", action="store_true", help="격리 CI Core에서만 개발용 계정 생성")
    parser.add_argument("--rag-review-check", action="store_true", help="격리 합성 실행에 자동 검토·판정·철회 기록 저장")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--compare-captures", action="store_true", help="기존 프롬프트 실행의 공통 E01 비교")
    mode.add_argument("--recover-source", type=UUID, help="무료 fixture가 만든 실패 실행을 복구")
    mode.add_argument("--rag-replay", action="store_true", help="합성 RAG 캡처 재계산과 출처·분모 확인")
    mode.add_argument("--core-rag-replay", type=Path, help="등록 명세 registration.json과 실제 Core 재평가 결과 대조")
    mode.add_argument("--core-snapshot-replay", choices=["v1", "v2"], help="고정 저장 Core 캡처의 실패·출처·분모 확인")
    parser.add_argument("--storage-transport", choices=["filesystem", "http"], default="filesystem")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.rag_review_check and (not args.rag_replay or os.environ.get("LLMOPS_ISOLATED_REVIEW_TEST") != "1"):
        parser.error("Review writes require --rag-replay and LLMOPS_ISOLATED_REVIEW_TEST=1 on an isolated test server")
    registration = json.loads(args.core_rag_replay.read_bytes()) if args.core_rag_replay else None
    is_rag = args.rag_replay or registration is not None or args.core_snapshot_replay is not None
    base = args.base_url.rstrip("/")
    if urlsplit(base).hostname not in {"localhost", "127.0.0.1"}:
        parser.error("This smoke test requires a loopback web endpoint")
    cookies = CookieJar()
    client = build_opener(HTTPCookieProcessor(cookies))

    def request(path, data=None, *, csrf=True):
        headers = {"Origin": base}
        if data is not None:
            headers["Content-Type"] = "application/json"
            if csrf:
                headers["X-CSRFToken"] = next(c.value for c in cookies if c.name == "govbiz_ops_csrf")
            data = json.dumps(data).encode()
        try:
            response = client.open(Request(base + path, data=data, headers=headers), timeout=15)
        except HTTPError as exc:
            response = exc
        with response:
            return response.status, response.read(), response.headers

    deadline = time.monotonic() + 180
    while True:
        try:
            if request("/api/v1/ops/session")[0] == 200 and request("/api/v1/health")[0] == 200:
                break
        except (URLError, OSError):
            pass
        if time.monotonic() >= deadline:
            raise RuntimeError("Ops readiness timed out")
        time.sleep(2)
    assert request("/api/v1/ops/evaluations")[0] == 401
    assert request("/api/v1/ops/runtime")[0] == 401
    if args.seed_dev_accounts:
        # 이 플래그는 CI의 별도 Core/빈 DB fixture에만 사용한다. 기존 회원의 권한은 변경하지 않는다.
        assert request("/api/v1/auth/dev-login", {"role": "USER"}, csrf=False)[0] == 200
        assert request("/api/v1/ops/session")[0] == 403
        assert request("/api/v1/ops/evaluations")[0] == 403
        assert request("/api/v1/ops/runtime")[0] == 403
        assert request("/api/v1/auth/dev-login", {"role": "ADMIN"}, csrf=False)[0] == 200
        assert request("/api/v1/auth/logout", {}, csrf=False)[0] == 204
    status, body, _ = request("/api/v1/auth/login", {
        "email": os.environ["CORE_ADMIN_EMAIL"],
        "password": os.environ["CORE_ADMIN_PASSWORD"],
        "rememberMe": False,
    }, csrf=False)
    assert status == 200 and json.loads(body)["account"]["role"] == "ADMIN"
    status, body, _ = request("/api/v1/ops/session")
    assert status == 200 and json.loads(body)["user"]["username"] == os.environ["CORE_ADMIN_EMAIL"]
    session = json.loads(body)
    datasets = {item["id"]: item for item in session["datasets"]}
    submit_path = "/api/v1/ops/evaluations"
    payload = {"request_id": str(uuid4()), "dataset_id": "target-coverage-20260907-v1"}
    if args.recover_source:
        source_id = str(args.recover_source)
        source = wait_for_list_state(request, source_id, "FAILED")
        status, body, _ = request(f"/api/v1/ops/evaluations/{source_id}")
        assert status == 200 and json.loads(body)["postprocessing"]["can_recover"]
        assert source["execution_mode"] == "replay" and source["model_api_calls"] == 0
        submit_path = f"/api/v1/ops/evaluations/{source_id}/recover"
        payload = {"request_id": payload["request_id"]}
    if args.compare_captures:
        payload.update(dataset_id="fixed-context-e01-v1",
                       candidate_capture_id="fixed-context-20260907-index-v1",
                       reference_capture_id="fixed-context-20260906-diagnostic-v1")
    if args.rag_replay:
        payload.update(dataset_id="rag-synthetic-multichunk-v1",
                       candidate_capture_id="rag-synthetic-capture-v1",
                       reference_capture_id="rag-synthetic-capture-v1")
    if args.core_snapshot_replay:
        version = args.core_snapshot_replay
        payload.update(dataset_id=f"core-rag-20261002-{version}",
                       candidate_capture_id=f"core-rag-capture-20261002-{version}",
                       reference_capture_id=f"core-rag-capture-20261002-{version}")
    if registration is not None:
        payload.update(dataset_id=registration["dataset_id"],
                       candidate_capture_id=registration["capture_id"],
                       reference_capture_id=registration["capture_id"])
    if is_rag:
        verify_rag_live_disabled(request, session, datasets[payload["dataset_id"]], payload)
    if not args.recover_source:
        payload["execution_profile"] = datasets[payload["dataset_id"]]["execution_profiles"]["replay"]
    assert request(submit_path, payload, csrf=False)[0] == 403
    if not args.recover_source:
        assert request(submit_path, {**payload, "dataset_id": "../../invalid"})[0] == 400
    # deployment 등록 직후의 접수 지연도 같은 요청 ID로 복구한다.
    deadline = time.monotonic() + 300
    while True:
        status, body, _ = request(submit_path, payload)
        first = json.loads(body)
        if status in (200, 202) and first["prefect_flow_run_id"]:
            break
        assert status == 503
        if time.monotonic() >= deadline:
            raise RuntimeError("Deployment dispatch timed out")
        time.sleep(3)
    status, body, _ = request(submit_path, payload)
    replay = json.loads(body)
    assert status == 200 and replay["prefect_flow_run_id"] == first["prefect_flow_run_id"]
    run = wait_for_list_state(request, payload["request_id"])
    assert run["execution_spec_sha256"] == first["execution_spec_sha256"] == replay["execution_spec_sha256"]
    assert run["execution_spec"] and run["execution_spec"]["generation"] is None
    assert run["execution_spec"]["dataset"]["case_ids"] == run["comparison"]["case_ids"]
    if not args.recover_source:
        assert run["execution_profile"] == payload["execution_profile"]
    if args.recover_source:
        assert run["execution_mode"] == "recovery" and run["source_run_id"] == source_id
        assert run["model_api_calls"] == 0
        assert run["prefect_flow_run_id"] != source["prefect_flow_run_id"]
        assert wait_for_list_state(request, source_id, "FAILED")["prefect_flow_run_id"] == source["prefect_flow_run_id"]
    expected_count = (registration["report"]["caseCount"] if registration is not None
                      else (9 if args.core_snapshot_replay == "v1" else 1) if args.core_snapshot_replay
                      else 3 if args.rag_replay else 1 if args.compare_captures else 6)
    assert run["summary"]["caseCount"] == expected_count
    comparison = run["comparison"]
    assert comparison["comparison"] == ("candidate-reference" if args.compare_captures else "self-replay")
    if args.compare_captures:
        assert comparison["case_ids"] == ["E01"]
        assert comparison["candidate_execution"]["source_case_ids"] == ["E01", "E07", "E10", "E12"]
        latency = next(item for item in comparison["metrics"] if item["key"] == "meanLatencyMs")
        assert abs(latency["delta"] - 117.477) < 0.001
        tokens = next(item for item in comparison["metrics"] if item["key"] == "meanOutputTokens")
        assert tokens["candidate"] is None and tokens["delta"] is None
        assert request("/api/v1/ops/evaluations", {**payload, "reference_capture_id": payload["candidate_capture_id"]})[0] == 409
    if is_rag:
        rag_evidence = (verify_core_rag_replay(run, registration) if registration is not None
                        else verify_core_snapshot_replay(run, args.core_snapshot_replay) if args.core_snapshot_replay
                        else verify_rag_replay(run))
        rag_evidence["review_material"] = verify_rag_material(request, run)
        if args.rag_review_check:
            rag_evidence["review_lifecycle"] = verify_rag_review_lifecycle(request, run, os.environ["CORE_ADMIN_EMAIL"])
    else:
        assert run["summary"]["statusAccuracy"] == 1
        assert run["summary"]["referenceCitationRecall"] == 1
    assert run["summary"]["semanticFaithfulness"] is None
    status, body, headers = request(run["report_url"])
    assert status == 200 and len(body) > 1000
    assert "sandbox allow-scripts;" in headers["Content-Security-Policy"]
    runtime = verify_runtime(request, run["id"], args.storage_transport)
    # Django 세션을 지우는 대신 Core 로그아웃 한 번으로 Ops도 차단되어야 한다.
    assert request("/api/v1/auth/logout", {}, csrf=False)[0] == 204
    assert request(run["report_url"])[0] == 401
    assert request("/api/v1/ops/evaluations")[0] == 401
    assert request("/api/v1/ops/runtime")[0] == 401
    if is_rag:
        assert request(f'/api/v1/ops/evaluations/{run["id"]}/rag-material')[0] == 401
        assert request(f'/api/v1/ops/evaluations/{run["id"]}/rag-reviews')[0] == 401
        if args.rag_review_check:
            for endpoint in ("rag-reviews", "rag-reference-review", "rag-quality", "rag-baseline"):
                assert request(f'/api/v1/ops/evaluations/{run["id"]}/{endpoint}', {})[0] == 401
    summary = {
        "request_id": run["id"], "prefect_flow_run_id": run["prefect_flow_run_id"],
        "evaluation_run_id": run["evaluation_run_id"], "status": run["status"],
        "execution_spec_sha256": run["execution_spec_sha256"],
        "case_count": expected_count, "comparison": comparison["comparison"],
        "metrics": run["summary"]["metrics"] if is_rag else comparison["metrics"],
        "duplicate_request_same_flow": True, "csrf_enforced": True,
        "core_admin_login": True, "core_logout_revokes_ops": True,
        "deployment_runtime_checks": runtime,
        "background_sync_without_detail": True, "source_run_id": run.get("source_run_id"),
        "report_http_status": status, "model_api_calls": 0,
        "detail_url": base + run["detail_url"],
    }
    if is_rag:
        summary["rag_replay"] = rag_evidence
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
