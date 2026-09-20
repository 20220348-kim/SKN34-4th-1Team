package ai.govbiz.core.account.controller

import ai.govbiz.core.account.controller.dto.AuthSessionResponse
import ai.govbiz.core.account.controller.dto.CurrentAccountResponse
import ai.govbiz.core.account.controller.dto.LoginRequest
import ai.govbiz.core.account.controller.dto.SignupRequest
import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.service.AccountLoginService
import ai.govbiz.core.account.service.AccountSessionService
import ai.govbiz.core.account.service.AccountSignupService
import ai.govbiz.core.account.helper.SessionCookieHelper
import jakarta.servlet.http.HttpServletRequest
import jakarta.validation.Valid
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/v1/auth")
class AccountAuthController(
    private val loginService: AccountLoginService,
    private val signupService: AccountSignupService,
    private val sessionService: AccountSessionService,
    private val cookieHelper: SessionCookieHelper,
) {

    /** 세션 JWT는 본문이 아니라 HttpOnly 쿠키로만 내려주고, 본문에는 만료 시각과 계정만 담습니다. */
    @PostMapping("/login")
    fun logIn(
        @RequestBody @Valid request: LoginRequest,
        httpRequest: HttpServletRequest,
    ): ResponseEntity<AuthSessionResponse> {
        val result = loginService.logIn(request.email, request.password, httpRequest.remoteAddr, request.rememberMe)
        return ResponseEntity.ok()
            .header(HttpHeaders.SET_COOKIE, cookieHelper.issue(result.sessionToken, result.rememberMe).toString())
            .body(AuthSessionResponse.from(result))
    }

    /** 계정을 만들고 바로 브라우저 세션 쿠키를 발급합니다. 이메일이 이미 있으면 409입니다. */
    @PostMapping("/signup")
    fun signUp(
        @RequestBody @Valid request: SignupRequest,
        httpRequest: HttpServletRequest,
    ): ResponseEntity<AuthSessionResponse> {
        val result = signupService.signUp(request.email, request.password, request.emailPassToken, httpRequest.remoteAddr)
        return ResponseEntity.status(HttpStatus.CREATED)
            .header(HttpHeaders.SET_COOKIE, cookieHelper.issue(result.sessionToken, result.rememberMe).toString())
            .body(AuthSessionResponse.from(result))
    }

    /** 세션 행을 지우고 브라우저 쿠키도 만료시킵니다. 쿠키가 없으면 401입니다. */
    @PostMapping("/logout")
    fun logOut(httpRequest: HttpServletRequest): ResponseEntity<Void> {
        sessionService.logOut(SessionCookieHelper.read(httpRequest))
        return ResponseEntity.noContent()
            .header(HttpHeaders.SET_COOKIE, cookieHelper.expire().toString())
            .build()
    }

    /** [Account] 파라미터는 AuthenticatedAccountArgumentResolver가 세션 쿠키로 채웁니다. */
    @GetMapping("/me")
    fun me(account: Account): CurrentAccountResponse =
        CurrentAccountResponse.from(account)
}
