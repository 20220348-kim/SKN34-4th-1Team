package ai.govbiz.core.admin.service

import ai.govbiz.core.account.domain.AccountRole
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.admin.domain.AdminAccessAction
import ai.govbiz.core.admin.domain.AdminAccountActionType
import ai.govbiz.core.admin.domain.AdminAccountDetail
import ai.govbiz.core.admin.domain.AdminAccountPage
import ai.govbiz.core.admin.domain.AdminAccountQuery
import ai.govbiz.core.admin.domain.AdminAccountStats
import ai.govbiz.core.admin.domain.AdminAccountTarget
import ai.govbiz.core.admin.domain.AdminActor
import ai.govbiz.core.admin.domain.accessSummaryOf
import ai.govbiz.core.admin.repository.AdminAccountRepository
import ai.govbiz.core.admin.service.exception.AdminAccessDeniedException
import ai.govbiz.core.admin.service.exception.AdminAccountNotFoundException
import ai.govbiz.core.admin.service.exception.AdminAccountStateConflictException
import ai.govbiz.core.admin.service.exception.AdminLastActiveAdminException
import ai.govbiz.core.admin.service.exception.AdminSelfActionException
import ai.govbiz.core.admin.service.exception.AdminTargetProtectedException
import java.time.Clock
import java.time.LocalDateTime
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional

/**
 * 관리자가 계정을 찾아보고 정지·정지 해제·강제 로그아웃·권한 변경을 합니다. 관리자 확인은 Controller 파라미터
 * ([ai.govbiz.core.admin.web.AdminPrincipal])가 끝낸 뒤라 여기서는 대상 규칙만 봅니다. 조치는 대상 행을 잠근 한 transaction에서
 * 상태를 바꾸고 사유를 기록합니다.
 *
 * 회원 개인정보를 돌려주는 목록·상세 조회와 모든 조치는 [AdminAccessLogService]로 접속기록을 남깁니다. 조회는 결과를 돌려주기
 * 직전에, 조치는 같은 transaction 안에서 남기므로 기록하지 못하면 조회 결과를 내주지 않고 조치도 되돌립니다.
 *
 * 자기 계정과 다른 관리자 계정에는 정지·강제 로그아웃을 할 수 없습니다. 자기 권한도 바꿀 수 없고 처리한 관리자가 활성
 * 관리자로 남으므로, 정지나 권한 변경으로 관리자가 모두 사라지는 일도 없습니다.
 */
