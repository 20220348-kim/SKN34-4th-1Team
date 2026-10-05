package ai.govbiz.core.admin.repository.mapper

import java.time.LocalDateTime

/** 접속기록 한 행입니다. INSERT에서는 처리자 이메일을 쓰지 않고, 조회에서만 계정을 LEFT JOIN해 채웁니다. */
data class AdminAccessLogDbRow(
    var id: Long = 0,
    var actorAccountId: Long = 0,
    var actorEmail: String? = null,
    var action: String = "",
    var targetAccountId: Long? = null,
    var requestSummary: String? = null,
    var clientIp: String = "",
    var userAgent: String? = null,
    var createdAt: LocalDateTime? = null,
)
