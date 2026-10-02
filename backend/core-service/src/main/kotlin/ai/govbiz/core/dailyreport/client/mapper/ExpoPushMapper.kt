package ai.govbiz.core.dailyreport.client.mapper

import ai.govbiz.core.dailyreport.client.dto.ExpoPushTicket
import ai.govbiz.core.dailyreport.domain.DailyReportPushOutcome

object ExpoPushMapper {
    fun fromTicket(ticket: ExpoPushTicket): DailyReportPushOutcome = when (ticket.status) {
        "ok" -> DailyReportPushOutcome("ACCEPTED", requireNotNull(ticket.id).also { require(it.length in 1..100) })
        "error" -> DailyReportPushOutcome("FAILED", errorCode = stableError(ticket.details?.error))
        else -> error("Invalid Expo push status")
    }

    fun fromReceipt(receipt: ExpoPushTicket): DailyReportPushOutcome = when (receipt.status) {
        "ok" -> DailyReportPushOutcome("DELIVERED")
        "error" -> DailyReportPushOutcome("FAILED", errorCode = stableError(receipt.details?.error))
        else -> error("Invalid Expo receipt status")
    }

    private fun stableError(code: String?) = code?.takeIf { Regex("[A-Za-z]{1,100}").matches(it) } ?: "PushRejected"
}
