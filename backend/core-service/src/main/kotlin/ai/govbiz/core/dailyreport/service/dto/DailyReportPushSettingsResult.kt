package ai.govbiz.core.dailyreport.service.dto

data class DailyReportPushSettingsResult(val enabled: Boolean, val available: Boolean, val sendHour: Int, val schedulerEnabled: Boolean)
