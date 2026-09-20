package ai.govbiz.core.account.controller.dto

import ai.govbiz.core.account.domain.SignupEmailPass
import jakarta.validation.constraints.Email
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Pattern
import jakarta.validation.constraints.Size
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** 인증번호를 받을 가입 이메일입니다. */
data class SignupEmailCodeRequest(
    @field:NotBlank
    @field:Email
    @field:Size(max = 320)
    val email: String,
)

/** 가입 이메일과 메일로 받은 6자리 인증번호입니다. 인증번호가 로그에 남지 않도록 toString을 제한합니다. */
class SignupEmailCodeVerifyRequest(
    @field:NotBlank
    @field:Email
    @field:Size(max = 320)
    val email: String,
    @field:NotBlank
    @field:Pattern(regexp = "[0-9]{6}")
    val code: String,
) {
    override fun toString(): String = "SignupEmailCodeVerifyRequest(email=$email)"
}

/** 인증번호가 맞았을 때 돌려주는 가입 통행 토큰입니다. 가입 요청의 `emailPassToken`에 그대로 실어 보냅니다. */
data class SignupEmailPassResponse(
    val passToken: String,
    val expiresAt: String,
) {
    companion object {
        fun from(pass: SignupEmailPass): SignupEmailPassResponse =
            SignupEmailPassResponse(
                passToken = pass.passToken,
                expiresAt = pass.expiresAt.atZone(ZoneId.of("Asia/Seoul")).format(DateTimeFormatter.ISO_OFFSET_DATE_TIME),
            )
    }
}
