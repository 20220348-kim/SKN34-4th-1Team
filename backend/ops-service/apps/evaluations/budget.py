"""Ops DB가 소유하는 누적 호출·입력·출력 토큰 예약. 금액 상한으로 해석하지 않는다."""

import re

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from .models import EvaluationBudget, EvaluationBudgetCall, EvaluationBudgetReservation


class BudgetUnavailable(Exception):
    pass


def operation_plan(run):
    """고정 근거 및 내부 RAG 작업을 검증한다. 과거 명세에 작업을 만들어 넣지 않는다."""
    spec = run.execution_spec
    if not isinstance(spec, dict):
        raise BudgetUnavailable
    if spec.get("evaluation_scope") == "source-chunks-retrieval-answer":
        return rag_operation_plan(run)
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


def rag_operation_plan(run):
    """내부 RAG 작업 계약. 공개 접수·품질 정책은 이 범위를 아직 허용하지 않는다."""
    spec, config = run.execution_spec, run.live_config
    plan = spec.get("model_operations")
    if (
        spec.get("execution_mode") != "live"
        or spec.get("live_config") != config
        or not isinstance(config, dict)
        or not isinstance(plan, list)
        or not 1 <= len(plan) <= 512
        or config.get("max_model_calls") != len(plan)
        or type(config.get("max_model_calls")) is not int
        or type(config.get("max_input_tokens")) is not int
        or type(config.get("max_output_tokens")) is not int
    ):
        raise BudgetUnavailable
    seen = set()
    for item in plan:
        if not isinstance(item, dict):
            raise BudgetUnavailable
        kind = item.get("kind")
        if not isinstance(kind, str):
            raise BudgetUnavailable
        embedding = kind in {"document_embedding", "query_embedding"}
        fields = {"id", "kind", "model", "max_input_tokens", "max_output_tokens"}
        fields |= {"input_sha256", "dimensions"} if embedding else {"case_id"}
        if (
            kind not in {"answer", "document_embedding", "query_embedding"}
            or set(item) != fields
            or not isinstance(item.get("id"), str)
            or not re.fullmatch(kind + r":[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}", item["id"])
            or item["id"] in seen
            or type(item.get("max_input_tokens")) is not int
            or not 1 <= item["max_input_tokens"] <= (262112 if embedding else 32768)
            or type(item.get("max_output_tokens")) is not int
            or item["max_output_tokens"] != (0 if embedding else 2000)
            or item.get("model") != config.get("embedding_model" if embedding else "model")
            or not isinstance(item.get("model"), str)
            or not item["model"]
        ):
            raise BudgetUnavailable
        if embedding:
            if (
                not isinstance(item.get("input_sha256"), str)
                or not re.fullmatch(r"[a-f0-9]{64}", item["input_sha256"])
                or type(item.get("dimensions")) is not int
                or item["model"] not in {"text-embedding-3-small", "text-embedding-3-large"}
                or type(config.get("embedding_dimensions")) is not int
                or not 1
                <= item["dimensions"]
                <= (1536 if item["model"] == "text-embedding-3-small" else 3072)
                or item["dimensions"] != config.get("embedding_dimensions")
            ):
                raise BudgetUnavailable
        elif not isinstance(item.get("case_id"), str) or item["id"] != "answer:" + item["case_id"]:
            raise BudgetUnavailable
        seen.add(item["id"])
    if config.get("max_input_tokens") != max(
        item["max_input_tokens"] for item in plan
    ) or config.get("max_output_tokens") != max(item["max_output_tokens"] for item in plan):
        raise BudgetUnavailable
    return plan


def call_limits(call):
    """새 승인 상한을 사용하고 기존 승인에는 당시 예약 상한을 유지한다."""
    reservation = call.reservation
    return (
        call.max_input_tokens
        if call.max_input_tokens is not None
        else reservation.max_input_tokens,
        call.max_output_tokens
        if call.max_output_tokens is not None
        else reservation.max_output_tokens,
    )


def reservation_limits(reservation):
    return (
        reservation.reserved_input_tokens
        if reservation.reserved_input_tokens is not None
        else reservation.max_calls * reservation.max_input_tokens
        if reservation.max_input_tokens is not None
        else None,
        reservation.reserved_output_tokens
        if reservation.reserved_output_tokens is not None
        else reservation.max_calls * reservation.max_output_tokens,
    )


