"""완료 응답의 관리자 검토 이력과 데이터셋별 비교 기준을 관리한다."""

import json
from hashlib import sha256

from django.db import transaction

from .artifact_store import read_artifact, read_evidence
from .baselines import change_baseline, lock_baseline
from .catalog import DATASETS, selection
from .models import EvaluationBaseline, EvaluationCaseReview, EvaluationReview, EvaluationRun
from .quality import quality_pass, quality_state
from .review_eligibility import (
    RUBRIC_CRITERIA,
    RUBRIC_VERSION,
    current_approval,
    suitable_case_reviews,
)
from .services import (
    RequestConflict,
    ResultsUnavailable,
    read_candidate,
)


def review_material(run):
    try:
        capture, capture_hash, comparison = read_candidate(run)
        dataset = DATASETS[run.dataset_id]
        raw = read_evidence(dataset["fixture"])
        if sha256(raw).hexdigest() != dataset["fixture_sha256"]:
            raise ResultsUnavailable
        fixture = json.loads(raw)
        documents = {item["id"]: item for item in fixture["documents"]}
        cases = {item["id"]: item for item in fixture["cases"]}
        _, _, reference = selection(
            run.dataset_id, run.candidate_capture_id, run.reference_capture_id
        )
        reference_raw = (
            read_artifact(run.id, "reference-capture.json")
            if run.reference_config or run.execution_mode == "recovery"
            else read_evidence(reference["path"])
        )
        reference_capture = json.loads(reference_raw)
        if (
            sha256(reference_raw).hexdigest() != comparison["reference_execution"]["capture_sha256"]
            or reference_capture.get("schemaVersion")
            not in {"support-program-evidence-capture-v1", "support-program-evidence-capture-v2"}
            or reference_capture.get("scope", "fixed-answer-context-only") != comparison["scope"]
            or reference_capture["fixtureSha256"] != dataset["fixture_sha256"]
            or reference_capture["completed"] is not True
        ):
            raise ResultsUnavailable
        results = {item["caseId"]: item["response"] for item in capture["cases"]}
        references = {item["caseId"]: item["response"] for item in reference_capture["cases"]}
        official = fixture.get("schemaVersion") == "support-program-evidence-eval-v2"
        # 실제 공고 v2는 캡처 당시 Core 청크 ID를 보존한다. v1의 식별 계약도 유지한다.
        # fixture v1의 청크 식별 계약. 평가 SDK 없이 원본 인용 ID를 화면의 순번으로 해석한다.
        cited_orders = {}
        for case_id in dataset["case_ids"]:
            document = documents[cases[case_id]["documentId"]]
            by_id = {
                (
                    chunk["id"]
                    if official
                    else sha256(
                        f"evidence-eval-v1\0{document['id']}\0{chunk['order']}\0{chunk['text']}".encode()
                    ).hexdigest()
                ): chunk["order"]
                for chunk in document["chunks"]
            }
            cited_orders[case_id] = [by_id[value] for value in results[case_id]["citationChunkIds"]]
        return {
            "evaluation_scope": comparison["scope"],
            "data_type": fixture.get("dataType", "synthetic"),
            "candidate_origin": capture.get("measurementKind", "recorded-answer"),
            "recorded_model": capture["model"],
            "recorded_at": capture.get("startedAt"),
            "reference_revision": {
                "previous_dataset_id": fixture["referenceRevision"]["previousDatasetId"],
                "previous_fixture_sha256": fixture["referenceRevision"]["previousFixtureSha256"],
                "changed_case_ids": fixture["referenceRevision"]["changedCaseIds"],
                "reason": fixture["referenceRevision"]["reason"],
                "source_quote": fixture["referenceRevision"]["sourceQuote"],
            }
            if fixture.get("referenceRevision")
            else None,
            "capture_sha256": capture_hash,
            "fixture_sha256": dataset["fixture_sha256"],
            "cases": [
                {
                    "case_id": case_id,
                    "question": cases[case_id]["question"],
                    "document_title": documents[cases[case_id]["documentId"]]["title"],
                    "evidence": documents[cases[case_id]["documentId"]]["chunks"],
                    "source": {
                        "url": documents[cases[case_id]["documentId"]]["source"]["sourceUrl"],
                        "collected_at": documents[cases[case_id]["documentId"]]["source"][
                            "collectedAt"
                        ],
                        "html_sha256": documents[cases[case_id]["documentId"]]["source"][
                            "htmlSha256"
                        ],
                        "content_sha256": documents[cases[case_id]["documentId"]]["source"][
                            "contentSha256"
                        ],
                        "scope": documents[cases[case_id]["documentId"]]["source"]["scope"],
                    }
                    if official
                    else None,
                    "answer": results[case_id]["answer"],
                    "answer_status": results[case_id]["answerStatus"],
                    "cited_orders": cited_orders[case_id],
                    "reference_answer": references[case_id]["answer"],
                    "expected_status": cases[case_id]["expectedStatus"],
                    "expected_citation_orders": cases[case_id]["expectedCitationOrders"],
                    "reference_facts": cases[case_id]["referenceFacts"],
                    "forbidden_claims": cases[case_id]["forbiddenClaims"],
                }
                for case_id in dataset["case_ids"]
            ],
        }
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise ResultsUnavailable from exc


