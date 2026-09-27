"""Core의 현재 관리자 세션을 검증하고 Ops 실행 이력의 요청자에 연결한다."""

import json
import re
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from django.conf import settings
from django.contrib.auth import get_user_model
from rest_framework.authentication import BaseAuthentication, SessionAuthentication
from rest_framework.exceptions import APIException, AuthenticationFailed, PermissionDenied


class CoreUnavailable(APIException):
    status_code = 503
    default_detail = "관리자 인증 서버에 연결할 수 없습니다."
    default_code = "CORE_AUTH_UNAVAILABLE"


class NoAuthRedirect(HTTPRedirectHandler):
    # 설정한 Core 이외의 호스트로 세션 쿠키를 보내지 않는다.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def read_core_admin(token):
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,4096}", token):
        raise AuthenticationFailed("로그인이 필요합니다.")
    request = Request(
        settings.CORE_API_URL + "/api/v1/admin/session",
        headers={"Cookie": f"govbiz_session={token}", "Accept": "application/json"},
    )
    try:
        with build_opener(NoAuthRedirect()).open(request, timeout=3) as response:
            if response.status != 200:
                raise CoreUnavailable
            data = json.loads(response.read(8193))
        if (
            not isinstance(data, dict)
            or type(data.get("accountId")) is not int
            or data["accountId"] <= 0
            or not isinstance(data.get("email"), str)
            or not 1 <= len(data["email"]) <= 254
            or data.get("role") != "ADMIN"
        ):
            raise CoreUnavailable
        return data
    except HTTPError as exc:
        if exc.code == 401:
            raise AuthenticationFailed("로그인이 만료되었습니다.") from None
        if exc.code == 403:
            raise PermissionDenied("관리자 계정만 운영 화면을 이용할 수 있습니다.") from None
        raise CoreUnavailable from None
    except (URLError, OSError, ValueError, TypeError):
        raise CoreUnavailable from None


class CoreSessionAuthentication(BaseAuthentication):
    def authenticate_header(self, request):
        return "Session"

    def authenticate(self, request):
        token = request.COOKIES.get("govbiz_session")
        if not token:
            return None
        # 모든 요청에서 확인한다. Django 세션이나 로컬 is_staff 값을 인증 근거로 삼지 않는다.
        principal = read_core_admin(token)
        SessionAuthentication().enforce_csrf(request)
        user, _ = get_user_model().objects.get_or_create(
            username=f"core:{principal['accountId']}",
            defaults={"email": principal["email"], "password": "!", "is_staff": True},
        )
        if user.email != principal["email"]:
            user.email = principal["email"]
            user.save(update_fields=["email"])
        return user, None
