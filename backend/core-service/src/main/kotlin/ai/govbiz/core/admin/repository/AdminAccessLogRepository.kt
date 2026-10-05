package ai.govbiz.core.admin.repository

import ai.govbiz.core.admin.domain.AdminAccessAction
import ai.govbiz.core.admin.domain.AdminAccessLog
import ai.govbiz.core.admin.domain.AdminAccessLogPage
import ai.govbiz.core.admin.domain.AdminAccessLogQuery
import ai.govbiz.core.admin.domain.NewAdminAccessLog
import ai.govbiz.core.admin.repository.mapper.AdminAccessLogDbRow
import ai.govbiz.core.admin.repository.mapper.AdminAccessLogMapper
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional

/**
 * 관리자 접속기록을 MySQL에 추가하고 최신순으로 읽습니다. 추가만 하는 기록이라 고치거나 지우는 메서드는 없습니다.
 * 조치 transaction 안에서 부르면 같은 transaction에 묶여 조치가 되돌려지면 기록도 함께 되돌려집니다.
 */
@Repository
class AdminAccessLogRepository(
    private val mapper: AdminAccessLogMapper,
) {

    @Transactional
    fun insert(log: NewAdminAccessLog) {
        val inserted = mapper.insertLog(
            AdminAccessLogDbRow(
                actorAccountId = log.actor.accountId,
                action = log.action.name,
                targetAccountId = log.targetAccountId,
                requestSummary = log.requestSummary,
                clientIp = log.actor.clientIp,
                userAgent = log.actor.userAgent,
                createdAt = log.createdAt,
            ),
        )
        check(inserted == 1) { "admin access log row was not created" }
    }

    /** 기간은 서울 기준 날짜이며 끝 날은 다음 날 0시 전까지입니다. 한 건 더 읽어 다음 쪽이 있는지 정합니다. */
    fun findPage(query: AdminAccessLogQuery): AdminAccessLogPage {
        val rows = mapper.findLogs(
            actorAccountId = query.actorAccountId,
            targetAccountId = query.targetAccountId,
            action = query.action?.name,
            createdFrom = query.from?.atStartOfDay(),
            createdBefore = query.to?.plusDays(1)?.atStartOfDay(),
            beforeId = query.before,
            limit = query.limit + 1,
        )
        val records = rows.take(query.limit).map { it.toLog() }
        return AdminAccessLogPage(records, if (rows.size > query.limit) records.last().id else null)
    }

    private fun AdminAccessLogDbRow.toLog(): AdminAccessLog =
        AdminAccessLog(
            id = id,
            actorAccountId = actorAccountId,
            actorEmail = actorEmail,
            action = AdminAccessAction.valueOf(action),
            targetAccountId = targetAccountId,
            requestSummary = requestSummary,
            clientIp = clientIp,
            userAgent = userAgent,
            createdAt = requireNotNull(createdAt) { "access log createdAt must not be null" },
        )
}
