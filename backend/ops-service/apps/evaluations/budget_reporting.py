"""관리자용 예산 장부 조회와 CLI 한도 변경 감사. 모델 호출·예약 환급은 하지 않는다."""

from uuid import UUID

from django.db import transaction
from django.db.models import Count, F, Q, Sum

from .models import (
    EvaluationBudget,
    EvaluationBudgetCall,
    EvaluationBudgetChange,
    EvaluationBudgetReservation,
    EvaluationRun,
)


def ledger_totals(reservations):
    """정산해도 close 전에는 출력 차액이 반환되지 않는 기존 장부 계약을 계산한다."""
    opened = reservations.filter(closed_at__isnull=True).aggregate(
        calls=Sum("max_calls", default=0),
        output=Sum(F("max_calls") * F("max_output_tokens"), default=0),
    )
    calls = EvaluationBudgetCall.objects.filter(reservation__in=reservations)
    settled = Q(settled_at__isnull=False)
    open_call = Q(reservation__closed_at__isnull=True)
    counts = calls.aggregate(
        settled_calls=Count("pk", filter=settled),
        confirmed_input_tokens=Sum("input_tokens", filter=settled, default=0),
        confirmed_output_tokens=Sum("output_tokens", filter=settled, default=0),
        unknown_calls=Count("pk", filter=~settled),
        unknown_output_tokens=Sum("reservation__max_output_tokens", filter=~settled, default=0),
        open_calls=Count("pk", filter=open_call),
        open_output=Sum("reservation__max_output_tokens", filter=open_call, default=0),
        open_settled_capacity=Sum(
            "reservation__max_output_tokens", filter=open_call & settled, default=0
        ),
        open_settled_output=Sum("output_tokens", filter=open_call & settled, default=0),
    )
    # Subtract in Python: MySQL's unsigned subtraction can fail on inconsistent historical rows.
    counts["unapproved_calls"] = opened["calls"] - counts.pop("open_calls")
    counts["unapproved_output_tokens"] = opened["output"] - counts.pop("open_output")
    counts["pending_release_output_tokens"] = counts.pop("open_settled_capacity") - counts.pop(
        "open_settled_output"
    )
    counts["allocated_calls"] = (
        counts["settled_calls"] + counts["unknown_calls"] + counts["unapproved_calls"]
    )
    counts["allocated_output_tokens"] = sum(
        counts[key]
        for key in (
            "confirmed_output_tokens",
            "unknown_output_tokens",
            "unapproved_output_tokens",
            "pending_release_output_tokens",
        )
    )
    return counts


def change_data(change):
    return {
        "request_id": str(change.request_id),
        "actor": change.actor,
        "source": change.source,
        "reason": change.reason,
        "previous_limits": None
        if change.previous_call_limit is None
        else {
            "calls": change.previous_call_limit,
            "output_tokens": change.previous_output_token_limit,
        },
        "limits": {"calls": change.call_limit, "output_tokens": change.output_token_limit},
        "created_at": change.created_at.isoformat(),
    }


def budget_summary(budget):
    """호출자가 budget 행을 잠근다. 같은 응답의 상세도 잠금 안에서 계산한다."""
    # All reserve/authorize/settle/close/limit writes take this same budget lock first.
    missing = EvaluationRun.objects.filter(
        execution_mode="live", budget_reservation__isnull=True
    ).count()
    if budget is None:
        return {
            "state": "unconfigured",
            "limits": None,
            "allocated": None,
            "remaining": None,
            "breakdown": None,
            "reservation_count": 0,
            "legacy_live_run_count": missing,
            "change_count": 0,
            "recent_changes": [],
        }
    reservations = EvaluationBudgetReservation.objects.filter(budget=budget)
    totals = ledger_totals(reservations)
    consistent = (
        all(value >= 0 for value in totals.values())
        and totals["allocated_calls"] == budget.allocated_calls <= budget.call_limit
        and totals["allocated_output_tokens"]
        == budget.allocated_output_tokens
        <= budget.output_token_limit
    )
    changes = EvaluationBudgetChange.objects.filter(budget=budget)
    return {
        "state": "consistent" if consistent else "inconsistent",
        "limits": {"calls": budget.call_limit, "output_tokens": budget.output_token_limit},
        "allocated": {
            "calls": budget.allocated_calls,
            "output_tokens": budget.allocated_output_tokens,
        },
        "remaining": {
            "calls": budget.call_limit - budget.allocated_calls,
            "output_tokens": budget.output_token_limit - budget.allocated_output_tokens,
        }
        if consistent
        else None,
        "breakdown": totals,
        "reservation_count": reservations.count(),
        "legacy_live_run_count": missing,
        "change_count": changes.count(),
        "recent_changes": [change_data(change) for change in changes[:10]],
    }


