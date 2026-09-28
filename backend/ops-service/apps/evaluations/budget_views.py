"""실행기 전용 예산 경계. 관리자 쿠키로 호출할 수 없으며 별도 비밀값을 요구한다."""

from django.conf import settings
from django.utils.crypto import constant_time_compare
from rest_framework import serializers
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

from .budget import BudgetUnavailable, worker_action


class BudgetRequest(serializers.Serializer):
    worker_id = serializers.UUIDField()
    flow_id = serializers.UUIDField()
    spec_hash = serializers.RegexField(r"^[a-f0-9]{64}$")
    sequence = serializers.IntegerField(min_value=0, max_value=11, required=False)
    usage = serializers.JSONField(required=False, allow_null=True)
    model = serializers.CharField(max_length=100, required=False)
    max_output_tokens = serializers.IntegerField(min_value=1, required=False)


@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
def api_budget(request, run_id, action):
    token = settings.LLMOPS_BUDGET_TOKEN
    if len(token) < 32 or not constant_time_compare(
        request.headers.get("Authorization", ""), "Bearer " + token
    ):
        return Response({"code": "BUDGET_AUTH_REQUIRED"}, status=403)
    if action not in {"claim", "authorize", "settle", "close"}:
        return Response({"code": "INVALID_BUDGET_ACTION"}, status=400)
    serializer = BudgetRequest(data=request.data)
    serializer.is_valid(raise_exception=True)
    try:
        worker_action(run_id, action=action, **serializer.validated_data)
    except BudgetUnavailable:
        return Response({"code": "LIVE_BUDGET_UNAVAILABLE"}, status=409)
    return Response({"accepted": True})
