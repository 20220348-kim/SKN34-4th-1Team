package ai.govbiz.core.account.helper

import ai.govbiz.core.account.config.AccountSessionProperties
import jakarta.servlet.http.HttpServletRequest
import java.time.Duration
import org.springframework.http.ResponseCookie
import org.springframework.stereotype.Component

/**
 * 세션 JWT를 담는 HttpOnly 쿠키를 만들고 읽습니다.
 *
 * 브라우저 스크립트가 토큰을 읽을 수 없도록 `HttpOnly`, 다른 사이트에서 시작한 요청에는 붙지 않도록
 * `SameSite=Lax`를 씁니다. `Secure`는 HTTPS가 없는 로컬 개발에서만 설정으로 끕니다. `Domain`은 두지 않아
 * 발급한 호스트에만 묶입니다.
 */
@Component
class SessionCookieHelper(
    private val properties: AccountSessionProperties,
) {

    /**
     * "로그인 상태 유지"면 세션 절대 만료와 같은 `Max-Age`를 붙이고, 아니면 브라우저를 닫을 때 사라지는
     * 세션 쿠키로 내려줍니다. 서버 쪽 짧은 만료는 세션 행의 `expires_at`이 따로 지킵니다.
     */
    fun issue(sessionToken: String, rememberMe: Boolean): ResponseCookie =
        build(sessionToken, if (rememberMe) properties.sessionTtl else null)

    /** 로그아웃 뒤 브라우저가 쿠키를 지우도록 Max-Age 0으로 같은 이름·경로의 쿠키를 내려줍니다. */
    fun expire(): ResponseCookie =
        build("", Duration.ZERO)

    private fun build(value: String, maxAge: Duration?): ResponseCookie =
        ResponseCookie.from(COOKIE_NAME, value)
            .httpOnly(true)
            .secure(properties.cookieSecure)
            .sameSite("Lax")
            .path("/")
            .apply { if (maxAge != null) maxAge(maxAge) }
            .build()

    companion object {
        const val COOKIE_NAME = "govbiz_session"

        /** 읽기는 설정이 필요 없어 companion에 둡니다. 웹 계층만 띄우는 테스트에서도 interceptor·resolver가 동작합니다. */
        fun read(request: HttpServletRequest): String? =
            request.cookies
                ?.firstOrNull { cookie -> cookie.name == COOKIE_NAME }
                ?.value
                ?.takeIf(String::isNotEmpty)
    }
}
