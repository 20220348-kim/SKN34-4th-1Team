package ai.govbiz.core.account.controller

import ai.govbiz.core.account.config.AccountOAuthProperties
import ai.govbiz.core.account.controller.dto.OAuthProviderResponse
import ai.govbiz.core.account.controller.dto.OAuthProvidersResponse
import ai.govbiz.core.account.domain.OAuthProvider
import ai.govbiz.core.account.helper.OAuthStateCookieHelper
import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core.account.service.AccountOAuthService
import ai.govbiz.core.account.service.AccountMobileOAuthService
import ai.govbiz.core.account.service.dto.OAuthCallback
import ai.govbiz.core.account.service.dto.OAuthCompletionResult
import ai.govbiz.core.account.service.dto.OAuthFailure
import jakarta.servlet.http.HttpServletRequest
import java.net.URI
import org.springframework.http.CacheControl
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.util.UriComponentsBuilder

/**
 * 소셜 로그인 HTTP 진입점입니다. 시작과 콜백은 브라우저의 최상위 이동이라 JSON 대신 302로 답합니다.
 * 성공하면 세션 쿠키를 심고 프런트의 `/oauth/complete`로, 실패하면 사유를 담아 `/login?oauthError=`로 보냅니다.
 * 모두 GET이라 세션 쿠키 Origin 검사 대상이 아니며, CSRF는 서명 쿠키의 state가 막습니다.
 */
@RestController
@RequestMapping(AccountOAuthProperties.PATH_PREFIX)
class AccountOAuthController(
    private val oauthService: AccountOAuthService,
    private val stateCookieHelper: OAuthStateCookieHelper,
    private val sessionCookieHelper: SessionCookieHelper,
    private val properties: AccountOAuthProperties,
    private val mobileOAuthService: AccountMobileOAuthService,
) {

    /** 설정된 공급자와 버튼이 열 시작 주소입니다. */
    @GetMapping("/providers")
    fun providers(): OAuthProvidersResponse =
        OAuthProvidersResponse(
            oauthService.availableProviders().map { provider ->
                OAuthProviderResponse(provider = provider.pathName, startUrl = properties.startUri(provider))
            },
        )

    /** 공급자 로그인 화면으로 보내고 state·nonce·PKCE verifier를 서명 쿠키에 담습니다. */
    @GetMapping("/{provider}/authorize")
    fun authorize(
        @PathVariable provider: String,
        @RequestParam(required = false) next: String?,
        @RequestParam(required = false, defaultValue = "false") rememberMe: Boolean,
    ): ResponseEntity<Void> {
        val started = OAuthProvider.fromPathName(provider)?.let { known -> oauthService.start(known, next, rememberMe) }
            ?: return redirect(loginUri(OAuthFailure.UNAVAILABLE, AccountOAuthService.safeReturnPath(next))).build()
        return redirect(started.authorizationUri)
            .header(HttpHeaders.SET_COOKIE, stateCookieHelper.issue(started.transaction).toString())
            .build()
    }

    /** 공급자가 돌려보낸 콜백입니다. 결과와 관계없이 로그인 상태 쿠키는 지웁니다. */
    @GetMapping("/{provider}/callback")
    fun callback(
        @PathVariable provider: String,
        @RequestParam(required = false) code: String?,
        @RequestParam(required = false) state: String?,
        @RequestParam(required = false) error: String?,
        httpRequest: HttpServletRequest,
    ): ResponseEntity<Void> {
        val transaction = stateCookieHelper.read(httpRequest)
        if (transaction?.mobile == true) {
            return redirect(mobileOAuthService.complete(OAuthProvider.fromPathName(provider),
                OAuthCallback(code, state, error), transaction, httpRequest.remoteAddr))
                .header(HttpHeaders.SET_COOKIE, stateCookieHelper.expire().toString())
                .header("Referrer-Policy", "no-referrer")
                .build()
        }
        val result = oauthService.complete(
            provider = OAuthProvider.fromPathName(provider),
            callback = OAuthCallback(code = code, state = state, error = error),
            transaction = transaction,
            clientAddress = httpRequest.remoteAddr,
        )
        return when (result) {
            is OAuthCompletionResult.SignedIn -> redirect(completeUri(result.returnPath))
                .header(HttpHeaders.SET_COOKIE, stateCookieHelper.expire().toString())
                .header(HttpHeaders.SET_COOKIE, sessionCookieHelper.issue(result.session.sessionToken, result.session.rememberMe).toString())
                .build()
            is OAuthCompletionResult.Failed -> redirect(loginUri(result.failure, result.returnPath))
                .header(HttpHeaders.SET_COOKIE, stateCookieHelper.expire().toString())
                .build()
        }
    }

    private fun redirect(location: URI): ResponseEntity.BodyBuilder =
        ResponseEntity.status(HttpStatus.FOUND)
            .location(location)
            .cacheControl(CacheControl.noStore())

    /** 프런트가 세션을 확인하고 복귀 경로로 옮기는 화면입니다. 복귀 경로는 값 전체를 인코딩합니다. */
    private fun completeUri(returnPath: String): URI =
        UriComponentsBuilder.fromUriString(properties.frontendBaseUrl)
            .path(FRONTEND_COMPLETE_PATH)
            .queryParam("next", "{next}")
            .encode()
            .buildAndExpand(returnPath)
            .toUri()

    private fun loginUri(failure: OAuthFailure, returnPath: String): URI =
        UriComponentsBuilder.fromUriString(properties.frontendBaseUrl)
            .path(FRONTEND_LOGIN_PATH)
            .queryParam("oauthError", "{error}")
            .queryParam("next", "{next}")
            .encode()
            .buildAndExpand(failure.code, returnPath)
            .toUri()

    private companion object {
        const val FRONTEND_COMPLETE_PATH = "/oauth/complete"
        const val FRONTEND_LOGIN_PATH = "/login"
    }
}
