"""완료 RAG 실행의 고정 원문·참조 조건 승인과 철회를 누적한다."""

from django.db import transaction

from .models import RagReferenceReview
from .rag_material import read_material
from .rag_reviews import locked_run
from .services import RequestConflict

RUBRIC = {
    "version": "rag-reference-review-v1",
    "scope": "this-run-all-cases",
    "description": (
        "모든 사례의 원문·청크·질문을 대조하고 기대 상태와 기대 인용의 정확성·완전성을 확인합니다."
    ),
}


def reference_state(run, material):
    # 호출자의 실행 행 잠금 안에서 읽는다. 다른 실행의 승인은 재사용하지 않는다.
    case_ids = [case["case_id"] for case in material["cases"]]
    rows = list(run.rag_reference_reviews.select_related("reviewed_by"))
    history = [
        {
            "id": row.pk,
            "version": row.version,
            "decision": row.decision,
            "comment": row.comment,
            "fixture_sha256": row.fixture_sha256,
            "case_ids": row.case_ids,
            "rubric_version": row.rubric_version,
            "execution_spec_sha256": row.execution_spec_sha256,
            "revoked_review_id": row.revoked_review_id,
            "reviewed_by": row.reviewed_by.email or row.reviewed_by.get_username(),
            "created_at": row.created_at.isoformat(),
            "is_current": index == 0
            and row.fixture_sha256 == material["fixture_sha256"]
            and row.case_ids == case_ids
            and row.rubric_version == RUBRIC["version"]
            and row.execution_spec_sha256 == run.execution_spec_sha256,
        }
        for index, row in enumerate(rows)
    ]
    current = history[0] if history and history[0]["is_current"] else None
    return {
        "rubric": RUBRIC,
        "case_ids": case_ids,
        "fixture_sha256": material["fixture_sha256"],
        "approved": bool(current and current["decision"] == "APPROVED"),
        "current_id": current["id"] if current else None,
        "can_revoke": bool(history and history[0]["decision"] == "APPROVED"),
        "history": history,
    }


def save_reference_review(
    run,
    user,
    *,
    decision,
    comment,
    fixture_sha256,
    case_ids,
    rubric_version,
    review_version,
    confirmed_all_cases,
):
    material = read_material(run)
    if (
        fixture_sha256 != material["fixture_sha256"]
        or case_ids != [case["case_id"] for case in material["cases"]]
        or rubric_version != RUBRIC["version"]
    ):
        raise RequestConflict
    comment = comment.strip()
    if (
        decision not in RagReferenceReview.Decision.values
        or not 1 <= len(comment) <= 3000
        or type(review_version) is not int
        or review_version < 0
        or confirmed_all_cases is not True
    ):
        raise ValueError("모든 대상 자료와 검토 근거를 확인하세요.")
    values = {
        "decision": decision,
        "comment": comment,
        "fixture_sha256": fixture_sha256,
        "case_ids": case_ids,
        "rubric_version": rubric_version,
        "execution_spec_sha256": run.execution_spec_sha256,
        "reviewed_by_id": user.pk,
    }
    with transaction.atomic():
        locked = locked_run(run)
        retry = locked.rag_reference_reviews.filter(version=review_version + 1).first()
        if retry:
            if all(getattr(retry, key) == value for key, value in values.items()):
                return retry  # 철회 이후 과거 승인 재전송도 기존 행만 반환한다.
            raise RequestConflict
        if locked.review_version != review_version:
            raise RequestConflict
        previous = locked.rag_reference_reviews.first()
        revoked_id = None
        if decision == "REVOKED":
            if not previous or previous.decision != "APPROVED":
                raise RequestConflict
            revoked_id = previous.pk
        locked.review_version += 1
        locked.save(update_fields=["review_version"])
        return RagReferenceReview.objects.create(
            run=locked,
            version=locked.review_version,
            revoked_review_id=revoked_id,
            **values,
        )