def reserve(run):
    """접수 transaction 안에서 호출한다. DB 한도 잠금은 모든 데이터셋이 공유한다."""
    if run.execution_mode != "live":
        return
    plan = operation_plan(run)
    max_input = (max(item.get("max_input_tokens", 0) for item in plan) or None) if plan else None
    input_total = sum(item["max_input_tokens"] for item in plan) if max_input is not None else None
    output_total = sum(item["max_output_tokens"] for item in plan) if plan else None
    budget = EvaluationBudget.objects.select_for_update().filter(pk=1).first()
    if budget is None or len(settings.LLMOPS_BUDGET_TOKEN) < 32:
        raise BudgetUnavailable
    if EvaluationBudgetReservation.objects.filter(run=run).exists():
        return
    calls, output = run.live_config["max_model_calls"], run.live_config["max_output_tokens"]
    if output_total is None:
        output_total = calls * output
    if plan and any(item["kind"] != "answer" for item in plan) and budget.input_token_limit is None:
        raise BudgetUnavailable
    if (
        budget.allocated_calls + calls > budget.call_limit
        or budget.allocated_output_tokens + output_total > budget.output_token_limit
        or (
            budget.input_token_limit is not None
            and (
                max_input is None
                or budget.allocated_input_tokens + input_total > budget.input_token_limit
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
        reserved_input_tokens=input_total,
        reserved_output_tokens=output_total,
    )
    budget.allocated_calls += calls
    budget.allocated_output_tokens += output_total
    budget.allocated_input_tokens += input_total or 0
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
    input_sha256=None,
    dimensions=None,
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
    if action in {"claim", "authorize"}:
        if (
            run.execution_spec.get("evaluation_scope") == "source-chunks-retrieval-answer"
            and "dataset_id" in run.execution_spec
            and not settings.LLMOPS_RAG_LIVE_ENABLED
        ):
            raise BudgetUnavailable
        plan = operation_plan(run)
        if plan is None:
            if reservation.max_input_tokens is not None:
                raise BudgetUnavailable
        else:
            input_max = max(item.get("max_input_tokens", 0) for item in plan) or None
            input_total = sum(item["max_input_tokens"] for item in plan) if input_max else None
            output_max = max(item["max_output_tokens"] for item in plan)
            output_total = sum(item["max_output_tokens"] for item in plan)
            if (
                len(plan) != reservation.max_calls
                or input_max != reservation.max_input_tokens
                or output_max != reservation.max_output_tokens
                or (input_total, output_total) != reservation_limits(reservation)
            ):
                raise BudgetUnavailable
    if action == "claim":
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
        previous = reservation.calls.order_by("-sequence").first()
        if (
            not settings.LLMOPS_LIVE_ENABLED
            or run.cancel_requested_at is not None
            or run.status not in {"REQUESTED", "QUEUED", "RUNNING"}
            or type(sequence) is not int
            or sequence < 0
            or (previous is not None and sequence <= previous.sequence)
            or (
                run.execution_spec.get("evaluation_scope") != "source-chunks-retrieval-answer"
                and sequence != reservation.calls.count()
            )
            or sequence >= reservation.max_calls
            or reservation.calls.filter(settled_at__isnull=True).exists()
            or type(max_output_tokens) is not int
        ):
            raise BudgetUnavailable
        if plan is not None and any(
            item["kind"] == "answer"
            for item in plan[(previous.sequence + 1 if previous else 0) : sequence]
        ):
            raise BudgetUnavailable  # 캐시 적중으로 건너뛸 수 있는 작업은 임베딩뿐이다.
        if operation_id != (plan[sequence]["id"] if plan is not None else None):
            raise BudgetUnavailable
        item = plan[sequence] if plan is not None else None
        input_cap = item.get("max_input_tokens") if item else reservation.max_input_tokens
        output_cap = item["max_output_tokens"] if item else reservation.max_output_tokens
        if (
            model != (item["model"] if item else run.live_config["model"])
            or max_output_tokens != output_cap
            or (
                input_cap is not None
                and (type(input_token_count) is not int or not 0 <= input_token_count <= input_cap)
            )
            or (budget.input_token_limit is not None and input_cap is None)
        ):
            raise BudgetUnavailable
        if item and item["kind"] != "answer":
            if (
                input_sha256 != item["input_sha256"]
                or type(dimensions) is not int
                or dimensions != item["dimensions"]
            ):
                raise BudgetUnavailable
        elif input_sha256 is not None or dimensions is not None:
            raise BudgetUnavailable
        # 같은 sequence의 승인을 재발급하지 않는다. 응답 유실도 미확인 시도로 보존한다.
        EvaluationBudgetCall.objects.create(
            reservation=reservation,
            sequence=sequence,
            operation_id=operation_id,
            max_input_tokens=input_cap,
            max_output_tokens=output_cap,
            counted_input_tokens=input_token_count if input_cap is not None else None,
        )
    elif action == "settle":
        call = reservation.calls.filter(sequence=sequence).first()
        if call is None or call.operation_id != operation_id:
            raise BudgetUnavailable
        if usage is None:
            return  # 응답/사용량을 확인하지 못한 호출은 예약을 유지한다.
        input_cap, output_cap = call_limits(call)
        input_tokens, output_tokens = validate_usage(usage, output_cap, input_cap)
        if call.settled_at:
            if (call.input_tokens, call.output_tokens) != (input_tokens, output_tokens):
                raise BudgetUnavailable
            return
        if input_cap is None:
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
    input_capacity, output_capacity = reservation_limits(reservation)
    # 종료 후 신규 승인은 금지한다. 미전송 몫과 확인된 출력 차액만 반환한다.
    charged_output = sum(
        call.output_tokens if call.settled_at else call_limits(call)[1] for call in calls
    )
    budget.allocated_calls -= reservation.max_calls - len(calls)
    budget.allocated_output_tokens -= output_capacity - charged_output
    if input_capacity is not None:
        charged_input = sum(
            call.input_tokens if call.settled_at else call_limits(call)[0] for call in calls
        )
        budget.allocated_input_tokens -= input_capacity - charged_input
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
