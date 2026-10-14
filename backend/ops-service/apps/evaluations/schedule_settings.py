"""관리자 정기 접수 정책. 모델 실행 허용과 예산은 이 정책에서 변경하지 않는다."""

from django.conf import settings
from django.db import transaction

from .models import EvaluationScheduleSettings, EvaluationScheduleSettingsChange
from .services import RequestConflict


def effective_enabled(policy):
    return (
        policy.enabled
        if policy is not None and policy.enabled is not None
        else settings.LLMOPS_SCHEDULES_ENABLED
    )


def enabled():
    return effective_enabled(EvaluationScheduleSettings.objects.filter(pk=1).first())


def lock_settings():
    """외부 검증 이후, 새 접수 및 예산 잠금 이전에만 획득한다."""
    EvaluationScheduleSettings.objects.get_or_create(pk=1)
    return EvaluationScheduleSettings.objects.select_for_update().get(pk=1)


def change_data(change):
    return {
        "request_id": str(change.request_id),
        "revision": change.revision,
        "enabled": change.enabled,
        "previous_enabled": change.previous_enabled,
        "actor": change.actor,
        "reason": change.reason,
        "created_at": change.created_at.isoformat(),
    }


def status():
    # 행을 생성하거나 잠그지 않는다. 읽은 revision 이후의 변경은 이 응답에서 제외한다.
    policy = EvaluationScheduleSettings.objects.filter(pk=1).first()
    revision = policy.revision if policy else 0
    return {
        "enabled": effective_enabled(policy),
        "revision": revision,
        "source": "admin" if revision else "environment",
        "live_enabled": settings.LLMOPS_LIVE_ENABLED,
        "rag_live_enabled": settings.LLMOPS_LIVE_ENABLED and settings.LLMOPS_RAG_LIVE_ENABLED,
        "changes": [
            change_data(change)
            for change in EvaluationScheduleSettingsChange.objects.filter(
                revision__lte=revision
            ).order_by("-revision")[:20]
        ],
    }


def change_settings(*, user, request_id, expected_revision, enabled, reason):
    with transaction.atomic():
        policy = lock_settings()
        previous = EvaluationScheduleSettingsChange.objects.filter(pk=request_id).first()
        if previous is not None:
            if (
                previous.authenticated_actor_id != user.pk
                or previous.revision != expected_revision + 1
                or previous.enabled != enabled
                or previous.reason != reason
            ):
                raise RequestConflict
            change = previous
        else:
            if policy.revision != expected_revision:
                raise RequestConflict
            change = EvaluationScheduleSettingsChange.objects.create(
                request_id=request_id,
                policy=policy,
                revision=policy.revision + 1,
                enabled=enabled,
                previous_enabled=effective_enabled(policy),
                authenticated_actor=user,
                actor=user.get_username(),
                reason=reason,
            )
            policy.enabled = enabled
            policy.revision += 1
            policy.save(update_fields=["enabled", "revision", "updated_at"])
        # 과거 성공 요청의 재전송은 이후 변경을 되돌리지 않는다.
        return {**status(), "change": change_data(change)}
