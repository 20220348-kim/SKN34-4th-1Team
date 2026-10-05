package ai.govbiz.core.dailyreport.client

import ai.govbiz.core.dailyreport.client.exception.DailyReportPushException
import ai.govbiz.core.dailyreport.domain.DailyReportPushDelivery
import java.time.LocalDate
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.springframework.http.MediaType
import org.springframework.test.web.client.MockRestServiceServer
import org.springframework.test.web.client.match.MockRestRequestMatchers.*
import org.springframework.test.web.client.response.MockRestResponseCreators.*
import org.springframework.web.client.RestClient

class DailyReportPushClientTest {
    private val builder = RestClient.builder().baseUrl("https://exp.host")
    private val server = MockRestServiceServer.bindTo(builder).build()
    private val client = DailyReportPushClient(builder.build())
    private val delivery = DailyReportPushDelivery(1, 2, "device", "ExpoPushToken[test]", LocalDate.of(2026, 10, 2), null)

    @Test
    fun sendsOnlyReportIdentityAndGenericNoticeThenMapsProviderReceipt() {
        server.expect(requestTo("https://exp.host/--/api/v2/push/send"))
            .andExpect(jsonPath("$.data.reportId").value("2"))
            .andExpect(jsonPath("$.channelId").value("daily-reports"))
            .andExpect(jsonPath("$.data.accountId").doesNotExist())
            .andRespond(withSuccess("""{"data":{"status":"ok","id":"ticket"}}""", MediaType.APPLICATION_JSON))
        server.expect(requestTo("https://exp.host/--/api/v2/push/getReceipts"))
            .andRespond(withSuccess("""{"data":{"ticket":{"status":"error","details":{"error":"DeviceNotRegistered"}}}}""", MediaType.APPLICATION_JSON))
        val result = client.send(delivery)
        assertEquals("ACCEPTED", result.status)
        assertEquals("DeviceNotRegistered", client.receipt(requireNotNull(result.ticketId))?.errorCode)
        server.verify()
    }

    @Test
    fun deadlineReminderSendsOnlyTitleDeadlineAndProgramIdentityOnItsOwnChannel() {
        server.expect(requestTo("https://exp.host/--/api/v2/push/send"))
            .andExpect(jsonPath("$.to").value("ExpoPushToken[test]"))
            .andExpect(jsonPath("$.title").value("관심 공고 마감 D-3"))
            .andExpect(jsonPath("$.body").value("AI 바우처 지원사업 · 10월 5일 마감"))
            .andExpect(jsonPath("$.channelId").value("deadline-reminders"))
            .andExpect(jsonPath("$.data.type").value("deadline-reminder"))
            .andExpect(jsonPath("$.data.sourceCode").value("BIZINFO"))
            .andExpect(jsonPath("$.data.sourceProgramId").value("PBLN_1"))
            .andExpect(jsonPath("$.data.dueDate").value("2026-10-05"))
            .andExpect(jsonPath("$.data.url").doesNotExist())
            .andExpect(jsonPath("$.data.accountId").doesNotExist())
            .andRespond(withSuccess("""{"data":{"status":"error","details":{"error":"DeviceNotRegistered"}}}""", MediaType.APPLICATION_JSON))
        val result = client.sendDeadlineReminder("ExpoPushToken[test]", "AI 바우처\n지원사업", "BIZINFO", "PBLN_1", LocalDate.of(2026, 10, 5), 3)
        assertEquals("FAILED", result.status)
        assertEquals("DeviceNotRegistered", result.errorCode)
        server.verify()
    }

    @Test
    fun invalidResponseIsAnExplicitFailureAndCannotAppearDelivered() {
        server.expect(requestTo("https://exp.host/--/api/v2/push/send"))
            .andRespond(withSuccess("""{"data":{"status":"ok"}}""", MediaType.APPLICATION_JSON))
        assertThrows(DailyReportPushException::class.java) { client.send(delivery) }
        server.verify()
    }
}
