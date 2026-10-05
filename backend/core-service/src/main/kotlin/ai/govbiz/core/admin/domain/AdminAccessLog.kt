package ai.govbiz.core.admin.domain

import java.time.LocalDate
import java.time.LocalDateTime

/** 관리자 접속기록의 수행업무입니다. DB CHECK 제약과 같은 값입니다. */
enum class AdminAccessAction {
    /** 회원 목록 조회·검색입니다. 여러 회원을 보므로 대상 계정 없이 조건 요약과 건수를 남깁니다. */
    ACCOUNT_LIST,
    ACCOUNT_DETAIL,
    ACCOUNT_SUSPEND,
    ACCOUNT_UNSUSPEND,
    ACCOUNT_SESSIONS_REVOKE,
    ACCOUNT_ADMIN_GRANT,
    ACCOUNT_ADMIN_REVOKE,
    /** 감사 기록 조회입니다. 기록에도 관리자 이메일과 접속지가 있으므로 이 조회도 남깁니다. */
    AUDIT_LOG_LIST,
}

/**
 * 관리자 요청을 보낸 처리자와 접속지입니다. 접속 주소는 다른 기능처럼 Tomcat이 정한 `remoteAddr`이며, 운영에서는
 * 신뢰하도록 지정한 Nginx 한 곳의 전달 헤더만 반영됩니다. 클라이언트가 보낸 전달 헤더를 여기서 따로 읽지 않습니다.
 */
data class AdminActor(
    val accountId: Long,
    val clientIp: String,
    /** 브라우저가 보낸 User-Agent를 [MAX_USER_AGENT_LENGTH]자까지 자른 값입니다. 보내지 않았으면 null입니다. */
    val userAgent: String?,
) {
    init {
        require(accountId > 0) { "accountId must be positive" }
        require(clientIp.isNotBlank() && clientIp.length <= MAX_CLIENT_IP_LENGTH) {
            "clientIp must be a non-blank text of at most $MAX_CLIENT_IP_LENGTH characters"
        }
        require(userAgent == null || (userAgent.isNotBlank() && userAgent.length <= MAX_USER_AGENT_LENGTH)) {
            "userAgent must be null or a non-blank text of at most $MAX_USER_AGENT_LENGTH characters"
        }
    }

    companion object {
        const val MAX_CLIENT_IP_LENGTH = 64
        const val MAX_USER_AGENT_LENGTH = 255

        /** 접속 주소가 비어 있을 때 남기는 값입니다. 실제 HTTP 요청에는 항상 주소가 있습니다. */
        const val UNKNOWN_CLIENT_IP = "unknown"

        /** 요청에서 읽은 값을 DB 칸에 맞춥니다. 주소가 비면 [UNKNOWN_CLIENT_IP]이고, 긴 값은 앞쪽만 남깁니다. */
        fun of(accountId: Long, clientIp: String?, userAgent: String?): AdminActor =
            AdminActor(
                accountId = accountId,
                clientIp = clientIp.trimmedOrNull()?.let { truncate(it, MAX_CLIENT_IP_LENGTH) } ?: UNKNOWN_CLIENT_IP,
                userAgent = userAgent.trimmedOrNull()?.let { truncate(it, MAX_USER_AGENT_LENGTH) },
            )

        private fun String?.trimmedOrNull(): String? = this?.trim()?.takeIf { it.isNotEmpty() }

        /** 이모지처럼 두 칸을 쓰는 문자를 반으로 나누지 않도록 자릅니다. */
        private fun truncate(value: String, maxLength: Int): String {
            if (value.length <= maxLength) return value
            val end = if (Character.isHighSurrogate(value[maxLength - 1])) maxLength - 1 else maxLength
            return value.substring(0, end)
        }
    }
}

/** 새로 남길 접속기록 한 건입니다. */
data class NewAdminAccessLog(
    val actor: AdminActor,
    val action: AdminAccessAction,
    /** 처리한 정보주체 한 명입니다. 목록처럼 여러 회원을 본 요청은 null이고 조건은 [requestSummary]에 남습니다. */
    val targetAccountId: Long?,
    /** 개인정보 원문 없이 조건 이름·건수·조치 기록 번호만 담은 요약입니다. */
    val requestSummary: String?,
    val createdAt: LocalDateTime,
) {
    init {
        require(targetAccountId == null || targetAccountId > 0) { "targetAccountId must be positive" }
        require(requestSummary == null || requestSummary.length in 1..MAX_REQUEST_SUMMARY_LENGTH) {
            "requestSummary must be 1~$MAX_REQUEST_SUMMARY_LENGTH characters"
        }
    }

    companion object {
        const val MAX_REQUEST_SUMMARY_LENGTH = 500
    }
}

/** 저장된 접속기록 한 건입니다. 처리자 계정 행이 없어졌으면 이메일은 null입니다. */
data class AdminAccessLog(
    val id: Long,
    val actorAccountId: Long,
    val actorEmail: String?,
    val action: AdminAccessAction,
    val targetAccountId: Long?,
    val requestSummary: String?,
    val clientIp: String,
    val userAgent: String?,
    val createdAt: LocalDateTime,
)

/**
 * 감사 기록 조건입니다. 비운 조건은 전체이고 기간은 서울 기준 날짜로 [from]부터 [to]까지(끝 날 포함)입니다.
 * [from]이 [to]보다 늦으면 맞는 기록이 없습니다. 최신 기록부터 [limit]건씩 읽고, 다음 쪽은 [before]보다 작은 ID입니다.
 */
data class AdminAccessLogQuery(
    val actorAccountId: Long?,
    val targetAccountId: Long?,
    val action: AdminAccessAction?,
    val from: LocalDate?,
    val to: LocalDate?,
    val before: Long?,
    val limit: Int,
) {
    init {
        require(listOfNotNull(actorAccountId, targetAccountId, before).all { it > 0 }) { "ids must be positive" }
        require(limit in 1..MAX_LIMIT) { "limit must be 1~$MAX_LIMIT" }
    }

    /** 이 조회를 접속기록에 남길 때의 요약입니다. 고른 조건과 돌려준 건수만 담습니다. */
    fun accessSummary(returned: Int): String =
        accessSummaryOf(
            "actorAccountId" to actorAccountId,
            "targetAccountId" to targetAccountId,
            "action" to action,
            "from" to from,
            "to" to to,
            "before" to before,
            "limit" to limit,
            "returned" to returned,
        )

    companion object {
        const val MAX_LIMIT = 50
    }
}

data class AdminAccessLogPage(
    val records: List<AdminAccessLog>,
    /** 더 오래된 기록이 있으면 다음 요청의 `before`로 쓸 ID입니다. 없으면 null입니다. */
    val nextCursor: Long?,
)

/** 접속기록 요청 요약을 `이름=값` 쌍을 쉼표로 이은 글로 만듭니다. 값이 null인 조건은 고르지 않은 것이라 뺍니다. */
internal fun accessSummaryOf(vararg pairs: Pair<String, Any?>): String =
    pairs.filter { it.second != null }.joinToString(", ") { (name, value) -> "$name=$value" }
