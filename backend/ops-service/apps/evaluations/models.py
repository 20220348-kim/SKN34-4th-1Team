import uuid

from django.conf import settings
from django.db import models
from django.utils import timezone


class EvaluationAdmission(models.Model):
    """새 Ops 평가 접수의 공통 잠금. 기존 실행의 종료·정산은 계속 허용한다."""

    id = models.PositiveSmallIntegerField(primary_key=True, default=1, editable=False)
    accepting = models.BooleanField(default=True)
    version = models.PositiveBigIntegerField(default=0)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=models.Q(id=1), name="single_admission")]


class EvaluationAdmissionChange(models.Model):
    request_id = models.UUIDField(primary_key=True)
    admission = models.ForeignKey(EvaluationAdmission, on_delete=models.PROTECT)
    version = models.PositiveBigIntegerField(unique=True)
    previous_accepting = models.BooleanField()
    accepting = models.BooleanField()
    actor = models.CharField(max_length=150)
    reason = models.CharField(max_length=500)
    created_at = models.DateTimeField(auto_now_add=True)


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


class EvaluationScheduleSettings(models.Model):
    """정기 접수의 관리자 정책과 접수 transaction이 공유하는 잠금."""

    id = models.PositiveSmallIntegerField(primary_key=True, default=1, editable=False)
    # 첫 관리자 저장 전에는 기존 환경설정을 따른다. GET은 행을 만들지 않는다.
    enabled = models.BooleanField(null=True, default=None)
    revision = models.PositiveBigIntegerField(default=0)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.CheckConstraint(condition=models.Q(id=1), name="single_schedule_settings"),
            models.CheckConstraint(
                condition=(
                    models.Q(revision=0, enabled__isnull=True)
                    | models.Q(revision__gt=0, enabled__isnull=False)
                ),
                name="schedule_settings_initialized",
            ),
        ]


class EvaluationScheduleSettingsChange(models.Model):
    request_id = models.UUIDField(primary_key=True)
    policy = models.ForeignKey(EvaluationScheduleSettings, on_delete=models.PROTECT)
    revision = models.PositiveBigIntegerField(unique=True)
    enabled = models.BooleanField()
    previous_enabled = models.BooleanField()
    authenticated_actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    actor = models.CharField(max_length=150)
    reason = models.CharField(max_length=500)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(revision__gt=0), name="schedule_settings_change_revision"
            )
        ]


class EvaluationSchedule(models.Model):
    """관리자가 승인한 유한 기간의 일별 계획. 조건 변경은 새 계획으로 남긴다."""

    id = models.UUIDField(primary_key=True, editable=False)
    dataset_id = models.CharField(max_length=100)
    active_dataset = models.CharField(max_length=100, null=True, unique=True)
    requested_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    request = models.JSONField()
    max_usage = models.JSONField()
    daily_at = models.TimeField()
    starts_on = models.DateField()
    ends_on = models.DateField()
    reason = models.CharField(max_length=500)
    created_at = models.DateTimeField(auto_now_add=True)
    paused_at = models.DateTimeField(null=True)
    paused_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, related_name="+", on_delete=models.PROTECT
    )
    pause_request_id = models.UUIDField(null=True, unique=True)
    pause_reason = models.CharField(max_length=500, blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(ends_on__gte=models.F("starts_on")),
                name="schedule_valid_dates",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(
                        active_dataset=models.F("dataset_id"),
                        active_dataset__isnull=False,
                        paused_at__isnull=True,
                        paused_by__isnull=True,
                        pause_request_id__isnull=True,
                        pause_reason="",
                    )
                    | (
                        models.Q(
                            active_dataset__isnull=True,
                            paused_at__isnull=False,
                            paused_by__isnull=False,
                            pause_request_id__isnull=False,
                        )
                        & ~models.Q(pause_reason="")
                    )
                ),
                name="schedule_pause_audit",
            ),
        ]


