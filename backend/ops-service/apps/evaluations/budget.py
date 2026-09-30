"""Ops DB가 소유하는 누적 호출·입력·출력 토큰 예약. 금액 상한으로 해석하지 않는다."""

import re

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from .models import EvaluationBudget, EvaluationBudgetCall, EvaluationBudgetReservation


class BudgetUnavailable(Exception):
    pass


def operation_plan(run):
    """현재 지원하는 고정 근거 답변 작업만 허용한다. 과거 명세에는 작업을 만들어 넣지 않는다."""
    spec = run.execution_spec
    if not isinstance(spec, dict):
        raise BudgetUnavailable
    if "model_operations" not in spec:
        return None
    config = run.live_config
    dataset = spec.get("dataset")
    if not isinstance(config, dict) or not isinstance(dataset, dict):
        raise BudgetUnavailable
    cases = dataset.get("case_ids")
    if (
        spec.get("evaluation_scope") != "fixed-answer-context-only"
        or spec.get("execution_mode") != "live"
        or spec.get("live_config") != config
        or not isinstance(cases, list)
        or not 1 <= len(cases) <= 12
        or any(
            not isinstance(case, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}", case)
            for case in cases
        )
        or len(set(cases)) != len(cases)
        or type(config.get("max_model_calls")) is not int
        or config["max_model_calls"] != len(cases)
        or type(config.get("max_output_tokens")) is not int
        or config["max_output_tokens"] <= 0
        or not isinstance(config.get("model"), str)
        or not config["model"]
    ):
        raise BudgetUnavailable
    if "max_input_tokens" in config and (
        type(config["max_input_tokens"]) is not int or not 1 <= config["max_input_tokens"] <= 32768
    ):
        raise BudgetUnavailable
    expected = [
        {
            "id": f"answer:{case}",
            "kind": "answer",
            "case_id": case,
            "model": config["model"],
            "max_output_tokens": config["max_output_tokens"],
            **(
                {"max_input_tokens": config["max_input_tokens"]}
                if "max_input_tokens" in config
                else {}
            ),
        }
        for case in cases
    ]
    if spec["model_operations"] != expected:
        raise BudgetUnavailable
    return expected


def reserve(run):
    """접수 transaction 안에서 호출한다. DB 한도 잠금은 모든 데이터셋이 공유한다."""
    if run.execution_mode != "live":
        return
    plan = operation_plan(run)
    max_input = plan[0].get("max_input_tokens") if plan else None
    budget = EvaluationBudget.objects.select_for_update().filter(pk=1).first()
    if budget is None or len(settings.LLMOPS_BUDGET_TOKEN) < 32:
        raise BudgetUnavailable
    if EvaluationBudgetReservation.objects.filter(run=run).exists():
        return
    calls, output = run.live_config["max_model_calls"], run.live_config["max_output_tokens"]
    if (
        budget.allocated_calls + calls > budget.call_limit
        or budget.allocated_output_tokens + calls * output > budget.output_token_limit
        or (
            budget.input_token_limit is not None
            and (
                max_input is None
                or budget.allocated_input_tokens + calls * max_input > budget.input_token_limit
            )
        )
    ):
        raise BudgetUnavailable
    EvaluationBudgetReservation.objects.create(
        run=run,
        budget=budget,
        max_calls=calls,
        max_output_tokens=output,
        max_input_tokens=max_input,
    )
    budget.allocated_calls += calls
    budget.allocated_output_tokens += calls * output
    budget.allocated_input_tokens += calls * (max_input or 0)
    budget.save(
        update_fields=[
            "allocated_calls",
            "allocated_output_tokens",
            "allocated_input_tokens",
            "updated_at",
        ]
    )


def validate_usage(usage, max_output, max_input=None):
    if (
        not isinstance(usage, dict)
        or set(usage) != {"input_tokens", "output_tokens", "total_tokens"}
        or any(type(value) is not int or not 0 <= value <= 2**53 - 1 for value in usage.values())
        or usage["total_tokens"] != usage["input_tokens"] + usage["output_tokens"]
        or usage["output_tokens"] > max_output
        or (max_input is not None and usage["input_tokens"] > max_input)
    ):
        raise BudgetUnavailable
    return usage["input_tokens"], usage["output_tokens"]


