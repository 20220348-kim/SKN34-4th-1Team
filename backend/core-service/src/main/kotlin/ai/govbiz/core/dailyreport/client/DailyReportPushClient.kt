package ai.govbiz.core.dailyreport.client

import ai.govbiz.core.dailyreport.client.dto.*
import ai.govbiz.core.dailyreport.client.mapper.ExpoPushMapper
import ai.govbiz.core.dailyreport.client.exception.DailyReportPushException
import ai.govbiz.core.dailyreport.domain.DailyReportPushDelivery
import ai.govbiz.core.dailyreport.domain.DailyReportPushOutcome
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.http.MediaType
import org.springframework.stereotype.Component
import org.springframework.web.client.RestClient

@Component
class DailyReportPushClient(@param:Qualifier("dailyReportPushRestClient") private val http: RestClient) {
    fun send(delivery: DailyReportPushDelivery): DailyReportPushOutcome = try {
        val response = http.post().uri("/--/api/v2/push/send").contentType(MediaType.APPLICATION_JSON)
            .body(mapOf("to" to delivery.expoToken, "title" to "오늘의 맞춤 리포트가 도착했어요",
                "body" to "${delivery.reportDate} 지원사업 리포트를 확인해 보세요.", "sound" to "default",
                "channelId" to "daily-reports", "ttl" to 3600,
                "data" to mapOf("type" to "daily-report", "reportId" to delivery.reportId.toString(),
                    "reportDate" to delivery.reportDate.toString())))
            .retrieve().body(ExpoPushSendResponse::class.java)
        ExpoPushMapper.fromTicket(requireNotNull(response?.data))
    } catch (_: Exception) { throw DailyReportPushException() }

    fun receipt(ticketId: String): DailyReportPushOutcome? = try {
        val response = requireNotNull(http.post().uri("/--/api/v2/push/getReceipts").contentType(MediaType.APPLICATION_JSON)
            .body(mapOf("ids" to listOf(ticketId))).retrieve().body(ExpoPushReceiptResponse::class.java))
        response.data[ticketId]?.let(ExpoPushMapper::fromReceipt)
    } catch (_: Exception) { throw DailyReportPushException() }
}
