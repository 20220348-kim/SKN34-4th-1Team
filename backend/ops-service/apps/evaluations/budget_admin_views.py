"""Core 관리자 세션으로 읽는 장부. 실행기 전용 예산 쓰기 API와 인증을 공유하지 않는다."""

from uuid import uuid4

from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.views.decorators.cache import never_cache
from rest_framework.decorators import api_view
from rest_framework.pagination import PageNumberPagination
from rest_framework.response import Response

from .budget import call_limits
from .budget_cleanup import cleanup_data
from .budget_reporting import budget_summary, legacy_usage_data, reservation_data
from .catalog import DATASETS
from .legacy_usage import LegacyUsageUnavailable, reconcile_legacy_usage
from .models import (
    EvaluationBudget,
    EvaluationBudgetReservation,
    EvaluationLegacyUsage,
    EvaluationRun,
)
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
def api_unaccounted_runs(request):
    # Include incomplete/new runs too: missing accounting is not proof of eligible legacy usage.
    rows = EvaluationRun.objects.filter(
        execution_mode="live", budget_reservation__isnull=True, legacy_usage__isnull=True
    ).order_by("-created_at", "-id")
    paginator = PageNumberPagination()
    paginator.page_size = 25
    page = paginator.paginate_queryset(rows, request)
    response = paginator.get_paginated_response(
        [
            {
                "run_id": str(run.pk),
                "dataset_id": run.dataset_id,
                "dataset_label": DATASETS.get(run.dataset_id, {}).get("label", run.dataset_id),
                "status": run.status,
                "status_label": run.get_status_display(),
                "created_at": run.created_at.isoformat(),
            }
            for run in page
        ]
    )
    response.data["as_of"] = timezone.now().isoformat()
    return response


@never_cache
@api_view(["GET"])
def api_legacy_usage_preview(request, run_id):
    get_object_or_404(EvaluationRun, pk=run_id)
    base = {"run_id": str(run_id), "applied": False}
    try:
        # Reuse the CLI's integrity/budget checks in preview mode only. No audit is written.
        preview = reconcile_legacy_usage(
            run_id=run_id,
            request_id=uuid4(),
            actor=request.user.get_username(),
            reason="관리자 화면의 과거 사용량 읽기 전용 확인",
            apply=False,
        )
    except LegacyUsageUnavailable as error:
        result = {**base, "state": "unavailable", "blockers": [str(error)]}
    else:
        result = {
            **base,
            "state": "verified",
            **{
                key: preview[key]
                for key in (
                    "can_apply",
                    "blockers",
                    "usage",
                    "before",
                    "after",
                    "evidence_sha256",
                    "source",
                    "provider_receipt_verified",
                )
            },
            "capture_sha256": preview["evidence"]["capture_sha256"],
        }
    return Response({"as_of": timezone.now().isoformat(), **result})


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
        legacy = EvaluationLegacyUsage.objects.filter(run=run).first()
        if legacy is not None:
            return Response(
                {
                    "as_of": as_of,
                    "state": "legacy_recorded",
                    "reservation": None,
                    "calls": [],
                    "cleanup": None,
                    "corrections": [],
                    "legacy_usage": legacy_usage_data(legacy),
                }
            )
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
                    "max_input_tokens": call_limits(call)[0],
                    "max_output_tokens": call_limits(call)[1],
                    "authorized_at": call.authorized_at.isoformat(),
                    "settled_at": call.settled_at.isoformat() if call.settled_at else None,
                    "input_tokens": call.input_tokens,
                    "output_tokens": call.output_tokens,
                }
                for call in sorted(reservation.calls.all(), key=lambda call: call.sequence)
            ],
        }
    )
