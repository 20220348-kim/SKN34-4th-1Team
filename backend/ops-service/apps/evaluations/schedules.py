"""서울 날짜당 한 번, 관리자가 승인한 종료일 안에서만 평가를 접수한다."""

from datetime import timedelta
from types import SimpleNamespace
from uuid import uuid5
from zoneinfo import ZoneInfo

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from .admission import AdmissionUnavailable, lock_admission, require_open
from .artifact_store import ResultsUnavailable
from .baselines import lock_baseline
from .budget import BudgetUnavailable, operation_plan
from .budget_reporting import budget_summary
from .catalog import LIVE_CAPTURE_ID, RAG_SCOPE, evaluation_scope, validate_execution
from .execution_spec import digest, profile, read_release
from .models import (
    EvaluationBudget,
    EvaluationRun,
    EvaluationSchedule,
    EvaluationScheduleOccurrence,
)
from .reviews import baseline_choices
from .services import PENDING_SYNC, RequestConflict, submit_run

SEOUL = ZoneInfo("Asia/Seoul")


class ScheduleBlocked(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def require_enabled(dataset_id):
    if (
        not settings.LLMOPS_SCHEDULES_ENABLED
        or not settings.LLMOPS_LIVE_ENABLED
        or (evaluation_scope(dataset_id) == RAG_SCOPE and not settings.LLMOPS_RAG_LIVE_ENABLED)
    ):
        raise ScheduleBlocked("SCHEDULE_DISABLED")


def required_capacity(request):
    validate_execution(
        request["dataset_id"],
        LIVE_CAPTURE_ID,
        request["reference_capture_id"],
        "live",
        request["live_config"],
    )
    spec = profile(read_release(), request["dataset_id"], "live", request["live_config"])
    if digest(spec) != request["execution_profile"]:
        raise ScheduleBlocked("EXECUTION_PROFILE_CHANGED")
    plan = operation_plan(SimpleNamespace(execution_spec=spec, live_config=request["live_config"]))
    if not plan or any(item.get("max_input_tokens") is None for item in plan):
        raise BudgetUnavailable
    return {
        "calls": len(plan),
        "input_tokens": sum(item["max_input_tokens"] for item in plan),
        "output_tokens": sum(item["max_output_tokens"] for item in plan),
    }


def require_budget(required):
    """접수 잠금 다음에 전역 예산을 잠근다. reserve도 같은 잠금을 유지한다."""
    budget = EvaluationBudget.objects.select_for_update().filter(pk=1).first()
    summary = budget_summary(budget)
    if (
        len(settings.LLMOPS_BUDGET_TOKEN) < 32
        or summary["state"] != "consistent"
        or summary["input_state"] != "enforced"
        or summary["daily"]["state"] != "enforced"
    ):
        raise ScheduleBlocked("SCHEDULE_BUDGET_UNAVAILABLE")
    if any(
        required[key] > available[key]
        for available in (summary["remaining"], summary["daily"]["remaining"])
        for key in required
    ):
        raise BudgetUnavailable


def create_schedule(user, *, request_id, daily_at, starts_on, ends_on, reason, **request):
    request = {**request, "candidate_capture_id": LIVE_CAPTURE_ID, "execution_mode": "live"}

    def retry(existing):
        if (
            existing.requested_by_id != user.pk
            or existing.request != request
            or existing.daily_at != daily_at
            or existing.starts_on != starts_on
            or existing.ends_on != ends_on
            or existing.reason != reason
        ):
            raise RequestConflict
        return existing, False

    existing = EvaluationSchedule.objects.filter(pk=request_id).first()
    if existing:
        return retry(existing)
    today = timezone.now().astimezone(SEOUL).date()
    if (
        not user.is_active
        or request.get("confirm_paid_run") is not True
        or not today <= starts_on <= ends_on <= starts_on + timedelta(days=30)
        or starts_on > today + timedelta(days=30)
        or daily_at.second
        or daily_at.microsecond
    ):
        raise ValueError(
            "오늘부터 30일 안에 시작하는 최대 31일 계획과 유료 실행 동의가 필요합니다."
        )
    dataset_id = request["dataset_id"]
    require_enabled(dataset_id)
    required = required_capacity(request)
    # RAG의 자료 조회를 포함한 검토 확인은 DB 잠금 밖에서 수행한다.
    choice = baseline_choices().get(dataset_id)
    if not choice or (choice["id"], choice["version"]) != (
        request["reference_capture_id"],
        request["baseline_version"],
    ):
        raise ScheduleBlocked("REVIEWED_BASELINE_REQUIRED")
    with transaction.atomic():
        baseline = lock_baseline(dataset_id)
        existing = EvaluationSchedule.objects.filter(pk=request_id).first()
        if existing:
            return retry(existing)
        if baseline.version != choice["version"]:
            raise RequestConflict
        if EvaluationSchedule.objects.filter(active_dataset=dataset_id).exists():
            raise ScheduleBlocked("ACTIVE_SCHEDULE_EXISTS")
        require_open(lock_admission())
        require_budget(required)
        return EvaluationSchedule.objects.create(
            id=request_id,
            dataset_id=dataset_id,
            active_dataset=dataset_id,
            requested_by=user,
            request=request,
            max_usage=required,
            daily_at=daily_at,
            starts_on=starts_on,
            ends_on=ends_on,
            reason=reason,
        ), True


def pause_schedule(schedule_id, user, *, request_id, reason):
    with transaction.atomic():
        schedule = EvaluationSchedule.objects.select_for_update().get(pk=schedule_id)
        if schedule.paused_at is not None:
            if (schedule.pause_request_id, schedule.paused_by_id, schedule.pause_reason) != (
                request_id,
                user.pk,
                reason,
            ):
                raise RequestConflict
        else:
            if EvaluationSchedule.objects.filter(pause_request_id=request_id).exists():
                raise RequestConflict
            schedule.active_dataset = None
            schedule.paused_at = timezone.now()
            schedule.paused_by = user
            schedule.pause_request_id = request_id
            schedule.pause_reason = reason
            schedule.save(
                update_fields=[
                    "active_dataset",
                    "paused_at",
                    "paused_by",
                    "pause_request_id",
                    "pause_reason",
                ]
            )
        # submit_run also locks the schedule before its occurrence. Close only
        # unsubmitted slots in the same transaction as the authenticated pause.
        # A matching retry can repair slots left pending by an older app version.
        schedule.occurrences.filter(status="PENDING", run__isnull=True).update(
            status="BLOCKED", reason_code="SCHEDULE_CLOSED", updated_at=timezone.now()
        )
        return schedule


def lock_occurrence(occurrence_id, user, request_id, request):
    """submit_run의 새 접수 transaction 시작에서 호출. 순서: 일정 → 기준 → 접수 → 예산."""
    schedule_id = EvaluationScheduleOccurrence.objects.values_list("schedule_id", flat=True).get(
        pk=occurrence_id
    )
    schedule = EvaluationSchedule.objects.select_for_update().get(pk=schedule_id)
    occurrence = EvaluationScheduleOccurrence.objects.select_for_update().get(pk=occurrence_id)
    now = timezone.now().astimezone(SEOUL)
    if (
        occurrence.pk != request_id
        or occurrence.status != "PENDING"
        or schedule.paused_at is not None
        or not schedule.starts_on <= now.date() <= schedule.ends_on
        or occurrence.scheduled_on != now.date()
        or now.time() < schedule.daily_at
        or not user.is_active
        or schedule.requested_by_id != user.pk
        or schedule.request != request
    ):
        raise ScheduleBlocked("SCHEDULE_CLOSED")
    require_enabled(schedule.dataset_id)
    return occurrence


def require_previous_finished(dataset_id):
    if (
        EvaluationRun.objects.filter(dataset_id=dataset_id, execution_mode="live")
        .filter(status__in=PENDING_SYNC)
        .exists()
    ):
        raise ScheduleBlocked("PREVIOUS_RUN_UNFINISHED")
    if EvaluationRun.objects.filter(
        dataset_id=dataset_id,
        execution_mode="live",
        budget_reservation__closed_at__isnull=True,
        budget_reservation__isnull=False,
    ).exists():
        raise ScheduleBlocked("PREVIOUS_BUDGET_UNSETTLED")
    if EvaluationRun.objects.filter(
        dataset_id=dataset_id,
        execution_mode="live",
        budget_reservation__calls__settled_at__isnull=True,
        budget_reservation__calls__isnull=False,
    ).exists():
        raise ScheduleBlocked("PREVIOUS_BUDGET_UNSETTLED")


def dispatch_due_schedules():
    if not settings.LLMOPS_SCHEDULES_ENABLED:
        return 0
    now = timezone.now().astimezone(SEOUL)
    stale_schedules = (
        EvaluationScheduleOccurrence.objects.filter(status="PENDING", scheduled_on__lt=now.date())
        .values_list("schedule_id", flat=True)
        .distinct()
    )
    for schedule_id in list(stale_schedules):
        with transaction.atomic():
            EvaluationSchedule.objects.select_for_update().get(pk=schedule_id)
            EvaluationScheduleOccurrence.objects.filter(
                schedule_id=schedule_id, status="PENDING", scheduled_on__lt=now.date()
            ).update(status="BLOCKED", reason_code="MISSED_SCHEDULE_DAY", updated_at=timezone.now())
    ids = EvaluationSchedule.objects.filter(
        paused_at__isnull=True,
        starts_on__lte=now.date(),
        ends_on__gte=now.date(),
        daily_at__lte=now.time(),
    ).values_list("id", flat=True)
    count = 0
    for schedule_id in list(ids):
        with transaction.atomic():
            schedule = EvaluationSchedule.objects.select_for_update().get(pk=schedule_id)
            if schedule.paused_at is not None:
                continue
            occurrence, _ = EvaluationScheduleOccurrence.objects.get_or_create(
                id=uuid5(schedule_id, now.date().isoformat()),
                defaults={"schedule": schedule, "scheduled_on": now.date()},
            )
            if occurrence.status != "PENDING":
                continue
        try:
            submit_run(
                schedule.requested_by,
                occurrence.pk,
                **schedule.request,
                schedule_occurrence_id=occurrence.pk,
            )
        except (
            ScheduleBlocked,
            BudgetUnavailable,
            AdmissionUnavailable,
            ResultsUnavailable,
            RequestConflict,
            ValueError,
        ) as error:
            if isinstance(error, (ScheduleBlocked, AdmissionUnavailable)):
                code = error.code
            elif isinstance(error, BudgetUnavailable):
                code = "LIVE_BUDGET_UNAVAILABLE"
            elif isinstance(error, ResultsUnavailable):
                code = "RESULTS_UNAVAILABLE"
            else:
                code = "BASELINE_OR_PROFILE_CHANGED"
            # 다른 dispatcher가 이미 접수한 결과는 덮어쓰지 않는다.
            EvaluationScheduleOccurrence.objects.filter(pk=occurrence.pk, status="PENDING").update(
                status="BLOCKED", reason_code=code, updated_at=timezone.now()
            )
        count += 1
    return count
