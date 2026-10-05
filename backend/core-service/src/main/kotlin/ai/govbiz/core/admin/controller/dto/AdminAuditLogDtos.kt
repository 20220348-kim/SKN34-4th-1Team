package ai.govbiz.core.admin.controller.dto

import ai.govbiz.core.admin.domain.AdminAccessAction
import ai.govbiz.core.admin.domain.AdminAccessLog
import ai.govbiz.core.admin.domain.AdminAccessLogPage
import java.time.format.DateTimeFormatter

/**
 * 감사 기록 한 건입니다. 처리자는 계정 ID와 지금의 이메일(계정 행이 없으면 null), 대상은 계정 ID만 보여 줍니다.
 * 시각은 계정 관리 응답과 같은 서울 기준 ISO 로컬 시각 문자열입니다.
 */
data class AdminAuditLogResponse(
    val id: Long,
    val action: AdminAccessAction,
    val actorAccountId: Long,
    val actorEmail: String?,
    val targetAccountId: Long?,
    val requestSummary: String?,
    val clientIp: String,
    val userAgent: String?,
    val createdAt: String,
) {
    companion object {
        fun from(log: AdminAccessLog): AdminAuditLogResponse =
            AdminAuditLogResponse(
                id = log.id,
                action = log.action,
                actorAccountId = log.actorAccountId,
                actorEmail = log.actorEmail,
                targetAccountId = log.targetAccountId,
                requestSummary = log.requestSummary,
                clientIp = log.clientIp,
                userAgent = log.userAgent,
                createdAt = log.createdAt.format(DateTimeFormatter.ISO_LOCAL_DATE_TIME),
            )
    }
}

/** 최신순 한 쪽입니다. `nextCursor`가 있으면 다음 요청의 `before`로 보내 더 오래된 기록을 읽습니다. */
data class AdminAuditLogListResponse(
    val records: List<AdminAuditLogResponse>,
    val nextCursor: Long?,
) {
    companion object {
        fun from(page: AdminAccessLogPage): AdminAuditLogListResponse =
            AdminAuditLogListResponse(page.records.map(AdminAuditLogResponse::from), page.nextCursor)
    }
}
