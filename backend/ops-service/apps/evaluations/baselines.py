"""데이터셋별 비교 기준의 잠금과 변경 이력을 소유한다."""

from .catalog import DATASETS
from .models import EvaluationBaseline, EvaluationBaselineChange


def lock_baseline(dataset_id):
    # 호출자가 transaction.atomic()을 소유한다. 없는 행도 PK로 한 번만 생성한다.
    EvaluationBaseline.objects.get_or_create(dataset_id=dataset_id)
    return EvaluationBaseline.objects.select_for_update().get(pk=dataset_id)


def change_baseline(baseline, review, user, reason, *, rag_assessment=None):
    previous = baseline.review
    previous_rag = baseline.rag_assessment
    baseline.version += 1
    baseline.review = review
    baseline.rag_assessment = rag_assessment
    baseline.selected_by = user
    baseline.save(
        update_fields=["version", "review", "rag_assessment", "selected_by", "selected_at"]
    )
    EvaluationBaselineChange.objects.create(
        baseline=baseline,
        version=baseline.version,
        previous_review=previous,
        review=review,
        previous_rag_assessment=previous_rag,
        rag_assessment=rag_assessment,
        changed_by=user,
        reason=reason,
        fixture_sha256=DATASETS[baseline.dataset_id]["fixture_sha256"],
    )