def review_data(review):
    return {
        "id": review.id,
        "decision": review.decision,
        "comment": review.comment,
        "capture_sha256": review.capture_sha256,
        "fixture_sha256": review.fixture_sha256,
        "rubric_version": review.rubric_version,
        "version": review.version,
        "case_review_ids": list(review.case_reviews.values_list("pk", flat=True)),
        "reviewed_by": review.reviewed_by.email or review.reviewed_by.get_username(),
        "created_at": review.created_at,
    }


def review_state(run, material=None):
    run.refresh_from_db(fields=["review_version", "status"])
    reviews = list(run.reviews.select_related("reviewed_by"))
    baseline = EvaluationBaseline.objects.filter(dataset_id=run.dataset_id).first()
    is_baseline = bool(baseline and any(item.id == baseline.review_id for item in reviews))
    approved = bool(
        material
        and run.status == "COMPLETED"
        and reviews
        and reviews[0].capture_sha256 == material["capture_sha256"]
        and current_approval(reviews[0], run)
    )
    quality = quality_state(run, material)
    eligible = approved and quality["is_current"] and quality["status"] == "PASS"
    return {
        "quality": quality,
        "can_promote": bool(eligible),
        "reviews": [review_data(item) for item in reviews],
        "review_version": run.review_version,
        "rubric": {"version": RUBRIC_VERSION, "criteria": RUBRIC_CRITERIA},
        "case_reviews": [
            {
                "id": item.pk,
                "case_id": item.case_id,
                "version": item.version,
                "decision": item.decision,
                "comment": item.comment,
                "capture_sha256": item.capture_sha256,
                "fixture_sha256": item.fixture_sha256,
                "rubric_version": item.rubric_version,
                "reviewed_by": item.reviewed_by.email or item.reviewed_by.get_username(),
                "created_at": item.created_at,
            }
            for item in run.case_reviews.select_related("reviewed_by")
        ],
        "can_approve": bool(
            material
            and run.status == "COMPLETED"
            and suitable_case_reviews(run, material["capture_sha256"]) is not None
        ),
        "approval_current": approved,
        "is_baseline": is_baseline,
        "baseline_requires_review": is_baseline and not eligible,
        "baseline_version": baseline.version if baseline else 0,
        "baseline_history": [
            {
                "version": item.version,
                "previous_review_id": item.previous_review_id,
                "review_id": item.review_id,
                "previous_capture_sha256": item.previous_review.capture_sha256
                if item.previous_review
                else None,
                "previous_run_id": str(item.previous_review.run_id)
                if item.previous_review
                else None,
                "run_id": str(item.review.run_id) if item.review else None,
                "capture_sha256": item.review.capture_sha256 if item.review else None,
                "fixture_sha256": item.fixture_sha256 or None,
                "changed_by": item.changed_by.email or item.changed_by.get_username(),
                "reason": item.reason,
                "created_at": item.created_at,
            }
            for item in (
                baseline.changes.select_related("previous_review", "review", "changed_by")
                if baseline
                else []
            )
        ],
    }


def save_review(
    run, user, decision, comment, capture_sha256, fixture_sha256, rubric_version, review_version
):
    # 외부 통신 없이 완료 파일을 확인한 뒤 짧은 DB transaction으로 이력을 추가한다.
    material = review_material(run)
    if (
        material["capture_sha256"] != capture_sha256
        or material["fixture_sha256"] != fixture_sha256
        or rubric_version != RUBRIC_VERSION
    ):
        raise RequestConflict
    with transaction.atomic():
        baseline = lock_baseline(run.dataset_id)
        locked = EvaluationRun.objects.select_for_update().get(pk=run.pk)
        if locked.status != "COMPLETED":
            raise ResultsUnavailable
        latest = run.reviews.first()
        if latest and (
            locked.review_version == review_version + 1
            and latest.version == locked.review_version
            and latest.fixture_sha256 == fixture_sha256
            and latest.rubric_version == rubric_version
            and latest.reviewed_by_id == user.pk
            and latest.decision == decision
            and latest.comment == comment
            and latest.capture_sha256 == capture_sha256
        ):
            return latest  # 응답 유실 재전송은 같은 검토 기록을 반환한다.
        if locked.review_version != review_version:
            raise RequestConflict
        cases = suitable_case_reviews(locked, capture_sha256)
        if decision == EvaluationReview.Decision.APPROVED and cases is None:
            raise RequestConflict
        locked.review_version += 1
        locked.save(update_fields=["review_version"])
        review = EvaluationReview.objects.create(
            run=run,
            reviewed_by=user,
            decision=decision,
            comment=comment,
            capture_sha256=capture_sha256,
            fixture_sha256=fixture_sha256,
            rubric_version=rubric_version,
            version=locked.review_version,
        )
        if cases is not None:
            review.case_reviews.set(cases.values())
        # 새 검토 뒤에는 재지정해야 한다. 기존 평가가 고정한 기준은 변경하지 않는다.
        if baseline.review_id and baseline.review.run_id == run.pk:
            change_baseline(baseline, None, user, f"새 검토로 기준 해제: {comment}")
        return review


