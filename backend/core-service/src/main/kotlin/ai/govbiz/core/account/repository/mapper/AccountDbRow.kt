package ai.govbiz.core.account.repository.mapper

import java.time.LocalDateTime

/** MyBatis가 계정 한 행을 읽고 쓰기 위한 DB 행 값입니다. */
data class AccountDbRow(
    var id: Long = 0,
    var email: String = "",
    /** 소셜 로그인으로만 가입한 계정은 null입니다. */
    var passwordHash: String? = null,
    var role: String = "USER",
    var emailVerifiedAt: LocalDateTime? = null,
    var suspendedAt: LocalDateTime? = null,
    var deletedAt: LocalDateTime? = null,
    var termsAgreedAt: LocalDateTime? = null,
    var createdAt: LocalDateTime? = null,
    /** company를 LEFT JOIN한 요약입니다. 기업이 없으면 셋 다 null입니다. */
    var companyId: Long? = null,
    var companyName: String? = null,
    var companyBusinessNumber: String? = null,
)
