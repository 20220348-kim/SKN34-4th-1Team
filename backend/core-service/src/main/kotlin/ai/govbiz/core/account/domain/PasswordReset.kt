package ai.govbiz.core.account.domain

import java.time.LocalDateTime

/** 저장된 비밀번호 재설정 토큰 한 건입니다. 토큰 원문은 메일에만 있고 여기에는 없습니다. */
data class PasswordReset(
    val id: Long,
    val accountId: Long,
    val expiresAt: LocalDateTime,
)
