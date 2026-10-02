package ai.govbiz.core.dailyreport.controller.dto

import ai.govbiz.core.dailyreport.service.dto.DailyReportPushSettingsResult

data class DailyReportPushSettingsResponse(val enabled: Boolean, val available: Boolean, val sendHour: Int, val schedulerEnabled: Boolean) {
    companion object {
        fun from(result: DailyReportPushSettingsResult) = DailyReportPushSettingsResponse(
            result.enabled, result.available, result.sendHour, result.schedulerEnabled)
    }
}
