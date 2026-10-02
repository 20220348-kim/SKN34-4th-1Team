package ai.govbiz.core.dailyreport.domain

import java.time.LocalDate

data class DailyReportPushDelivery(
    val id: Long, val reportId: Long, val deviceId: String, val expoToken: String,
    val reportDate: LocalDate, val ticketId: String?,
)
data class DailyReportPushOutcome(val status: String, val ticketId: String? = null, val errorCode: String? = null)
