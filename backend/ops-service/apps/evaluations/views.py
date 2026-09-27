from urllib.parse import urlencode
from uuid import uuid4

from django.conf import settings
from django.contrib.auth.decorators import user_passes_test
from django.contrib.auth.views import LoginView
from django.http import FileResponse, Http404, HttpResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.utils import timezone
from django.views.decorators.http import require_http_methods
from rest_framework import serializers
from rest_framework.decorators import api_view, permission_classes
from rest_framework.pagination import PageNumberPagination
from rest_framework.permissions import IsAdminUser
from rest_framework.response import Response

from .forms import EvaluationForm, OperatorAuthenticationForm
from .models import EvaluationRun
from .services import (
    DATASET_ID,
    DATASET_LABEL,
    TERMINAL,
    RequestConflict,
    ResultsUnavailable,
    read_result,
    submit_run,
    sync_run,
)

operator_required = user_passes_test(lambda user: user.is_active and user.is_staff)

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


class OperatorLoginView(LoginView):
    authentication_form = OperatorAuthenticationForm
    template_name = "evaluations/login.html"


class RunRequestSerializer(serializers.Serializer):
    request_id = serializers.UUIDField()
    dataset_id = serializers.ChoiceField(choices=[DATASET_ID])


def run_data(run):
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
        "dataset_label": DATASET_LABEL,
        "requested_by": run.requested_by.get_username(),
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
        "detail_url": reverse("evaluation-detail", args=[run.id]),
    }


@api_view(["GET", "POST"])
@permission_classes([IsAdminUser])
def api_runs(request):
    if request.method == "GET":
        paginator = PageNumberPagination()
        paginator.page_size = 25
        runs = paginator.paginate_queryset(
            EvaluationRun.objects.select_related("requested_by"), request
        )
        return paginator.get_paginated_response([run_data(run) for run in runs])
    serializer = RunRequestSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    try:
        run, created = submit_run(request.user, **serializer.validated_data)
    except RequestConflict:
        return Response({"code": "REQUEST_CONFLICT"}, status=409)
    # 응답 유실 가능성이 있으므로 접수 불확실을 실패/완료로 숨기지 않는다.
    status = 503 if run.prefect_flow_run_id is None else (202 if created else 200)
    return Response(run_data(run), status=status)


@api_view(["GET"])
@permission_classes([IsAdminUser])
def api_run_detail(request, run_id):
    run = get_object_or_404(EvaluationRun.objects.select_related("requested_by"), pk=run_id)
    return Response(run_data(sync_run(run)))


@operator_required
@require_http_methods(["GET", "POST"])
def evaluation_list(request):
    form = EvaluationForm(request.POST or None, initial={"request_id": uuid4()})
    if request.method == "POST" and form.is_valid():
        try:
            run, _ = submit_run(request.user, **form.cleaned_data)
        except RequestConflict:
            form.add_error(None, "이미 다른 평가에 사용된 요청입니다. 페이지를 새로 열어 주세요.")
        else:
            return redirect("evaluation-detail", run_id=run.id)
    from django.core.paginator import Paginator

    page = Paginator(EvaluationRun.objects.select_related("requested_by"), 25).get_page(
        request.GET.get("page")
    )
    return render(request, "evaluations/list.html", {"form": form, "page": page})


@operator_required
@require_http_methods(["GET", "POST"])
def evaluation_detail(request, run_id):
    run = get_object_or_404(EvaluationRun.objects.select_related("requested_by"), pk=run_id)
    if request.method == "POST":
        try:
            submit_run(request.user, run.id, run.dataset_id)
        except RequestConflict:
            return HttpResponse("요청자만 접수를 다시 확인할 수 있습니다.", status=403)
        return redirect("evaluation-detail", run_id=run.id)
    run = sync_run(run)
    return render(
        request,
        "evaluations/detail.html",
        {
            "run": run,
            "data": run_data(run),
            "poll": run.prefect_flow_run_id is not None and run.status not in TERMINAL,
        },
    )


@operator_required
@require_http_methods(["GET"])
def evaluation_report(request, run_id):
    run = get_object_or_404(EvaluationRun, pk=run_id, status="COMPLETED")
    try:
        _, _, report = read_result(run)
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
