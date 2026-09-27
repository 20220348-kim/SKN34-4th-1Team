"""완료 응답의 관리자 검토 이력과 데이터셋별 비교 기준을 관리한다."""

import json
from hashlib import sha256

from django.db import transaction

from .catalog import DATASETS, selection
from .models import EvaluationBaseline, EvaluationReview, EvaluationRun
from .services import (
    RequestConflict,
    ResultsUnavailable,
    artifact_path,
    evidence_path,
    read_candidate,
)


def review_material(run):
    try:
        capture, capture_hash, comparison = read_candidate(run)
        dataset = DATASETS[run.dataset_id]
        raw = evidence_path(dataset["fixture"]).read_bytes()
        if sha256(raw).hexdigest() != dataset["fixture_sha256"]:
            raise ResultsUnavailable
        fixture = json.loads(raw)
        documents = {item["id"]: item for item in fixture["documents"]}
        cases = {item["id"]: item for item in fixture["cases"]}
        _, _, reference = selection(
            run.dataset_id, run.candidate_capture_id, run.reference_capture_id
        )
        reference_path = (
            artifact_path(run, "reference-capture.json")
            if run.reference_config or run.execution_mode == "recovery"
            else evidence_path(reference["path"])
        )
        reference_raw = reference_path.read_bytes()
        reference_capture = json.loads(reference_raw)
        if (
            sha256(reference_raw).hexdigest() != comparison["reference_execution"]["capture_sha256"]
            or reference_capture["fixtureSha256"] != dataset["fixture_sha256"]
            or reference_capture["completed"] is not True
        ):
            raise ResultsUnavailable
        results = {item["caseId"]: item["response"] for item in capture["cases"]}
        references = {item["caseId"]: item["response"] for item in reference_capture["cases"]}
        # fixture v1의 청크 식별 계약. 평가 SDK 없이 원본 인용 ID를 화면의 순번으로 해석한다.
        cited_orders = {}
        for case_id in dataset["case_ids"]:
            document = documents[cases[case_id]["documentId"]]
            by_id = {
                sha256(
                    f"evidence-eval-v1\0{document['id']}\0{chunk['order']}\0{chunk['text']}".encode()
                ).hexdigest(): chunk["order"]
                for chunk in document["chunks"]
            }
            cited_orders[case_id] = [by_id[value] for value in results[case_id]["citationChunkIds"]]
        return {
            "capture_sha256": capture_hash,
            "fixture_sha256": dataset["fixture_sha256"],
            "cases": [
                {
                    "case_id": case_id,
                    "question": cases[case_id]["question"],
                    "document_title": documents[cases[case_id]["documentId"]]["title"],
                    "evidence": documents[cases[case_id]["documentId"]]["chunks"],
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
        "reviewed_by": review.reviewed_by.email or review.reviewed_by.get_username(),
        "created_at": review.created_at,
    }


def review_state(run):
    reviews = list(run.reviews.select_related("reviewed_by"))
    baseline = EvaluationBaseline.objects.filter(dataset_id=run.dataset_id).first()
    return {
        "reviews": [review_data(item) for item in reviews],
        "is_baseline": bool(baseline and any(item.id == baseline.review_id for item in reviews)),
    }


def save_review(run, user, decision, comment, capture_sha256):
    # 외부 통신 없이 완료 파일을 확인한 뒤 짧은 DB transaction으로 이력을 추가한다.
    material = review_material(run)
    if material["capture_sha256"] != capture_sha256:
        raise RequestConflict
    with transaction.atomic():
        EvaluationRun.objects.select_for_update().get(pk=run.pk)
        latest = run.reviews.first()
        if latest and (
            latest.reviewed_by_id == user.pk
            and latest.decision == decision
            and latest.comment == comment
            and latest.capture_sha256 == capture_sha256
        ):
            return latest  # 응답 유실 재전송은 같은 검토 기록을 반환한다.
        review = EvaluationReview.objects.create(
            run=run,
            reviewed_by=user,
            decision=decision,
            comment=comment,
            capture_sha256=capture_sha256,
        )
        # 새 검토 뒤에는 재지정해야 한다. 기존 평가가 고정한 기준은 변경하지 않는다.
        EvaluationBaseline.objects.filter(dataset_id=run.dataset_id, review__run=run).delete()
        return review


def promote_baseline(run, user, review_id):
    material = review_material(run)
    with transaction.atomic():
        EvaluationRun.objects.select_for_update().get(pk=run.pk)
        latest = run.reviews.first()
        if (
            latest is None
            or latest.id != review_id
            or latest.decision != EvaluationReview.Decision.APPROVED
            or latest.capture_sha256 != material["capture_sha256"]
        ):
            raise RequestConflict
        EvaluationBaseline.objects.update_or_create(
            dataset_id=run.dataset_id, defaults={"review": latest, "selected_by": user}
        )


def baseline_choices():
    return {
        item.dataset_id: {
            "id": f"run:{item.review.run_id}",
            "label": f"검토 기준 · {str(item.review.run_id)[:8]}",
        }
        for item in EvaluationBaseline.objects.select_related("review")
    }
