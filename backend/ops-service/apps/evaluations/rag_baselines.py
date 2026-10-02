"""현재 RAG 합격 판정을 명시적으로 지정·해제하고 접수 시 다시 검증한다."""

from django.db import transaction

from .baselines import change_baseline, lock_baseline
from .catalog import DATASETS
from .models import EvaluationBaseline
from .rag_reviews import locked_run, review_state, state_for_material
from .services import RequestConflict, ResultsUnavailable


def lock_existing(dataset_id):
    # 기준 → 실행 순서. 기준이 없으면 검토만 저장하고 새 행은 만들지 않는다.
    return EvaluationBaseline.objects.select_for_update().filter(pk=dataset_id).first()


def invalidate(baseline, run, user, reason):
    if baseline and baseline.rag_assessment_id and baseline.rag_assessment.run_id == run.pk:
        change_baseline(baseline, None, user, reason)


def baseline_state(run, quality):
    baseline = (
        EvaluationBaseline.objects.select_related("rag_assessment")
        .filter(pk=run.dataset_id)
        .first()
    )
    return {
        "version": baseline.version if baseline else 0,
        "run_id": str(baseline.rag_assessment.run_id)
        if baseline and baseline.rag_assessment_id
        else None,
        "assessment_id": baseline.rag_assessment_id if baseline else None,
        "selected": bool(
            baseline
            and baseline.rag_assessment_id == quality["current_id"]
            and quality["baseline_eligible"]
        ),
        "history": [
            {
                "version": row.version,
                "assessment_id": row.rag_assessment_id,
                "previous_assessment_id": row.previous_rag_assessment_id,
                "reason": row.reason,
                "changed_by": row.changed_by.email or row.changed_by.get_username(),
                "created_at": row.created_at,
            }
            for row in baseline.changes.select_related("changed_by")
        ]
        if baseline
        else [],
    }


def require_pass(run, state, assessment_id, input_sha256):
    quality = state["quality"]
    if (
        not quality["baseline_eligible"]
        or quality["current_id"] != assessment_id
        or quality["input_sha256"] != input_sha256
        or state["material"]["fixture_sha256"] != DATASETS[run.dataset_id]["fixture_sha256"]
    ):
        raise RequestConflict


def select_baseline(run, user, *, assessment_id, input_sha256, baseline_version, reason):
    prepared = review_state(run, user)  # 파일·HTTP 검증은 잠금 밖에서 수행한다.
    with transaction.atomic():
        baseline = lock_baseline(run.dataset_id)
        source = locked_run(run)
        retry = baseline.changes.filter(version=baseline_version + 1).first()
        if retry:
            if (
                retry.rag_assessment_id == assessment_id
                and retry.rag_assessment.run_id == run.pk
                and retry.rag_assessment.input_sha256 == input_sha256
                and retry.changed_by_id == user.pk
                and retry.reason == reason
            ):
                return  # 철회 후 재전송도 과거 지정만 확인하고 재지정하지 않는다.
            raise RequestConflict
        if baseline.version != baseline_version:
            raise RequestConflict
        state = state_for_material(source, prepared["material"], user)
        require_pass(source, state, assessment_id, input_sha256)
        if baseline.rag_assessment_id == assessment_id:
            return
        assessment = source.assessments.get(pk=assessment_id)
        change_baseline(baseline, None, user, reason, rag_assessment=assessment)


def clear_baseline(run, user, *, baseline_version, reason):
    with transaction.atomic():
        baseline = lock_baseline(run.dataset_id)
        retry = baseline.changes.filter(version=baseline_version + 1).first()
        if retry:
            if (
                retry.rag_assessment_id is None
                and retry.previous_rag_assessment_id
                and retry.previous_rag_assessment.run_id == run.pk
                and retry.changed_by_id == user.pk
                and retry.reason == reason
            ):
                return
            raise RequestConflict
        if (
            baseline.version != baseline_version
            or not baseline.rag_assessment_id
            or baseline.rag_assessment.run_id != run.pk
        ):
            raise RequestConflict
        change_baseline(baseline, None, user, reason)


def baseline_choices():
    choices = {}
    for baseline in EvaluationBaseline.objects.select_related("rag_assessment__run").filter(
        rag_assessment__isnull=False
    ):
        assessment = baseline.rag_assessment
        run = assessment.run
        try:
            state = review_state(run, run.requested_by)
            require_pass(run, state, assessment.pk, assessment.input_sha256)
            if not state["baseline"]["selected"]:
                continue
        except (RequestConflict, ResultsUnavailable):
            continue
        choices[baseline.dataset_id] = {
            "id": f"run:{run.pk}",
            "label": f"검토 기준 · {str(run.pk)[:8]}",
            "version": state["baseline"]["version"],
        }
    return choices