def reservation_data(reservation):
    # A page prefetches these calls once. Never expose the worker's identity or bearer token.
    calls = list(reservation.calls.all())
    settled = [call for call in calls if call.settled_at is not None]
    unknown = len(calls) - len(settled)
    unapproved = reservation.max_calls - len(calls) if reservation.closed_at is None else 0
    output = sum(call.output_tokens for call in settled)
    pending = (
        len(settled) * reservation.max_output_tokens - output
        if reservation.closed_at is None
        else 0
    )
    totals = {
        "settled_calls": len(settled),
        "confirmed_input_tokens": sum(call.input_tokens for call in settled),
        "confirmed_output_tokens": output,
        "unknown_calls": unknown,
        "unknown_output_tokens": unknown * reservation.max_output_tokens,
        "unapproved_calls": unapproved,
        "unapproved_output_tokens": unapproved * reservation.max_output_tokens,
        "pending_release_output_tokens": pending,
        "allocated_calls": len(calls) + unapproved,
        "allocated_output_tokens": output
        + (unknown + unapproved) * reservation.max_output_tokens
        + pending,
    }
    return {
        "run_id": str(reservation.run_id),
        "dataset_id": reservation.run.dataset_id,
        "created_at": reservation.created_at.isoformat(),
        "closed_at": reservation.closed_at.isoformat() if reservation.closed_at else None,
        "max_calls": reservation.max_calls,
        "max_output_tokens": reservation.max_output_tokens,
        "breakdown": totals,
    }


@transaction.atomic
def change_limits(*, calls, output_tokens, actor, reason, request_id):
    """OS 운영자가 CLI에 명시한 신원이며 Core 로그인으로 인증한 신원은 아니다."""
    if any(
        type(value) is not int or not 0 <= value <= 2**53 - 1 for value in (calls, output_tokens)
    ):
        raise ValueError("한도는 0 이상 안전한 정수 범위여야 합니다.")
    actor, reason = actor.strip(), reason.strip()
    if not 1 <= len(actor) <= 150 or not 1 <= len(reason) <= 1000:
        raise ValueError("변경자(1~150자)와 사유(1~1000자)를 입력하세요.")
    request_id = UUID(str(request_id))
    # get_or_create handles two simultaneous first settings; re-read under the common lock.
    budget, created = EvaluationBudget.objects.get_or_create(pk=1)
    budget = EvaluationBudget.objects.select_for_update().get(pk=budget.pk)
    previous = EvaluationBudgetChange.objects.filter(request_id=request_id).first()
    if previous:
        if (previous.call_limit, previous.output_token_limit, previous.actor, previous.reason) != (
            calls,
            output_tokens,
            actor,
            reason,
        ):
            raise ValueError("같은 요청 ID의 한도·변경자·사유를 바꿀 수 없습니다.")
        return previous
    if calls < budget.allocated_calls or output_tokens < budget.allocated_output_tokens:
        raise ValueError("이미 예약·확정한 사용량보다 한도를 낮출 수 없습니다.")
    change = EvaluationBudgetChange.objects.create(
        request_id=request_id,
        budget=budget,
        actor=actor,
        reason=reason,
        previous_call_limit=None if created else budget.call_limit,
        previous_output_token_limit=None if created else budget.output_token_limit,
        call_limit=calls,
        output_token_limit=output_tokens,
    )
    budget.call_limit, budget.output_token_limit = calls, output_tokens
    budget.save(update_fields=["call_limit", "output_token_limit", "updated_at"])
    return change
