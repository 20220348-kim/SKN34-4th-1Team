package ai.govbiz.core.account.web

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.helper.SessionRequestTokenHelper
import ai.govbiz.core.account.service.AccountSessionService
import jakarta.servlet.http.HttpServletRequest
import org.springframework.core.MethodParameter
import org.springframework.web.bind.support.WebDataBinderFactory
import org.springframework.web.context.request.NativeWebRequest
import org.springframework.web.method.support.HandlerMethodArgumentResolver
import org.springframework.web.method.support.ModelAndViewContainer

/**
 * Controller 메서드의 [Account] 파라미터를 웹 쿠키 또는 네이티브 Bearer 세션으로 채웁니다.
 *
 * 파라미터가 non-null이면 세션이 없거나 만료됐을 때 [AccountSessionService.requireAccount]의 예외가 그대로 401이
 * 됩니다. nullable(`Account?`)이면 인증이 없는 요청에는 null을 넣어 비로그인 조회를 허용하되, 인증이 있는데
 * 유효하지 않으면 여전히 401입니다.
 */
class AuthenticatedAccountArgumentResolver(
    private val sessionServiceSupplier: () -> AccountSessionService,
) : HandlerMethodArgumentResolver {

    constructor(sessionService: AccountSessionService) : this({ sessionService })

    override fun supportsParameter(parameter: MethodParameter): Boolean =
        parameter.parameterType == Account::class.java

    override fun resolveArgument(
        parameter: MethodParameter,
        mavContainer: ModelAndViewContainer?,
        webRequest: NativeWebRequest,
        binderFactory: WebDataBinderFactory?,
    ): Account? {
        val request = requireNotNull(webRequest.getNativeRequest(HttpServletRequest::class.java)) {
            "Account parameters need a servlet request"
        }
        val sessionToken = SessionRequestTokenHelper.read(request)
        if (sessionToken == null && parameter.isOptional) return null
        return sessionServiceSupplier().requireAccount(sessionToken)
    }
}
