package ai.govbiz.core.account.repository.mapper

import java.time.LocalDateTime

/** MyBatis가 비밀번호 재설정 토큰 한 행을 읽고 쓰기 위한 DB 행 값입니다. 토큰 원문은 없고 해시만 있습니다. */
data class AccountPasswordResetDbRow(
    var id: Long = 0,
    var accountId: Long = 0,
    var tokenHash: String = "",
    var expiresAt: LocalDateTime? = null,
    var usedAt: LocalDateTime? = null,
    var createdAt: LocalDateTime? = null,
)