class EvaluationScheduleOccurrence(models.Model):
    # 일정 ID + 서울 날짜로 만든 UUID를 평가 요청 ID로도 사용한다.
    id = models.UUIDField(primary_key=True, editable=False)
    schedule = models.ForeignKey(
        EvaluationSchedule, related_name="occurrences", on_delete=models.PROTECT
    )
    scheduled_on = models.DateField()
    status = models.CharField(max_length=10, default="PENDING")
    reason_code = models.CharField(max_length=64, blank=True)
    run = models.OneToOneField(EvaluationRun, null=True, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["schedule", "scheduled_on"], name="schedule_one_occurrence_per_day"
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(status="SUBMITTED", run__isnull=False, reason_code="")
                    | models.Q(status="PENDING", run__isnull=True, reason_code="")
                    | (models.Q(status="BLOCKED", run__isnull=True) & ~models.Q(reason_code=""))
                ),
                name="schedule_occurrence_state",
            ),
        ]


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


class RagCaseReview(models.Model):
    class Decision(models.TextChoices):
        SUITABLE = "SUITABLE", "적합"
        UNSUITABLE = "UNSUITABLE", "부적합"
        DEFERRED = "DEFERRED", "판단 보류"

    run = models.ForeignKey(
        EvaluationRun, on_delete=models.PROTECT, related_name="rag_case_reviews"
    )
    case_id = models.CharField(max_length=100)
    version = models.PositiveIntegerField()
    retrieval_decision = models.CharField(max_length=20, choices=Decision.choices)
    answer_decision = models.CharField(max_length=20, choices=Decision.choices)
    citation_decision = models.CharField(max_length=20, choices=Decision.choices)
    comment = models.TextField()
    material_sha256 = models.CharField(max_length=64)
    fixture_sha256 = models.CharField(max_length=64)
    candidate_capture_sha256 = models.CharField(max_length=64)
    reference_capture_sha256 = models.CharField(max_length=64)
    execution_spec_sha256 = models.CharField(max_length=64)
    rubric_version = models.CharField(max_length=40)
    reviewed_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-version"]
        constraints = [
            models.UniqueConstraint(
                fields=["run", "version"], name="unique_rag_case_review_version"
            ),
            models.CheckConstraint(
                condition=models.Q(version__gte=1), name="rag_review_version_positive"
            ),
            *[
                models.CheckConstraint(
                    condition=models.Q(
                        **{f"{field}_decision__in": ["SUITABLE", "UNSUITABLE", "DEFERRED"]}
                    ),
                    name=f"rag_review_{field}_decision",
                )
                for field in ("retrieval", "answer", "citation")
            ],
        ]


class RagReferenceReview(models.Model):
    """한 실행의 고정 원문·참조 조건 전체에 대한 사람 검토 이력."""

    class Decision(models.TextChoices):
        APPROVED = "APPROVED", "참조 자료 승인"
        CHANGES_REQUESTED = "CHANGES_REQUESTED", "수정 필요"
        DEFERRED = "DEFERRED", "판단 보류"
        REVOKED = "REVOKED", "승인 철회"

    run = models.ForeignKey(
        EvaluationRun, on_delete=models.PROTECT, related_name="rag_reference_reviews"
    )
    version = models.PositiveIntegerField()
    decision = models.CharField(max_length=20, choices=Decision.choices)
    comment = models.TextField()
    fixture_sha256 = models.CharField(max_length=64)
    case_ids = models.JSONField()
    rubric_version = models.CharField(max_length=40)
    execution_spec_sha256 = models.CharField(max_length=64)
    reviewed_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)
    revoked_review = models.ForeignKey("self", null=True, on_delete=models.PROTECT)

    class Meta:
        ordering = ["-version"]
        constraints = [
            models.UniqueConstraint(fields=["run", "version"], name="unique_rag_reference_version"),
            models.CheckConstraint(
                condition=models.Q(version__gte=1), name="rag_reference_version_positive"
            ),
            models.CheckConstraint(
                condition=models.Q(
                    decision__in=["APPROVED", "CHANGES_REQUESTED", "DEFERRED", "REVOKED"]
                ),
                name="rag_reference_decision",
            ),
            models.CheckConstraint(
                condition=(models.Q(decision="REVOKED", revoked_review__isnull=False))
                | (~models.Q(decision="REVOKED") & models.Q(revoked_review__isnull=True)),
                name="rag_reference_revocation_target",
            ),
        ]


