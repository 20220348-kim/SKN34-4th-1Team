import uuid

from django.conf import settings
from django.db import models


class EvaluationRun(models.Model):
    class Status(models.TextChoices):
        REQUESTED = "REQUESTED", "접수 중"
        QUEUED = "QUEUED", "실행 대기"
        RUNNING = "RUNNING", "실행 중"
        CANCELLING = "CANCELLING", "취소 요청 중"
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
    review_version = models.PositiveIntegerField(default=0)
    comparison = models.JSONField(default=dict)
    execution_mode = models.CharField(max_length=10, default="replay")
    live_config = models.JSONField(default=dict)
    # 과거 기록은 빈 값으로 남긴다. 새 요청만 접수 시의 명세를 보존한다.
    execution_spec = models.JSONField(default=dict)
    execution_spec_sha256 = models.CharField(max_length=64, blank=True)
    source_run = models.ForeignKey(
        "self", null=True, on_delete=models.PROTECT, related_name="recoveries"
    )
    recovery_config = models.JSONField(default=dict)
    model_api_calls = models.PositiveSmallIntegerField(default=0, null=True)
    requested_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    cancel_requested_at = models.DateTimeField(null=True)
    cancel_requested_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        on_delete=models.PROTECT,
        related_name="evaluation_cancellations",
    )
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
    fixture_sha256 = models.CharField(max_length=64, blank=True)
    rubric_version = models.CharField(max_length=40, blank=True)
    version = models.PositiveIntegerField(null=True)
    case_reviews = models.ManyToManyField("EvaluationCaseReview", blank=True)
    reviewed_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-id"]
        constraints = [
            models.UniqueConstraint(fields=["run", "version"], name="unique_run_review_version")
        ]


class EvaluationCaseReview(models.Model):
    class Decision(models.TextChoices):
        SUITABLE = "SUITABLE", "적합"
        UNSUITABLE = "UNSUITABLE", "부적합"
        DEFERRED = "DEFERRED", "판단 보류"

    run = models.ForeignKey(EvaluationRun, on_delete=models.PROTECT, related_name="case_reviews")
    case_id = models.CharField(max_length=100)
    version = models.PositiveIntegerField()
    decision = models.CharField(max_length=20, choices=Decision.choices)
    comment = models.TextField()
    capture_sha256 = models.CharField(max_length=64)
    fixture_sha256 = models.CharField(max_length=64)
    rubric_version = models.CharField(max_length=40)
    reviewed_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-version"]
        constraints = [
            models.UniqueConstraint(fields=["run", "version"], name="unique_case_review_version")
        ]


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


class FixtureReview(models.Model):
    dataset_id = models.CharField(max_length=100)
    version = models.PositiveIntegerField()
    fixture_sha256 = models.CharField(max_length=64)
    case_ids = models.JSONField()
    rubric_version = models.CharField(max_length=40)
    decision = models.CharField(
        max_length=20,
        choices=[
            ("APPROVED", "검토 승인"),
            ("CHANGES_REQUESTED", "수정 필요"),
            ("DEFERRED", "보류"),
        ],
    )
    comment = models.TextField()
    reviewed_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-version"]
        constraints = [
            models.UniqueConstraint(fields=["dataset_id", "version"], name="unique_fixture_review")
        ]


class QualityAssessment(models.Model):
    run = models.ForeignKey(EvaluationRun, on_delete=models.PROTECT, related_name="assessments")
    policy = models.JSONField()
    policy_sha256 = models.CharField(max_length=64)
    inputs = models.JSONField()
    input_sha256 = models.CharField(max_length=64)
    status = models.CharField(
        max_length=20,
        choices=[("PASS", "합격"), ("FAIL", "불합격"), ("NEEDS_REVIEW", "검토 필요")],
    )
    reasons = models.JSONField(default=list)
    assessed_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-id"]
        constraints = [
            models.UniqueConstraint(
                fields=["run", "input_sha256"], name="unique_quality_assessment"
            )
        ]


