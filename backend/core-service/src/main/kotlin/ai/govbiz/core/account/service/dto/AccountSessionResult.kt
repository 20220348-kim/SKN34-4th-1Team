package ai.govbiz.core.account.service.dto

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.domain.NewAccountSession
import java.time.OffsetDateTime

/** 가입·로그인 성공 뒤 브라우저에 돌려줄 세션 토큰과 계정입니다. */
data class AccountSessionResult(
    val sessionToken: String,
    val expiresAt: OffsetDateTime,
    /** true면 쿠키에 Max-Age를 붙여 브라우저를 닫아도 유지하고, false면 브라우저 세션 쿠키로 내려줍니다. */
    val rememberMe: Boolean,
    val account: Account,
)

/** 저장 전 발급한 세션입니다. 원본 토큰은 결과에만, 해시는 DB에만 갑니다. */
data class IssuedSessionResult(
    val sessionToken: String,
    val rememberMe: Boolean,
    val session: NewAccountSession,
)
