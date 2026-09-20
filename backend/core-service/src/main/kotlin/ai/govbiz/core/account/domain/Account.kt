package ai.govbiz.core.account.domain

import java.time.LocalDateTime

/** 관리자는 SQL이나 개발용 로그인으로만 지정하며 가입 시에는 항상 USER입니다. */
enum class AccountRole {
    USER,
    ADMIN,
}

/**
 * 화면 권한을 정하는 확인 단계입니다. 역할 이름이 아니라 계정이 통과한 확인으로 계산합니다.
 *
 * `COMPANY`는 사업자등록번호 조회를 통과한 기업을 등록하면 붙습니다. 이메일 인증 조건은 인증 기능이 생길 때 더합니다.
 */
enum class AccountTier {
    MEMBER,
    COMPANY,
    ADMIN,
}

/** 로그인 가능한 계정입니다. 비밀번호 해시는 포함하지 않습니다. */
data class Account(
    val id: Long,
    val email: String,
    val role: AccountRole,
    val emailVerifiedAt: LocalDateTime?,
    val suspendedAt: LocalDateTime?,
    val createdAt: LocalDateTime,
    /** 등록한 기업 요약입니다. 없으면 회원(MEMBER) 단계입니다. */
    val company: CompanySummary? = null,
    /** 비밀번호를 만든 계정인지입니다. 소셜 로그인으로만 가입한 계정은 거짓이며 화면이 비밀번호 항목을 숨깁니다. */
    val hasPassword: Boolean = true,
) {
    init {
        requireEmail(email)
    }

    val isAdmin: Boolean
        get() = role == AccountRole.ADMIN

    val isEmailVerified: Boolean
        get() = emailVerifiedAt != null

    /** 정지된 계정은 로그인과 세션 확인이 모두 막힙니다. 정지 사유는 관리자 조치 기록이 맡습니다. */
    val isSuspended: Boolean
        get() = suspendedAt != null

    val hasCompany: Boolean
        get() = company != null

    val tier: AccountTier
        get() = when {
            isAdmin -> AccountTier.ADMIN
            hasCompany -> AccountTier.COMPANY
            else -> AccountTier.MEMBER
        }
}

/** 로그인 검증에만 쓰는 계정과 비밀번호 해시 조합입니다. 공개 계약으로 노출하지 않습니다. */
data class AccountCredential(
    val account: Account,
    val passwordHash: String,
) {
    init {
        require(passwordHash.isNotBlank()) { "passwordHash must not be blank" }
    }
}

/** DB에 저장된 로그인 세션 한 건입니다. 토큰 원문은 없고 만료·마지막 사용 시각만 있습니다. */
data class StoredAccountSession(
    val accountId: Long,
    val expiresAt: LocalDateTime,
    val lastUsedAt: LocalDateTime,
)

internal fun requireEmail(email: String) {
    require(email.isNotBlank() && email == email.trim() && email == email.lowercase()) {
        "email must be a trimmed lowercase address"
    }
}
