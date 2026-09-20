package ai.govbiz.core.account.helper

import ai.govbiz.core.account.service.exception.AuthenticationRequiredException
import jakarta.servlet.http.HttpServletRequest
import org.springframework.http.HttpHeaders

/** 웹 쿠키를 우선하고, 쿠키가 없는 네이티브 요청에서만 명시적으로 보낸 Bearer 세션을 읽습니다. */
object SessionRequestTokenHelper {

    // 쿠키와 Authorization이 함께 오면 resolver와 Origin 검사 모두 같은 웹 세션을 사용합니다.
    fun read(request: HttpServletRequest): String? =
        SessionCookieHelper.read(request) ?: readBearer(request)

    /** 헤더가 없는 경우만 null입니다. 잘못된 인증은 nullable Account에서도 비로그인으로 숨기지 않습니다. */
    fun readBearer(request: HttpServletRequest): String? {
        val headers = request.getHeaders(HttpHeaders.AUTHORIZATION)?.toList().orEmpty()
        if (headers.isEmpty()) return null
        if (headers.size != 1) throw AuthenticationRequiredException()
        return BEARER.matchEntire(headers.single())?.groupValues?.get(1)
            ?: throw AuthenticationRequiredException()
    }

    private val BEARER = Regex("Bearer ([A-Za-z0-9._~+/-]+=*)", RegexOption.IGNORE_CASE)
}
