from urllib.parse import urlencode

from django.conf import settings
from django.http import FileResponse, Http404
from django.middleware.csrf import get_token
from django.shortcuts import get_object_or_404, redirect
from django.urls import reverse
from django.utils import timezone
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_http_methods
from rest_framework import serializers
from rest_framework.decorators import api_view, permission_classes
from rest_framework.pagination import PageNumberPagination
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response

from .catalog import DATASETS, public_datasets, selection
from .models import EvaluationRun
from .services import (
    DATASET_ID,
    RequestConflict,
    ResultsUnavailable,
    read_result,
    submit_run,
    sync_run,
)

ERROR_MESSAGES = {
    "PREFECT_DISPATCH_UNCONFIRMED": (
        "실행 접수를 확인하지 못했습니다. 같은 요청으로 접수를 다시 확인하세요."
    ),
    "PREFECT_STATUS_UNAVAILABLE": (
        "실행 서버에 연결할 수 없습니다. 마지막으로 확인한 상태를 표시합니다."
    ),
    "RESULTS_UNAVAILABLE": (
        "작업은 종료됐지만 결과 파일을 확인할 수 없습니다. 결과 저장소를 확인하세요."
    ),
    "EVALUATION_FAILED": "평가 작업이 실패했습니다. Prefect 로그에서 실패 단계를 확인하세요.",
    "EVALUATION_CRASHED": "평가 실행 프로세스가 중단됐습니다. Prefect 로그를 확인하세요.",
    "EVALUATION_CANCELLED": "평가 실행이 취소됐습니다.",
}


@never_cache
@api_view(["GET"])
@permission_classes([AllowAny])
def api_session(request):
    operator = request.user.is_authenticated
    return Response(
        {
            "user": {"username": request.user.email or request.user.get_username()}
            if operator
            else None,
            "csrf_token": get_token(request),
            "datasets": public_datasets() if operator else [],
        }
    )


@require_http_methods(["GET"])
def web_redirect(request, run_id=None):
    # 기존 Django 화면의 북마크만 React로 옮긴다. 사용자 입력 URL로 리다이렉트하지 않는다.
    path = f"/ops/evaluations/{run_id}" if run_id else "/ops/evaluations"
    return redirect(settings.OPS_WEB_URL + path)


class RunRequestSerializer(serializers.Serializer):
    request_id = serializers.UUIDField()
    dataset_id = serializers.ChoiceField(choices=list(DATASETS))
    candidate_capture_id = serializers.CharField(max_length=100, default=DATASET_ID)
    reference_capture_id = serializers.CharField(max_length=100, default=DATASET_ID)

    def validate(self, attrs):
        try:
            selection(
                attrs["dataset_id"], attrs["candidate_capture_id"], attrs["reference_capture_id"]
            )
        except ValueError as exc:
            raise serializers.ValidationError(str(exc)) from None
        return attrs


def run_data(run, viewer_id=None):
    # 저장 캡처 점수에는 trace가 없어 session 상세가 존재하지 않을 수 있다.
    # Langfuse 4.46 UI의 점수 필터 계약을 사용하고 기본 1일 범위를 해제한다.
    score_query = urlencode(
        {
            "filter": f"sessionId;string;;contains;{run.evaluation_run_id}",
            "dateRange": f"0-{int((run.finished_at or timezone.now()).timestamp() * 1000)}",
        }
    )
    return {
        "id": str(run.id),
        "dataset_id": run.dataset_id,
        "dataset_label": DATASETS[run.dataset_id]["label"],
        "candidate_capture_id": run.candidate_capture_id,
        "reference_capture_id": run.reference_capture_id,
        "candidate_label": selection(
            run.dataset_id, run.candidate_capture_id, run.reference_capture_id
        )[1]["label"],
        "reference_label": selection(
            run.dataset_id, run.candidate_capture_id, run.reference_capture_id
        )[2]["label"],
        "comparison": run.comparison or None,
        "requested_by": run.requested_by.email or run.requested_by.get_username(),
        "can_retry": run.prefect_flow_run_id is None and run.requested_by_id == viewer_id,
        "status": run.status,
        "status_label": run.get_status_display(),
        "created_at": run.created_at,
        "started_at": run.started_at,
        "finished_at": run.finished_at,
        "synced_at": run.synced_at,
        "error_code": run.error_code,
        "error_message": ERROR_MESSAGES.get(run.error_code, ""),
        "summary": run.summary,
        "model_api_calls": 0,
        "evaluation_run_id": run.evaluation_run_id or None,
        "prefect_flow_run_id": str(run.prefect_flow_run_id) if run.prefect_flow_run_id else None,
        "prefect_url": (
            f"{settings.PREFECT_UI_URL}/v2/runs/flow-run/{run.prefect_flow_run_id}"
            if run.prefect_flow_run_id
            else None
        ),
        "langfuse_url": (
            f"{settings.LANGFUSE_PROJECT_URL}/scores?{score_query}"
            if run.evaluation_run_id
            else None
        ),
        "report_url": (
            reverse("evaluation-report", args=[run.id]) if run.status == "COMPLETED" else None
        ),
        "detail_url": f"/ops/evaluations/{run.id}",
    }


@never_cache
@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def api_runs(request):
    if request.method == "GET":
        paginator = PageNumberPagination()
        paginator.page_size = 25
        runs = paginator.paginate_queryset(
            EvaluationRun.objects.select_related("requested_by"), request
        )
        return paginator.get_paginated_response([run_data(run, request.user.pk) for run in runs])
    serializer = RunRequestSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    try:
        run, created = submit_run(request.user, **serializer.validated_data)
    except RequestConflict:
        return Response({"code": "REQUEST_CONFLICT"}, status=409)
    # 응답 유실 가능성이 있으므로 접수 불확실을 실패/완료로 숨기지 않는다.
    status = 503 if run.prefect_flow_run_id is None else (202 if created else 200)
    return Response(run_data(run, request.user.pk), status=status)


@never_cache
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_run_detail(request, run_id):
    run = get_object_or_404(EvaluationRun.objects.select_related("requested_by"), pk=run_id)
    return Response(run_data(sync_run(run), request.user.pk))


@never_cache
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def evaluation_report(request, run_id):
    run = get_object_or_404(EvaluationRun, pk=run_id, status="COMPLETED")
    try:
        _, _, report, _ = read_result(run)
        response = FileResponse(report.open("rb"), content_type="text/html; charset=utf-8")
    except (ResultsUnavailable, OSError) as exc:
        raise Http404("보고서를 확인할 수 없습니다.") from exc
    # 생성 HTML의 스크립트가 Ops 쿠키·DOM·API를 읽을 수 없는 별도 origin sandbox.
    response["Content-Security-Policy"] = (
        "sandbox allow-scripts; default-src 'none'; "
        "script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; "
        "img-src data: blob:; font-src data:; connect-src 'none'"
    )
    response["Cache-Control"] = "private, no-store"
    return response
