"""선택한 실측의 검토 진행과 같은 자료의 현재 비교 기준을 읽는다."""

from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.views.decorators.cache import never_cache
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from . import rag_baselines, rag_reviews, reviews
from .catalog import DATASETS
from .dashboard import FIXED_SCOPE, RAG_SCOPE
from .models import EvaluationBaseline, EvaluationRun
from .review_eligibility import current_approval
from .services import RequestConflict, ResultsUnavailable


def read_state(run, user):
    if run.status != "COMPLETED" or run.dataset_id not in DATASETS:
        raise ResultsUnavailable
    scope = run.comparison.get("scope")
    if scope == RAG_SCOPE:
        state = rag_reviews.review_state(run, user)
        return state["material"], state
    if scope == FIXED_SCOPE:
        material = reviews.review_material(run)
        return material, reviews.review_state(run, material)
    raise ResultsUnavailable


def review_summary(material, state):
    rag = material["evaluation_scope"] == RAG_SCOPE
    latest = {}
    for row in sorted(state["case_reviews"], key=lambda row: row["version"], reverse=True):
        latest.setdefault(row["case_id"], row)
    counts = dict.fromkeys(("suitable", "unsuitable", "deferred", "unreviewed", "stale"), 0)
    for case in material["cases"]:
        row = latest.get(case["case_id"])
        if not row:
            counts["unreviewed"] += 1
            continue
        current = (
            row["is_current"]
            if rag
            else row["capture_sha256"] == material["capture_sha256"]
            and row["fixture_sha256"] == material["fixture_sha256"]
            and row["rubric_version"] == state["rubric"]["version"]
        )
        if not current:
            counts["stale"] += 1
            continue
        decisions = (
            [row[field] for field in rag_reviews.DECISION_FIELDS] if rag else [row["decision"]]
        )
        # RAG은 검색·답변·인용을 모두 적합으로 검토한 사례만 적합으로 센다.
        decision = (
            "UNSUITABLE"
            if "UNSUITABLE" in decisions
            else "DEFERRED"
            if "DEFERRED" in decisions
            else "SUITABLE"
        )
        counts[decision.lower()] += 1
    quality = state["quality"]
    if rag:
        reference_approved = state["reference_review"]["approved"]
    else:
        fixture = next(iter(quality["fixture_reviews"]), None)
        reference_approved = bool(
            fixture
            and fixture["decision"] == "APPROVED"
            and fixture["fixture_sha256"] == material["fixture_sha256"]
            and fixture["case_ids"] == [case["case_id"] for case in material["cases"]]
            and fixture["rubric_version"] == quality["fixture_rubric_version"]
        )
    return {
        "cases": {"total": len(material["cases"]), **counts},
        "reference_approved": reference_approved,
        "approval": "not_required"
        if rag
        else "approved"
        if state["approval_current"]
        else "pending",
        "quality": (
            "UNAVAILABLE"
            if quality.get("blocked_reason")
            else quality["status"]
            if quality["is_current"]
            else "STALE"
            if quality["history"]
            else "NOT_EVALUATED"
        ),
    }


def baseline_summary(run, user, state):
    baseline = (
        EvaluationBaseline.objects.select_related("review__run", "rag_assessment__run")
        .filter(pk=run.dataset_id)
        .first()
    )
    result = {
        "status": "none",
        "run_id": None,
        "version": baseline.version if baseline else 0,
    }
    if not baseline or not (baseline.review_id or baseline.rag_assessment_id):
        return result
    source = baseline.review if baseline.review_id else baseline.rag_assessment
    target = source.run
    result["run_id"] = str(target.pk)
    try:
        if target.pk != run.pk:
            _, state = read_state(target, user)
        if state["quality"].get("blocked_reason"):
            raise ResultsUnavailable
        checked_version = (
            state["baseline"]["version"]
            if baseline.rag_assessment_id
            else state["baseline_version"]
        )
        if checked_version != baseline.version:
            raise ResultsUnavailable
        if baseline.rag_assessment_id:
            rag_baselines.require_pass(target, state, source.pk, source.input_sha256)
            eligible = state["baseline"]["selected"]
        else:
            eligible = (
                current_approval(source, target)
                and state["quality"]["is_current"]
                and state["quality"]["status"] == "PASS"
            )
        result["status"] = "active" if eligible else "needs_review"
    except RequestConflict:
        result["status"] = "needs_review"
    except ResultsUnavailable:
        result["status"] = "unavailable"
    # 읽는 동안 다른 관리자가 기준을 바꿨다면 이전 기준을 활성으로 표시하지 않는다.
    if (
        EvaluationBaseline.objects.filter(pk=run.dataset_id)
        .values_list("version", flat=True)
        .first()
        != baseline.version
    ):
        result["status"] = "unavailable"
    return result


@never_cache
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_review_status(request, run_id):
    run = get_object_or_404(EvaluationRun, pk=run_id)
    try:
        material, state = read_state(run, request.user)
        summary = review_summary(material, state)
        baseline = baseline_summary(run, request.user, state)
    except (ResultsUnavailable, RequestConflict):
        return Response({"code": "REVIEW_STATUS_UNAVAILABLE"}, status=503)
    return Response(
        {
            "run_id": str(run.pk),
            "checked_at": timezone.now().isoformat(),
            "review": summary,
            "baseline": baseline,
        }
    )
