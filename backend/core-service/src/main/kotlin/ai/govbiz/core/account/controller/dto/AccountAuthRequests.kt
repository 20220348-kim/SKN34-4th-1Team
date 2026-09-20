package ai.govbiz.core.account.controller.dto

import ai.govbiz.core.account.domain.AccountRole
import jakarta.validation.constraints.Email
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Pattern
import jakarta.validation.constraints.Size

/** 비밀번호가 로그·예외 메시지에 남지 않도록 data class 대신 toString을 제한한 요청입니다. */
class LoginRequest(
    @field:NotBlank
    @field:Email
    @field:Size(max = 320)
    val email: String,
    @field:NotBlank
    @field:Size(max = 72)
    val password: String,
    /** "로그인 상태 유지". true면 긴 만료의 영구 쿠키, false면 브라우저를 닫으면 사라지는 세션 쿠키입니다. */
    val rememberMe: Boolean = false,
) {
    override fun toString(): String = "LoginRequest(email=$email, rememberMe=$rememberMe)"
}

/**
 * 회원가입 요청입니다. 비밀번호는 길이(8~72자)만 검사하고, 약관 동의 시각은 서버가 요청 시각으로 기록합니다.
 * `emailPassToken`은 인증번호 확인이 돌려준 43자 통행 토큰이며 같은 이메일로 인증한 것이어야 합니다.
 */
class SignupRequest(
    @field:NotBlank
    @field:Email
    @field:Size(max = 320)
    val email: String,
    @field:NotBlank
    @field:Size(min = 8, max = 72)
    val password: String,
    @field:NotBlank
    @field:Pattern(regexp = "[A-Za-z0-9_-]{43}")
    val emailPassToken: String,
) {
    override fun toString(): String = "SignupRequest(email=$email)"
}

/** 개발용 로그인에서 어떤 시드 계정으로 들어갈지 고릅니다. 본문이 없으면 관리자입니다. */
data class DevLoginRequest(
    val role: AccountRole = AccountRole.ADMIN,
)
