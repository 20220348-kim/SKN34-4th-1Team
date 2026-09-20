package ai.govbiz.core.dailyreport.repository.mapper

import java.time.LocalDate
import java.time.LocalDateTime

data class DailyReportDbRow(
    var id: Long = 0, var accountId: Long = 0, var reportDate: LocalDate? = null,
    var status: String = "GENERATING", var deliveryStatus: String = "NOT_REQUESTED",
    var inputJson: String = "{}", var contentJson: String? = null, var errorMessage: String? = null,
    var generationAttempts: Int = 1, var generationKey: String = "", var startedAt: LocalDateTime? = null,
    var generatedAt: LocalDateTime? = null,
)

data class DailyReportSubscriptionDbRow(
    var accountId: Long = 0, var supportPurpose: String = "", var enabled: Boolean = false,
    var confirmedEmail: String? = null, var confirmedAt: LocalDateTime? = null, var consentAt: LocalDateTime? = null,
)
