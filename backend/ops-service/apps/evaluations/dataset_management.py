"""초안 편집·불변 버전 게시·보관을 관리한다. 평가를 접수하거나 모델을 호출하지 않는다."""

import json
from hashlib import sha256

from django.db import IntegrityError, transaction

from .managed_materials import build_snapshot, validate_content
from .models import EvaluationDataset, EvaluationDatasetChange, EvaluationDatasetRevision


class DatasetConflict(Exception):
    """오래된 편집 버전 또는 다른 내용의 요청 ID 재사용."""


def dataset_data(dataset):
    return {
        "id": str(dataset.pk),
        "version": dataset.version,
        "archived": dataset.archived,
        "content": dataset.draft,
        "created_at": dataset.created_at.isoformat(),
        "updated_at": dataset.updated_at.isoformat(),
        "revisions": [
            {
                "id": revision.pk,
                "number": revision.number,
                "created_at": revision.created_at.isoformat(),
                "label": revision.snapshot["catalog"]["label"],
            }
            for revision in dataset.revisions.all()
        ],
    }


def _payload_hash(action, dataset_id, expected_version, content, archived):
    return sha256(
        json.dumps(
            {
                "action": action,
                "dataset_id": str(dataset_id) if dataset_id is not None else None,
                "expected_version": expected_version,
                "content": content,
                "archived": archived,
            },
            sort_keys=True,
            ensure_ascii=False,
            separators=(",", ":"),
            allow_nan=False,
        ).encode()
    ).hexdigest()


def _previous(request_id, user, payload_sha256):
    change = EvaluationDatasetChange.objects.filter(pk=request_id).first()
    if change is None:
        return None
    if change.actor_id != user.pk or change.payload_sha256 != payload_sha256:
        raise DatasetConflict
    # 원래 응답을 반환하며 이후의 편집·보관 상태를 되돌리지 않는다.
    return change.response


def change_dataset(
    *, user, request_id, expected_version, action, dataset_id=None, content=None, archived=None
):
    if action not in {"CREATE", "UPDATE", "PUBLISH", "ARCHIVE"}:
        raise ValueError("평가 자료 변경 작업을 확인하세요.")
    payload_sha256 = _payload_hash(action, dataset_id, expected_version, content, archived)
    previous = _previous(request_id, user, payload_sha256)
    if previous is not None:
        return previous
    prepared = validate_content(content, publish=False) if action in {"CREATE", "UPDATE"} else None
    try:
        with transaction.atomic():
            if action == "CREATE":
                if expected_version != 0 or dataset_id is not None:
                    raise DatasetConflict
                dataset = EvaluationDataset.objects.create(
                    draft=prepared, created_by=user, updated_by=user
                )
            else:
                dataset = EvaluationDataset.objects.select_for_update().get(pk=dataset_id)
                # 같은 자료를 기다리는 재전송은 잠금을 얻은 뒤 다시 확인한다.
                previous = _previous(request_id, user, payload_sha256)
                if previous is not None:
                    return previous
                if dataset.version != expected_version:
                    raise DatasetConflict
                if dataset.archived and action != "ARCHIVE":
                    raise ValueError("보관된 평가 자료는 복원한 뒤 수정하거나 게시하세요.")
                if action == "UPDATE":
                    dataset.draft = prepared
                elif action == "PUBLISH":
                    number = (dataset.revisions.values_list("number", flat=True).first() or 0) + 1
                    identifier = f"managed-{dataset.pk.hex}-v{number}"
                    snapshot = build_snapshot(dataset.draft, identifier)
                    EvaluationDatasetRevision.objects.create(
                        id=identifier,
                        dataset=dataset,
                        number=number,
                        snapshot=snapshot,
                        published_by=user,
                    )
                else:
                    if type(archived) is not bool:
                        raise ValueError("보관 상태는 참 또는 거짓으로 지정하세요.")
                    dataset.archived = archived
                dataset.version += 1
                dataset.updated_by = user
                dataset.save(
                    update_fields=["draft", "archived", "version", "updated_by", "updated_at"]
                )
            response = dataset_data(dataset)
            EvaluationDatasetChange.objects.create(
                request_id=request_id,
                dataset=dataset,
                actor=user,
                action=action,
                payload_sha256=payload_sha256,
                response=response,
            )
            return response
    except IntegrityError:
        # 서로 다른 자료/CREATE에 같은 요청 ID가 동시에 들어와도 한 변경만 남긴다.
        previous = _previous(request_id, user, payload_sha256)
        if previous is not None:
            return previous
        raise


def lock_for_submission(dataset_id):
    """호출자의 접수 transaction에서 보관 변경과 새 접수를 직렬화한다."""
    try:
        revision = EvaluationDatasetRevision.objects.only("dataset_id").get(pk=dataset_id)
        dataset = EvaluationDataset.objects.select_for_update().get(pk=revision.dataset_id)
        revision = EvaluationDatasetRevision.objects.select_for_update().get(pk=dataset_id)
    except (EvaluationDataset.DoesNotExist, EvaluationDatasetRevision.DoesNotExist) as error:
        raise ValueError("게시된 평가 자료 버전을 선택하세요.") from error
    if dataset.archived:
        raise ValueError("보관된 평가 자료는 새 평가에 사용할 수 없습니다.")
    return revision.snapshot
