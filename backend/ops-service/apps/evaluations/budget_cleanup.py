"""종료 증거를 조회한 후 미사용 예약만 정리한다. 기본 동작은 쓰기 없는 미리보기다."""

from uuid import UUID

from django.db import transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from . import prefect_client
from .budget import BudgetUnavailable, _close_reservation, call_limits, operation_plan
from .budget_reporting import budget_totals, reservation_data
from .execution_spec import digest
from .models import (
    EvaluationBudget,
    EvaluationBudgetCleanup,
    EvaluationBudgetReservation,
    EvaluationRun,
)


class CleanupUnavailable(ValueError):
    pass


def terminal_evidence(run, remote):
    """외부 본문 전체 대신 고정 식별자와 파라미터 해시만 감사 기록에 보존한다."""
    try:
        parameters = dict(remote["parameters"])
        for key in ("recovery_config", "execution_spec", "execution_spec_sha256"):
            if parameters.get(key) in (None, {}, ""):
                parameters.pop(key, None)
        state = remote["state"]
        stamp = parse_datetime(state["timestamp"])
        if (
            run.execution_mode != "live"
            or not run.execution_spec
            or digest(run.execution_spec) != run.execution_spec_sha256
            or UUID(str(remote["id"])) != run.prefect_flow_run_id
            or remote["idempotency_key"] != f"ops-{run.pk}"
            or digest(parameters) != digest(prefect_client.run_parameters(run))
            or remote["state_type"] not in {"COMPLETED", "FAILED", "CRASHED", "CANCELLED"}
            or state["type"] != remote["state_type"]
            or stamp is None
            or timezone.is_naive(stamp)
        ):
            raise ValueError
        return {
            "source": "PREFECT",
            "flow_id": str(run.prefect_flow_run_id),
            "run_id": str(run.pk),
            "spec_sha256": run.execution_spec_sha256,
            "parameters_sha256": digest(parameters),
            "state_id": str(UUID(str(state["id"]))),
            "state_type": state["type"],
            "state_timestamp": stamp.isoformat(),
            "observed_at": timezone.now().isoformat(),
        }
    except (KeyError, ValueError, TypeError, AttributeError):
        raise CleanupUnavailable("Prefect 종료 상태·요청·실행 명세를 확인할 수 없습니다.") from None


def cleanup_data(record):
    # Worker identity and per-call audit snapshots stay internal to the ledger.
    return {
        "request_id": str(record.request_id),
        "actor": record.actor,
        "source": "CLI",
        "reason": record.reason,
        "evidence": record.evidence,
        "before": record.before,
        "after": record.after,
        "created_at": record.created_at.isoformat(),
    }


def _existing(request_id, run_id, actor, reason):
    record = EvaluationBudgetCleanup.objects.filter(pk=request_id).first()
    if record and (record.reservation_id, record.actor, record.reason) != (run_id, actor, reason):
        raise CleanupUnavailable("같은 정리 요청 ID의 실행·변경자·사유를 바꿀 수 없습니다.")
    return record


