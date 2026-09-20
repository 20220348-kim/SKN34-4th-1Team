package ai.govbiz.core.admin.controller.dto

import ai.govbiz.core.account.domain.AccountRole
import ai.govbiz.core.account.domain.AccountTier
import ai.govbiz.core.admin.domain.AdminAccountAction
import ai.govbiz.core.admin.domain.AdminAccountActionType
import ai.govbiz.core.admin.domain.AdminAccountActivity
import ai.govbiz.core.admin.domain.AdminAccountCompany
import ai.govbiz.core.admin.domain.AdminAccountDetail
import ai.govbiz.core.admin.domain.AdminAccountLoginMethod
import ai.govbiz.core.admin.domain.AdminAccountPage
import ai.govbiz.core.admin.domain.AdminAccountStats
import ai.govbiz.core.admin.domain.AdminAccountStatus
import ai.govbiz.core.admin.domain.AdminAccountSummary
import ai.govbiz.core.admin.service.AdminAccountService
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter

/** 정지·정지 해제·강제 로그아웃에 함께 보내는 사유입니다. 조치 기록에 남습니다. */
class AdminAccountActionRequest(
    @field:NotBlank
    @field:Size(max = AdminAccountService.MAX_REASON_LENGTH)
    val reason: String = "",
)

/** 시각은 서울 기준 ISO 로컬 시각 문자열(`2026-09-11T17:49:09.591286`처럼 초 아래 자리는 있을 때만)입니다. 모집글·제안 응답과 같은 형식입니다. */
private val DATE_TIME: DateTimeFormatter = DateTimeFormatter.ISO_LOCAL_DATE_TIME

private fun LocalDateTime.formatted(): String = format(DATE_TIME)

data class AdminAccountStatsResponse(
    val total: Long,
    val companyRegistered: Long,
    val socialLinked: Long,
    val suspended: Long,
    val admins: Long,
    val joinedRecently: Long,
    /** [joinedRecently]를 센 기간(일)입니다. */
    val recentJoinDays: Long,
) {
    companion object {
        fun from(stats: AdminAccountStats): AdminAccountStatsResponse =
            AdminAccountStatsResponse(
                total = stats.total,
                companyRegistered = stats.companyRegistered,
                socialLinked = stats.socialLinked,
                suspended = stats.suspended,
                admins = stats.admins,
                joinedRecently = stats.joinedRecently,
                recentJoinDays = AdminAccountService.RECENT_JOIN_DAYS,
            )
    }
}

data class AdminAccountCompanySummaryResponse(
    val companyName: String,
    val businessNumber: String,
)

/** 목록 한 줄입니다. 비밀번호 해시·세션 토큰은 담지 않고 비밀번호가 있는지만 알려 줍니다. */
data class AdminAccountSummaryResponse(
    val id: Long,
    val email: String,
    val role: AccountRole,
    val tier: AccountTier,
    val status: AdminAccountStatus,
    val emailVerified: Boolean,
    val hasPassword: Boolean,
    val loginMethods: List<AdminAccountLoginMethod>,
    val company: AdminAccountCompanySummaryResponse?,
    val createdAt: String,
    val lastLoginAt: String?,
    val suspendedAt: String?,
) {
    companion object {
        fun from(account: AdminAccountSummary): AdminAccountSummaryResponse =
            AdminAccountSummaryResponse(
                id = account.id,
                email = account.email,
                role = account.role,
                tier = account.tier,
                status = account.status,
                emailVerified = account.emailVerified,
                hasPassword = account.hasPassword,
                loginMethods = account.loginMethods,
                company = account.companyName?.let { name ->
                    AdminAccountCompanySummaryResponse(name, requireNotNull(account.businessNumber) { "business number must not be null" })
                },
                createdAt = account.createdAt.formatted(),
                lastLoginAt = account.lastLoginAt?.formatted(),
                suspendedAt = account.suspendedAt?.formatted(),
            )
    }
}

data class AdminAccountListResponse(
    val accounts: List<AdminAccountSummaryResponse>,
    val total: Long,
    val page: Int,
    val pageSize: Int,
    val totalPages: Int,
) {
    companion object {
        fun from(page: AdminAccountPage): AdminAccountListResponse =
            AdminAccountListResponse(
                accounts = page.accounts.map(AdminAccountSummaryResponse::from),
                total = page.total,
                page = page.page,
                pageSize = page.pageSize,
                totalPages = page.totalPages,
            )
    }
}

data class AdminAccountCompanyResponse(
    val companyName: String,
    val businessNumber: String,
    val region: String,
    val industry: String,
    val foundedYear: Int,
) {
    companion object {
        fun from(company: AdminAccountCompany): AdminAccountCompanyResponse =
            AdminAccountCompanyResponse(company.companyName, company.businessNumber, company.region, company.industry, company.foundedYear)
    }
}

data class AdminAccountActivityResponse(
    val recruitmentCount: Int,
    val openRecruitmentCount: Int,
    val sentProposalCount: Int,
    val activeSessionCount: Int,
) {
    companion object {
        fun from(activity: AdminAccountActivity): AdminAccountActivityResponse =
            AdminAccountActivityResponse(
                activity.recruitmentCount,
                activity.openRecruitmentCount,
                activity.sentProposalCount,
                activity.activeSessionCount,
            )
    }
}

data class AdminAccountActionResponse(
    val id: Long,
    val action: AdminAccountActionType,
    val reason: String,
    val adminEmail: String,
    val createdAt: String,
) {
    companion object {
        fun from(action: AdminAccountAction): AdminAccountActionResponse =
            AdminAccountActionResponse(action.id, action.action, action.reason, action.adminEmail, action.createdAt.formatted())
    }
}

data class AdminAccountDetailResponse(
    val account: AdminAccountSummaryResponse,
    val company: AdminAccountCompanyResponse?,
    val activity: AdminAccountActivityResponse,
    val actions: List<AdminAccountActionResponse>,
    /** 조회한 관리자 자신의 계정이면 참입니다. 화면은 이때 조치 버튼을 그리지 않습니다. */
    val isSelf: Boolean,
) {
    companion object {
        fun from(detail: AdminAccountDetail, viewerAccountId: Long): AdminAccountDetailResponse =
            AdminAccountDetailResponse(
                account = AdminAccountSummaryResponse.from(detail.account),
                company = detail.company?.let(AdminAccountCompanyResponse::from),
                activity = AdminAccountActivityResponse.from(detail.activity),
                actions = detail.actions.map(AdminAccountActionResponse::from),
                isSelf = detail.account.id == viewerAccountId,
            )
    }
}
