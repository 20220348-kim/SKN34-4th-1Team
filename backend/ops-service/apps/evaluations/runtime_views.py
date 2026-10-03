"""Authenticated operator diagnostics kept separate from Kubernetes probes."""

from types import SimpleNamespace

from django.conf import settings
from django.db import transaction
from django.utils import timezone
from django.views.decorators.cache import never_cache
from rest_framework import serializers
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .budget import BudgetUnavailable, operation_plan
from .budget_reporting import budget_summary
from .catalog import DATASETS, RAG_SCOPE, evaluation_scope, live_config
from .execution_spec import digest, profile, read_release
from .models import EvaluationAdmission, EvaluationBudget
from .runtime_checks import inspect_runtime


class RuntimeQuery(serializers.Serializer):
    run_id = serializers.UUIDField(required=False)


@never_cache
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def runtime_status(request):
    query = RuntimeQuery(data=request.query_params)
    query.is_valid(raise_exception=True)
    result = inspect_runtime(query.validated_data.get("run_id"))
    return Response(result, status=200 if result["status"] == "PASS" else 503)


class LiveReadinessQuery(serializers.Serializer):
    dataset_id = serializers.ChoiceField(choices=tuple(DATASETS))
    execution_profile = serializers.RegexField(r"^[a-f0-9]{64}$")


@never_cache
@api_view(["GET"])
def live_readiness(request):
    """Read configured admission and budget only; never reserve, dispatch or call a provider."""
    query = LiveReadinessQuery(data=request.query_params)
    query.is_valid(raise_exception=True)
    dataset_id = query.validated_data["dataset_id"]
    scope = evaluation_scope(dataset_id)
    if scope not in {"fixed-answer-context-only", RAG_SCOPE}:
        return Response({"detail": "새 모델 평가를 지원하지 않는 자료입니다."}, status=400)
    try:
        config = live_config(dataset_id)
        if config is None:
            return Response({"detail": "등록된 새 모델 호출 계획이 없습니다."}, status=400)
        spec = profile(read_release(), dataset_id, "live", config)
        stamp = digest(spec)
        plan = operation_plan(SimpleNamespace(execution_spec=spec, live_config=config))
        if not plan or any(item.get("max_input_tokens") is None for item in plan):
            raise BudgetUnavailable
    except (OSError, ValueError, KeyError, TypeError, BudgetUnavailable):
        return Response(
            {"code": "LIVE_PLAN_UNAVAILABLE", "detail": "서버의 실행 계획을 확인할 수 없습니다."},
            status=503,
        )
    if stamp != query.validated_data["execution_profile"]:
        return Response(
            {
                "code": "LIVE_PROFILE_CHANGED",
                "detail": "실행 설정이 변경됐습니다. 화면을 새로고침하세요.",
            },
            status=409,
        )
    required = {
        "calls": len(plan),
        "input_tokens": sum(item["max_input_tokens"] for item in plan),
        "output_tokens": sum(item["max_output_tokens"] for item in plan),
    }
    # Same lock order as new admission, without creating a singleton during a GET.
    with transaction.atomic():
        admission = EvaluationAdmission.objects.select_for_update().filter(pk=1).first()
        budget = EvaluationBudget.objects.select_for_update().filter(pk=1).first()
        summary = budget_summary(budget)
        accepting = admission is None or admission.accepting
        as_of = timezone.now().isoformat()
    blockers, warnings = [], []
    if not settings.LLMOPS_LIVE_ENABLED or (
        scope == RAG_SCOPE and not settings.LLMOPS_RAG_LIVE_ENABLED
    ):
        blockers.append(
            {"code": "LIVE_DISABLED", "message": "선택한 새 모델 평가가 비활성화되어 있습니다."}
        )
    if not accepting:
        blockers.append(
            {"code": "ADMISSION_PAUSED", "message": "새 평가 접수가 중지되어 있습니다."}
        )
    if len(settings.LLMOPS_BUDGET_TOKEN) < 32:
        blockers.append(
            {"code": "BUDGET_AUTH_UNCONFIGURED", "message": "실행기 예산 인증 설정이 필요합니다."}
        )
    if summary["state"] != "consistent":
        blockers.append(
            {
                "code": "BUDGET_UNCONFIGURED"
                if summary["state"] == "unconfigured"
                else "BUDGET_INCONSISTENT",
                "message": "누적 예산 한도를 설정하세요."
                if summary["state"] == "unconfigured"
                else "예산 장부가 일치하지 않아 잔여 한도를 확인할 수 없습니다.",
            }
        )
    if summary["input_state"] != "enforced":
        (blockers if scope == RAG_SCOPE else warnings).append(
            {
                "code": "INPUT_BUDGET_UNKNOWN"
                if summary["input_state"] == "legacy_unknown"
                else "INPUT_BUDGET_UNCONFIGURED",
                "message": "미확인 과거 입력 사용량을 먼저 검토하세요."
                if summary["input_state"] == "legacy_unknown"
                else "누적 입력 토큰 한도가 설정되지 않았습니다.",
            }
        )
    remaining = summary["remaining"]
    if remaining is not None:
        for key, label in (
            ("calls", "호출"),
            ("input_tokens", "입력 토큰"),
            ("output_tokens", "출력 토큰"),
        ):
            if remaining[key] is not None and required[key] > remaining[key]:
                blockers.append(
                    {
                        "code": f"INSUFFICIENT_{key.upper()}",
                        "message": f"잔여 {label} 한도가 이번 실행의 최대 예약량보다 작습니다.",
                    }
                )
    daily = summary["daily"]
    if daily["state"] in {"unknown", "exceeded"}:
        blockers.append(
            {
                "code": "DAILY_BUDGET_UNAVAILABLE",
                "message": "일별 장부가 미확인이거나 일별 한도를 초과했습니다.",
            }
        )
    elif daily["state"] == "enforced":
        for key, label in (
            ("calls", "호출"),
            ("input_tokens", "입력 토큰"),
            ("output_tokens", "출력 토큰"),
        ):
            if required[key] > daily["remaining"][key]:
                blockers.append(
                    {
                        "code": f"DAILY_INSUFFICIENT_{key.upper()}",
                        "message": f"일별 잔여 {label} 한도가 이번 최대 예약량보다 작습니다.",
                    }
                )
    return Response(
        {
            "as_of": as_of,
            "dataset_id": dataset_id,
            "execution_profile": stamp,
            "evaluation_scope": scope,
            "model": config["model"],
            "state": "blocked" if blockers else "checked",
            "required": required,
            "remaining": remaining,
            "daily": daily,
            "blockers": blockers,
            "warnings": warnings,
        }
    )