class EvaluationBaseline(models.Model):
    # 해제 뒤에도 행과 버전을 유지해 최초 지정·교체·접수의 잠금 대상으로 사용한다.
    dataset_id = models.CharField(max_length=100, primary_key=True)
    version = models.PositiveIntegerField(default=0)
    review = models.ForeignKey(EvaluationReview, null=True, on_delete=models.PROTECT)
    rag_assessment = models.ForeignKey("QualityAssessment", null=True, on_delete=models.PROTECT)
    selected_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.PROTECT)
    selected_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(review__isnull=True) | models.Q(rag_assessment__isnull=True),
                name="baseline_one_review_type",
            )
        ]


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
    previous_rag_assessment = models.ForeignKey(
        "QualityAssessment",
        null=True,
        on_delete=models.PROTECT,
        related_name="baseline_replacements",
    )
    rag_assessment = models.ForeignKey(
        "QualityAssessment",
        null=True,
        on_delete=models.PROTECT,
        related_name="baseline_selections",
    )
    changed_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    reason = models.TextField()
    fixture_sha256 = models.CharField(max_length=64, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-version"]
        constraints = [
            models.UniqueConstraint(fields=["baseline", "version"], name="unique_baseline_version"),
            models.CheckConstraint(
                condition=models.Q(review__isnull=True) | models.Q(rag_assessment__isnull=True),
                name="baseline_change_one_review_type",
            ),
            models.CheckConstraint(
                condition=models.Q(previous_review__isnull=True)
                | models.Q(previous_rag_assessment__isnull=True),
                name="baseline_previous_one_review_type",
            ),
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
    input_token_limit = models.PositiveBigIntegerField(null=True)
    allocated_input_tokens = models.PositiveBigIntegerField(default=0)
    allocated_calls = models.PositiveBigIntegerField(default=0)
    allocated_output_tokens = models.PositiveBigIntegerField(default=0)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.CheckConstraint(condition=models.Q(id=1), name="single_evaluation_budget"),
            models.CheckConstraint(
                condition=models.Q(input_token_limit__isnull=True)
                | models.Q(allocated_input_tokens__lte=models.F("input_token_limit")),
                name="evaluation_input_budget_limit",
            ),
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
    # NULL means a legacy reservation with no approved input bound.
    max_input_tokens = models.PositiveIntegerField(null=True)
    reserved_input_tokens = models.PositiveBigIntegerField(null=True)
    reserved_output_tokens = models.PositiveBigIntegerField(null=True)
    worker_id = models.UUIDField(null=True)
    closed_at = models.DateTimeField(null=True)
    # 일별 접수 검사와 같은 시각을 저장한다. 자정 경계에서 날짜가 달라지지 않는다.
    created_at = models.DateTimeField(default=timezone.now, editable=False)


class EvaluationDailyBudget(models.Model):
    """서울 날짜별 접수 한도. 사용량은 기존 예약 원장에서 계산한다."""

    budget = models.OneToOneField(EvaluationBudget, primary_key=True, on_delete=models.PROTECT)
    enabled = models.BooleanField(default=False)
    call_limit = models.PositiveBigIntegerField()
    input_token_limit = models.PositiveBigIntegerField()
    output_token_limit = models.PositiveBigIntegerField()
    updated_at = models.DateTimeField(auto_now=True)


class EvaluationDailyBudgetChange(models.Model):
    """CLI 또는 인증된 관리자의 일별 정책 변경 이력."""

    request_id = models.UUIDField(unique=True)
    policy = models.ForeignKey(EvaluationDailyBudget, on_delete=models.PROTECT)
    actor = models.CharField(max_length=150)
    source = models.CharField(max_length=10, default="CLI", editable=False)
    authenticated_actor = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, on_delete=models.PROTECT, related_name="+"
    )
    expected_revision = models.CharField(max_length=64, null=True)
    reason = models.CharField(max_length=1000)
    previous = models.JSONField(null=True)
    policy_snapshot = models.JSONField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-id"]
        constraints = [
            models.CheckConstraint(
                condition=~models.Q(actor="") & ~models.Q(reason=""),
                name="daily_budget_change_attribution",
            ),
            models.CheckConstraint(
                condition=models.Q(
                    source="CLI", authenticated_actor__isnull=True, expected_revision__isnull=True
                )
                | models.Q(
                    source="CORE_ADMIN",
                    authenticated_actor__isnull=False,
                    expected_revision__isnull=False,
                ),
                name="daily_budget_change_actor_source",
            ),
        ]


class EvaluationBudgetChange(models.Model):
    """CLI 또는 인증된 관리자의 한도 변경 원장. 기존 출처는 보존한다."""

    request_id = models.UUIDField(unique=True)
    budget = models.ForeignKey(EvaluationBudget, on_delete=models.PROTECT)
    actor = models.CharField(max_length=150)
    source = models.CharField(max_length=10, default="CLI", editable=False)
    authenticated_actor = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, on_delete=models.PROTECT, related_name="+"
    )
    expected_revision = models.CharField(max_length=64, null=True)
    reason = models.CharField(max_length=1000)
    previous_call_limit = models.PositiveBigIntegerField(null=True)
    previous_output_token_limit = models.PositiveBigIntegerField(null=True)
    previous_input_token_limit = models.PositiveBigIntegerField(null=True)
    input_token_limit = models.PositiveBigIntegerField(null=True)
    call_limit = models.PositiveBigIntegerField()
    output_token_limit = models.PositiveBigIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-id"]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(
                    source="CLI", authenticated_actor__isnull=True, expected_revision__isnull=True
                )
                | models.Q(
                    source="CORE_ADMIN",
                    authenticated_actor__isnull=False,
                    expected_revision__isnull=False,
                ),
                name="budget_change_actor_source",
            ),
            models.CheckConstraint(
                condition=~models.Q(actor="") & ~models.Q(reason=""),
                name="budget_change_attribution",
            ),
        ]


