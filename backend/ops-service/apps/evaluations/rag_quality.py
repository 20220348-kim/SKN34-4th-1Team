"""RAG 자료·검토·정책 스냅샷에 고정된 품질 점검 이력을 저장한다."""

from hashlib import sha256
from pathlib import Path

from django.db import transaction

from . import rag_quality_policy
from .execution_spec import digest
from .models import QualityAssessment
from .rag_reviews import locked_run, review_state
from .services import RequestConflict

REASONS = {
    "REFERENCE_REVIEW_REQUIRED": (
        "RAG 원문·참조 조건의 사람 검토 승인 절차가 필요해 합격은 보류됩니다."
    ),
    "NON_MODEL_CAPTURE": "합성·무료 대역 캡처는 현재 모델 품질이나 비교 기준의 근거가 아닙니다.",
    "SOURCE_EXECUTION_FAILED": (
        "원본 실행 실패가 있습니다. 미측정 항목을 품질 부적합으로 대체하지 않습니다."
    ),
    "NOT_MEASURED": "이 항목은 미측정입니다.",
    "HUMAN_UNSUITABLE": "현재 자료의 사람 검토에서 부적합으로 판단됐습니다.",
    "CASE_REVIEW_REQUIRED": "현재 자료의 사람 검토가 없거나 판단 보류 상태입니다.",
}


def assessment_inputs(run, state):
    material = state["material"]
    current = {row["case_id"]: row for row in state["case_reviews"] if row["is_current"]}
    cases = []
    for case in material["cases"]:
        review = current.get(case["case_id"])
        saved = case["candidate"]
        cases.append(
            {
                "case_id": case["case_id"],
                "review": {**review, "created_at": review["created_at"].isoformat()}
                if review
                else None,
                "failure": saved["failure"],
                "dimensions": {
                    name: {
                        "measured": saved[
                            "retrieved_chunk_ids" if name == "retrieval" else "answer"
                        ]
                        is not None,
                        "decision": review[f"{name}_decision"] if review else None,
                    }
                    for name in rag_quality_policy.POLICY["dimensions"]
                },
            }
        )
    return {
        "policy": {
            "definition": rag_quality_policy.POLICY,
            "code_sha256": sha256(Path(rag_quality_policy.__file__).read_bytes()).hexdigest(),
        },
        "assessment_code_sha256": sha256(Path(__file__).read_bytes()).hexdigest(),
        "evaluation_scope": material["evaluation_scope"],
        "execution_spec_sha256": run.execution_spec_sha256,
        "accepted_policy_sha256": digest(run.execution_spec.get("quality_policy")),
        **{
            key: material[key]
            for key in (
                "material_sha256",
                "fixture_sha256",
                "candidate_capture_sha256",
                "reference_capture_sha256",
            )
        },
        "reference_source": material["reference_source"],
        "measurement_kind": material["candidate_measurement_kind"],
        "review_version": state["review_version"],
        "rubric": state["rubric"],
        "cases": cases,
    }


def assessment_data(record):
    return {
        "id": record.pk,
        "status": record.status,
        "policy": record.policy,
        "policy_sha256": record.policy_sha256,
        "input_sha256": record.input_sha256,
        "inputs": record.inputs,
        "reasons": [
            {**reason, "message": REASONS.get(reason["code"], reason["code"])}
            for reason in record.reasons
        ],
        "assessed_by": record.assessed_by.email or record.assessed_by.get_username(),
        "created_at": record.created_at,
    }


def quality_state(run, state):
    # 호출자의 실행 행 잠금 안에서 검토 버전과 판정 이력을 함께 읽는다.
    inputs = assessment_inputs(run, state)
    fingerprint = digest(inputs)
    history = list(run.assessments.select_related("assessed_by"))
    current = next((row for row in history if row.input_sha256 == fingerprint), None)
    return {
        "status": current.status if current else "NOT_EVALUATED",
        "is_current": current is not None,
        "current_id": current.pk if current else None,
        "input_sha256": fingerprint,
        "policy": inputs["policy"],
        "baseline_eligible": False,
        "history": [assessment_data(row) for row in history],
    }


def assess(run, user, input_sha256):
    state = review_state(run, user)
    with transaction.atomic():
        locked = locked_run(run)
        if locked.review_version != state["review_version"]:
            raise RequestConflict
        inputs = assessment_inputs(locked, state)
        if digest(inputs) != input_sha256:
            raise RequestConflict
        status, reasons = rag_quality_policy.judge(inputs)
        record, _ = QualityAssessment.objects.get_or_create(
            run=locked,
            input_sha256=input_sha256,
            defaults={
                "policy": inputs["policy"],
                "policy_sha256": digest(inputs["policy"]),
                "inputs": inputs,
                "status": status,
                "reasons": reasons,
                "assessed_by": user,
            },
        )
        return record
