package ai.govbiz.core.account.web

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core.account.helper.SessionRequestTokenHelper
import ai.govbiz.core.account.service.AccountSessionService
import ai.govbiz.core.account.service.exception.AccountSuspendedException
import ai.govbiz.core.account.service.exception.AuthenticationRequiredException
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.core.MethodParameter
import org.springframework.http.HttpHeaders
import org.springframework.web.bind.support.WebDataBinderFactory
import org.springframework.web.context.request.NativeWebRequest
import org.springframework.web.method.support.HandlerMethodArgumentResolver
import org.springframework.web.method.support.ModelAndViewContainer

/**
 * Controller 메서드의 [Account] 파라미터를 웹 쿠키 또는 네이티브 Bearer 세션으로 채웁니다.
 *
 * 파라미터가 non-null이면 세션이 없거나 만료됐을 때 [AccountSessionService.requireAccount]의 예외가 그대로 401(정지는
 * 403)이 됩니다. nullable(`Account?`)이면 인증이 없는 요청에는 null을 넣어 비로그인 조회를 허용합니다.
 *
 * 세션 쿠키가 확실히 쓸 수 없는 경우(401 사유 또는 정지)에는 응답에 쿠키 만료 `Set-Cookie`를 붙여 브라우저가 같은
 * 쿠키를 계속 보내지 않게 합니다. 이때 nullable 파라미터는 손님(null)으로 계속 처리하고, non-null 파라미터는 원래
 * 예외를 그대로 던집니다. 예외 처리기는 응답 헤더를 지우지 않으므로 401·403 응답에도 만료 쿠키가 남습니다.
 * 세션 저장소 장애처럼 확인할 수 없는 경우와 Bearer 인증 실패는 지금처럼 오류로 돌려줍니다.
 */
class AuthenticatedAccountArgumentResolver(
    private val sessionServiceSupplier: () -> AccountSessionService,
    private val sessionCookieHelperSupplier: () -> SessionCookieHelper,
) : HandlerMethodArgumentResolver {

    constructor(sessionService: AccountSessionService, sessionCookieHelper: SessionCookieHelper) :
        this({ sessionService }, { sessionCookieHelper })

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
        val cookieToken = SessionCookieHelper.read(request)
        if (cookieToken == null) {
            val bearerToken = SessionRequestTokenHelper.readBearer(request)
            if (bearerToken == null && parameter.isOptional) return null
            return sessionServiceSupplier().requireAccount(bearerToken)
        }

        return try {
            sessionServiceSupplier().requireAccount(cookieToken)
        } catch (exception: RuntimeException) {
            if (exception !is AuthenticationRequiredException && exception !is AccountSuspendedException) throw exception
            val response = requireNotNull(webRequest.getNativeResponse(HttpServletResponse::class.java)) {
                "Account parameters need a servlet response"
            }
            response.addHeader(HttpHeaders.SET_COOKIE, sessionCookieHelperSupplier().expire().toString())
            if (parameter.isOptional) null else throw exception
        }
    }
}
