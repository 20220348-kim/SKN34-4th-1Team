from django.db import DatabaseError, connection
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response


@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
def health(request):
    """DB에 접근하지 않고 애플리케이션 실행 여부를 확인합니다."""
    return Response({"status": "UP", "service": "govbiz-ops-service"})


@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
def readiness(request):
    """MySQL에 실제 질의합니다. 연결 실패를 정상 상태로 숨기지 않습니다."""
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            cursor.fetchone()
    except DatabaseError:
        return Response({"status": "DOWN", "checks": {"database": "DOWN"}}, status=503)
    return Response({"status": "UP", "checks": {"database": "UP"}})
