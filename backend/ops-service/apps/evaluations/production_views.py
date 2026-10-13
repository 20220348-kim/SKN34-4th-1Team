"""Core 전용 운영 표본 수집과 기존 Core 관리자 인증을 사용하는 검토 API."""

import json

from django.conf import settings
from django.http import RawPostDataException
from django.utils.crypto import constant_time_compare
from django.views.decorators.cache import never_cache
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response

from .authentication import CoreSessionAuthentication
from .models import ProductionRegressionCandidate
from .production_quality import (
    MAX_BODY_BYTES,
    ProductionQualityError,
    ingest_sample,
    retained_samples,
    sample_dashboard,
    sample_data,
    save_regression_candidate,
    save_review,
)


def bounded_payload(request):
    try:
        declared = int(request.META.get("CONTENT_LENGTH") or "0")
    except (TypeError, ValueError):
        raise ProductionQualityError("INVALID_BODY_SIZE") from None
    if declared < 0 or declared > MAX_BODY_BYTES:
        raise ProductionQualityError("SAMPLE_TOO_LARGE", 413)
    if request.content_type != "application/json":
        raise ProductionQualityError("JSON_REQUIRED", 415)
    try:
        raw = request.body
        if len(raw) > MAX_BODY_BYTES:
            raise ProductionQualityError("SAMPLE_TOO_LARGE", 413)
        value = json.loads(raw, parse_constant=reject_json_constant)
    except (ValueError, UnicodeDecodeError, RawPostDataException, RecursionError):
        raise ProductionQualityError("INVALID_SAMPLE_JSON") from None
    return value


def reject_json_constant(_value):
    raise ValueError("INVALID_JSON_CONSTANT")


def error_response(error):
    return Response({"code": error.code}, status=error.status)


@never_cache
@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
def api_ingest(request):
    token = settings.LLMOPS_PRODUCTION_SAMPLE_TOKEN
    if len(token) < 32 or not constant_time_compare(
        request.headers.get("Authorization", ""), "Bearer " + token
    ):
        return Response({"code": "PRODUCTION_SAMPLE_AUTH_REQUIRED"}, status=403)
    try:
        sample, created = ingest_sample(bounded_payload(request))
    except ProductionQualityError as error:
        return error_response(error)
    return Response({"id": str(sample.pk), "accepted": True}, status=201 if created else 200)


@never_cache
@api_view(["GET"])
@authentication_classes([CoreSessionAuthentication])
@permission_classes([IsAuthenticated])
def api_samples(request):
    try:
        if set(request.query_params) - {"page"}:
            raise ProductionQualityError("INVALID_SAMPLE_QUERY")
        try:
            page = int(request.query_params.get("page", "1"))
        except (TypeError, ValueError):
            raise ProductionQualityError("INVALID_SAMPLE_PAGE") from None
        return Response(sample_dashboard(page))
    except ProductionQualityError as error:
        return error_response(error)


@never_cache
@api_view(["GET"])
@authentication_classes([CoreSessionAuthentication])
@permission_classes([IsAuthenticated])
def api_sample_detail(request, sample_id):
    sample = retained_samples().filter(pk=sample_id).first()
    if sample is None:
        return Response({"code": "PRODUCTION_SAMPLE_NOT_FOUND"}, status=404)
    return Response(sample_data(sample, detail=True))


@never_cache
@api_view(["POST"])
@authentication_classes([CoreSessionAuthentication])
@permission_classes([IsAuthenticated])
def api_sample_review(request, sample_id):
    try:
        sample = save_review(sample_id, request.user, bounded_payload(request))
        return Response(sample_data(sample, detail=True))
    except ProductionQualityError as error:
        return error_response(error)


@never_cache
@api_view(["GET", "POST"])
@authentication_classes([CoreSessionAuthentication])
@permission_classes([IsAuthenticated])
def api_regression_candidate(request, sample_id):
    if request.method == "POST":
        try:
            sample = save_regression_candidate(sample_id, request.user, bounded_payload(request))
            return Response(sample_data(sample, detail=True))
        except ProductionQualityError as error:
            return error_response(error)
    candidate = ProductionRegressionCandidate.objects.filter(
        sample__in=retained_samples(), sample_id=sample_id
    ).first()
    if candidate is None:
        return Response({"code": "REGRESSION_CANDIDATE_NOT_FOUND"}, status=404)
    response = Response(candidate.snapshot)
    response["Content-Disposition"] = (
        f'attachment; filename="production-candidate-{candidate.id}.json"'
    )
    return response
