package ai.govbiz.core.account.repository.mapper

import java.time.LocalDateTime

/** MyBatis가 로그인 세션 한 행을 읽고 쓰기 위한 DB 행 값입니다. */
data class AccountSessionDbRow(
    var id: Long = 0,
    var tokenHash: String = "",
    var accountId: Long = 0,
    var lastUsedAt: LocalDateTime? = null,
    var expiresAt: LocalDateTime? = null,
)