@Service
class AdminAccountService(
    private val repository: AdminAccountRepository,
    private val accountRepository: AccountRepository,
    private val accessLog: AdminAccessLogService,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {

    /** 요약 수치는 건수뿐이라 접속기록을 남기지 않습니다. */
    fun stats(): AdminAccountStats =
        repository.findStats(LocalDateTime.now(clock).minusDays(RECENT_JOIN_DAYS))

    /** 여러 회원을 한 번에 보므로 대상 계정 없이 조건 요약(검색어 원문 제외)과 돌려준 건수를 남깁니다. */
    fun findPage(actor: AdminActor, query: AdminAccountQuery): AdminAccountPage {
        val page = repository.findPage(query)
        accessLog.record(actor, AdminAccessAction.ACCOUNT_LIST, requestSummary = query.accessSummary(page.accounts.size))
        return page
    }

    /** 없는 계정(404)은 개인정보를 돌려주지 않으므로 남기지 않습니다. */
    fun detail(actor: AdminActor, accountId: Long): AdminAccountDetail {
        val detail = loadDetail(accountId)
        accessLog.record(actor, AdminAccessAction.ACCOUNT_DETAIL, targetAccountId = accountId)
        return detail
    }

    /** 정지하면 모든 세션을 지워 바로 로그아웃시킵니다. 정지된 계정은 로그인·세션 확인·비밀번호 재설정이 모두 막힙니다. */
    @Transactional
    fun suspend(actor: AdminActor, accountId: Long, reason: String): AdminAccountDetail {
        val normalizedReason = normalizeReason(reason)
        val target = lockTarget(actor, accountId)
        if (target.role == AccountRole.ADMIN) throw AdminTargetProtectedException()
        if (target.suspendedAt != null) throw AdminAccountStateConflictException()

        val now = LocalDateTime.now(clock)
        repository.updateSuspendedAt(accountId, now)
        accountRepository.deleteAllSessionsByAccountId(accountId)
        recordAction(actor, accountId, AdminAccountActionType.SUSPEND, normalizedReason, now)
        return loadDetail(accountId)
    }

    /** 정지를 풉니다. 지운 세션은 돌아오지 않으므로 회원은 다시 로그인합니다. */
    @Transactional
    fun unsuspend(actor: AdminActor, accountId: Long, reason: String): AdminAccountDetail {
        val normalizedReason = normalizeReason(reason)
        val target = lockTarget(actor, accountId)
        if (target.suspendedAt == null) throw AdminAccountStateConflictException()

        val now = LocalDateTime.now(clock)
        repository.updateSuspendedAt(accountId, null)
        recordAction(actor, accountId, AdminAccountActionType.UNSUSPEND, normalizedReason, now)
        return loadDetail(accountId)
    }

    /** 모든 기기의 세션을 지웁니다. 계정은 그대로라 다시 로그인할 수 있습니다. */
    @Transactional
    fun revokeSessions(actor: AdminActor, accountId: Long, reason: String): AdminAccountDetail {
        val normalizedReason = normalizeReason(reason)
        val target = lockTarget(actor, accountId)
        if (target.role == AccountRole.ADMIN) throw AdminTargetProtectedException()

        accountRepository.deleteAllSessionsByAccountId(accountId)
        recordAction(actor, accountId, AdminAccountActionType.SESSIONS_REVOKE, normalizedReason, LocalDateTime.now(clock))
        return loadDetail(accountId)
    }

    /**
     * 관리자 권한을 주거나 내립니다. 역할은 요청마다 DB에서 다시 읽으므로 대상의 다음 요청부터 바뀐 권한이 적용됩니다.
     *
     * 두 관리자가 서로의 권한을 동시에 내려 관리자가 모두 사라지지 않도록, 처리한 관리자와 대상 계정 행을 ID 순서로 잠근 뒤
     * 처리한 관리자가 아직 정지되지 않은 관리자인지 다시 확인합니다. 그래서 대상 권한을 내려도 처리한 관리자가 남지만,
     * 마지막 활성 관리자를 내리지 않는다는 규칙은 수를 세어 한 번 더 확인합니다.
     * 정지된 계정은 관리자로 올리지 않습니다. 정지를 먼저 풀어야 합니다.
     */
    @Transactional
    fun changeRole(actor: AdminActor, accountId: Long, role: AccountRole, reason: String): AdminAccountDetail {
        val normalizedReason = normalizeReason(reason)
        if (actor.accountId == accountId) throw AdminSelfActionException()
        val locked = listOf(actor.accountId, accountId).sorted().associateWith { repository.lockTarget(it) }
        if (locked[actor.accountId]?.isActiveAdmin != true) throw AdminAccessDeniedException()
        val target = locked[accountId] ?: throw AdminAccountNotFoundException()
        if (target.role == role) throw AdminAccountStateConflictException()
        if (role == AccountRole.ADMIN && target.suspendedAt != null) throw AdminAccountStateConflictException()
        if (target.isActiveAdmin && accountRepository.countActiveAdmins() <= 1) throw AdminLastActiveAdminException()

        val now = LocalDateTime.now(clock)
        repository.updateRole(accountId, role)
        val type = if (role == AccountRole.ADMIN) AdminAccountActionType.ADMIN_GRANT else AdminAccountActionType.ADMIN_REVOKE
        recordAction(actor, accountId, type, normalizedReason, now, roleChange = "${target.role}->$role")
        return loadDetail(accountId)
    }

    private fun loadDetail(accountId: Long): AdminAccountDetail {
        val account = repository.findSummary(accountId) ?: throw AdminAccountNotFoundException()
        val now = LocalDateTime.now(clock)
        return AdminAccountDetail(
            account = account,
            company = repository.findCompany(accountId),
            activity = repository.findActivity(accountId, now.toLocalDate(), now),
            actions = repository.findActions(accountId, ACTION_HISTORY_LIMIT),
        )
    }

    private fun lockTarget(actor: AdminActor, accountId: Long): AdminAccountTarget {
        if (actor.accountId == accountId) throw AdminSelfActionException()
        return repository.lockTarget(accountId) ?: throw AdminAccountNotFoundException()
    }

    /** 사유가 담긴 조치 기록과, 그 기록 번호를 가리키는 접속기록을 같은 transaction에서 남깁니다. */
    private fun recordAction(
        actor: AdminActor,
        accountId: Long,
        type: AdminAccountActionType,
        reason: String,
        createdAt: LocalDateTime,
        roleChange: String? = null,
    ) {
        val actionId = repository.recordAction(accountId, actor.accountId, type, reason, createdAt)
        val accessAction = when (type) {
            AdminAccountActionType.SUSPEND -> AdminAccessAction.ACCOUNT_SUSPEND
            AdminAccountActionType.UNSUSPEND -> AdminAccessAction.ACCOUNT_UNSUSPEND
            AdminAccountActionType.SESSIONS_REVOKE -> AdminAccessAction.ACCOUNT_SESSIONS_REVOKE
            AdminAccountActionType.ADMIN_GRANT -> AdminAccessAction.ACCOUNT_ADMIN_GRANT
            AdminAccountActionType.ADMIN_REVOKE -> AdminAccessAction.ACCOUNT_ADMIN_REVOKE
        }
        accessLog.record(
            actor,
            accessAction,
            targetAccountId = accountId,
            requestSummary = accessSummaryOf("role" to roleChange, "adminActionId" to actionId),
        )
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
