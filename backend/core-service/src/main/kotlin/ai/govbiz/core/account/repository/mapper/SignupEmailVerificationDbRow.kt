package ai.govbiz.core.account.repository.mapper

import java.time.LocalDateTime

/** MyBatis가 회원가입 인증번호 한 행을 읽고 쓰기 위한 DB 행 값입니다. 인증번호·통행 토큰은 해시만 있습니다. */
data class SignupEmailVerificationDbRow(
    var id: Long = 0,
    var email: String = "",
    var codeHash: String = "",
    var expiresAt: LocalDateTime? = null,
    var attemptCount: Int = 0,
    var verifiedAt: LocalDateTime? = null,
    var passTokenHash: String? = null,
    var passExpiresAt: LocalDateTime? = null,
    var consumedAt: LocalDateTime? = null,
    var createdAt: LocalDateTime? = null,
)
