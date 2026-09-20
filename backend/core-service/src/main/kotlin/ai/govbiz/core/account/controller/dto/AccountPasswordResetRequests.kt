package ai.govbiz.core.account.controller.dto

import jakarta.validation.constraints.Email
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Pattern
import jakarta.validation.constraints.Size

/** 재설정 링크를 받을 가입 이메일입니다. 가입 여부와 관계없이 같은 응답을 받습니다. */
data class PasswordResetRequest(
    @field:NotBlank
    @field:Email
    @field:Size(max = 320)
    val email: String,
)

/** 메일 링크의 토큰과 새 비밀번호입니다. 토큰·비밀번호가 로그에 남지 않도록 toString을 제한합니다. */
class PasswordResetConfirmRequest(
    @field:NotBlank
    @field:Pattern(regexp = "[A-Za-z0-9_-]{43}")
    val token: String,
    @field:NotBlank
    @field:Size(min = 8, max = 72)
    val newPassword: String,
) {
    override fun toString(): String = "PasswordResetConfirmRequest()"
}