def cleanup_reservation(*, run_id, actor, reason, request_id, apply=False):
    run_id, request_id = UUID(str(run_id)), UUID(str(request_id))
    actor, reason = actor.strip(), reason.strip()
    if not 1 <= len(actor) <= 150 or not 1 <= len(reason) <= 1000:
        raise CleanupUnavailable("변경자(1~150자)와 사유(1~1000자)를 입력하세요.")
    previous = _existing(request_id, run_id, actor, reason)
    if previous:
        return {"applied": True, "replayed": True, **cleanup_data(previous)}
    run = EvaluationRun.objects.filter(pk=run_id).first()
    reservation = EvaluationBudgetReservation.objects.filter(run_id=run_id).first()
    if run is None or reservation is None or not run.prefect_flow_run_id:
        raise CleanupUnavailable("실행·예약·Prefect 실행 ID가 모두 있어야 정리할 수 있습니다.")
    if reservation.closed_at:
        previous = _existing(request_id, run_id, actor, reason)
        if previous:
            return {"applied": True, "replayed": True, **cleanup_data(previous)}
        raise CleanupUnavailable("이미 닫힌 예약입니다. 새 정리 이력을 소급 생성하지 않습니다.")
    # No external request holds the database transaction open.
    evidence = terminal_evidence(run, prefect_client.read_run(run.prefect_flow_run_id))
    with transaction.atomic():
        # Same order as cancellation/dispatch: run → global budget → reservation.
        locked_run = EvaluationRun.objects.select_for_update().get(pk=run_id)
        budget = EvaluationBudget.objects.select_for_update().get(pk=reservation.budget_id)
        locked = EvaluationBudgetReservation.objects.select_for_update().get(pk=run_id)
        previous = _existing(request_id, run_id, actor, reason)
        if previous:
            return {"applied": True, "replayed": True, **cleanup_data(previous)}
        if (
            locked.closed_at
            or locked.worker_id != reservation.worker_id
            or locked.max_calls != reservation.max_calls
            or locked.max_output_tokens != reservation.max_output_tokens
            or locked.max_input_tokens != reservation.max_input_tokens
            or locked.reserved_input_tokens != reservation.reserved_input_tokens
            or locked.reserved_output_tokens != reservation.reserved_output_tokens
            or locked.max_calls != locked_run.live_config.get("max_model_calls")
            or locked.max_output_tokens != locked_run.live_config.get("max_output_tokens")
            or locked_run.prefect_flow_run_id != run.prefect_flow_run_id
            or digest(prefect_client.run_parameters(locked_run))
            != digest(prefect_client.run_parameters(run))
        ):
            raise CleanupUnavailable("조회 중 실행·소유자·예약이 변경됐습니다. 다시 확인하세요.")
        totals = budget_totals(budget)
        if (
            any(value < 0 for value in totals.values())
            or totals["allocated_calls"] != budget.allocated_calls
            or totals["allocated_output_tokens"] != budget.allocated_output_tokens
            or totals["allocated_input_tokens"] != budget.allocated_input_tokens
            or budget.allocated_calls > budget.call_limit
            or budget.allocated_output_tokens > budget.output_token_limit
        ):
            raise CleanupUnavailable("전체 예산과 상세 장부가 일치하지 않아 정리를 거절했습니다.")
        calls = list(locked.calls.order_by("sequence"))
        try:
            plan = operation_plan(locked_run)
        except BudgetUnavailable:
            raise CleanupUnavailable("실행 작업 명세를 확인할 수 없습니다.") from None
        if (
            (
                locked_run.execution_spec.get("evaluation_scope")
                != "source-chunks-retrieval-answer"
                and [call.sequence for call in calls] != list(range(len(calls)))
            )
            or (plan is not None and len(plan) != locked.max_calls)
            or any(
                call.sequence >= locked.max_calls
                or (plan is not None and call.operation_id != plan[call.sequence]["id"])
                for call in calls
            )
            or len(calls) > locked.max_calls
            or (calls and locked.worker_id is None)
            or any(
                call.settled_at
                and (
                    call.output_tokens > call_limits(call)[1]
                    or (
                        call_limits(call)[0] is not None
                        and call.input_tokens > call_limits(call)[0]
                    )
                )
                for call in calls
            )
        ):
            raise CleanupUnavailable("소유자·호출 번호·출력 장부를 확인할 수 없습니다.")
        breakdown = reservation_data(locked)["breakdown"]
        returned_calls = breakdown["unapproved_calls"]
        returned_output = (
            breakdown["unapproved_output_tokens"] + breakdown["pending_release_output_tokens"]
        )
        returned_input = (
            breakdown["unapproved_input_tokens"] + breakdown["pending_release_input_tokens"]
        )
        before = {
            "global_calls": budget.allocated_calls,
            "global_output_tokens": budget.allocated_output_tokens,
            "global_input_tokens": budget.allocated_input_tokens,
            "reservation_input_tokens": breakdown["allocated_input_tokens"],
            "reservation_calls": breakdown["allocated_calls"],
            "reservation_output_tokens": breakdown["allocated_output_tokens"],
        }
        after = {
            "global_calls": before["global_calls"] - returned_calls,
            "global_output_tokens": before["global_output_tokens"] - returned_output,
            "global_input_tokens": before["global_input_tokens"] - returned_input,
            "reservation_input_tokens": before["reservation_input_tokens"] - returned_input,
            "reservation_calls": before["reservation_calls"] - returned_calls,
            "reservation_output_tokens": before["reservation_output_tokens"] - returned_output,
            "unknown_calls": breakdown["unknown_calls"],
            "unknown_output_tokens": breakdown["unknown_output_tokens"],
        }
        record = EvaluationBudgetCleanup(
            request_id=request_id,
            reservation=locked,
            actor=actor,
            reason=reason,
            evidence=evidence,
            worker_id=locked.worker_id,
            calls=[
                {
                    "sequence": call.sequence,
                    "authorized_at": call.authorized_at.isoformat(),
                    "settled_at": call.settled_at.isoformat() if call.settled_at else None,
                    "input_tokens": call.input_tokens,
                    "output_tokens": call.output_tokens,
                }
                for call in calls
            ],
            before=before,
            after=after,
            created_at=timezone.now(),
        )
        if apply:
            _close_reservation(budget, locked)
            record.save(force_insert=True)
        return {"applied": apply, "replayed": False, **cleanup_data(record)}
