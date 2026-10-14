"""기존 Core 관리자 인증과 CSRF를 재사용하는 평가 자료 관리 API."""

from django.shortcuts import get_object_or_404
from django.views.decorators.cache import never_cache
from rest_framework import serializers
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .catalog import DATASETS
from .dataset_management import DatasetConflict, change_dataset, dataset_data
from .models import EvaluationDataset


class DatasetWriteSerializer(serializers.Serializer):
    request_id = serializers.UUIDField()
    expected_version = serializers.IntegerField(min_value=0, max_value=2**31 - 2)
    content = serializers.JSONField(required=False)
    archived = serializers.BooleanField(required=False)


def _write(request, action, dataset_id=None):
    data = DatasetWriteSerializer(data=request.data)
    allowed = {"request_id", "expected_version"}
    if action in {"CREATE", "UPDATE"}:
        allowed.add("content")
    if action == "ARCHIVE":
        allowed.add("archived")
    if (
        not isinstance(request.data, dict)
        or set(request.data) != allowed
        or type(request.data.get("expected_version")) is not int
        or (action in {"CREATE", "UPDATE"} and not isinstance(request.data.get("content"), dict))
        or (action == "ARCHIVE" and type(request.data.get("archived")) is not bool)
        or not data.is_valid()
    ):
        return Response(
            {
                "code": "DATASET_VALIDATION_ERROR",
                "detail": "평가 자료 요청의 항목·요청 ID·버전 형식을 확인하세요.",
            },
            status=400,
        )
    try:
        result = change_dataset(
            user=request.user, action=action, dataset_id=dataset_id, **data.validated_data
        )
    except EvaluationDataset.DoesNotExist:
        return Response(
            {"code": "DATASET_NOT_FOUND", "detail": "평가 자료를 찾을 수 없습니다."}, status=404
        )
    except DatasetConflict:
        return Response(
            {
                "code": "DATASET_CONFLICT",
                "detail": (
                    "자료 또는 요청 내용이 변경됐습니다. 최신 자료를 확인한 뒤 다시 저장하세요."
                ),
            },
            status=409,
        )
    except ValueError as error:
        return Response({"code": "DATASET_VALIDATION_ERROR", "detail": str(error)}, status=400)
    return Response(result, status=201 if action == "CREATE" else 200)


@never_cache
@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def api_datasets(request):
    if request.method == "POST":
        return _write(request, "CREATE")
    return Response(
        {
            "datasets": [
                dataset_data(dataset)
                for dataset in EvaluationDataset.objects.prefetch_related("revisions")
            ],
            "builtin_count": len(DATASETS),
        }
    )


@never_cache
@api_view(["GET", "PUT"])
@permission_classes([IsAuthenticated])
def api_dataset(request, dataset_id):
    if request.method == "PUT":
        return _write(request, "UPDATE", dataset_id)
    return Response(dataset_data(get_object_or_404(EvaluationDataset, pk=dataset_id)))


@never_cache
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_dataset_publish(request, dataset_id):
    return _write(request, "PUBLISH", dataset_id)


@never_cache
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_dataset_archive(request, dataset_id):
    return _write(request, "ARCHIVE", dataset_id)
