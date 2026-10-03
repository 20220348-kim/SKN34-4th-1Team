"""예약 도입 전 완료 실행의 저장 사용량을 검토 후 누적 장부에 한 번 반영한다."""

import json
import re
from hashlib import sha256
from uuid import UUID

from django.db import transaction

from .artifact_store import ResultsUnavailable, read_artifact
from .budget_reporting import budget_totals, legacy_usage_data
from .execution_spec import digest
from .models import (
    EvaluationBudget,
    EvaluationBudgetReservation,
    EvaluationLegacyUsage,
    EvaluationRun,
)
from .services import read_candidate

MAX_INTEGER = 2**53 - 1


class LegacyUsageUnavailable(ValueError):
    pass


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate evidence field")
        result[key] = value
    return result


def capture_usage(capture, calls, max_output):
    """호출 누락·부분 응답·불명 사용량을 0으로 바꾸지 않는다."""
    try:
        responses = capture["apiResponses"]
        cases = capture["cases"]
        case_ids = capture["caseIds"]
        if (
            type(calls) is not int
            or not 1 <= calls <= 512
            or type(max_output) is not int
            or not 1 <= max_output <= MAX_INTEGER
            or type(capture["modelApiCalls"]) is not int
            or capture["modelApiCalls"] != calls
            or capture["completed"] is not True
            or len(responses) != calls
            or not case_ids
            or len(set(case_ids)) != len(case_ids)
            or [case["caseId"] for case in cases] != case_ids
            or any(case["outcome"] != "success" for case in cases)
            or any(not case["apiResponseIndexes"] for case in cases)
        ):
            raise ValueError
        indexes = [index for case in cases for index in case["apiResponseIndexes"]]
        if any(type(index) is not int for index in indexes) or sorted(indexes) != list(
            range(calls)
        ):
            raise ValueError
        input_tokens = output_tokens = 0
        for response in responses:
            usage = response["usage"]
            if (
                response["httpStatus"] != 200
                or response["responseStatus"] != "completed"
                or any(
                    type(usage[key]) is not int or not 0 <= usage[key] <= MAX_INTEGER
                    for key in ("input_tokens", "output_tokens", "total_tokens")
                )
                or usage["total_tokens"] != usage["input_tokens"] + usage["output_tokens"]
                or usage["output_tokens"] > max_output
            ):
                raise ValueError
            input_tokens += usage["input_tokens"]
            output_tokens += usage["output_tokens"]
        if max(input_tokens, output_tokens) > MAX_INTEGER:
            raise ValueError
        return {"calls": calls, "input_tokens": input_tokens, "output_tokens": output_tokens}
    except (KeyError, TypeError, ValueError, AttributeError):
        raise LegacyUsageUnavailable(
            "모든 호출의 완료 응답·사용량·사례 연결을 확인해야 합니다."
        ) from None


def _identity(run):
    return {
        "run_id": str(run.pk),
        "dataset_id": run.dataset_id,
        "status": run.status,
        "error_code": run.error_code,
        "execution_mode": run.execution_mode,
        "execution_spec": run.execution_spec,
        "execution_spec_sha256": run.execution_spec_sha256,
        "flow_id": str(run.prefect_flow_run_id),
        "evaluation_run_id": run.evaluation_run_id,
        "source_run_id": str(run.source_run_id) if run.source_run_id else None,
        "live_config": run.live_config,
        "model_api_calls": run.model_api_calls,
    }


def _eligible(run):
    if (
        run is None
        or run.status != "COMPLETED"
        or run.error_code
        or run.execution_mode != "live"
        or run.execution_spec
        or run.execution_spec_sha256
        or run.source_run_id
        or not run.prefect_flow_run_id
    ):
        raise LegacyUsageUnavailable("예약·실행 명세 도입 전 완료된 원본 live 실행만 대상입니다.")


def _previous(request_id, run_id, actor, reason, evidence_sha256, authenticated_actor_id):
    record = EvaluationLegacyUsage.objects.filter(request_id=request_id).first()
    if record and (
        record.run_id,
        record.actor,
        record.reason,
        record.evidence_sha256,
        record.authenticated_actor_id,
    ) != (
        run_id,
        actor,
        reason,
        evidence_sha256,
        authenticated_actor_id,
    ):
        raise LegacyUsageUnavailable("같은 요청 ID의 실행·담당자·사유·증거를 바꿀 수 없습니다.")
    return record


