package ai.govbiz.core.planusage.controller.dto

import ai.govbiz.core.planusage.service.dto.PlanUsageResult

/** 현재 요금제입니다. 로그인하지 않았으면 `plan`이 null입니다. */
data class PlanUsageResponse(val plan: String?) {
    companion object {
        fun from(result: PlanUsageResult) = PlanUsageResponse(result.plan?.name)
    }
}