class EvaluationLegacyUsage(models.Model):
    """예약 도입 전 저장 응답을 운영자가 검토해 반영한 사용량. 과거 승인을 만들지 않는다."""

    run = models.OneToOneField(EvaluationRun, on_delete=models.PROTECT, related_name="legacy_usage")
    budget = models.ForeignKey(EvaluationBudget, on_delete=models.PROTECT)
    request_id = models.UUIDField(unique=True)
    actor = models.CharField(max_length=150)
    actor_source = models.CharField(max_length=10, default="CLI", editable=False)
    authenticated_actor = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, on_delete=models.PROTECT, related_name="+"
    )
    reason = models.CharField(max_length=1000)
    capture_sha256 = models.CharField(max_length=64, unique=True)
    evidence_sha256 = models.CharField(max_length=64)
    evidence = models.JSONField()
    calls = models.PositiveIntegerField()
    input_tokens = models.PositiveBigIntegerField()
    output_tokens = models.PositiveBigIntegerField()
    before = models.JSONField()
    after = models.JSONField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-id"]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(actor_source="CLI", authenticated_actor__isnull=True)
                | models.Q(actor_source="CORE_ADMIN", authenticated_actor__isnull=False),
                name="legacy_usage_actor_source",
            ),
            models.CheckConstraint(condition=models.Q(calls__gt=0), name="legacy_usage_calls"),
            models.CheckConstraint(
                condition=~models.Q(actor="") & ~models.Q(reason=""),
                name="legacy_usage_attribution",
            ),
        ]


