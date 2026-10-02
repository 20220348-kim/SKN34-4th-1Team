package ai.govbiz.core.dailyreport.client.dto

data class ExpoPushDetails(val error: String? = null)
data class ExpoPushTicket(val status: String, val id: String? = null, val details: ExpoPushDetails? = null)
data class ExpoPushSendResponse(val data: ExpoPushTicket? = null)
data class ExpoPushReceiptResponse(val data: Map<String, ExpoPushTicket> = emptyMap())
