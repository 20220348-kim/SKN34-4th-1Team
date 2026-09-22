package ai.govbiz.core.account.domain

import java.time.LocalDateTime

/** 비밀번호 재설정 인증번호 한 건입니다. 인증번호 원문은 메일로만 보내고 해시만 둡니다. */
data class PasswordReset(
    val id: Long,
    val accountId: Long,
    val codeHash: String,
    val expiresAt: LocalDateTime,
    val attemptCount: Int,
)

/** 인증번호를 맞힌 뒤 새 비밀번호 저장 요청에 실어 보내는 통행 토큰입니다. 원문은 이 응답에만 있습니다. */
data class PasswordResetPass(
    val passToken: String,
    val expiresAt: LocalDateTime,
)
