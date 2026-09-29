"""Authenticated operator diagnostics kept separate from Kubernetes probes."""

from django.views.decorators.cache import never_cache
from rest_framework import serializers
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .runtime_checks import inspect_runtime


class RuntimeQuery(serializers.Serializer):
    run_id = serializers.UUIDField(required=False)


@never_cache
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def runtime_status(request):
    query = RuntimeQuery(data=request.query_params)
    query.is_valid(raise_exception=True)
    result = inspect_runtime(query.validated_data.get("run_id"))
    return Response(result, status=200 if result["status"] == "PASS" else 503)
