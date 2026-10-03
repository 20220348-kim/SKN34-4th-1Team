"""서울 날짜별 예약 한도. 누적 장부를 초기화하지 않고 미확정 몫을 이월한다."""

from datetime import timedelta
from uuid import UUID
from zoneinfo import ZoneInfo

from django.db import transaction
from django.db.models import Sum
from django.utils import timezone

from .models import (
    EvaluationBudget,
    EvaluationBudgetReservation,
    EvaluationDailyBudget,
    EvaluationDailyBudgetChange,
    EvaluationLegacyUsage,
    EvaluationRun,
)

KEYS = ("calls", "input_tokens", "output_tokens")
SEOUL = ZoneInfo("Asia/Seoul")


def day_bounds(at):
    start = at.astimezone(SEOUL).replace(hour=0, minute=0, second=0, microsecond=0)
    return start, start + timedelta(days=1)


def policy_data(policy):
    if policy is None:
        return None
    return {
        "enabled": policy.enabled,
        "limits": {
            "calls": policy.call_limit,
            "input_tokens": policy.input_token_limit,
            "output_tokens": policy.output_token_limit,
        },
    }


def _allocation(budget, start, end, exclude_run_id=None):
    # Import here: reporting also exposes this summary, and budget owns the lock.
    from .budget_reporting import budget_totals, ledger_totals

    reservations = EvaluationBudgetReservation.objects.filter(budget=budget)
    total = budget_totals(budget)
    missing = EvaluationRun.objects.filter(
        execution_mode="live", budget_reservation__isnull=True, legacy_usage__isnull=True
    )
    if exclude_run_id is not None:
        missing = missing.exclude(pk=exclude_run_id)
    if (
        budget is None
        or missing.exists()
        or reservations.filter(created_at__gte=end).exists()
        or EvaluationLegacyUsage.objects.filter(budget=budget, run__created_at__gte=end).exists()
        or total["unbounded_input_calls"]
        or total["unbounded_input_reservations"]
        or any(value < 0 for value in total.values())
        or any(total["allocated_" + key] != getattr(budget, "allocated_" + key) for key in KEYS)
    ):
        return None
    current = ledger_totals(reservations.filter(created_at__gte=start, created_at__lt=end))
    previous = ledger_totals(reservations.filter(created_at__lt=start))
    if any(value < 0 for ledger in (current, previous) for value in ledger.values()):
        return None
    # 과거 사용량은 반영 시각이 아닌 원래 실행의 접수 날짜에 귀속한다.
    legacy = EvaluationLegacyUsage.objects.filter(
        budget=budget, run__created_at__gte=start, run__created_at__lt=end
    ).aggregate(**{key: Sum(key, default=0) for key in KEYS})
    today = {key: current["allocated_" + key] + legacy[key] for key in KEYS}
    carried = {
        key: previous["unknown_" + key]
        + previous["unapproved_" + key]
        + (previous["pending_release_" + key] if key != "calls" else 0)
        for key in KEYS
    }
    return today, carried, {key: today[key] + carried[key] for key in KEYS}


def daily_summary(budget, *, at=None, exclude_run_id=None):
    """조회자도 누적 budget 행 잠금 안에서 호출한다. GET은 정책을 생성하지 않는다."""
    start, end = day_bounds(at or timezone.now())
    policy = EvaluationDailyBudget.objects.filter(budget=budget).first()
    snapshot = policy_data(policy)
    changes = EvaluationDailyBudgetChange.objects.filter(policy=policy)
    result = {
        "state": "disabled",
        "timezone": "Asia/Seoul",
        "period_start": start.isoformat(),
        "period_end": end.isoformat(),
        "limits": snapshot["limits"] if snapshot else None,
        "current_day": None,
        "carried": None,
        "allocated": None,
        "remaining": None,
        "recent_changes": [
            {
                "request_id": str(change.request_id),
                "source": "CLI",
                "actor": change.actor,
                "reason": change.reason,
                "previous": change.previous,
                "policy": change.policy_snapshot,
                "created_at": change.created_at.isoformat(),
            }
            for change in changes[:10]
        ],
    }
    if policy is None or not policy.enabled:
        return result
    allocation = _allocation(budget, start, end, exclude_run_id)
    if allocation is None:
        result["state"] = "unknown"
        return result
    today, carried, allocated = allocation
    result.update(current_day=today, carried=carried, allocated=allocated)
    if any(allocated[key] > result["limits"][key] for key in KEYS):
        result["state"] = "exceeded"
        return result
    result["state"] = "enforced"
    result["remaining"] = {key: result["limits"][key] - allocated[key] for key in KEYS}
    return result


