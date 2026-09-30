"""서명된 실행기 응답 사용량만 닫힌 예약에 보정한다. 원래 호출 행은 변경하지 않는다."""

import hashlib
import hmac
import json
import re
from uuid import UUID

from django.conf import settings
from django.db import transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from .budget import BudgetUnavailable, call_limits, operation_plan, validate_usage
from .budget_reporting import ledger_totals, reservation_data
from .execution_spec import digest
from .models import (
    EvaluationBudget,
    EvaluationBudgetReservation,
    EvaluationRun,
    EvaluationUsageCorrection,
)


class CorrectionUnavailable(ValueError):
    pass


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError
        result[key] = value
    return result


def read_receipt(run_id, sequence):
    """고정 결과 경로만 읽는다. 업로드/원격 조회·모델 호출·임의 파일 경로를 허용하지 않는다."""
    try:
        root = settings.LLMOPS_RESULTS_DIR.resolve(strict=True)
        path = root
        for part in (str(run_id), "capture", f"usage-{sequence}.json"):
            path = path / part
            if path.is_symlink():
                raise ValueError
        if not path.resolve(strict=True).is_relative_to(root):
            raise ValueError
        with path.open("rb") as stream:
            raw = stream.read(8193)
        if len(raw) > 8192:
            raise ValueError
        envelope = json.loads(raw, object_pairs_hook=_unique_object)
        if set(envelope) != {"payload", "signature"} or len(settings.LLMOPS_BUDGET_TOKEN) < 32:
            raise ValueError
        payload = envelope["payload"]
        version = payload.get("version")
        if type(version) is not int or version not in {1, 2}:
            raise ValueError
        canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        signature = hmac.new(
            settings.LLMOPS_BUDGET_TOKEN.encode(),
            f"govbiz-budget-usage-v{version}\n".encode() + canonical,
            hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(signature, envelope["signature"]):
            raise ValueError
        fields = {
            "version",
            "source",
            "run_id",
            "worker_id",
            "flow_id",
            "spec_hash",
            "sequence",
            "model",
            "max_output_tokens",
            "usage",
            "observed_at",
        }
        fields |= (
            {"response_id", "response_status"}
            if version == 1
            else {
                "operation_id",
                "operation_kind",
                "dimensions",
                "input_sha256",
                "max_input_tokens",
                "provider_request_id",
            }
        )
        if (
            set(payload) != fields
            or payload["source"]
            != ("WORKER_RESPONSE" if version == 1 else "WORKER_EMBEDDING_RESPONSE")
            or type(payload["sequence"]) is not int
            or not 0 <= payload["sequence"] <= 511
            or payload["sequence"] != sequence
            or payload["run_id"] != str(run_id)
            or type(payload["max_output_tokens"]) is not int
            or not re.fullmatch(r"[a-f0-9]{64}", payload["spec_hash"])
        ):
            raise ValueError
        if version == 1:
            if not re.fullmatch(r"resp_[A-Za-z0-9_-]{1,180}", payload["response_id"]) or payload[
                "response_status"
            ] not in {"completed", "incomplete", "failed", "cancelled"}:
                raise ValueError
        else:
            kind = payload["operation_kind"]
            if (
                kind not in {"document_embedding", "query_embedding"}
                or not re.fullmatch(
                    kind + r":[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}", payload["operation_id"]
                )
                or payload["model"] not in {"text-embedding-3-small", "text-embedding-3-large"}
                or type(payload["dimensions"]) is not int
                or not 1
                <= payload["dimensions"]
                <= (1536 if payload["model"].endswith("small") else 3072)
                or not re.fullmatch(r"[a-f0-9]{64}", payload["input_sha256"])
                or type(payload["max_input_tokens"]) is not int
                or not 1 <= payload["max_input_tokens"] <= 262112
                or payload["max_output_tokens"] != 0
                or not re.fullmatch(
                    r"[A-Za-z0-9][A-Za-z0-9_-]{0,199}", payload["provider_request_id"]
                )
            ):
                raise ValueError
        for key in ("worker_id", "flow_id"):
            if str(UUID(payload[key])) != payload[key]:
                raise ValueError
        stamp = parse_datetime(payload["observed_at"])
        if stamp is None or timezone.is_naive(stamp):
            raise ValueError
        validate_usage(
            payload["usage"], payload["max_output_tokens"], payload.get("max_input_tokens")
        )
        return raw.decode("utf-8"), hashlib.sha256(raw).hexdigest(), payload, stamp
    except (OSError, ValueError, TypeError, KeyError, AttributeError, BudgetUnavailable):
        raise CorrectionUnavailable("사용량 증거의 파일·서명·계약을 확인할 수 없습니다.") from None


def correction_data(record):
    return {
        "request_id": str(record.request_id),
        "run_id": str(record.call.reservation_id),
        "sequence": record.call.sequence,
        "source": "WORKER_EMBEDDING_RESPONSE" if record.provider_request_id else "WORKER_RESPONSE",
        **(
            {"provider_request_id": record.provider_request_id}
            if record.provider_request_id
            else {}
        ),
        "actor": record.actor,
        "reason": record.reason,
        "evidence_sha256": record.evidence_sha256,
        "response_id": record.response_id,
        "input_tokens": record.input_tokens,
        "output_tokens": record.output_tokens,
        "before": record.before,
        "after": record.after,
        "created_at": record.created_at.isoformat(),
    }


def _existing(request_id, run_id, sequence, actor, reason, evidence_sha256):
    previous = (
        EvaluationUsageCorrection.objects.select_related("call").filter(pk=request_id).first()
    )
    if previous and (
        previous.call.reservation_id,
        previous.call.sequence,
        previous.actor,
        previous.reason,
        previous.evidence_sha256,
    ) != (run_id, sequence, actor, reason, evidence_sha256):
        raise CorrectionUnavailable(
            "같은 보정 요청 ID의 실행·호출·담당자·사유·증거를 바꿀 수 없습니다."
        )
    return previous


def correct_usage(
    *, run_id, sequence, actor, reason, request_id, evidence_sha256=None, apply=False
):
    run_id, request_id = UUID(str(run_id)), UUID(str(request_id))
    actor, reason = actor.strip(), reason.strip()
    if (
        type(sequence) is not int
        or not 0 <= sequence <= 511
        or not 1 <= len(actor) <= 150
        or not 1 <= len(reason) <= 1000
        or (evidence_sha256 is not None and not re.fullmatch(r"[a-f0-9]{64}", evidence_sha256))
        or (apply and evidence_sha256 is None)
    ):
        raise CorrectionUnavailable(
            "호출 번호·담당자·사유를 확인하고 적용 시 미리보기 증거 해시를 지정하세요."
        )
    previous = _existing(request_id, run_id, sequence, actor, reason, evidence_sha256)
    if previous:
        return {"applied": True, "replayed": True, **correction_data(previous)}
    # File I/O and signature verification never hold database locks.
    raw, evidence_hash, evidence, observed_at = read_receipt(run_id, sequence)
    if evidence_sha256 is not None and evidence_sha256 != evidence_hash:
        raise CorrectionUnavailable("미리보기 이후 사용량 증거가 변경됐습니다.")
    with transaction.atomic():
        run = EvaluationRun.objects.select_for_update().filter(pk=run_id).first()
        budget = EvaluationBudget.objects.select_for_update().filter(pk=1).first()
        reservation = (
            EvaluationBudgetReservation.objects.select_for_update().filter(pk=run_id).first()
        )
        previous = _existing(request_id, run_id, sequence, actor, reason, evidence_sha256)
        if previous:
            return {"applied": True, "replayed": True, **correction_data(previous)}
        if (
            run is None
            or budget is None
            or reservation is None
            or reservation.closed_at is None
            or reservation.budget_id != budget.pk
            or run.execution_mode != "live"
            or not run.execution_spec
            or digest(run.execution_spec) != run.execution_spec_sha256
            or evidence["spec_hash"] != run.execution_spec_sha256
            or evidence["flow_id"] != str(run.prefect_flow_run_id)
            or evidence["worker_id"] != str(reservation.worker_id)
            or reservation.max_input_tokens != run.live_config.get("max_input_tokens")
            or reservation.max_calls != run.live_config.get("max_model_calls")
            or reservation.max_output_tokens != run.live_config.get("max_output_tokens")
        ):
            raise CorrectionUnavailable("닫힌 예약의 실행·소유자·명세와 증거가 일치해야 합니다.")
        calls = list(reservation.calls.select_related("correction").order_by("sequence"))
        try:
            plan = operation_plan(run)
        except BudgetUnavailable:
            raise CorrectionUnavailable("실행 작업 명세를 확인할 수 없습니다.") from None
        if (
            (
                run.execution_spec.get("evaluation_scope") != "source-chunks-retrieval-answer"
                and [call.sequence for call in calls] != list(range(len(calls)))
            )
            or (plan is not None and len(plan) != reservation.max_calls)
            or len(calls) > reservation.max_calls
            or not any(call.sequence == sequence for call in calls)
            or any(
                call.sequence >= reservation.max_calls
                or (plan is not None and call.operation_id != plan[call.sequence]["id"])
                for call in calls
            )
        ):
            raise CorrectionUnavailable("승인된 호출 번호를 확인할 수 없습니다.")
        call = next(call for call in calls if call.sequence == sequence)
        input_cap, output_cap = call_limits(call)
        item = plan[sequence] if plan is not None else None
        if evidence["version"] == 1:
            if (
                evidence["max_output_tokens"] != output_cap
                or evidence["model"] != run.live_config.get("model")
                or (item is not None and item["kind"] != "answer")
            ):
                raise CorrectionUnavailable("답변 생성 응답의 승인 상한과 증거가 일치해야 합니다.")
        elif (
            item is None
            or item["kind"] == "answer"
            or evidence["operation_id"] != call.operation_id
            or evidence["operation_kind"] != item["kind"]
            or evidence["model"] != item["model"]
            or evidence["dimensions"] != item["dimensions"]
            or evidence["input_sha256"] != item["input_sha256"]
            or evidence["max_input_tokens"] != input_cap
            or input_cap != item["max_input_tokens"]
            or evidence["max_output_tokens"] != output_cap
            or output_cap != item["max_output_tokens"]
        ):
            raise CorrectionUnavailable("임베딩 배치의 승인 명세·상한과 증거가 일치해야 합니다.")
        if call.settled_at or hasattr(call, "correction"):
            raise CorrectionUnavailable(
                "이미 정산·보정된 호출입니다. 원래 보정 요청 ID를 재사용하세요."
            )
        if not call.authorized_at <= observed_at <= reservation.closed_at:
            raise CorrectionUnavailable("사용량 관측 시각이 승인과 예약 종료 사이에 있어야 합니다.")
        identity = (
            {"response_id": evidence["response_id"]}
            if evidence["version"] == 1
            else {"provider_request_id": evidence["provider_request_id"]}
        )
        if EvaluationUsageCorrection.objects.filter(**identity).exists():
            raise CorrectionUnavailable("이미 다른 호출에 반영한 응답 증거입니다.")
        if EvaluationUsageCorrection.objects.filter(evidence_sha256=evidence_hash).exists():
            raise CorrectionUnavailable("이미 반영한 사용량 증거입니다.")
        totals = ledger_totals(EvaluationBudgetReservation.objects.filter(budget=budget))
        if (
            any(value < 0 for value in totals.values())
            or totals["allocated_calls"] != budget.allocated_calls
            or totals["allocated_output_tokens"] != budget.allocated_output_tokens
            or totals["allocated_input_tokens"] != budget.allocated_input_tokens
            or budget.allocated_calls > budget.call_limit
            or budget.allocated_output_tokens > budget.output_token_limit
        ):
            raise CorrectionUnavailable(
                "전체 예산과 상세 장부가 일치하지 않아 보정을 거절했습니다."
            )
        try:
            input_tokens, output_tokens = validate_usage(evidence["usage"], output_cap, input_cap)
        except BudgetUnavailable:
            raise CorrectionUnavailable(
                "증거의 사용량이 예약한 입력·출력 상한을 초과합니다."
            ) from None
        released = output_cap - output_tokens
        input_delta = input_tokens - (input_cap or 0)
        breakdown = reservation_data(reservation)["breakdown"]
        before = {
            "global_calls": budget.allocated_calls,
            "global_output_tokens": budget.allocated_output_tokens,
            "global_input_tokens": budget.allocated_input_tokens,
            "reservation_input_tokens": breakdown["allocated_input_tokens"],
            "reservation_calls": breakdown["allocated_calls"],
            "reservation_output_tokens": breakdown["allocated_output_tokens"],
            "unknown_calls": breakdown["unknown_calls"],
            "unknown_output_tokens": breakdown["unknown_output_tokens"],
        }
        after = {
            **before,
            "global_output_tokens": before["global_output_tokens"] - released,
            "global_input_tokens": before["global_input_tokens"] + input_delta,
            "reservation_input_tokens": before["reservation_input_tokens"] + input_delta,
            "reservation_output_tokens": before["reservation_output_tokens"] - released,
            "unknown_calls": before["unknown_calls"] - 1,
            "unknown_output_tokens": before["unknown_output_tokens"] - output_cap,
        }
        record = EvaluationUsageCorrection(
            request_id=request_id,
            call=call,
            actor=actor,
            reason=reason,
            evidence_sha256=evidence_hash,
            evidence_raw=raw,
            response_id=evidence.get("response_id"),
            provider_request_id=evidence.get("provider_request_id"),
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            original_call={
                "worker_id": str(reservation.worker_id),
                "sequence": sequence,
                "operation_id": call.operation_id,
                "max_input_tokens": input_cap,
                "max_output_tokens": output_cap,
                "authorized_at": call.authorized_at.isoformat(),
                "settled_at": None,
                "input_tokens": call.input_tokens,
                "output_tokens": call.output_tokens,
            },
            before=before,
            after=after,
            created_at=timezone.now(),
        )
        if apply:
            budget.allocated_output_tokens = after["global_output_tokens"]
            budget.allocated_input_tokens = after["global_input_tokens"]
            budget.save(
                update_fields=["allocated_output_tokens", "allocated_input_tokens", "updated_at"]
            )
            record.save(force_insert=True)
        return {"applied": apply, "replayed": False, **correction_data(record)}
