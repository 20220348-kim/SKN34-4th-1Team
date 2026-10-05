package ai.govbiz.core.dailyreport.client

import ai.govbiz.core.dailyreport.client.dto.*
import ai.govbiz.core.dailyreport.client.mapper.ExpoPushMapper
import ai.govbiz.core.dailyreport.client.exception.DailyReportPushException
import ai.govbiz.core.dailyreport.domain.DailyReportPushDelivery
import ai.govbiz.core.dailyreport.domain.DailyReportPushOutcome
import java.time.LocalDate
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.http.MediaType
import org.springframework.stereotype.Component
import org.springframework.web.client.RestClient

/** Expo Push Service 발송 경계입니다. 맞춤 리포트와 관심 공고 마감 알림이 같은 접수·오류 변환을 씁니다. */
@Component
class DailyReportPushClient(@param:Qualifier("dailyReportPushRestClient") private val http: RestClient) {
    fun send(delivery: DailyReportPushDelivery): DailyReportPushOutcome = sendMessage(mapOf(
        "to" to delivery.expoToken, "title" to "오늘의 맞춤 리포트가 도착했어요",
        "body" to "${delivery.reportDate} 지원사업 리포트를 확인해 보세요.", "sound" to "default",
        "channelId" to "daily-reports", "ttl" to 3600,
        "data" to mapOf("type" to "daily-report", "reportId" to delivery.reportId.toString(),
            "reportDate" to delivery.reportDate.toString())))

    /** 공고 제목·마감일과 공고 식별자만 보냅니다. 앱은 식별자로 공고 상세를 열고 임의 URL은 열지 않습니다. */
    fun sendDeadlineReminder(
        token: String, programTitle: String, sourceCode: String, sourceProgramId: String, dueDate: LocalDate, daysLeft: Int,
    ): DailyReportPushOutcome {
        require(daysLeft >= 0) { "daysLeft must not be negative" }
        val title = programTitle.map { if (it.isISOControl()) ' ' else it }.joinToString("").trim()
        return sendMessage(mapOf(
            "to" to token, "title" to "관심 공고 마감 D-$daysLeft",
            "body" to "${shorten(title, 80)} · ${dueDate.monthValue}월 ${dueDate.dayOfMonth}일 마감", "sound" to "default",
            "channelId" to "deadline-reminders", "ttl" to 43_200,
            "data" to mapOf("type" to "deadline-reminder", "sourceCode" to sourceCode,
                "sourceProgramId" to sourceProgramId, "dueDate" to dueDate.toString())))
    }

    fun receipt(ticketId: String): DailyReportPushOutcome? = try {
        val response = requireNotNull(http.post().uri("/--/api/v2/push/getReceipts").contentType(MediaType.APPLICATION_JSON)
            .body(mapOf("ids" to listOf(ticketId))).retrieve().body(ExpoPushReceiptResponse::class.java))
        response.data[ticketId]?.let(ExpoPushMapper::fromReceipt)
    } catch (_: Exception) { throw DailyReportPushException() }

    private fun sendMessage(message: Map<String, Any>): DailyReportPushOutcome = try {
        val response = http.post().uri("/--/api/v2/push/send").contentType(MediaType.APPLICATION_JSON)
            .body(message).retrieve().body(ExpoPushSendResponse::class.java)
        ExpoPushMapper.fromTicket(requireNotNull(response?.data))
    } catch (_: Exception) { throw DailyReportPushException() }

    private fun shorten(value: String, maxCodePoints: Int): String =
        if (value.codePointCount(0, value.length) <= maxCodePoints) value
        else value.substring(0, value.offsetByCodePoints(0, maxCodePoints)) + "…"
}