def require_daily_budget(budget, run, required, at):
    from .budget import BudgetUnavailable

    summary = daily_summary(budget, at=at, exclude_run_id=run.pk)
    if summary["state"] == "disabled":
        return
    if summary["state"] != "enforced" or any(
        required[key] is None or required[key] > summary["remaining"][key] for key in KEYS
    ):
        raise BudgetUnavailable


def require_reservation_day(reservation):
    from .budget import BudgetUnavailable

    if not EvaluationDailyBudget.objects.filter(
        budget_id=reservation.budget_id, enabled=True
    ).exists():
        return
    start, end = day_bounds(timezone.now())
    if not start <= reservation.created_at < end or reservation.max_input_tokens is None:
        raise BudgetUnavailable


@transaction.atomic
def change_daily_limits(
    *, calls=None, input_tokens=None, output_tokens=None, disable=False, actor, reason, request_id
):
    """누적 한도와 같은 잠금으로 정책 저장·검증·감사 기록을 직렬화한다."""
    if type(disable) is not bool or not isinstance(actor, str) or not isinstance(reason, str):
        raise ValueError("정책, 변경자와 사유를 확인하세요.")
    actor, reason = actor.strip(), reason.strip()
    if not 1 <= len(actor) <= 150 or not 1 <= len(reason) <= 1000:
        raise ValueError("변경자와 사유가 필요합니다.")
    request_id = UUID(str(request_id))
    values = dict(calls=calls, input_tokens=input_tokens, output_tokens=output_tokens)
    if (disable and any(value is not None for value in values.values())) or (
        not disable
        and any(type(value) is not int or not 0 <= value <= 2**53 - 1 for value in values.values())
    ):
        raise ValueError("세 가지 정수 한도를 모두 지정하거나 --disable만 지정하세요.")
    budget = EvaluationBudget.objects.select_for_update().filter(pk=1).first()
    if budget is None:
        raise ValueError("누적 예산을 먼저 설정하세요.")
    existing = EvaluationDailyBudgetChange.objects.filter(request_id=request_id).first()
    if existing:
        if (
            existing.actor != actor
            or existing.reason != reason
            or existing.policy_snapshot["enabled"] == disable
            or (not disable and existing.policy_snapshot["limits"] != values)
        ):
            raise ValueError("같은 요청 ID의 정책·변경자·사유가 다릅니다.")
        return existing
    policy = EvaluationDailyBudget.objects.filter(budget=budget).first()
    previous = policy_data(policy)
    if disable and policy is None:
        raise ValueError("해제할 일별 정책이 없습니다.")
    if not disable:
        allocation = _allocation(budget, *day_bounds(timezone.now()))
        if allocation is None:
            raise ValueError("미확인 입력·누락·불일치 장부를 먼저 해결하세요.")
        if any(values[key] < allocation[2][key] for key in KEYS):
            raise ValueError("오늘의 할당량과 전날 이월량보다 한도를 낮출 수 없습니다.")
    policy = policy or EvaluationDailyBudget(budget=budget)
    policy.enabled = not disable
    if not disable:
        policy.call_limit, policy.input_token_limit, policy.output_token_limit = (
            calls,
            input_tokens,
            output_tokens,
        )
    policy.save()
    return EvaluationDailyBudgetChange.objects.create(
        request_id=request_id,
        policy=policy,
        actor=actor,
        reason=reason,
        previous=previous,
        policy_snapshot=policy_data(policy),
    )
