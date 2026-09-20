package ai.govbiz.core.account.domain

import java.time.LocalDateTime

/** 저장된 회원가입 인증번호 한 건입니다. 인증번호 원문은 메일에만 있고 여기에는 해시만 있습니다. */
data class SignupEmailVerification(
    val id: Long,
    val email: String,
    val codeHash: String,
    val expiresAt: LocalDateTime,
    val attemptCount: Int,
)

/** 인증번호가 맞았을 때 가입 요청에 실어 보내는 통행 토큰입니다. 원문은 응답에만 있고 DB에는 해시만 둡니다. */
data class SignupEmailPass(
    val passToken: String,
    val expiresAt: LocalDateTime,
)
