"""고정 RAG 자료에 대한 사람의 사례별 판단을 버전 충돌 없이 누적한다."""

from django.db import transaction

from .models import EvaluationRun, RagCaseReview
from .rag_material import read_material
from .services import RequestConflict, ResultsUnavailable

RUBRIC = {
    "version": "rag-case-review-v1",
    "criteria": [
        {
            "key": "retrieval",
            "label": "검색 적합성",
            "description": "질문에 필요한 원문 근거를 검색했고 무관한 근거에 의존하지 않는가",
        },
        {
            "key": "answer",
            "label": "답변 정확성",
            "description": (
                "후보 답변의 주장·조건·예외가 원문과 일치하며 근거 부족을 올바르게 알리는가"
            ),
        },
        {
            "key": "citation",
            "label": "인용 적합성",
            "description": "인용이 주장을 뒷받침하고 필요한 근거의 누락이나 과잉 인용이 없는가",
        },
    ],
}
DECISION_FIELDS = ("retrieval_decision", "answer_decision", "citation_decision")


def validate_review(material, *, case_id, material_sha256, rubric_version, **decisions):
    if material["material_sha256"] != material_sha256 or rubric_version != RUBRIC["version"]:
        raise RequestConflict
    case = next((item for item in material["cases"] if item["case_id"] == case_id), None)
    if case is None:
        raise ValueError("검토할 사례를 확인하세요.")
    candidate = case["candidate"]
    for field in DECISION_FIELDS:
        if decisions[field] not in RagCaseReview.Decision.values:
            raise ValueError("판단을 확인하세요.")
        measured = (
            candidate["retrieved_chunk_ids"] is not None
            if field == "retrieval_decision"
            else candidate["answer"] is not None
        )
        if not measured and decisions[field] != "DEFERRED":
            raise ValueError("미측정 항목은 판단 보류만 저장할 수 있습니다.")


def locked_run(run):
    locked = EvaluationRun.objects.select_for_update().get(pk=run.pk)
    if locked.status != "COMPLETED":
        raise ResultsUnavailable
    # 파일·HTTP 검증 후 짧은 DB 잠금을 잡는다. 잠금 사이에 실행 명세가 바뀌면 저장하지 않는다.
    if any(
        getattr(locked, field) != getattr(run, field)
        for field in (
            "dataset_id",
            "candidate_capture_id",
            "reference_capture_id",
            "execution_mode",
            "execution_spec_sha256",
            "execution_spec",
            "recovery_config",
            "reference_config",
        )
    ):
        raise RequestConflict
    return locked


def review_state(run, user):
    material = read_material(run)
    with transaction.atomic():
        locked = locked_run(run)
        rows = list(locked.rag_case_reviews.select_related("reviewed_by"))
        latest = {}
        for row in rows:
            latest.setdefault(row.case_id, row.pk)
        state = {
            "material": material,
            "reviewer_id": user.get_username(),
            "review_version": locked.review_version,
            "rubric": RUBRIC,
            "case_reviews": [
                {
                    "id": row.pk,
                    "case_id": row.case_id,
                    "version": row.version,
                    **{field: getattr(row, field) for field in DECISION_FIELDS},
                    "comment": row.comment,
                    "material_sha256": row.material_sha256,
                    "fixture_sha256": row.fixture_sha256,
                    "candidate_capture_sha256": row.candidate_capture_sha256,
                    "reference_capture_sha256": row.reference_capture_sha256,
                    "execution_spec_sha256": row.execution_spec_sha256,
                    "rubric_version": row.rubric_version,
                    "is_current": latest[row.case_id] == row.pk
                    and row.material_sha256 == material["material_sha256"]
                    and row.rubric_version == RUBRIC["version"]
                    and row.execution_spec_sha256 == locked.execution_spec_sha256,
                    "reviewed_by": row.reviewed_by.email or row.reviewed_by.get_username(),
                    "created_at": row.created_at,
                }
                for row in rows
            ],
        }
        from .rag_quality import quality_state
        from .rag_reference_reviews import reference_state

        state["reference_review"] = reference_state(locked, material)
        state["quality"] = quality_state(locked, state)
        return state


def save_review(
    run,
    user,
    *,
    case_id,
    material_sha256,
    rubric_version,
    review_version,
    comment,
    retrieval_decision,
    answer_decision,
    citation_decision,
):
    material = read_material(run)
    decisions = dict(
        zip(DECISION_FIELDS, (retrieval_decision, answer_decision, citation_decision), strict=True)
    )
    validate_review(
        material,
        case_id=case_id,
        material_sha256=material_sha256,
        rubric_version=rubric_version,
        **decisions,
    )
    comment = comment.strip()
    if not 1 <= len(comment) <= 3000 or type(review_version) is not int or review_version < 0:
        raise ValueError("검토 의견과 버전을 확인하세요.")
    values = {
        "case_id": case_id,
        **decisions,
        "comment": comment,
        "material_sha256": material_sha256,
        "rubric_version": rubric_version,
        "execution_spec_sha256": run.execution_spec_sha256,
        **{
            key: material[key]
            for key in ("fixture_sha256", "candidate_capture_sha256", "reference_capture_sha256")
        },
        "reviewed_by_id": user.pk,
    }
    with transaction.atomic():
        locked = locked_run(run)
        previous = locked.rag_case_reviews.filter(version=review_version + 1).first()
        if previous is not None:
            if all(getattr(previous, key) == value for key, value in values.items()):
                # 응답 유실 재전송. 이후 검토가 있어도 이력을 중복 생성하지 않는다.
                return previous
            raise RequestConflict
        if locked.review_version != review_version:
            raise RequestConflict
        locked.review_version += 1
        locked.save(update_fields=["review_version"])
        return RagCaseReview.objects.create(run=locked, version=locked.review_version, **values)
