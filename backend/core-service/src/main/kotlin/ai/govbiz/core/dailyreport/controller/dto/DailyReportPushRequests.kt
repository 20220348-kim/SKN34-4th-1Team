package ai.govbiz.core.dailyreport.controller.dto

import jakarta.validation.constraints.Pattern
import jakarta.validation.constraints.Size

data class DailyReportPushRequest(
    @field:Pattern(regexp = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}") val deviceId: String,
    @field:Size(max = 200) @field:Pattern(regexp = "(?:Expo|Exponent)PushToken\\[[A-Za-z0-9_-]{1,160}\\]") val token: String,
)
