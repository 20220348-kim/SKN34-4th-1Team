"""Core 관리자 세션으로 읽는 장부. 실행기 전용 예산 쓰기 API와 인증을 공유하지 않는다."""

from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.views.decorators.cache import never_cache
from rest_framework.decorators import api_view
from rest_framework.pagination import PageNumberPagination
from rest_framework.response import Response

from .budget_cleanup import cleanup_data
from .budget_reporting import budget_summary, reservation_data
from .models import EvaluationBudget, EvaluationBudgetReservation, EvaluationRun
from .usage_correction import correction_data


@never_cache
@api_view(["GET"])
@transaction.atomic
def api_summary(request):
    budget = EvaluationBudget.objects.select_for_update().filter(pk=1).first()
    as_of = timezone.now().isoformat()
    return Response({"as_of": as_of, **budget_summary(budget)})


@never_cache
@api_view(["GET"])
@transaction.atomic
def api_reservations(request):
    budget = EvaluationBudget.objects.select_for_update().filter(pk=1).first()
    as_of = timezone.now().isoformat()
    paginator = PageNumberPagination()
    paginator.page_size = 25
    rows = (
        EvaluationBudgetReservation.objects.filter(budget=budget)
        .select_related("run")
        .prefetch_related("calls__correction")
        .order_by("-created_at", "-run_id")
    )
    page = paginator.paginate_queryset(rows, request)
    response = paginator.get_paginated_response([reservation_data(row) for row in page])
    # Full ledger totals and this page are materialized before releasing the common budget lock.
    response.data.update({"as_of": as_of, "summary": budget_summary(budget)})
    return response


@never_cache
@api_view(["GET"])
@transaction.atomic
def api_run_budget(request, run_id):
    EvaluationBudget.objects.select_for_update().filter(pk=1).first()
    as_of = timezone.now().isoformat()
    run = get_object_or_404(EvaluationRun, pk=run_id)
    reservation = (
        EvaluationBudgetReservation.objects.filter(run=run)
        .select_related("run", "cleanup")
        .prefetch_related("calls__correction")
        .first()
    )
    if reservation is None:
        return Response(
            {
                "as_of": as_of,
                "state": "missing" if run.execution_mode == "live" else "not_applicable",
                "reservation": None,
                "calls": [],
                "cleanup": None,
                "corrections": [],
            }
        )
    return Response(
        {
            "as_of": as_of,
            "state": "recorded",
            "reservation": reservation_data(reservation),
            "corrections": [
                correction_data(call.correction)
                for call in sorted(reservation.calls.all(), key=lambda call: call.sequence)
                if hasattr(call, "correction")
            ],
            "cleanup": cleanup_data(reservation.cleanup)
            if hasattr(reservation, "cleanup")
            else None,
            "calls": [
                {
                    "sequence": call.sequence,
                    "operation_id": call.operation_id,
                    "counted_input_tokens": call.counted_input_tokens,
                    "authorized_at": call.authorized_at.isoformat(),
                    "settled_at": call.settled_at.isoformat() if call.settled_at else None,
                    "input_tokens": call.input_tokens,
                    "output_tokens": call.output_tokens,
                }
                for call in sorted(reservation.calls.all(), key=lambda call: call.sequence)
            ],
        }
    )
