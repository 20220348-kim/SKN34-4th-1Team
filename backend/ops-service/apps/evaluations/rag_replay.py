"""무료 RAG 재계산 결과 계약. Django와 평가 실행기가 SDK 없이 함께 검증한다."""

import json
import re
from hashlib import sha256
from math import isclose, isfinite

SCOPE = "source-chunks-retrieval-answer"
METRICS = ("retrievalRecallAtK", "answerCitationRecall", "answerStatusAccuracy")
POLICY = {"version": "rag-replay-diagnostics-v1", "scope": SCOPE, "baseline_eligible": False}
KINDS = {
    "synthetic": "synthetic-contract-check",
    "integration-stub": "integration-stub-replay",
    "recorded": "recorded-capture-replay",
}


def require(condition):
    if not condition:
        raise ValueError("RAG replay evidence differs from the accepted specification")


def result_id(fixture_hash, capture_hash, evaluator_version):
    return sha256(
        f"rag-replay:{fixture_hash}:{capture_hash}:{evaluator_version}".encode()
    ).hexdigest()[:32]


def validate_recording(execution, spec):
    config, generation = spec["live_config"], spec["generation"]
    require(
        execution
        == {
            "kind": "recorded",
            "model": config["model"],
            "embeddingModel": config["embedding_model"],
            "promptSha256": generation["prompt_sha256"],
            "recorderSha256": generation["files"][
                "evaluation/support-program-evidence/rag_live.py"
            ],
        }
    )


def validate_live_capture(capture, usage, spec, spec_hash):
    """관측한 전송 횟수만 읽는다. 누락된 사용량을 0으로 추정하지 않는다."""
    require(spec["execution_mode"] == "live" and spec["evaluation_scope"] == SCOPE)
    validate_recording(capture["execution"], spec)
    require(
        capture["schemaVersion"] == "support-program-rag-capture-v1"
        and capture["scope"] == SCOPE
        and capture["fixtureSha256"] == spec["dataset"]["fixture_sha256"]
    )
    cases = capture["cases"]
    require([case["caseId"] for case in cases] == spec["dataset"]["case_ids"])
    vector_plan = spec["live_config"].get("document_vectors")
    vector_hashes = {}
    if vector_plan is not None:
        for case in cases:
            recorded = case.get("documentVectors")
            if recorded is None:
                require(case["failure"] is not None)
                continue
            selected = vector_plan[case["caseId"]]
            expected_status = (
                "created"
                if selected["sha256"] is None and selected["source_case_id"] == case["caseId"]
                else "reused"
            )
            require(
                isinstance(recorded, dict)
                and set(recorded) == {"key", "sha256", "status"}
                and recorded["key"] == selected["key"]
                and recorded["status"] == expected_status
                and isinstance(recorded["sha256"], str)
                and re.fullmatch(r"[a-f0-9]{64}", recorded["sha256"])
                and (selected["sha256"] is None or recorded["sha256"] == selected["sha256"])
                and recorded["sha256"]
                == vector_hashes.setdefault(recorded["key"], recorded["sha256"])
            )
    require(usage["schema_version"] == 1 and usage["execution_spec_sha256"] == spec_hash)
    count, operations = usage["model_api_calls"], usage["operations"]
    plan = spec["model_operations"]
    require(type(count) is int and count == len(operations) and 0 <= count <= len(plan))
    sequence = [item["sequence"] for item in operations]
    require(all(type(item) is int and 0 <= item < len(plan) for item in sequence))
    require(sequence == sorted(set(sequence)))
    require(all(item["operation_id"] == plan[item["sequence"]]["id"] for item in operations))
    require(
        type(usage["input_token_count_requests"]) is int
        and 0 <= usage["input_token_count_requests"] <= len(cases)
    )
    require(
        type(usage["completed"]) is bool
        and usage["completed"] is all(case["failure"] is None for case in cases)
    )
    if usage["completed"]:
        # 임베딩 캐시는 전송을 생략할 수 있다. 답변은 모든 사례에 한 번씩 필요하다.
        require(
            {plan[item]["id"] for item in sequence if plan[item]["kind"] == "answer"}
            == {item["id"] for item in plan if item["kind"] == "answer"}
        )
        require(usage["input_token_count_requests"] == len(cases))
    return {**capture, "completed": usage["completed"], "modelApiCalls": count}


