"""Serialize new requests with operator pause/resume without holding locks over HTTP."""

from uuid import UUID

from django.db import DatabaseError, transaction

from .models import EvaluationAdmission, EvaluationAdmissionChange


class AdmissionUnavailable(Exception):
    code = "EVALUATION_ADMISSION_UNAVAILABLE"


class AdmissionPaused(AdmissionUnavailable):
    code = "EVALUATION_ADMISSION_PAUSED"


def lock_admission():
    """Lock after baseline/source checks, just before new run creation and budget locks."""
    try:
        # Before the first operation the new table is empty and admission is open.
        # Once changed, audit foreign keys protect the singleton from deletion.
        EvaluationAdmission.objects.get_or_create(pk=1)
        return EvaluationAdmission.objects.select_for_update().get(pk=1)
    except DatabaseError as error:
        raise AdmissionUnavailable from error


def require_open(state):
    if not state.accepting:
        raise AdmissionPaused


def status():
    state = EvaluationAdmission.objects.filter(pk=1).first()
    return {
        "scope": "ops_new_evaluation_requests",
        "initialized": state is not None,
        "accepting": state.accepting if state is not None else True,
        "version": state.version if state is not None else 0,
        "updated_at": state.updated_at.isoformat() if state is not None else None,
    }


def change_admission(*, accepting, expected_version, request_id, actor, reason):
    try:
        request_id = UUID(str(request_id))
    except (ValueError, TypeError, AttributeError) as error:
        raise ValueError("request-id에는 UUID가 필요합니다.") from error
    if (
        type(accepting) is not bool
        or type(expected_version) is not int
        or not 0 <= expected_version < 2**63 - 1
        or not isinstance(actor, str)
        or not 1 <= len(actor.strip()) <= 150
        or not isinstance(reason, str)
        or not 1 <= len(reason.strip()) <= 500
        or any(ord(char) < 32 or ord(char) == 127 for char in actor + reason)
    ):
        raise ValueError("버전과 변경자·사유를 확인하세요.")
    actor, reason = actor.strip(), reason.strip()
    with transaction.atomic():
        state = lock_admission()
        previous = EvaluationAdmissionChange.objects.filter(pk=request_id).first()
        replayed = previous is not None
        if previous is not None:
            if (
                previous.version != expected_version + 1
                or previous.accepting != accepting
                or previous.actor != actor
                or previous.reason != reason
            ):
                raise ValueError("같은 request-id의 변경 조건이 다릅니다.")
            change = previous
        else:
            if state.version != expected_version:
                raise ValueError("접수 상태 버전이 변경되었습니다. status를 다시 확인하세요.")
            change = EvaluationAdmissionChange.objects.create(
                request_id=request_id,
                admission=state,
                version=state.version + 1,
                previous_accepting=state.accepting,
                accepting=accepting,
                actor=actor,
                reason=reason,
            )
            state.accepting = accepting
            state.version += 1
            state.save(update_fields=["accepting", "version", "updated_at"])
        # A replay returns current state too; an old resume never reopens a later pause.
        return {
            **status(),
            "replayed": replayed,
            "change": {
                "request_id": str(change.request_id),
                "version": change.version,
                "accepting": change.accepting,
            },
        }
