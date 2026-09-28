"""평가 기준 검토와 정책별 품질 판정의 불변 이력을 저장한다."""

from hashlib import sha256
from pathlib import Path

from django.db import transaction

from . import quality_policy
from .baselines import change_baseline, lock_baseline
from .catalog import DATASETS
from .execution_spec import digest, read_release
from .models import EvaluationRun, FixtureReview, QualityAssessment
from .review_eligibility import RUBRIC_VERSION, latest_case_reviews
from .services import RequestConflict, ResultsUnavailable, artifact_path

REASONS = {
    "FIXTURE_REVIEW_REQUIRED": "평가 기준 자료의 사람 검토가 필요합니다.",
    "CASE_REVIEW_REQUIRED": "후보 답변의 사례별 검토가 필요합니다.",
    "CASE_UNSUITABLE": "후보 답변의 필수 사례가 부적합으로 검토됐습니다.",
    "STATUS_MISMATCH": "검토된 기대 답변 상태와 일치하지 않습니다.",
    "EXPECTED_CITATION_MISSING": "검토된 필수 인용이 누락됐습니다.",
}


def current_policy():
    policy = read_release()["quality_policy"]
    actual = {
        "definition": quality_policy.POLICY,
        "code_sha256": sha256(Path(quality_policy.__file__).read_bytes()).hexdigest(),
    }
    if policy != actual:
        raise ResultsUnavailable
    return policy


def fixture_reviews(dataset_id):
    return FixtureReview.objects.filter(dataset_id=dataset_id).select_related("reviewed_by")


def fixture_data(review):
    return {
        "id": review.pk,
        "version": review.version,
        "decision": review.decision,
        "comment": review.comment,
        "fixture_sha256": review.fixture_sha256,
        "case_ids": review.case_ids,
        "rubric_version": review.rubric_version,
        "reviewed_by": review.reviewed_by.email or review.reviewed_by.get_username(),
        "created_at": review.created_at,
    }


def assessment_inputs(run, material):
    if run.status != "COMPLETED" or material is None:
        raise ResultsUnavailable
    policy = current_policy()
    pinned = run.execution_spec.get("quality_policy")
    cases = material["cases"]
    fixture = fixture_reviews(run.dataset_id).first()
    fixture_approved = bool(
        fixture
        and fixture.decision == "APPROVED"
        and fixture.fixture_sha256 == material["fixture_sha256"]
        and fixture.case_ids == [case["case_id"] for case in cases]
        and fixture.rubric_version == quality_policy.FIXTURE_RUBRIC
    )
    reviews = latest_case_reviews(run)
    observations = []
    for case in cases:
        review = reviews.get(case["case_id"])
        valid = bool(
            review
            and review.capture_sha256 == material["capture_sha256"]
            and review.fixture_sha256 == material["fixture_sha256"]
            and review.rubric_version == RUBRIC_VERSION
        )
        expected = set(case["expected_citation_orders"])
        observations.append(
            {
                "case_id": case["case_id"],
                "review_id": review.pk if valid else None,
                "review": review.decision if valid else None,
                "status_match": case["answer_status"] == case["expected_status"],
                "citation_recall": len(expected & set(case["cited_orders"])) / len(expected)
                if expected
                else None,
            }
        )
    return {
        "policy": policy,
        # 재판정은 현재 정책을 명시적으로 적용하며 접수 당시 정책을 수정하지 않는다.
        "accepted_policy_sha256": digest(pinned) if pinned is not None else None,
        "assessment_code_sha256": sha256(Path(__file__).read_bytes()).hexdigest(),
        "execution_spec_sha256": run.execution_spec_sha256 or None,
        "fixture_sha256": material["fixture_sha256"],
        "capture_sha256": material["capture_sha256"],
        "comparison_sha256": sha256(
            artifact_path(run, "evaluation/comparison.json").read_bytes()
        ).hexdigest(),
        "fixture_review_id": fixture.pk if fixture else None,
        "fixture_approved": fixture_approved,
        "rubric_version": RUBRIC_VERSION,
        "cases": observations,
    }