class EvaluationBudgetCall(models.Model):
    reservation = models.ForeignKey(
        EvaluationBudgetReservation, on_delete=models.PROTECT, related_name="calls"
    )
    sequence = models.PositiveSmallIntegerField()
    # 과거 승인의 사례를 소급 추정하지 않는다. 새 승인은 고정 실행 명세의 작업을 가리킨다.
    operation_id = models.CharField(max_length=128, null=True, db_collation="utf8mb4_bin")
    max_input_tokens = models.PositiveIntegerField(null=True)
    max_output_tokens = models.PositiveIntegerField(null=True)
    counted_input_tokens = models.PositiveBigIntegerField(null=True)
    input_tokens = models.PositiveBigIntegerField(null=True)
    output_tokens = models.PositiveBigIntegerField(null=True)
    authorized_at = models.DateTimeField(auto_now_add=True)
    settled_at = models.DateTimeField(null=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["reservation", "sequence"], name="unique_evaluation_budget_call"
            ),
            models.UniqueConstraint(
                fields=["reservation", "operation_id"], name="unique_evaluation_budget_operation"
            ),
            models.CheckConstraint(
                condition=models.Q(operation_id__isnull=True) | ~models.Q(operation_id=""),
                name="nonempty_evaluation_budget_operation",
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


class EvaluationUsageCorrection(models.Model):
    """원래 호출 행을 보존하는, 서명된 실행기 사용량 증거의 단발성 보정."""

    request_id = models.UUIDField(primary_key=True)
    call = models.OneToOneField(
        EvaluationBudgetCall, on_delete=models.PROTECT, related_name="correction"
    )
    actor = models.CharField(max_length=150)
    reason = models.CharField(max_length=1000)
    evidence_sha256 = models.CharField(max_length=64, unique=True)
    response_id = models.CharField(max_length=185, unique=True, null=True)
    provider_request_id = models.CharField(max_length=200, unique=True, null=True)
    evidence_raw = models.TextField()
    input_tokens = models.PositiveBigIntegerField()
    output_tokens = models.PositiveBigIntegerField()
    original_call = models.JSONField()
    before = models.JSONField()
    after = models.JSONField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=~models.Q(actor="") & ~models.Q(reason=""),
                name="usage_correction_attribution",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(response_id__isnull=False, provider_request_id__isnull=True)
                    & ~models.Q(response_id="")
                )
                | (
                    models.Q(response_id__isnull=True, provider_request_id__isnull=False)
                    & ~models.Q(provider_request_id="")
                ),
                name="usage_correction_response_identity",
            ),
        ]


class ProductionSampleDay(models.Model):
    """서울 날짜별 접수 상한의 잠금 행. 삭제된 표본도 당일 접수량에서 차감하지 않는다."""

    day = models.DateField(primary_key=True)
    accepted = models.PositiveIntegerField(default=0)


class ProductionQualitySample(models.Model):
    """운영 응답에서 선택해 보관한 자료. 전체 요청의 분모나 품질 합격을 뜻하지 않는다."""

    id = models.UUIDField(primary_key=True, editable=False)
    captured_at = models.DateTimeField()
    received_at = models.DateTimeField(auto_now_add=True, db_index=True)
    scope = models.CharField(max_length=64)
    source_document_id = models.CharField(max_length=320)
    sample_rate_bps = models.PositiveSmallIntegerField()
    trace_id = models.CharField(max_length=32, null=True)
    release = models.CharField(max_length=40, null=True)
    payload_sha256 = models.CharField(max_length=64)
    material = models.JSONField()
    material_sha256 = models.CharField(max_length=64)
    redacted = models.BooleanField(default=False)
    checks_status = models.CharField(max_length=10, default="pending", db_index=True)
    check_codes = models.JSONField(default=list)
    checked_at = models.DateTimeField(null=True)
    review_version = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["-received_at", "-id"]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(sample_rate_bps__gte=1, sample_rate_bps__lte=10000),
                name="production_sample_rate_range",
            ),
            models.CheckConstraint(
                condition=models.Q(checks_status__in=["pending", "checked", "error"]),
                name="production_sample_check_status",
            ),
        ]


