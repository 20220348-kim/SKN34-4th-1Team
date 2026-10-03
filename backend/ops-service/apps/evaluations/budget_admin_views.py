"""Core 관리자 세션의 예산 검토·변경. 실행기 전용 인증과 분리한다."""

from uuid import uuid4

from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.views.decorators.cache import never_cache
from rest_framework import serializers
from rest_framework.decorators import api_view
from rest_framework.pagination import PageNumberPagination
from rest_framework.response import Response

from .budget import call_limits
from .budget_cleanup import cleanup_data
from .budget_reporting import (
    budget_summary,
    change_data,
    change_limits,
    legacy_usage_data,
    reservation_data,
)
from .catalog import DATASETS
from .legacy_usage import LegacyUsageUnavailable, reconcile_legacy_usage
from .models import (
    EvaluationBudget,
    EvaluationBudgetReservation,
    EvaluationLegacyUsage,
    EvaluationRun,
)
from .usage_correction import correction_data


class BudgetLimitsRequest(serializers.Serializer):
    request_id = serializers.UUIDField()
    expected_revision = serializers.RegexField(r"^[a-f0-9]{64}$")
    calls = serializers.IntegerField(min_value=0, max_value=2**53 - 1)
    output_tokens = serializers.IntegerField(min_value=0, max_value=2**53 - 1)
    input_tokens = serializers.IntegerField(min_value=0, max_value=2**53 - 1, allow_null=True)
    reason = serializers.CharField(max_length=1000, allow_blank=False)


class LegacyUsageRequest(serializers.Serializer):
    request_id = serializers.UUIDField()
    evidence_sha256 = serializers.RegexField(r"^[a-f0-9]{64}$")
    reason = serializers.CharField(max_length=1000, allow_blank=False)


def _write_payload(request, schema):
    serializer = schema(data=request.data)
    if not isinstance(request.data, dict) or set(request.data) - set(serializer.fields):
        raise serializers.ValidationError("허용된 변경 항목만 전달하세요.")
    for key in ("calls", "output_tokens", "input_tokens"):
        if key in request.data and not (key == "input_tokens" and request.data[key] is None):
            if type(request.data[key]) is not int:
                raise serializers.ValidationError("한도는 정수로 전달하세요.")
    if not isinstance(request.data.get("reason"), str):
        raise serializers.ValidationError("검토 사유를 입력하세요.")
    serializer.is_valid(raise_exception=True)
    return serializer.validated_data


@never_cache
@api_view(["POST"])
def api_change_limits(request):
    payload = _write_payload(request, BudgetLimitsRequest)
    try:
        change = change_limits(
            **payload, actor=request.user.get_username(), authenticated_actor=request.user
        )
    except ValueError as error:
        return Response({"code": "BUDGET_CHANGE_CONFLICT", "detail": str(error)}, status=409)
    return Response({"change": change_data(change)})


@never_cache
@api_view(["POST"])
def api_apply_legacy_usage(request, run_id):
    get_object_or_404(EvaluationRun, pk=run_id)
    payload = _write_payload(request, LegacyUsageRequest)
    try:
        result = reconcile_legacy_usage(
            **payload,
            run_id=run_id,
            actor=request.user.get_username(),
            authenticated_actor=request.user,
            apply=True,
        )
    except LegacyUsageUnavailable as error:
        return Response({"code": "LEGACY_USAGE_CONFLICT", "detail": str(error)}, status=409)
    applied, replayed = result.pop("applied"), result.pop("replayed")
    return Response({"applied": applied, "replayed": replayed, "record": result})


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
