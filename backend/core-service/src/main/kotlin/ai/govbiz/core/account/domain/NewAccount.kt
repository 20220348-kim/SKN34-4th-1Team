package ai.govbiz.core.account.domain

import java.time.LocalDateTime

/** 저장 전 검증을 마친 새 계정입니다. 이메일은 소문자로 정규화되어 있어야 합니다. */
data class NewAccount(
    val email: String,
    /** 소셜 로그인으로만 가입한 계정은 null이며 이메일·비밀번호 로그인을 할 수 없습니다. */
    val passwordHash: String?,
    val termsAgreedAt: LocalDateTime,
    val role: AccountRole = AccountRole.USER,
    /** 이메일 가입은 null(미인증)이고, 공급자가 인증한 이메일로 소셜 가입하거나 개발용 시드 계정을 만들 때만 인증 완료로 둡니다. */
    val emailVerifiedAt: LocalDateTime? = null,
) {
    init {
        requireEmail(email)
        require(passwordHash == null || passwordHash.isNotBlank()) { "passwordHash must not be blank" }
    }
}

/** 발급한 세션 토큰의 해시와 만료 시각입니다. 원본 토큰은 저장하지 않습니다. */
data class NewAccountSession(
    val tokenHash: String,
    val expiresAt: LocalDateTime,
) {
    init {
        require(TOKEN_HASH_PATTERN.matches(tokenHash)) { "tokenHash must be a lowercase SHA-256 hash" }
    }

    private companion object {
        val TOKEN_HASH_PATTERN = Regex("[0-9a-f]{64}")
    }
}
