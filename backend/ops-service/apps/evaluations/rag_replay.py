"""무료 RAG 재계산 결과 계약. Django와 평가 실행기가 SDK 없이 함께 검증한다."""

import json
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


def validate_report(report, spec, capture_hash):
    """해시만 맞는 다른 범위·출처·불완전 집계를 완료 결과로 받지 않는다."""
    require(isinstance(report, dict))
    require(
        report["scope"] == SCOPE
        and report["fixtureSha256"] == spec["dataset"]["fixture_sha256"]
        and report["captureSha256"] == capture_hash
        and report["captureValidated"] is True
        and report["liveExecutionPerformed"] is False
        and report["baselineEligible"] is False
        and report["semanticFaithfulness"] is None
        and report["semanticReviewRequired"] is True
        and report["referenceSource"] == "ai-authored-not-human-reviewed"
        and report["evaluatorSha256"]
        == spec["evaluation"]["files"]["evaluation/support-program-evidence/rag_evaluate.py"]
    )
    execution = report["execution"]
    kind = execution["kind"]
    require(kind in KINDS and report["measurementKind"] == KINDS[kind])
    require(
        any(
            source_hash == capture_hash and spec["dataset"]["capture_kinds"][name] == kind
            for name, source_hash in spec["dataset"]["captures"].items()
        )
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
    require(spec["evaluation_scope"] == SCOPE and spec["execution_mode"] in {"replay", "recovery"})
    require(not spec["live_config"] and not spec["model_operations"] and spec["generation"] is None)
    require(spec["quality_policy"]["definition"] == POLICY)
    validate_report(current, spec, spec["candidate_sha256"])
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
        and manifest["capture_sha256"] == spec["candidate_sha256"]
        and manifest["reference_capture_sha256"] == spec["reference_sha256"]
        and manifest["evaluation_run_id"] == value["evaluation_run_id"]
        and manifest["reference_run_id"] == value["reference_run_id"]
        and manifest["artifact_sha256"]["comparison.json"] == sha256(raw).hexdigest()
        and manifest["artifact_sha256"]["report.html"] == sha256(report).hexdigest()
    )
    return value["evaluation_run_id"], value["current"], report, value