@transaction.atomic
def worker_action(
    run_id,
    worker_id,
    flow_id,
    spec_hash,
    action,
    *,
    sequence=None,
    usage=None,
    model=None,
    max_output_tokens=None,
    operation_id=None,
    input_token_count=None,
):
    # 모든 작업은 budget → reservation 순서로 잠근다. 외부 통신은 transaction 밖이다.
    budget = EvaluationBudget.objects.select_for_update().filter(pk=1).first()
    reservation = (
        EvaluationBudgetReservation.objects.select_for_update().filter(run_id=run_id).first()
    )
    if budget is None or reservation is None:
        raise BudgetUnavailable
    run = reservation.run
    if (
        run.execution_mode != "live"
        or run.prefect_flow_run_id != flow_id
        or run.execution_spec_sha256 != spec_hash
        or not spec_hash
        or not run.execution_spec
    ):
        raise BudgetUnavailable
    if action == "claim":
        operation_plan(run)
        if (
            not settings.LLMOPS_LIVE_ENABLED
            or run.cancel_requested_at is not None
            or run.status not in {"REQUESTED", "QUEUED", "RUNNING"}
            or reservation.closed_at
            or (budget.input_token_limit is not None and reservation.max_input_tokens is None)
            or reservation.worker_id not in (None, worker_id)
        ):
            raise BudgetUnavailable
        reservation.worker_id = worker_id
        reservation.save(update_fields=["worker_id"])
        return
    if reservation.worker_id != worker_id:
        raise BudgetUnavailable
    if action == "close" and reservation.closed_at:
        return
    if reservation.closed_at:
        raise BudgetUnavailable
    if action == "authorize":
        if (
            not settings.LLMOPS_LIVE_ENABLED
            or run.cancel_requested_at is not None
            or run.status not in {"REQUESTED", "QUEUED", "RUNNING"}
            or type(sequence) is not int
            or sequence != reservation.calls.count()
            or sequence >= reservation.max_calls
            or reservation.calls.filter(settled_at__isnull=True).exists()
            or model != run.live_config["model"]
            or type(max_output_tokens) is not int
            or max_output_tokens != reservation.max_output_tokens
        ):
            raise BudgetUnavailable
        plan = operation_plan(run)
        if plan is not None and len(plan) != reservation.max_calls:
            raise BudgetUnavailable
        if operation_id != (plan[sequence]["id"] if plan is not None else None):
            raise BudgetUnavailable
        if reservation.max_input_tokens is not None and (
            plan is None
            or plan[sequence].get("max_input_tokens") != reservation.max_input_tokens
            or type(input_token_count) is not int
            or not 0 <= input_token_count <= reservation.max_input_tokens
        ):
            raise BudgetUnavailable
        if budget.input_token_limit is not None and reservation.max_input_tokens is None:
            raise BudgetUnavailable
        # 같은 sequence의 승인을 재발급하지 않는다. 응답 유실도 미확인 시도로 보존한다.
        EvaluationBudgetCall.objects.create(
            reservation=reservation,
            sequence=sequence,
            operation_id=operation_id,
            counted_input_tokens=input_token_count
            if reservation.max_input_tokens is not None
            else None,
        )
    elif action == "settle":
        call = reservation.calls.filter(sequence=sequence).first()
        if call is None or call.operation_id != operation_id:
            raise BudgetUnavailable
        if usage is None:
            return  # 응답/사용량을 확인하지 못한 호출은 예약을 유지한다.
        input_tokens, output_tokens = validate_usage(
            usage, reservation.max_output_tokens, reservation.max_input_tokens
        )
        if call.settled_at:
            if (call.input_tokens, call.output_tokens) != (input_tokens, output_tokens):
                raise BudgetUnavailable
            return
        if reservation.max_input_tokens is None:
            budget.allocated_input_tokens += input_tokens
            budget.save(update_fields=["allocated_input_tokens", "updated_at"])
        call.input_tokens, call.output_tokens, call.settled_at = (
            input_tokens,
            output_tokens,
            timezone.now(),
        )
        call.save(update_fields=["input_tokens", "output_tokens", "settled_at"])
    elif action == "close":
        _close_reservation(budget, reservation)
    else:
        raise BudgetUnavailable


def close_after_cancellation(run):
    """종료를 확인한 취소 요청만 정리한다. 호출자는 run 행 잠금을 먼저 소유한다."""
    if run.execution_mode != "live" or run.cancel_requested_at is None:
        return
    budget = EvaluationBudget.objects.select_for_update().filter(pk=1).first()
    reservation = EvaluationBudgetReservation.objects.select_for_update().filter(run=run).first()
    if budget is not None and reservation is not None and reservation.closed_at is None:
        _close_reservation(budget, reservation)


def _close_reservation(budget, reservation):
    calls = list(reservation.calls.all())
    # 종료 후 신규 승인은 금지한다. 미전송 몫과 확인된 출력 차액만 반환한다.
    charged_output = sum(
        call.output_tokens if call.settled_at else reservation.max_output_tokens for call in calls
    )
    budget.allocated_calls -= reservation.max_calls - len(calls)
    budget.allocated_output_tokens -= (
        reservation.max_calls * reservation.max_output_tokens - charged_output
    )
    if reservation.max_input_tokens is not None:
        charged_input = sum(
            call.input_tokens if call.settled_at else reservation.max_input_tokens for call in calls
        )
        budget.allocated_input_tokens -= (
            reservation.max_calls * reservation.max_input_tokens - charged_input
        )
    budget.save(
        update_fields=[
            "allocated_calls",
            "allocated_output_tokens",
            "allocated_input_tokens",
            "updated_at",
        ]
    )
    reservation.closed_at = timezone.now()
    reservation.save(update_fields=["closed_at"])