class EvaluationBudget(models.Model):
    # Ops DB 전체 누적 한도. 자동 기간 초기화나 미확인 사용량 환급은 하지 않는다.
    id = models.PositiveSmallIntegerField(primary_key=True, default=1, editable=False)
    call_limit = models.PositiveBigIntegerField(default=0)
    output_token_limit = models.PositiveBigIntegerField(default=0)
    allocated_calls = models.PositiveBigIntegerField(default=0)
    allocated_output_tokens = models.PositiveBigIntegerField(default=0)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.CheckConstraint(condition=models.Q(id=1), name="single_evaluation_budget"),
            models.CheckConstraint(
                condition=models.Q(allocated_calls__lte=models.F("call_limit")),
                name="evaluation_call_budget_limit",
            ),
            models.CheckConstraint(
                condition=models.Q(allocated_output_tokens__lte=models.F("output_token_limit")),
                name="evaluation_output_budget_limit",
            ),
        ]


class EvaluationBudgetReservation(models.Model):
    run = models.OneToOneField(
        EvaluationRun, primary_key=True, on_delete=models.PROTECT, related_name="budget_reservation"
    )
    budget = models.ForeignKey(EvaluationBudget, on_delete=models.PROTECT)
    max_calls = models.PositiveSmallIntegerField()
    max_output_tokens = models.PositiveIntegerField()
    worker_id = models.UUIDField(null=True)
    closed_at = models.DateTimeField(null=True)
    created_at = models.DateTimeField(auto_now_add=True)


class EvaluationBudgetChange(models.Model):
    """CLI가 기록하는 한도 변경 원장. 기존 한도의 출처를 소급해서 만들지 않는다."""

    request_id = models.UUIDField(unique=True)
    budget = models.ForeignKey(EvaluationBudget, on_delete=models.PROTECT)
    actor = models.CharField(max_length=150)
    source = models.CharField(max_length=10, default="CLI", editable=False)
    reason = models.CharField(max_length=1000)
    previous_call_limit = models.PositiveBigIntegerField(null=True)
    previous_output_token_limit = models.PositiveBigIntegerField(null=True)
    call_limit = models.PositiveBigIntegerField()
    output_token_limit = models.PositiveBigIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-id"]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(source="CLI"), name="budget_change_cli_source"
            ),
            models.CheckConstraint(
                condition=~models.Q(actor="") & ~models.Q(reason=""),
                name="budget_change_attribution",
            ),
        ]


class EvaluationBudgetCall(models.Model):
    reservation = models.ForeignKey(
        EvaluationBudgetReservation, on_delete=models.PROTECT, related_name="calls"
    )
    sequence = models.PositiveSmallIntegerField()
    input_tokens = models.PositiveBigIntegerField(null=True)
    output_tokens = models.PositiveBigIntegerField(null=True)
    authorized_at = models.DateTimeField(auto_now_add=True)
    settled_at = models.DateTimeField(null=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["reservation", "sequence"], name="unique_evaluation_budget_call"
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(
                        input_tokens__isnull=True,
                        output_tokens__isnull=True,
                        settled_at__isnull=True,
                    )
                    | models.Q(
                        input_tokens__isnull=False,
                        output_tokens__isnull=False,
                        settled_at__isnull=False,
                    )
                ),
                name="complete_evaluation_call_usage",
            ),
        ]


class EvaluationBudgetCleanup(models.Model):
    """Prefect 종료 증거로 수행한 CLI 예약 정리. 사용량 보정이나 실행 재개가 아니다."""

    request_id = models.UUIDField(primary_key=True)
    reservation = models.OneToOneField(
        EvaluationBudgetReservation, on_delete=models.PROTECT, related_name="cleanup"
    )
    actor = models.CharField(max_length=150)
    reason = models.CharField(max_length=1000)
    evidence = models.JSONField()
    worker_id = models.UUIDField(null=True)
    calls = models.JSONField()
    before = models.JSONField()
    after = models.JSONField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=~models.Q(actor="") & ~models.Q(reason=""),
                name="budget_cleanup_attribution",
            ),
        ]
