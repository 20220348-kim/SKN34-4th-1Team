package ai.govbiz.core.admin.domain

import ai.govbiz.core.account.domain.AccountRole
import ai.govbiz.core.account.domain.AccountTier
import ai.govbiz.core.account.domain.OAuthProvider
import java.time.LocalDateTime

/** 관리자 목록에서 계정을 나누는 상태입니다. 삭제된 계정은 목록과 상세에 나오지 않습니다. */
enum class AdminAccountStatus {
    ACTIVE,
    SUSPENDED,
}

/** 로그인 방법입니다. 이메일은 비밀번호가 있는 계정, 카카오·Google은 소셜 로그인이 연결된 계정이며 한 계정이 여럿을 가질 수 있습니다. */
enum class AdminAccountLoginMethod {
    EMAIL,
    KAKAO,
    GOOGLE,
}

/** 목록 정렬입니다. 최근 로그인순은 로그인한 적 없는 계정을 뒤에 둡니다. */
enum class AdminAccountSort {
    RECENT,
    OLDEST,
    LAST_LOGIN,
}

/** 관리자 조치 종류입니다. DB CHECK 제약과 같은 값입니다. */
enum class AdminAccountActionType {
    SUSPEND,
    UNSUSPEND,
    SESSIONS_REVOKE,
}

/** 관리자 계정 목록을 좁히는 조건입니다. 상태·역할·로그인 방법이 null이면 전체입니다. */
data class AdminAccountQuery(
    /** 이메일·기업명, 숫자만 있으면 사업자등록번호 일부로도 찾습니다. */
    val keyword: String,
    val status: AdminAccountStatus?,
    val role: AccountRole?,
    val loginMethod: AdminAccountLoginMethod?,
    val sort: AdminAccountSort,
    val page: Int,
    val pageSize: Int,
) {
    init {
        require(keyword == keyword.trim() && keyword.length <= MAX_KEYWORD_LENGTH) {
            "keyword must be a trimmed text of at most $MAX_KEYWORD_LENGTH characters"
        }
        require(page >= 1) { "page must be positive" }
        require(pageSize in 1..MAX_PAGE_SIZE) { "pageSize must be 1~$MAX_PAGE_SIZE" }
    }

    val offset: Int
        get() = (page - 1) * pageSize

    companion object {
        const val MAX_KEYWORD_LENGTH = 100
        const val MAX_PAGE_SIZE = 50
    }
}

/** 관리자 목록 한 줄입니다. 비밀번호 해시·세션 토큰은 담지 않습니다. */
data class AdminAccountSummary(
    val id: Long,
    val email: String,
    val role: AccountRole,
    val emailVerified: Boolean,
    val hasPassword: Boolean,
    val oauthProviders: Set<OAuthProvider>,
    val companyName: String?,
    val businessNumber: String?,
    val suspendedAt: LocalDateTime?,
    val createdAt: LocalDateTime,
    /** 로그인·가입·소셜 로그인으로 세션을 받은 마지막 시각입니다. 이 값이 생기기 전의 로그인은 남아 있지 않아 null입니다. */
    val lastLoginAt: LocalDateTime?,
) {
    val status: AdminAccountStatus
        get() = if (suspendedAt == null) AdminAccountStatus.ACTIVE else AdminAccountStatus.SUSPENDED

    /** 회원 화면의 권한 단계와 같은 규칙입니다. */
    val tier: AccountTier
        get() = when {
            role == AccountRole.ADMIN -> AccountTier.ADMIN
            companyName != null -> AccountTier.COMPANY
            else -> AccountTier.MEMBER
        }

    val loginMethods: List<AdminAccountLoginMethod>
        get() = buildList {
            if (hasPassword) add(AdminAccountLoginMethod.EMAIL)
            if (OAuthProvider.KAKAO in oauthProviders) add(AdminAccountLoginMethod.KAKAO)
            if (OAuthProvider.GOOGLE in oauthProviders) add(AdminAccountLoginMethod.GOOGLE)
        }
}

/** 한 페이지 결과입니다. 총 건수는 같은 조건의 전체 건수입니다. */
data class AdminAccountPage(
    val accounts: List<AdminAccountSummary>,
    val total: Long,
    val page: Int,
    val pageSize: Int,
) {
    val totalPages: Int
        get() = if (total == 0L) 0 else ((total - 1) / pageSize + 1).toInt()
}

/** 목록 위 요약 수치입니다. 삭제된 계정은 세지 않습니다. */
data class AdminAccountStats(
    val total: Long,
    val companyRegistered: Long,
    val socialLinked: Long,
    val suspended: Long,
    val admins: Long,
    /** 최근 [ai.govbiz.core.admin.service.AdminAccountService.RECENT_JOIN_DAYS]일 안에 가입한 계정 수입니다. */
    val joinedRecently: Long,
)

/** 상세의 기업 정보입니다. */
data class AdminAccountCompany(
    val companyName: String,
    val businessNumber: String,
    val region: String,
    val industry: String,
    val foundedYear: Int,
)

/** 상세의 활동 수치입니다. 세션은 아직 만료되지 않은 것만 셉니다. */
data class AdminAccountActivity(
    val recruitmentCount: Int,
    val openRecruitmentCount: Int,
    val sentProposalCount: Int,
    val activeSessionCount: Int,
)

/** 관리자 조치 기록 한 건입니다. */
data class AdminAccountAction(
    val id: Long,
    val action: AdminAccountActionType,
    val reason: String,
    val adminEmail: String,
    val createdAt: LocalDateTime,
)

data class AdminAccountDetail(
    val account: AdminAccountSummary,
    val company: AdminAccountCompany?,
    val activity: AdminAccountActivity,
    /** 최근 조치부터 최대 [ai.govbiz.core.admin.service.AdminAccountService.ACTION_HISTORY_LIMIT]건입니다. */
    val actions: List<AdminAccountAction>,
)

/** 조치 transaction 안에서 잠가 읽은 대상 계정의 상태입니다. */
data class AdminAccountTarget(
    val id: Long,
    val role: AccountRole,
    val suspendedAt: LocalDateTime?,
)
