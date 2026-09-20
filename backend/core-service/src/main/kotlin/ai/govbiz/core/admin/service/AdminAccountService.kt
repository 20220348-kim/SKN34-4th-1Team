package ai.govbiz.core.admin.service

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.domain.AccountRole
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.admin.domain.AdminAccountActionType
import ai.govbiz.core.admin.domain.AdminAccountDetail
import ai.govbiz.core.admin.domain.AdminAccountPage
import ai.govbiz.core.admin.domain.AdminAccountQuery
import ai.govbiz.core.admin.domain.AdminAccountStats
import ai.govbiz.core.admin.domain.AdminAccountTarget
import ai.govbiz.core.admin.repository.AdminAccountRepository
import ai.govbiz.core.admin.service.exception.AdminAccountNotFoundException
import ai.govbiz.core.admin.service.exception.AdminAccountStateConflictException
import ai.govbiz.core.admin.service.exception.AdminSelfActionException
import ai.govbiz.core.admin.service.exception.AdminTargetProtectedException
import java.time.Clock
import java.time.LocalDateTime
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional

/**
 * 관리자가 계정을 찾아보고 정지·정지 해제·강제 로그아웃합니다. 관리자 확인은 Controller 파라미터([ai.govbiz.core.admin.web.AdminPrincipal])가
 * 끝낸 뒤라 여기서는 대상 규칙만 봅니다. 조치는 대상 행을 잠근 한 transaction에서 상태를 바꾸고 사유를 기록합니다.
 *
 * 자기 계정과 다른 관리자 계정에는 조치할 수 없습니다. 그래서 정지로 관리자가 모두 사라지는 일도 없습니다.
 */
@Service
class AdminAccountService(
    private val repository: AdminAccountRepository,
    private val accountRepository: AccountRepository,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {

    fun stats(): AdminAccountStats =
        repository.findStats(LocalDateTime.now(clock).minusDays(RECENT_JOIN_DAYS))

    fun findPage(query: AdminAccountQuery): AdminAccountPage =
        repository.findPage(query)

    fun detail(accountId: Long): AdminAccountDetail {
        val account = repository.findSummary(accountId) ?: throw AdminAccountNotFoundException()
        val now = LocalDateTime.now(clock)
        return AdminAccountDetail(
            account = account,
            company = repository.findCompany(accountId),
            activity = repository.findActivity(accountId, now.toLocalDate(), now),
            actions = repository.findActions(accountId, ACTION_HISTORY_LIMIT),
        )
    }

    /** 정지하면 모든 세션을 지워 바로 로그아웃시킵니다. 정지된 계정은 로그인·세션 확인·비밀번호 재설정이 모두 막힙니다. */
    @Transactional
    fun suspend(admin: Account, accountId: Long, reason: String): AdminAccountDetail {
        val normalizedReason = normalizeReason(reason)
        val target = lockTarget(admin, accountId)
        if (target.role == AccountRole.ADMIN) throw AdminTargetProtectedException()
        if (target.suspendedAt != null) throw AdminAccountStateConflictException()

        val now = LocalDateTime.now(clock)
        repository.updateSuspendedAt(accountId, now)
        accountRepository.deleteAllSessionsByAccountId(accountId)
        repository.recordAction(accountId, admin.id, AdminAccountActionType.SUSPEND, normalizedReason, now)
        return detail(accountId)
    }

    /** 정지를 풉니다. 지운 세션은 돌아오지 않으므로 회원은 다시 로그인합니다. */
    @Transactional
    fun unsuspend(admin: Account, accountId: Long, reason: String): AdminAccountDetail {
        val normalizedReason = normalizeReason(reason)
        val target = lockTarget(admin, accountId)
        if (target.suspendedAt == null) throw AdminAccountStateConflictException()

        val now = LocalDateTime.now(clock)
        repository.updateSuspendedAt(accountId, null)
        repository.recordAction(accountId, admin.id, AdminAccountActionType.UNSUSPEND, normalizedReason, now)
        return detail(accountId)
    }

    /** 모든 기기의 세션을 지웁니다. 계정은 그대로라 다시 로그인할 수 있습니다. */
    @Transactional
    fun revokeSessions(admin: Account, accountId: Long, reason: String): AdminAccountDetail {
        val normalizedReason = normalizeReason(reason)
        val target = lockTarget(admin, accountId)
        if (target.role == AccountRole.ADMIN) throw AdminTargetProtectedException()

        accountRepository.deleteAllSessionsByAccountId(accountId)
        repository.recordAction(accountId, admin.id, AdminAccountActionType.SESSIONS_REVOKE, normalizedReason, LocalDateTime.now(clock))
        return detail(accountId)
    }

    private fun lockTarget(admin: Account, accountId: Long): AdminAccountTarget {
        if (admin.id == accountId) throw AdminSelfActionException()
        return repository.lockTarget(accountId) ?: throw AdminAccountNotFoundException()
    }

    private fun normalizeReason(reason: String): String {
        val normalized = reason.trim()
        require(normalized.length in 1..MAX_REASON_LENGTH) { "reason must be 1~$MAX_REASON_LENGTH characters" }
        return normalized
    }

    companion object {
        const val MAX_REASON_LENGTH = 500
        const val ACTION_HISTORY_LIMIT = 20
        const val RECENT_JOIN_DAYS = 7L
    }
}
