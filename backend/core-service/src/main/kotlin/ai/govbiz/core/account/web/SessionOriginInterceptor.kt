package ai.govbiz.core.account.web

import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core.account.service.exception.SessionOriginRejectedException
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import java.net.URI
import org.springframework.http.HttpHeaders
import org.springframework.web.servlet.HandlerInterceptor

/**
 * 세션 쿠키가 붙은 상태 변경 요청(POST·PUT·PATCH·DELETE)의 CSRF 방어입니다.
 *
 * 브라우저는 상태 변경 요청에 `Origin` 헤더를 붙이므로 허용된 origin과 같아야 합니다. `Origin`이 없으면
 * `Referer`의 origin으로 대신 판단하고, 둘 다 없으면 브라우저가 보낸 요청으로 볼 수 없어 거절합니다.
 * 쿠키가 없는 네이티브 Bearer 요청은 브라우저가 자동 첨부하는 인증이 아니므로 검사하지 않습니다.
 * Bearer 헤더를 추가해도 쿠키가 함께 있다면 이 검사를 생략하지 않습니다. 토큰 검증은 resolver가 담당합니다.
 */
class SessionOriginInterceptor(
    allowedOrigins: Collection<String>,
) : HandlerInterceptor {

    private val allowedOrigins: Set<String> = allowedOrigins
        .map(::normalize)
        .filter(String::isNotEmpty)
        .toSet()

    override fun preHandle(request: HttpServletRequest, response: HttpServletResponse, handler: Any): Boolean {
        if (request.method.uppercase() in SAFE_METHODS) return true
        if (SessionCookieHelper.read(request) == null) return true

        val origin = request.getHeader(HttpHeaders.ORIGIN)?.let(::normalize)
            ?: request.getHeader(HttpHeaders.REFERER)?.let(::originOf)
        if (origin == null || origin == "null" || origin !in allowedOrigins) throw SessionOriginRejectedException()
        return true
    }

    private fun normalize(origin: String): String = origin.trim().trimEnd('/').lowercase()

    /** Referer 전체 URL에서 scheme·host·port만 남깁니다. 파싱할 수 없으면 null입니다. */
    private fun originOf(referer: String): String? =
        runCatching { URI(referer.trim()) }.getOrNull()
            ?.takeIf { uri -> uri.scheme != null && uri.host != null }
            ?.let { uri -> normalize("${uri.scheme}://${uri.rawAuthority}") }

    private companion object {
        val SAFE_METHODS = setOf("GET", "HEAD", "OPTIONS")
    }
}
