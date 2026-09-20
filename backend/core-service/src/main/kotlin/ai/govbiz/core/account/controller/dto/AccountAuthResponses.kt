package ai.govbiz.core.account.controller.dto

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.domain.AccountRole
import ai.govbiz.core.account.domain.AccountTier
import ai.govbiz.core.account.service.dto.AccountSessionResult
import java.time.format.DateTimeFormatter

/** 세션 토큰은 HttpOnly 쿠키로만 전달하므로 본문에는 만료 시각과 계정만 담습니다. */
data class AuthSessionResponse(
    val expiresAt: String,
    val account: AccountResponse,
) {
    companion object {
        fun from(result: AccountSessionResult): AuthSessionResponse =
            AuthSessionResponse(
                expiresAt = result.expiresAt.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME),
                account = AccountResponse.from(result.account),
            )
    }
}

data class CurrentAccountResponse(
    val account: AccountResponse,
) {
    companion object {
        fun from(account: Account): CurrentAccountResponse =
            CurrentAccountResponse(AccountResponse.from(account))
    }
}

/** 프런트는 `tier`로 라우트를 지키고 서버는 같은 값을 모든 쓰기 API에서 다시 계산합니다. */
data class AccountResponse(
    val email: String,
    val role: AccountRole,
    val tier: AccountTier,
    val emailVerified: Boolean,
    /** 등록한 기업 요약. 없으면 null이며 사이드바가 이메일만 보여 줍니다. */
    val company: CompanySummaryResponse?,
    /** 거짓이면 소셜 로그인으로만 가입한 계정이라 프로필이 비밀번호 항목을 숨기고 계정 삭제에 비밀번호를 묻지 않습니다. */
    val hasPassword: Boolean,
) {
    companion object {
        fun from(account: Account): AccountResponse =
            AccountResponse(
                email = account.email,
                role = account.role,
                tier = account.tier,
                emailVerified = account.isEmailVerified,
                company = account.company?.let(CompanySummaryResponse::from),
                hasPassword = account.hasPassword,
            )
    }
}
