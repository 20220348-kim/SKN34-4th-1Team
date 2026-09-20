package ai.govbiz.core.account.controller

import ai.govbiz.core.account.controller.dto.SignupEmailCodeRequest
import ai.govbiz.core.account.controller.dto.SignupEmailCodeVerifyRequest
import ai.govbiz.core.account.controller.dto.SignupEmailPassResponse
import ai.govbiz.core.account.service.AccountSignupEmailVerificationService
import jakarta.servlet.http.HttpServletRequest
import jakarta.validation.Valid
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

/** 회원가입 전 이메일 인증번호입니다. 계정이 아직 없어 세션 쿠키를 쓰지 않으므로 Origin 검사 대상이 아닙니다. */
@RestController
@RequestMapping("/api/v1/auth/signup/email-code")
class AccountSignupEmailVerificationController(
    private val verificationService: AccountSignupEmailVerificationService,
) {

    /** 가입 이메일로 6자리 인증번호를 보냅니다. 이미 가입된 이메일은 409, 재전송 대기·발송 한도는 429입니다. */
    @PostMapping
    fun sendCode(
        @RequestBody @Valid request: SignupEmailCodeRequest,
        httpRequest: HttpServletRequest,
    ): ResponseEntity<Void> {
        verificationService.sendCode(request.email, httpRequest.remoteAddr)
        return ResponseEntity.noContent().build()
    }

    /** 인증번호를 확인하고 가입 요청에 실을 통행 토큰을 돌려줍니다. 틀리면 422, 만료·시도 초과면 422입니다. */
    @PostMapping("/verify")
    fun verifyCode(
        @RequestBody @Valid request: SignupEmailCodeVerifyRequest,
        httpRequest: HttpServletRequest,
    ): SignupEmailPassResponse =
        SignupEmailPassResponse.from(verificationService.verifyCode(request.email, request.code, httpRequest.remoteAddr))
}
