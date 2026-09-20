package ai.govbiz.core.account.controller

import ai.govbiz.core.account.controller.dto.PasswordResetConfirmRequest
import ai.govbiz.core.account.controller.dto.PasswordResetRequest
import ai.govbiz.core.account.service.AccountPasswordResetService
import jakarta.servlet.http.HttpServletRequest
import jakarta.validation.Valid
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

/** 로그인 없이 부르는 비밀번호 재설정입니다. 세션 쿠키를 쓰지 않으므로 Origin 검사 대상이 아닙니다. */
@RestController
@RequestMapping("/api/v1/auth/password-reset")
class AccountPasswordResetController(
    private val resetService: AccountPasswordResetService,
) {

    /** 가입 이메일로 재설정 링크를 보냅니다. 가입 여부와 관계없이 204라 계정 존재가 드러나지 않습니다. */
    @PostMapping
    fun request(
        @RequestBody @Valid request: PasswordResetRequest,
        httpRequest: HttpServletRequest,
    ): ResponseEntity<Void> {
        resetService.request(request.email, httpRequest.remoteAddr)
        return ResponseEntity.noContent().build()
    }

    /** 메일 링크의 토큰으로 새 비밀번호를 저장합니다. 성공하면 모든 세션이 끝나므로 다시 로그인해야 합니다. */
    @PostMapping("/confirm")
    fun confirm(@RequestBody @Valid request: PasswordResetConfirmRequest): ResponseEntity<Void> {
        resetService.reset(request.token, request.newPassword)
        return ResponseEntity.noContent().build()
    }
}