class ProductionSampleReview(models.Model):
    """자료 해시에 묶인 관리자 검토 이력. 갱신 대신 새 버전을 저장한다."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    sample = models.ForeignKey(
        ProductionQualitySample, on_delete=models.CASCADE, related_name="reviews"
    )
    request_id = models.UUIDField(unique=True)
    request_sha256 = models.CharField(max_length=64)
    version = models.PositiveIntegerField()
    material_sha256 = models.CharField(max_length=64)
    verdict = models.CharField(max_length=12)
    grounded = models.CharField(max_length=7)
    relevant = models.CharField(max_length=7)
    complete = models.CharField(max_length=7)
    note = models.CharField(max_length=1000)
    reference_answer = models.TextField(blank=True)
    expected_status = models.CharField(max_length=24, null=True)
    expected_citation_ids = models.JSONField(default=list)
    reviewed_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-version"]
        constraints = [
            models.UniqueConstraint(
                fields=["sample", "version"], name="production_sample_review_version"
            ),
            models.CheckConstraint(
                condition=models.Q(verdict__in=["acceptable", "issue", "unassessable"]),
                name="production_review_verdict",
            ),
        ]


class ProductionRegressionCandidate(models.Model):
    """사람이 작성한 기대 응답과 출처를 고정한다. 평가 fixture 자동 등록은 아니다."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    sample = models.OneToOneField(
        ProductionQualitySample, on_delete=models.CASCADE, related_name="regression_candidate"
    )
    review = models.ForeignKey(ProductionSampleReview, on_delete=models.CASCADE)
    request_id = models.UUIDField(unique=True)
    request_sha256 = models.CharField(max_length=64)
    snapshot = models.JSONField()
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)


class EvaluationDataset(models.Model):
    """관리자가 편집하는 초안. 게시된 실행 자료는 별도 불변 버전으로 보존한다."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    draft = models.JSONField()
    version = models.PositiveIntegerField(default=1)
    archived = models.BooleanField(default=False)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="created_datasets"
    )
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="updated_datasets"
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-updated_at", "id"]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(version__gte=1), name="dataset_version_positive"
            )
        ]


class EvaluationDatasetRevision(models.Model):
    """게시 당시 자료·저장 답변의 불변 스냅샷. 수정은 새 게시 번호를 만든다."""

    id = models.CharField(max_length=100, primary_key=True)
    dataset = models.ForeignKey(
        EvaluationDataset, on_delete=models.PROTECT, related_name="revisions"
    )
    number = models.PositiveIntegerField()
    snapshot = models.JSONField()
    published_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-number"]
        constraints = [
            models.UniqueConstraint(fields=["dataset", "number"], name="dataset_revision_number"),
            models.CheckConstraint(
                condition=models.Q(number__gte=1), name="dataset_number_positive"
            ),
        ]


class EvaluationDatasetChange(models.Model):
    """요청 ID와 응답을 보존해 재전송이 이후 수정·보관을 되돌리지 않게 한다."""

    request_id = models.UUIDField(primary_key=True)
    dataset = models.ForeignKey(EvaluationDataset, on_delete=models.PROTECT, related_name="changes")
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    action = models.CharField(max_length=10)
    payload_sha256 = models.CharField(max_length=64)
    response = models.JSONField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(action__in=["CREATE", "UPDATE", "PUBLISH", "ARCHIVE"]),
                name="dataset_change_action",
            )
        ]
