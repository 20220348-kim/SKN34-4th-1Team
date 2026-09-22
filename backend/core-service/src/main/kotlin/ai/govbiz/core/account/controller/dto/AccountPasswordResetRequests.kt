package ai.govbiz.core.account.controller.dto

import ai.govbiz.core.account.domain.PasswordResetPass
import jakarta.validation.constraints.Email
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Pattern
import jakarta.validation.constraints.Size
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** 인증번호를 받을 가입 이메일입니다. */
data class PasswordResetRequest(
    @field:NotBlank
    @field:Email
    @field:Size(max = 320)
    val email: String,
)

/** 가입 이메일과 메일로 받은 6자리 인증번호입니다. 인증번호가 로그에 남지 않도록 toString을 제한합니다. */
class PasswordResetVerifyRequest(
    @field:NotBlank
    @field:Email
    @field:Size(max = 320)
    val email: String,
    @field:NotBlank
    @field:Pattern(regexp = "[0-9]{6}")
    val code: String,
) {
    override fun toString(): String = "PasswordResetVerifyRequest(email=$email)"
}

/** 인증번호가 맞았을 때 돌려주는 통행 토큰입니다. 새 비밀번호 저장 요청의 `token`에 그대로 실어 보냅니다. */
data class PasswordResetPassResponse(
    val passToken: String,
    val expiresAt: String,
) {
    companion object {
        fun from(pass: PasswordResetPass): PasswordResetPassResponse =
            PasswordResetPassResponse(
                passToken = pass.passToken,
                expiresAt = pass.expiresAt.atZone(ZoneId.of("Asia/Seoul")).format(DateTimeFormatter.ISO_OFFSET_DATE_TIME),
            )
    }
}

/** 인증번호를 맞힌 뒤 받은 통행 토큰과 새 비밀번호입니다. 토큰·비밀번호가 로그에 남지 않도록 toString을 제한합니다. */
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
