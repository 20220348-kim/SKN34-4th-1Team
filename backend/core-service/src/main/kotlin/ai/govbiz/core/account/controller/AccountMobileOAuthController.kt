package ai.govbiz.core.account.controller

import ai.govbiz.core.account.controller.dto.MobileAuthSessionResponse
import ai.govbiz.core.account.controller.dto.MobileOAuthExchangeRequest
import ai.govbiz.core.account.helper.OAuthStateCookieHelper
import ai.govbiz.core.account.service.AccountMobileOAuthService
import jakarta.servlet.http.HttpServletRequest
import jakarta.validation.Valid
import org.springframework.http.CacheControl
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/v1/auth/mobile/oauth")
class AccountMobileOAuthController(
    private val service: AccountMobileOAuthService,
    private val stateCookieHelper: OAuthStateCookieHelper,
) {
    /** 시스템 브라우저가 여는 시작 주소입니다. 공급자는 기존 HTTPS 서버 callback으로 돌아옵니다. */
    @GetMapping("/{provider}/authorize")
    fun authorize(@PathVariable provider: String, @RequestParam redirectUri: String, @RequestParam state: String,
                  @RequestParam codeChallenge: String, @RequestParam(defaultValue = "false") rememberMe: Boolean,
                  request: HttpServletRequest): ResponseEntity<Void> {
        val started = service.start(provider, redirectUri, state, codeChallenge, rememberMe, request.remoteAddr)
        val response = ResponseEntity.status(HttpStatus.FOUND).cacheControl(CacheControl.noStore())
            .header("Referrer-Policy", "no-referrer")
        return if (started == null) response.location(AccountMobileOAuthService.callbackUri(redirectUri, state, error = "unavailable")).build()
        else response.location(started.authorizationUri)
            .header(HttpHeaders.SET_COOKIE, stateCookieHelper.issue(started.transaction).toString()).build()
    }

    @PostMapping("/exchange")
    fun exchange(@RequestBody @Valid request: MobileOAuthExchangeRequest,
                 httpRequest: HttpServletRequest): ResponseEntity<MobileAuthSessionResponse> =
        ResponseEntity.ok().cacheControl(CacheControl.noStore())
            .body(MobileAuthSessionResponse.from(service.exchange(request.code, request.codeVerifier, request.redirectUri, httpRequest.remoteAddr)))
}
