package ai.govbiz.core.admin.service

import ai.govbiz.core.admin.domain.AdminAccessAction
import ai.govbiz.core.admin.domain.AdminAccessLogPage
import ai.govbiz.core.admin.domain.AdminAccessLogQuery
import ai.govbiz.core.admin.domain.AdminActor
import ai.govbiz.core.admin.domain.NewAdminAccessLog
import ai.govbiz.core.admin.repository.AdminAccessLogRepository
import ai.govbiz.core.admin.service.exception.AdminAccessLogUnavailableException
import java.time.Clock
import java.time.LocalDateTime
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.dao.DataAccessException
import org.springframework.stereotype.Service

/**
 * 관리자 접속기록(감사 기록)을 남기고 보여 줍니다. 회원 개인정보를 돌려주는 조회는 응답 전에, 계정 조치는 같은 transaction
 * 안에서 [record]를 부릅니다. 기록을 남기지 못하면 503으로 요청 전체를 실패시켜, 기록되지 않은 조회·조치가 생기지 않게 합니다.
 */
@Service
class AdminAccessLogService(
    private val repository: AdminAccessLogRepository,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    /** 접속기록 한 건을 남깁니다. 조치 transaction 안에서 부르면 실패할 때 조치도 함께 되돌려집니다. */
    fun record(
        actor: AdminActor,
        action: AdminAccessAction,
        targetAccountId: Long? = null,
        requestSummary: String? = null,
    ) {
        val entry = NewAdminAccessLog(actor, action, targetAccountId, requestSummary, LocalDateTime.now(clock))
        try {
            repository.insert(entry)
        } catch (exception: DataAccessException) {
            log.warn(
                "admin_access_log_write_failed action={} actorAccountId={} rootException={}",
                action,
                actor.accountId,
                exception.mostSpecificCause.javaClass.simpleName,
            )
            throw AdminAccessLogUnavailableException(exception)
        }
    }

    /** 감사 기록을 최신순으로 읽습니다. 기록에도 관리자 이메일과 접속지가 있으므로 돌려주기 전에 이 조회도 남깁니다. */
    fun findPage(actor: AdminActor, query: AdminAccessLogQuery): AdminAccessLogPage {
        val page = repository.findPage(query)
        record(actor, AdminAccessAction.AUDIT_LOG_LIST, requestSummary = query.accessSummary(page.records.size))
        return page
    }
}
