package ai.govbiz.core.dailyreport.controller.dto

import jakarta.validation.constraints.Pattern
import jakarta.validation.constraints.Size

data class DailyReportSettingsRequest(
    @field:Size(max = 100) @field:Pattern(regexp = "[^\\p{C}]*") val supportPurpose: String,
    val enabled: Boolean,
    val consent: Boolean,
)
data class DailyReportEmailTokenRequest(@field:Pattern(regexp = "[A-Za-z0-9_-]{43}") val token: String)
