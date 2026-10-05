package ai.govbiz.core.admin.web

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.helper.SessionRequestTokenHelper
import ai.govbiz.core.account.service.AccountSessionService
import ai.govbiz.core.admin.domain.AdminActor
import ai.govbiz.core.admin.service.exception.AdminAccessDeniedException
import jakarta.servlet.http.HttpServletRequest
import org.springframework.core.MethodParameter
import org.springframework.http.HttpHeaders
import org.springframework.web.bind.support.WebDataBinderFactory
import org.springframework.web.context.request.NativeWebRequest
import org.springframework.web.method.support.HandlerMethodArgumentResolver
import org.springframework.web.method.support.ModelAndViewContainer

/**
 * 관리자 API Controller가 받는 로그인한 관리자입니다. 파라미터 타입만으로 관리자 확인이 끝나므로 메서드마다
 * 검사를 빠뜨릴 수 없습니다. 역할은 요청마다 DB에서 다시 읽으므로 권한을 내리거나 정지하면 다음 요청부터 막힙니다.
 *
 * 접속기록에 남길 접속지도 함께 담습니다. 접속 주소는 다른 기능의 요청 제한처럼 `HttpServletRequest.remoteAddr`이며,
 * 운영에서는 Tomcat이 신뢰하는 Nginx 한 곳의 전달 헤더만 반영한 값입니다. User-Agent는 브라우저가 보낸 값 그대로입니다.
 */
data class AdminPrincipal(
    val account: Account,
    val clientIp: String?,
    val userAgent: String?,
) {
    /** 접속기록의 처리자·접속지입니다. 긴 값은 DB 칸에 맞게 자릅니다. */
    val actor: AdminActor
        get() = AdminActor.of(account.id, clientIp, userAgent)
}

/** 쿠키/Bearer 세션으로 계정을 확인한 뒤(없거나 만료면 401, 정지면 403) 관리자가 아니면 403으로 막습니다. */
class AdminPrincipalArgumentResolver(
    private val sessionServiceSupplier: () -> AccountSessionService,
) : HandlerMethodArgumentResolver {

    override fun supportsParameter(parameter: MethodParameter): Boolean =
        parameter.parameterType == AdminPrincipal::class.java

    override fun resolveArgument(
        parameter: MethodParameter,
        mavContainer: ModelAndViewContainer?,
        webRequest: NativeWebRequest,
        binderFactory: WebDataBinderFactory?,
    ): AdminPrincipal {
        val request = requireNotNull(webRequest.getNativeRequest(HttpServletRequest::class.java)) {
            "AdminPrincipal parameters need a servlet request"
        }
        val account = sessionServiceSupplier().requireAccount(SessionRequestTokenHelper.read(request))
        if (!account.isAdmin) throw AdminAccessDeniedException()
        return AdminPrincipal(account, request.remoteAddr, request.getHeader(HttpHeaders.USER_AGENT))
    }
}
