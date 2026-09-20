package ai.govbiz.core.admin.repository.mapper

import java.time.LocalDateTime

/** 관리자 목록·상세의 계정 한 행입니다. 소셜 로그인 공급자는 쉼표로 이어 붙인 값입니다. */
data class AdminAccountDbRow(
    var id: Long = 0,
    var email: String = "",
    var role: String = "USER",
    var emailVerifiedAt: LocalDateTime? = null,
    var hasPassword: Boolean = false,
    var suspendedAt: LocalDateTime? = null,
    var createdAt: LocalDateTime? = null,
    var lastLoginAt: LocalDateTime? = null,
    var companyName: String? = null,
    var businessNumber: String? = null,
    var oauthProviders: String? = null,
)

data class AdminAccountStatsDbRow(
    var total: Long = 0,
    var companyRegistered: Long = 0,
    var socialLinked: Long = 0,
    var suspended: Long = 0,
    var admins: Long = 0,
    var joinedRecently: Long = 0,
)

data class AdminAccountCompanyDbRow(
    var companyName: String = "",
    var businessNumber: String = "",
    var region: String = "",
    var industry: String = "",
    var foundedYear: Int = 0,
)

/** 조치 기록 한 행입니다. INSERT에서는 관리자 이메일을 쓰지 않고, 조회에서만 JOIN해 채웁니다. */
data class AdminAccountActionDbRow(
    var id: Long = 0,
    var targetAccountId: Long = 0,
    var adminAccountId: Long = 0,
    var action: String = "",
    var reason: String = "",
    var createdAt: LocalDateTime? = null,
    var adminEmail: String? = null,
)

data class AdminAccountTargetDbRow(
    var id: Long = 0,
    var role: String = "USER",
    var suspendedAt: LocalDateTime? = null,
)
