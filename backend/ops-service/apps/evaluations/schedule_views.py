"""기존 Core 관리자 세션과 CSRF로 승인하는 일별 평가 계획 API."""

from django.conf import settings
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.views.decorators.cache import never_cache
from rest_framework import serializers
from rest_framework.decorators import api_view
from rest_framework.response import Response

from .admission import AdmissionUnavailable
from .artifact_store import ResultsUnavailable
from .budget import BudgetUnavailable
from .catalog import DATASETS
from .models import EvaluationSchedule
from .schedules import SEOUL, ScheduleBlocked, create_schedule, pause_schedule
from .services import RequestConflict


class ScheduleReasonSerializer(serializers.Serializer):
    request_id = serializers.UUIDField()
    reason = serializers.CharField(max_length=500, allow_blank=False)

    def validate_reason(self, value):
        if any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise serializers.ValidationError("사유는 제어 문자 없이 입력하세요.")
        return value


class ScheduleSerializer(ScheduleReasonSerializer):
    dataset_id = serializers.ChoiceField(choices=tuple(DATASETS))
    reference_capture_id = serializers.RegexField(r"^run:[0-9a-f-]{36}$")
    baseline_version = serializers.IntegerField(min_value=1)
    execution_profile = serializers.RegexField(r"^[a-f0-9]{64}$")
    live_config = serializers.JSONField()
    confirm_paid_run = serializers.BooleanField()
    daily_at = serializers.TimeField(input_formats=["%H:%M"])
    starts_on = serializers.DateField()
    ends_on = serializers.DateField()


def schedule_data(schedule):
    today = timezone.now().astimezone(SEOUL).date()
    return {
        "id": str(schedule.pk),
        "dataset_id": schedule.dataset_id,
        "requested_by": schedule.requested_by.get_username(),
        "request": schedule.request,
        "max_usage": schedule.max_usage,
        "daily_at": schedule.daily_at.strftime("%H:%M"),
        "starts_on": schedule.starts_on.isoformat(),
        "ends_on": schedule.ends_on.isoformat(),
        "reason": schedule.reason,
        "created_at": schedule.created_at.isoformat(),
        "state": "paused"
        if schedule.paused_at
        else "expired"
        if today > schedule.ends_on
        else "active",
        "paused_at": schedule.paused_at.isoformat() if schedule.paused_at else None,
        "paused_by": schedule.paused_by.get_username() if schedule.paused_by_id else None,
        "pause_reason": schedule.pause_reason,
        "occurrences": [
            {
                "id": str(item.pk),
                "scheduled_on": item.scheduled_on.isoformat(),
                "status": item.status,
                "reason_code": item.reason_code,
                "run_id": str(item.run_id) if item.run_id else None,
                "run_status": item.run.status if item.run_id else None,
            }
            for item in schedule.occurrences.select_related("run").order_by("-scheduled_on")
        ],
    }


ERRORS = {
    "SCHEDULE_DISABLED": "정기 실행 또는 선택한 새 모델 평가가 비활성화되어 있습니다.",
    "SCHEDULE_BUDGET_UNAVAILABLE": "누적 입력 한도와 유효한 일별 예산을 먼저 설정하세요.",
    "EXECUTION_PROFILE_CHANGED": "실행 설정이 변경됐습니다. 화면을 새로고침하세요.",
    "REVIEWED_BASELINE_REQUIRED": "사람 검토와 품질 판정을 통과한 현재 비교 기준이 필요합니다.",
    "ACTIVE_SCHEDULE_EXISTS": "이 자료의 기존 계획을 중지한 뒤 새 계획을 등록하세요.",
}


@never_cache
@api_view(["GET", "POST"])
def api_schedules(request):
    if request.method == "GET":
        try:
            page = int(request.query_params.get("page", "1"))
            if page < 1:
                raise ValueError
        except ValueError:
            return Response({"detail": "페이지를 확인하세요."}, status=400)
        rows = EvaluationSchedule.objects.select_related("requested_by", "paused_by").order_by(
            "-created_at", "id"
        )
        return Response(
            {
                "enabled": settings.LLMOPS_SCHEDULES_ENABLED,
                "timezone": "Asia/Seoul",
                "page": page,
                "total": rows.count(),
                "results": [schedule_data(row) for row in rows[(page - 1) * 25 : page * 25]],
            }
        )
    data = ScheduleSerializer(data=request.data)
    data.is_valid(raise_exception=True)
    try:
        schedule, created = create_schedule(request.user, **data.validated_data)
    except ScheduleBlocked as error:
        return Response({"code": error.code, "detail": ERRORS[error.code]}, status=409)
    except RequestConflict:
        return Response({"code": "SCHEDULE_CONFLICT"}, status=409)
    except AdmissionUnavailable as error:
        return Response({"code": error.code}, status=503)
    except BudgetUnavailable:
        return Response({"code": "LIVE_BUDGET_UNAVAILABLE"}, status=400)
    except ResultsUnavailable:
        return Response({"code": "RESULTS_UNAVAILABLE"}, status=503)
    except (ValueError, TypeError, KeyError):
        return Response({"code": "INVALID_SCHEDULE"}, status=400)
    return Response(schedule_data(schedule), status=201 if created else 200)


@never_cache
@api_view(["POST"])
def api_pause_schedule(request, schedule_id):
    get_object_or_404(EvaluationSchedule, pk=schedule_id)
    data = ScheduleReasonSerializer(data=request.data)
    data.is_valid(raise_exception=True)
    try:
        schedule = pause_schedule(schedule_id, request.user, **data.validated_data)
    except RequestConflict:
        return Response({"code": "SCHEDULE_CONFLICT"}, status=409)
    return Response(schedule_data(schedule))
