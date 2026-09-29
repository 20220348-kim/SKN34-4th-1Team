from django.db import DatabaseError, connection
from django.db.migrations.exceptions import (
    BadMigrationError,
    CircularDependencyError,
    InconsistentMigrationHistory,
    NodeNotFoundError,
)
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

from .schema import schema_is_ready


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
    """DB 연결, migration 이력과 실제 스키마를 확인합니다. 외부 서비스는 호출하지 않습니다."""
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            cursor.fetchone()
    except DatabaseError:
        return Response({"status": "DOWN", "checks": {"database": "DOWN"}}, status=503)
    try:
        ready = schema_is_ready()
    except (
        DatabaseError,
        BadMigrationError,
        CircularDependencyError,
        InconsistentMigrationHistory,
        NodeNotFoundError,
    ):
        ready = False
    if not ready:
        return Response(
            {"status": "DOWN", "checks": {"database": "UP", "schema": "DOWN"}}, status=503
        )
    return Response({"status": "UP", "checks": {"database": "UP", "schema": "UP"}})
