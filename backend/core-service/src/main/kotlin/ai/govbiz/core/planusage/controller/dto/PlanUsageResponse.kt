package ai.govbiz.core.planusage.controller.dto

import ai.govbiz.core.planusage.service.dto.PlanUsageItem
import ai.govbiz.core.planusage.service.dto.PlanUsageResult
import java.time.format.DateTimeFormatter

/** 현재 요금제와 기능별 사용량입니다. 로그인하지 않았으면 `plan`이 null이고 AI 대화 검색 체험만 담습니다. */
data class PlanUsageResponse(val plan: String?, val items: List<PlanUsageItemResponse>) {
    companion object {
        fun from(result: PlanUsageResult) = PlanUsageResponse(result.plan?.name, result.items.map(PlanUsageItemResponse::from))
    }
}

/** 한 기능의 이번 기간 사용량입니다. `limit`이 null이면 아직 한도가 없어 제한하지 않고, `resetsAt`은 서울 시각(+09:00)의 다음 초기화 시각입니다. */
data class PlanUsageItemResponse(
    val feature: String,
    val period: String,
    val limit: Int?,
    val used: Int,
    val resetsAt: String,
) {
    companion object {
        fun from(item: PlanUsageItem) = PlanUsageItemResponse(
            item.feature.name, item.feature.period.name, item.limit, item.used,
            item.resetsAt.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME),
        )
    }
}
