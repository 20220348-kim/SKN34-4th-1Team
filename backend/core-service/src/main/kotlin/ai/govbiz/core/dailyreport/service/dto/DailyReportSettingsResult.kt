package ai.govbiz.core.dailyreport.service.dto

data class DailyReportSettingsResult(
    val supportPurpose: String, val enabled: Boolean, val emailConfirmed: Boolean,
    val emailDeliveryAvailable: Boolean, val sendHour: Int, val schedulerEnabled: Boolean,
)