def assessment_data(item):
    return {
        "id": item.pk,
        "status": item.status,
        "policy": item.policy,
        "policy_sha256": item.policy_sha256,
        "input_sha256": item.input_sha256,
        "inputs": item.inputs,
        "reasons": [{**reason, "message": REASONS[reason["code"]]} for reason in item.reasons],
        "assessed_by": item.assessed_by.email or item.assessed_by.get_username(),
        "created_at": item.created_at,
    }


def quality_state(run, material):
    history = list(run.assessments.select_related("assessed_by"))
    fixtures = list(fixture_reviews(run.dataset_id))
    try:
        inputs = assessment_inputs(run, material)
    except (ResultsUnavailable, OSError):
        inputs = None
    input_hash = digest(inputs) if inputs else None
    current = next((item for item in history if item.input_sha256 == input_hash), None)
    return {
        "status": current.status
        if current
        else "NEEDS_REVIEW"
        if history and inputs
        else "NOT_EVALUATED",
        "is_current": current is not None,
        "current_id": current.pk if current else None,
        "input_sha256": input_hash,
        "policy": inputs["policy"] if inputs else None,
        "blocked_reason": "완료 자료 또는 정책 명세를 확인할 수 없습니다."
        if inputs is None
        else "",
        "history": [assessment_data(item) for item in history],
        "fixture_version": fixtures[0].version if fixtures else 0,
        "fixture_rubric_version": quality_policy.FIXTURE_RUBRIC,
        "fixture_reviews": [fixture_data(item) for item in fixtures],
    }


def quality_pass(run, material=None):
    if material is None:
        from .reviews import review_material

        try:
            material = review_material(run)
        except ResultsUnavailable:
            return False
    try:
        inputs = assessment_inputs(run, material)
    except (ResultsUnavailable, OSError):
        return False
    return run.assessments.filter(input_sha256=digest(inputs), status="PASS").exists()


def assess(run, user, input_sha256):
    from .reviews import review_material

    material = review_material(run)
    with transaction.atomic():
        baseline = lock_baseline(run.dataset_id)
        locked = EvaluationRun.objects.select_for_update().get(pk=run.pk)
        inputs = assessment_inputs(locked, material)
        if digest(inputs) != input_sha256:
            raise RequestConflict
        status, reasons = quality_policy.judge(inputs)
        record, _ = QualityAssessment.objects.get_or_create(
            run=locked,
            input_sha256=input_sha256,
            defaults={
                "policy": inputs["policy"],
                "policy_sha256": digest(inputs["policy"]),
                "inputs": inputs,
                "status": status,
                "reasons": reasons,
                "assessed_by": user,
            },
        )
        if status != "PASS" and baseline.review_id and baseline.review.run_id == run.pk:
            change_baseline(baseline, None, user, "품질 판정 미충족으로 기준 해제")
        return record


def save_fixture_review(
    run, user, decision, comment, fixture_sha256, case_ids, rubric_version, fixture_version
):
    from .reviews import review_material

    material = review_material(run)
    if (
        fixture_sha256 != material["fixture_sha256"]
        or case_ids != DATASETS[run.dataset_id]["case_ids"]
        or rubric_version != quality_policy.FIXTURE_RUBRIC
    ):
        raise RequestConflict
    with transaction.atomic():
        baseline = lock_baseline(run.dataset_id)
        previous = fixture_reviews(run.dataset_id).first()
        version = previous.version if previous else 0
        if (
            previous
            and version == fixture_version + 1
            and (
                previous.decision == decision
                and previous.comment == comment
                and previous.fixture_sha256 == fixture_sha256
                and previous.case_ids == case_ids
                and previous.rubric_version == rubric_version
                and previous.reviewed_by_id == user.pk
            )
        ):
            return previous
        if version != fixture_version:
            raise RequestConflict
        review = FixtureReview.objects.create(
            dataset_id=run.dataset_id,
            version=version + 1,
            fixture_sha256=fixture_sha256,
            case_ids=case_ids,
            rubric_version=rubric_version,
            decision=decision,
            comment=comment,
            reviewed_by=user,
        )
        if baseline.review_id:
            change_baseline(baseline, None, user, f"평가 기준 자료 검토 변경: {comment}")
        return review
