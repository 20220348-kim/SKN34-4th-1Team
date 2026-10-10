package ai.govbiz.core.planusage.controller.dto

import jakarta.validation.constraints.Pattern

/** 시작할 출시 전 무료 체험 요금제입니다. 플러스와 프리미엄만 체험할 수 있습니다. */
data class StartPlanTrialRequest(
    @field:Pattern(regexp = "PLUS|PREMIUM")
    val plan: String,
)
