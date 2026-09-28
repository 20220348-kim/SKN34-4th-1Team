"""사례별 검토와 전체 승인이 현재 비교 기준으로 사용할 수 있는지 판단한다."""

from .catalog import DATASETS
from .models import EvaluationCaseReview, EvaluationReview

RUBRIC_VERSION = "evidence-review-v1"
RUBRIC_CRITERIA = [
    "신청 조건·예외·제외 사유를 누락하거나 근거에 없는 조건을 추가하지 않았는가",
    "답변의 각 주장이 제공한 근거와 일치하고, 근거가 부족하면 부족하다고 답했는가",
    "인용한 청크가 답변을 뒷받침하며 필요한 인용이 빠지지 않았는가",
]


def latest_case_reviews(run):
    latest = {}
    for review in run.case_reviews.select_related("reviewed_by"):
        latest.setdefault(review.case_id, review)
    return latest


def suitable_case_reviews(run, capture_sha256):
    dataset = DATASETS[run.dataset_id]
    latest = latest_case_reviews(run)
    if set(latest) != set(dataset["case_ids"]):
        return None
    if any(
        review.decision != EvaluationCaseReview.Decision.SUITABLE
        or review.capture_sha256 != capture_sha256
        or review.fixture_sha256 != dataset["fixture_sha256"]
        or review.rubric_version != RUBRIC_VERSION
        for review in latest.values()
    ):
        return None
    return latest


def current_approval(review, run):
    if (
        review is None
        or review.version is None
        or review.version != run.review_version
        or review.run_id != run.pk
        or review.decision != EvaluationReview.Decision.APPROVED
        or review.fixture_sha256 != DATASETS[run.dataset_id]["fixture_sha256"]
        or review.rubric_version != RUBRIC_VERSION
    ):
        return False
    cases = suitable_case_reviews(run, review.capture_sha256)
    return cases is not None and set(review.case_reviews.values_list("pk", flat=True)) == {
        item.pk for item in cases.values()
    }
