package ai.govbiz.core.account.controller

import ai.govbiz.core.account.controller.dto.LoginRequest
import ai.govbiz.core.account.controller.dto.MobileAuthSessionResponse
import ai.govbiz.core.account.controller.dto.SignupRequest
import ai.govbiz.core.account.helper.SessionRequestTokenHelper
import ai.govbiz.core.account.service.AccountLoginService
import ai.govbiz.core.account.service.AccountSessionService
import ai.govbiz.core.account.service.AccountSignupService
import jakarta.servlet.http.HttpServletRequest
import jakarta.validation.Valid
import org.springframework.http.CacheControl
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

/** 네이티브 앱의 이메일 인증 경계입니다. 웹과 같은 세션을 발급하되 쿠키 대신 JSON으로 전달합니다. */
@RestController
@RequestMapping("/api/v1/auth/mobile")
class AccountMobileAuthController(
    private val loginService: AccountLoginService,
    private val signupService: AccountSignupService,
    private val sessionService: AccountSessionService,
) {

    @PostMapping("/login")
    fun logIn(
        @RequestBody @Valid request: LoginRequest,
        httpRequest: HttpServletRequest,
    ): ResponseEntity<MobileAuthSessionResponse> {
        val result = loginService.logIn(request.email, request.password, httpRequest.remoteAddr, request.rememberMe)
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
            .body(MobileAuthSessionResponse.from(result))
    }

    @PostMapping("/signup")
    fun signUp(
        @RequestBody @Valid request: SignupRequest,
        httpRequest: HttpServletRequest,
    ): ResponseEntity<MobileAuthSessionResponse> {
        val result = signupService.signUp(request.email, request.password, request.emailPassToken, httpRequest.remoteAddr)
        return ResponseEntity.status(HttpStatus.CREATED).cacheControl(CacheControl.noStore())
            .body(MobileAuthSessionResponse.from(result))
    }

    /** 앱이 보낸 Bearer 세션만 폐기합니다. 쿠키가 함께 오면 기존 Origin interceptor도 그대로 적용됩니다. */
    @PostMapping("/logout")
    fun logOut(httpRequest: HttpServletRequest): ResponseEntity<Void> {
        sessionService.logOut(SessionRequestTokenHelper.readBearer(httpRequest))
        return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build()
    }
}