def validate_report(report, spec, capture_hash, *, live=False, recovered=False):
    """해시만 맞는 다른 범위·출처·불완전 집계를 완료 결과로 받지 않는다."""
    require(isinstance(report, dict))
    require(
        report["scope"] == SCOPE
        and report["fixtureSha256"] == spec["dataset"]["fixture_sha256"]
        and report["captureSha256"] == capture_hash
        and report["captureValidated"] is True
        and report["liveExecutionPerformed"] is live
        and report["baselineEligible"] is False
        and report["semanticFaithfulness"] is None
        and report["semanticReviewRequired"] is True
        and report["referenceSource"] == "ai-authored-not-human-reviewed"
        and report["evaluatorSha256"]
        == spec["evaluation"]["files"]["evaluation/support-program-evidence/rag_evaluate.py"]
    )
    execution = report["execution"]
    kind = execution["kind"]
    require(isinstance(capture_hash, str) and re.fullmatch(r"[a-f0-9]{64}", capture_hash))
    require(
        kind in KINDS
        and report["measurementKind"] == ("recorded-live-evaluation" if live else KINDS[kind])
    )
    if live:
        validate_recording(execution, spec)
        require(report["completed"] is True)
    else:
        known = any(
            source_hash == capture_hash and spec["dataset"]["capture_kinds"][name] == kind
            for name, source_hash in spec["dataset"]["captures"].items()
        )
        approved = (
            spec.get("reference_config", {}).get("capture_sha256") == capture_hash
            and kind == "recorded"
        )
        recovered_source = spec.get("recovery_config", {}).get("recorded_execution")
        require(
            known
            or approved
            or (recovered and kind == "recorded" and execution == recovered_source)
        )
    api_files = {
        path: spec["evaluation"]["files"]["backend/ai-service/app/" + path]
        for path in ("support_program_evidence/models.py", "support_program_identity.py")
    }
    require(
        report["apiContractSha256"]
        == sha256(json.dumps(api_files, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    )
    require(
        report["schemaVersion"]
        == f"support-program-rag-report-v{2 if kind == 'integration-stub' else 1}"
    )
    if kind == "synthetic":
        require(
            all(
                execution[key] is None
                for key in ("model", "embeddingModel", "promptSha256", "recorderSha256")
            )
        )
    if kind == "integration-stub":
        require(type(execution["paidModelApiCalls"]) is int and execution["paidModelApiCalls"] == 0)
    cases = report["cases"]
    require([case["caseId"] for case in cases] == spec["dataset"]["case_ids"])
    require(type(report["caseCount"]) is int and report["caseCount"] == len(cases))
    for case in cases:
        require(type(case["retrievalMeasured"]) is bool and type(case["answerMeasured"]) is bool)
        require(not case["answerMeasured"] or case["retrievalMeasured"])
        require((case["failure"] is None) == case["answerMeasured"])
        if case["failure"] is not None:
            require(
                case["failure"]["stage"]
                in {"not_started", "source", "chunk", "index", "search", "answer"}
            )
            require(isinstance(case["failure"]["code"], str) and bool(case["failure"]["code"]))
        for key, measured in (
            ("retrievalRecallAtK", "retrievalMeasured"),
            ("answerCitationRecall", "answerMeasured"),
        ):
            value = case[key]
            require(
                value is None
                or (
                    case[measured]
                    and type(value) in {int, float}
                    and isfinite(value)
                    and 0 <= value <= 1
                )
            )
        require(
            type(case["answerStatusMatches"]) is bool
            if case["answerMeasured"]
            else case["answerStatusMatches"] is None
        )
        if kind == "synthetic":
            require(case["traceId"] is None)
    require(report["completed"] is all(case["answerMeasured"] for case in cases))
    expected_coverage = {
        "retrievalCaseCount": sum(case["retrievalMeasured"] for case in cases),
        "answerCaseCount": sum(case["answerMeasured"] for case in cases),
        "traceCaseCount": sum(case["traceId"] is not None for case in cases),
        "failedCaseCount": sum(case["failure"] is not None for case in cases),
    }
    require(
        report["coverage"] == expected_coverage
        and all(type(v) is int for v in report["coverage"].values())
    )
    require(set(report["metrics"]) == set(METRICS))
    for name, column in zip(METRICS, (*METRICS[:2], "answerStatusMatches"), strict=True):
        metric = report["metrics"][name]
        values = [case[column] for case in cases if case[column] is not None]
        require(
            type(metric["measuredCaseCount"]) is int and metric["measuredCaseCount"] == len(values)
        )
        eligible = metric["eligibleCaseCount"]
        require(type(eligible) is int and len(values) <= eligible <= len(cases))
        if name == "answerStatusAccuracy":
            require(eligible == len(cases))
        value = metric["value"]
        require(
            value is None
            if not values
            else type(value) in {int, float}
            and isfinite(value)
            and isclose(value, sum(values) / len(values), abs_tol=1e-12)
        )
    require(
        report["metrics"][METRICS[0]]["eligibleCaseCount"]
        == report["metrics"][METRICS[1]]["eligibleCaseCount"]
    )


def comparison(current, reference, spec):
    require(
        spec["evaluation_scope"] == SCOPE
        and spec["execution_mode"] in {"replay", "recovery", "live"}
    )
    live = spec["execution_mode"] == "live"
    if not live:
        require(
            not spec["live_config"] and not spec["model_operations"] and spec["generation"] is None
        )
    require(spec["quality_policy"]["definition"] == POLICY)
    validate_report(
        current,
        spec,
        current["captureSha256"] if live else spec["candidate_sha256"],
        live=live,
        recovered=spec["execution_mode"] == "recovery",
    )
    validate_report(reference, spec, spec["reference_sha256"])
    run_id = result_id(
        current["fixtureSha256"], current["captureSha256"], spec["evaluation"]["version"]
    )
    reference_id = result_id(
        reference["fixtureSha256"], reference["captureSha256"], spec["evaluation"]["version"]
    )
    return {
        "schema_version": 3,
        "scope": SCOPE,
        "retrieval_evaluated": True,
        "baseline_eligible": False,
        "comparison": "self-replay" if run_id == reference_id else "candidate-reference",
        "evaluation_run_id": run_id,
        "reference_run_id": reference_id,
        "fixture_sha256": current["fixtureSha256"],
        "case_ids": spec["dataset"]["case_ids"],
        "current": current,
        "reference": reference,
        "cases": [
            {"case_id": case["caseId"], "candidate": {"trace_id": case["traceId"]}}
            for case in current["cases"]
        ],
    }


def read_result(spec, spec_hash, manifest, raw, report):
    value = json.loads(raw)
    require(value == comparison(value["current"], value["reference"], spec))
    require(
        manifest["status"] == "completed"
        and manifest["stage"] == "completed"
        and manifest["scope"] == SCOPE
        and type(manifest["model_api_calls"]) is int
        and manifest["model_api_calls"] == 0
        and manifest["execution_spec_sha256"] == spec_hash
        and manifest["evaluator_version"] == spec["evaluation"]["version"]
        and manifest["fixture_sha256"] == spec["dataset"]["fixture_sha256"]
        and manifest["capture_sha256"] == value["current"]["captureSha256"]
        and manifest["reference_capture_sha256"] == spec["reference_sha256"]
        and manifest["evaluation_run_id"] == value["evaluation_run_id"]
        and manifest["reference_run_id"] == value["reference_run_id"]
        and manifest["artifact_sha256"]["comparison.json"] == sha256(raw).hexdigest()
        and manifest["artifact_sha256"]["report.html"] == sha256(report).hexdigest()
    )
    return value["evaluation_run_id"], value["current"], report, value