def save_case_review(
    run,
    user,
    case_id,
    decision,
    comment,
    capture_sha256,
    fixture_sha256,
    rubric_version,
    review_version,
):
    material = review_material(run)
    if case_id not in {item["case_id"] for item in material["cases"]}:
        raise ValueError("평가에 포함된 사례만 검토할 수 있습니다.")
    if (
        capture_sha256 != material["capture_sha256"]
        or fixture_sha256 != material["fixture_sha256"]
        or rubric_version != RUBRIC_VERSION
    ):
        raise RequestConflict
    with transaction.atomic():
        baseline = lock_baseline(run.dataset_id)
        locked = EvaluationRun.objects.select_for_update().get(pk=run.pk)
        if locked.status != "COMPLETED":
            raise ResultsUnavailable
        latest = locked.case_reviews.first()
        if latest and (
            locked.review_version == review_version + 1
            and latest.version == locked.review_version
            and latest.reviewed_by_id == user.pk
            and latest.case_id == case_id
            and latest.decision == decision
            and latest.comment == comment
            and latest.capture_sha256 == capture_sha256
            and latest.fixture_sha256 == fixture_sha256
            and latest.rubric_version == rubric_version
        ):
            return latest
        if locked.review_version != review_version:
            raise RequestConflict
        locked.review_version += 1
        locked.save(update_fields=["review_version"])
        review = EvaluationCaseReview.objects.create(
            run=locked,
            case_id=case_id,
            decision=decision,
            comment=comment,
            capture_sha256=capture_sha256,
            fixture_sha256=fixture_sha256,
            rubric_version=rubric_version,
            version=locked.review_version,
            reviewed_by=user,
        )
        if baseline.review_id and baseline.review.run_id == run.pk:
            change_baseline(
                baseline, None, user, f"사례별 검토 변경으로 기준 해제: {case_id} · {comment}"
            )
        return review


def promote_baseline(run, user, review_id, baseline_version):
    material = review_material(run)
    with transaction.atomic():
        baseline = lock_baseline(run.dataset_id)
        locked = EvaluationRun.objects.select_for_update().get(pk=run.pk)
        if locked.status != "COMPLETED":
            raise ResultsUnavailable
        latest = run.reviews.first()
        if (
            latest is None
            or latest.id != review_id
            or latest.decision != EvaluationReview.Decision.APPROVED
            or latest.capture_sha256 != material["capture_sha256"]
            or not current_approval(latest, locked)
            or not quality_pass(locked, material)
        ):
            raise RequestConflict
        if (
            baseline.review_id == latest.id
            and baseline.version == baseline_version + 1
            and baseline.selected_by_id == user.pk
        ):
            return  # 같은 지정의 응답 유실 재전송. 변경 이력을 추가하지 않는다.
        if baseline.version != baseline_version:
            raise RequestConflict
        if baseline.review_id != latest.id:
            change_baseline(baseline, latest, user, latest.comment)


def clear_baseline(run, user, baseline_version, reason):
    with transaction.atomic():
        baseline = lock_baseline(run.dataset_id)
        if baseline.version != baseline_version:
            latest = baseline.changes.first()
            if (
                baseline.version == baseline_version + 1
                and baseline.review_id is None
                and latest
                and latest.previous_review_id
                and latest.previous_review.run_id == run.pk
                and latest.changed_by_id == user.pk
                and latest.reason == reason
            ):
                return
            raise RequestConflict
        if not baseline.review_id or baseline.review.run_id != run.pk:
            raise RequestConflict
        change_baseline(baseline, None, user, reason)


def baseline_choices():
    from .rag_baselines import baseline_choices as rag_choices

    return {
        **rag_choices(),
        **{
            item.dataset_id: {
                "id": f"run:{item.review.run_id}",
                "label": f"검토 기준 · {str(item.review.run_id)[:8]}",
                "version": item.version,
            }
            for item in EvaluationBaseline.objects.select_related("review__run").filter(
                review__isnull=False
            )
            if current_approval(item.review, item.review.run) and quality_pass(item.review.run)
        },
    }
