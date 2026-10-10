package ai.govbiz.core.planusage.service.dto

import ai.govbiz.core.planusage.domain.PlanCode
import ai.govbiz.core.planusage.domain.PlanSource
import ai.govbiz.core.planusage.domain.PlanUsageFeature
import ai.govbiz.core.planusage.domain.PlanUsagePeriod
import java.time.ZonedDateTime

/**
 * 현재 요금제와 기능별 사용량입니다. 로그인하지 않았으면 [plan]이 null이고 체험 기능만 담습니다.
 * [planEndsAt]은 유료 이용권이 끝나는 때이며, 무료이거나 끝나는 때가 없는 배정이면 null입니다.
 * [planSource]는 유료 배정을 누가 했는지(운영자·출시 전 체험)이고, [trialsAvailable]은 지금 시작할 수 있는 무료 체험입니다.
 */
data class PlanUsageResult(
    val plan: PlanCode?,
    val planEndsAt: ZonedDateTime?,
    val items: List<PlanUsageItem>,
    val planSource: PlanSource? = null,
    val trialsAvailable: List<PlanCode> = emptyList(),
)

/**
 * 한 기능의 이번 기간 사용량입니다. [limit]이 null이면 개발용 무제한 계정이라 막지 않습니다.
 * 작업으로 세는 기능의 [used]에는 진행 중인 작업도 들어갑니다.
 */
data class PlanUsageItem(
    val feature: PlanUsageFeature,
    val period: PlanUsagePeriod,
    val limit: Int?,
    val used: Int,
    val resetsAt: ZonedDateTime,
)
