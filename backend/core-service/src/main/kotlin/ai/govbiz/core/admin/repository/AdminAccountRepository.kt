package ai.govbiz.core.admin.repository

import ai.govbiz.core.account.domain.AccountRole
import ai.govbiz.core.account.domain.OAuthProvider
import ai.govbiz.core.admin.domain.AdminAccountAction
import ai.govbiz.core.admin.domain.AdminAccountActionType
import ai.govbiz.core.admin.domain.AdminAccountActivity
import ai.govbiz.core.admin.domain.AdminAccountCompany
import ai.govbiz.core.admin.domain.AdminAccountPage
import ai.govbiz.core.admin.domain.AdminAccountQuery
import ai.govbiz.core.admin.domain.AdminAccountStats
import ai.govbiz.core.admin.domain.AdminAccountSummary
import ai.govbiz.core.admin.domain.AdminAccountTarget
import ai.govbiz.core.admin.repository.mapper.AdminAccountActionDbRow
import ai.govbiz.core.admin.repository.mapper.AdminAccountDbRow
import ai.govbiz.core.admin.repository.mapper.AdminAccountMapper
import java.time.LocalDate
import java.time.LocalDateTime
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional

/** 관리자 계정 관리의 조회와 정지 상태·조치 기록 쓰기를 MySQL에서 처리합니다. 세션 삭제는 account Repository가 맡습니다. */
@Repository
class AdminAccountRepository(
    private val mapper: AdminAccountMapper,
) {

    fun findPage(query: AdminAccountQuery): AdminAccountPage {
        val keywordPattern = query.keyword.ifEmpty { null }?.let { "%${escapeLikePattern(it)}%" }
        // 사업자등록번호는 숫자만 저장하므로 하이픈을 뺀 숫자 3자리 이상일 때만 번호로도 찾습니다.
        val businessNumberPattern = query.keyword.replace("-", "").takeIf { BUSINESS_NUMBER_KEYWORD.matches(it) }?.let { "%$it%" }
        val status = query.status?.name
        val role = query.role?.name
        val loginMethod = query.loginMethod?.name
        val rows = mapper.findAccounts(
            keywordPattern = keywordPattern,
            businessNumberPattern = businessNumberPattern,
            status = status,
            role = role,
            loginMethod = loginMethod,
            sort = query.sort.name,
            limit = query.pageSize,
            offset = query.offset,
        )
        val total = mapper.countAccounts(keywordPattern, businessNumberPattern, status, role, loginMethod)
        return AdminAccountPage(rows.map { it.toSummary() }, total, query.page, query.pageSize)
    }

    fun findSummary(accountId: Long): AdminAccountSummary? =
        mapper.findAccountById(accountId)?.toSummary()

    fun findStats(joinedSince: LocalDateTime): AdminAccountStats =
        mapper.findStats(joinedSince).let {
            AdminAccountStats(
                total = it.total,
                companyRegistered = it.companyRegistered,
                socialLinked = it.socialLinked,
                suspended = it.suspended,
                admins = it.admins,
                joinedRecently = it.joinedRecently,
            )
        }

    fun findCompany(accountId: Long): AdminAccountCompany? =
        mapper.findCompanyByAccountId(accountId)?.let {
            AdminAccountCompany(it.companyName, it.businessNumber, it.region, it.industry, it.foundedYear)
        }

    fun findActivity(accountId: Long, today: LocalDate, now: LocalDateTime): AdminAccountActivity =
        AdminAccountActivity(
            recruitmentCount = mapper.countRecruitments(accountId),
            openRecruitmentCount = mapper.countOpenRecruitments(accountId, today),
            sentProposalCount = mapper.countSentProposals(accountId),
            activeSessionCount = mapper.countActiveSessions(accountId, now),
        )

    fun findActions(accountId: Long, limit: Int): List<AdminAccountAction> =
        mapper.findActions(accountId, limit).map {
            AdminAccountAction(
                id = it.id,
                action = AdminAccountActionType.valueOf(it.action),
                reason = it.reason,
                adminEmail = requireNotNull(it.adminEmail) { "admin email must not be null" },
                createdAt = requireNotNull(it.createdAt) { "action createdAt must not be null" },
            )
        }

    /** 조치하는 transaction 안에서 대상 계정 행을 잠가 읽습니다. 없거나 삭제된 계정은 null입니다. */
    @Transactional
    fun lockTarget(accountId: Long): AdminAccountTarget? =
        mapper.lockAccount(accountId)?.let { AdminAccountTarget(it.id, AccountRole.valueOf(it.role), it.suspendedAt) }

    /** null이면 정지를 풉니다. */
    @Transactional
    fun updateSuspendedAt(accountId: Long, suspendedAt: LocalDateTime?) {
        check(mapper.updateSuspendedAt(accountId, suspendedAt) == 1) { "account suspension was not updated" }
    }

    @Transactional
    fun recordAction(
        targetAccountId: Long,
        adminAccountId: Long,
        action: AdminAccountActionType,
        reason: String,
        createdAt: LocalDateTime,
    ) {
        val inserted = mapper.insertAction(
            AdminAccountActionDbRow(
                targetAccountId = targetAccountId,
                adminAccountId = adminAccountId,
                action = action.name,
                reason = reason,
                createdAt = createdAt,
            ),
        )
        check(inserted == 1) { "admin action row was not created" }
    }

    private fun AdminAccountDbRow.toSummary(): AdminAccountSummary =
        AdminAccountSummary(
            id = id,
            email = email,
            role = AccountRole.valueOf(role),
            emailVerified = emailVerifiedAt != null,
            hasPassword = hasPassword,
            oauthProviders = oauthProviders.orEmpty().split(',').filter { it.isNotEmpty() }.map(OAuthProvider::valueOf).toSet(),
            companyName = companyName,
            businessNumber = businessNumber,
            suspendedAt = suspendedAt,
            createdAt = requireNotNull(createdAt) { "account createdAt must not be null" },
            lastLoginAt = lastLoginAt,
        )

    /** 검색어의 LIKE 특수문자를 '!'로 이스케이프합니다. Mapper XML의 ESCAPE 문자와 같아야 합니다. */
    private fun escapeLikePattern(value: String): String =
        value.replace("!", "!!").replace("%", "!%").replace("_", "!_")

    private companion object {
        val BUSINESS_NUMBER_KEYWORD = Regex("^\\d{3,10}$")
    }
}
