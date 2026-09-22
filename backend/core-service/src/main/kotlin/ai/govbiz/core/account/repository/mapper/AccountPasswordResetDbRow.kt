package ai.govbiz.core.account.repository.mapper

import java.time.LocalDateTime

/** account_password_reset 한 행입니다. 인증번호·통행 토큰은 해시만 있습니다. */
data class AccountPasswordResetDbRow(
    var id: Long = 0,
    var accountId: Long = 0,
    var codeHash: String = "",
    var expiresAt: LocalDateTime? = null,
    var attemptCount: Int = 0,
    var verifiedAt: LocalDateTime? = null,
    var passTokenHash: String? = null,
    var passExpiresAt: LocalDateTime? = null,
    var usedAt: LocalDateTime? = null,
    var createdAt: LocalDateTime? = null,
)