def reconcile_legacy_usage(
    *,
    run_id,
    actor,
    reason,
    request_id,
    evidence_sha256=None,
    apply=False,
    authenticated_actor=None,
):
    run_id, request_id = UUID(str(run_id)), UUID(str(request_id))
    if authenticated_actor is not None:
        actor = authenticated_actor.get_username()
    actor_id = authenticated_actor.pk if authenticated_actor is not None else None
    if (
        not isinstance(actor, str)
        or not isinstance(reason, str)
        or not 1 <= len(actor.strip()) <= 150
        or not 1 <= len(reason.strip()) <= 1000
        or type(apply) is not bool
        or (
            evidence_sha256 is not None
            and (
                not isinstance(evidence_sha256, str)
                or not re.fullmatch(r"[a-f0-9]{64}", evidence_sha256)
            )
        )
        or (apply and evidence_sha256 is None)
    ):
        raise LegacyUsageUnavailable("담당자·사유와 적용할 미리보기 증거 해시를 확인하세요.")
    actor, reason = actor.strip(), reason.strip()
    previous = _previous(request_id, run_id, actor, reason, evidence_sha256, actor_id)
    if previous:
        return {"applied": True, "replayed": True, **legacy_usage_data(previous)}
    run = EvaluationRun.objects.filter(pk=run_id).first()
    _eligible(run)
    identity = _identity(run)
    # 로컬/HTTP 파일 읽기와 결과 무결성 검증은 DB 잠금 밖에서 수행한다.
    try:
        raw = read_artifact(run_id, "capture/capture.json")
        capture = json.loads(raw, object_pairs_hook=_unique_object)
        _, verified_hash, _ = read_candidate(run)
        if sha256(raw).hexdigest() != verified_hash:
            raise ValueError
        usage = capture_usage(capture, run.model_api_calls, run.live_config["max_output_tokens"])
        if usage["calls"] != run.live_config["max_model_calls"]:
            raise ValueError
    except (ResultsUnavailable, KeyError, ValueError, TypeError):
        raise LegacyUsageUnavailable(
            "저장 결과의 무결성과 전체 호출 사용량을 확인할 수 없습니다."
        ) from None
    evidence = {
        "schema_version": 1,
        "source": "SAVED_CAPTURE",
        "provider_receipt_verified": False,
        "identity": identity,
        "capture_sha256": verified_hash,
        "usage": usage,
    }
    fingerprint = digest(evidence)
    if evidence_sha256 is not None and fingerprint != evidence_sha256:
        raise LegacyUsageUnavailable("미리보기 이후 실행 또는 사용량 증거가 변경됐습니다.")
    with transaction.atomic():
        locked = EvaluationRun.objects.select_for_update().get(pk=run_id)
        budget = EvaluationBudget.objects.select_for_update().filter(pk=1).first()
        previous = _previous(request_id, run_id, actor, reason, evidence_sha256, actor_id)
        if previous:
            return {"applied": True, "replayed": True, **legacy_usage_data(previous)}
        _eligible(locked)
        if (
            identity != _identity(locked)
            or EvaluationBudgetReservation.objects.filter(run_id=run_id).exists()
            or EvaluationLegacyUsage.objects.filter(run_id=run_id).exists()
            or EvaluationLegacyUsage.objects.filter(capture_sha256=verified_hash).exists()
        ):
            raise LegacyUsageUnavailable("실행이 변경됐거나 이미 예약·사용량 반영 기록이 있습니다.")
        blockers = []
        before = after = None
        if budget is None:
            blockers.append("먼저 운영자가 승인한 호출·출력 누적 한도를 설정하세요.")
        else:
            totals = budget_totals(budget)
            before = {key: getattr(budget, "allocated_" + key) for key in usage}
            after = {key: before[key] + value for key, value in usage.items()}
            if any(value < 0 for value in totals.values()) or any(
                totals["allocated_" + key] != before[key] for key in usage
            ):
                blockers.append("전체 예산과 상세 장부가 일치하지 않습니다.")
            for key, limit in (
                ("calls", budget.call_limit),
                ("output_tokens", budget.output_token_limit),
                ("input_tokens", budget.input_token_limit),
            ):
                if after[key] > MAX_INTEGER or (limit is not None and after[key] > limit):
                    blockers.append("현재 누적 한도가 과거 사용량을 포함하기에 부족합니다.")
                    break
        preview = {
            "applied": False,
            "replayed": False,
            "can_apply": not blockers,
            "blockers": blockers,
            "request_id": str(request_id),
            "run_id": str(run_id),
            "actor": actor,
            "reason": reason,
            "source": "SAVED_CAPTURE",
            "provider_receipt_verified": False,
            "evidence_sha256": fingerprint,
            "evidence": evidence,
            "usage": usage,
            "before": before,
            "after": after,
        }
        if not apply:
            return preview
        if blockers:
            raise LegacyUsageUnavailable(" ".join(blockers))
        record = EvaluationLegacyUsage.objects.create(
            run=locked,
            budget=budget,
            request_id=request_id,
            actor=actor,
            actor_source="CORE_ADMIN" if authenticated_actor is not None else "CLI",
            authenticated_actor=authenticated_actor,
            reason=reason,
            capture_sha256=verified_hash,
            evidence_sha256=fingerprint,
            evidence=evidence,
            before=before,
            after=after,
            **usage,
        )
        for key, value in after.items():
            setattr(budget, "allocated_" + key, value)
        budget.save(update_fields=[*("allocated_" + key for key in usage), "updated_at"])
        return {"applied": True, "replayed": False, **legacy_usage_data(record)}
