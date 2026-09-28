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
    candidate_capture_id = models.CharField(max_length=100, default="target-coverage-20260907-v1")
    reference_capture_id = models.CharField(max_length=100, default="target-coverage-20260907-v1")
    reference_config = models.JSONField(default=dict)
    baseline_version = models.PositiveIntegerField(null=True)
    baseline_review = models.ForeignKey("EvaluationReview", null=True, on_delete=models.PROTECT)
    comparison = models.JSONField(default=dict)
    execution_mode = models.CharField(max_length=10, default="replay")
    live_config = models.JSONField(default=dict)
    source_run = models.ForeignKey(
        "self", null=True, on_delete=models.PROTECT, related_name="recoveries"
    )
    recovery_config = models.JSONField(default=dict)
    model_api_calls = models.PositiveSmallIntegerField(default=0, null=True)
    requested_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.REQUESTED)
    prefect_flow_run_id = models.UUIDField(null=True, unique=True)
    evaluation_run_id = models.CharField(max_length=32, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True)
    finished_at = models.DateTimeField(null=True)
    synced_at = models.DateTimeField(null=True)
    sync_attempted_at = models.DateTimeField(null=True)
    # 안정적인 코드만 저장한다. 외부 예외 본문·키·파일 경로는 노출하지 않는다.
    error_code = models.CharField(max_length=64, blank=True)
    summary = models.JSONField(default=dict)

    class Meta:
        ordering = ["-created_at"]


class EvaluationReview(models.Model):
    class Decision(models.TextChoices):
        APPROVED = "APPROVED", "검토 승인"
        CHANGES_REQUESTED = "CHANGES_REQUESTED", "수정 필요"

    run = models.ForeignKey(EvaluationRun, on_delete=models.PROTECT, related_name="reviews")
    decision = models.CharField(max_length=20, choices=Decision.choices)
    comment = models.TextField()
    capture_sha256 = models.CharField(max_length=64)
    reviewed_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-id"]


class EvaluationBaseline(models.Model):
    # 해제 뒤에도 행과 버전을 유지해 최초 지정·교체·접수의 잠금 대상으로 사용한다.
    dataset_id = models.CharField(max_length=100, primary_key=True)
    version = models.PositiveIntegerField(default=0)
    review = models.ForeignKey(EvaluationReview, null=True, on_delete=models.PROTECT)
    selected_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.PROTECT)
    selected_at = models.DateTimeField(auto_now=True)


class EvaluationBaselineChange(models.Model):
    baseline = models.ForeignKey(
        EvaluationBaseline, on_delete=models.PROTECT, related_name="changes"
    )
    version = models.PositiveIntegerField()
    previous_review = models.ForeignKey(
        EvaluationReview, null=True, on_delete=models.PROTECT, related_name="baseline_replacements"
    )
    review = models.ForeignKey(
        EvaluationReview, null=True, on_delete=models.PROTECT, related_name="baseline_selections"
    )
    changed_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    reason = models.TextField()
    fixture_sha256 = models.CharField(max_length=64, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-version"]
        constraints = [
            models.UniqueConstraint(fields=["baseline", "version"], name="unique_baseline_version")
        ]
