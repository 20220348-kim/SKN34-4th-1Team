package ai.govbiz.core.planusage.controller.dto

import ai.govbiz.core.planusage.service.dto.PlanUsageItem
import ai.govbiz.core.planusage.service.dto.PlanUsageResult
import java.time.format.DateTimeFormatter

/**
 * 현재 요금제와 기능별 사용량입니다. 로그인하지 않았으면 `plan`이 null이고 AI 대화 검색 체험만 담습니다.
 * `planEndsAt`은 유료 이용권이 끝나는 서울 시각(+09:00)이며, 무료이거나 끝나는 때가 없는 배정이면 null입니다.
 * `planSource`는 OPERATOR(운영자 배정)·TRIAL(출시 전 무료 체험)이고 무료면 null, `trialsAvailable`은 지금 시작할 수 있는 체험입니다.
 */
data class PlanUsageResponse(
    val plan: String?,
    val planEndsAt: String?,
    val planSource: String?,
    val trialsAvailable: List<String>,
    val items: List<PlanUsageItemResponse>,
) {
    companion object {
        fun from(result: PlanUsageResult) = PlanUsageResponse(
            result.plan?.name,
            result.planEndsAt?.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME),
            result.planSource?.name,
            result.trialsAvailable.map { it.name },
            result.items.map(PlanUsageItemResponse::from),
        )
    }
}

/**
 * 한 기능의 이번 기간 사용량입니다. `period`는 DAY(서울 하루)·MONTH(서울 달)·PLAN(유료 이용 기간)이고,
 * `resetsAt`은 서울 시각(+09:00)으로 이번 기간이 끝나는 때입니다. `limit`이 null이면 개발용 무제한 계정입니다.
 */
data class PlanUsageItemResponse(
    val feature: String,
    val period: String,
    val limit: Int?,
    val used: Int,
    val resetsAt: String,
) {
    companion object {
        fun from(item: PlanUsageItem) = PlanUsageItemResponse(
            item.feature.name, item.period.name, item.limit, item.used,
            item.resetsAt.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME),
        )
    }
}
