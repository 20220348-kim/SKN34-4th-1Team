package ai.govbiz.core.planusage.service.exception

import ai.govbiz.core.planusage.domain.PlanCode
import ai.govbiz.core.planusage.domain.PlanUsageFeature
import ai.govbiz.core.planusage.domain.PlanUsagePeriod
import java.time.ZonedDateTime

/**
 * 요금제 한도를 다 썼습니다. [plan]이 null이면 로그인하지 않은 체험 한도이고, [period]는 다 쓴 기간(하루·달·유료 이용 기간)입니다.
 * [retryAfterSeconds]는 다음 초기화까지 남은 초이며 분당 요청 제한(`SUPPORT_PROGRAM_RATE_LIMITED`)과 다른 응답으로 나갑니다.
 */
class PlanQuotaExceededException(
    val feature: PlanUsageFeature,
    val period: PlanUsagePeriod,
    val plan: PlanCode?,
    val limit: Int,
    val used: Int,
    val resetsAt: ZonedDateTime,
    val retryAfterSeconds: Long,
) : RuntimeException("The $feature plan quota has been reached.")
