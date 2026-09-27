import uuid

from django.conf import settings
from django.db import models


class EvaluationRun(models.Model):
    class Status(models.TextChoices):
        REQUESTED = "REQUESTED", "접수 중"
        QUEUED = "QUEUED", "실행 대기"
        RUNNING = "RUNNING", "실행 중"
        COMPLETED = "COMPLETED", "완료"
        FAILED = "FAILED", "실패"
        CANCELLED = "CANCELLED", "취소"
        CRASHED = "CRASHED", "실행 중단"
        RESULT_ERROR = "RESULT_ERROR", "결과 확인 실패"

    # 요청 ID는 재전송을 식별한다. 콘텐츠 해시 기반 평가 ID와 구별한다.
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    dataset_id = models.CharField(max_length=100)
    requested_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.REQUESTED)
    prefect_flow_run_id = models.UUIDField(null=True, unique=True)
    evaluation_run_id = models.CharField(max_length=32, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True)
    finished_at = models.DateTimeField(null=True)
    synced_at = models.DateTimeField(null=True)
    # 안정적인 코드만 저장한다. 외부 예외 본문·키·파일 경로는 노출하지 않는다.
    error_code = models.CharField(max_length=64, blank=True)
    summary = models.JSONField(default=dict)

    class Meta:
        ordering = ["-created_at"]
