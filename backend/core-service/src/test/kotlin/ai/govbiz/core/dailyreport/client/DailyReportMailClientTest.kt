package ai.govbiz.core.dailyreport.client

import ai.govbiz.core.dailyreport.client.exception.DailyReportMailException
import ai.govbiz.core.dailyreport.config.DailyReportProperties
import jakarta.mail.Session
import jakarta.mail.internet.MimeMessage
import java.time.LocalDate
import java.util.Properties
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.mockito.ArgumentMatchers.any
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.doThrow
import org.mockito.Mockito.mock
import org.mockito.Mockito.verifyNoInteractions
import org.springframework.beans.factory.support.StaticListableBeanFactory
import org.springframework.mail.MailSendException
import org.springframework.mail.javamail.JavaMailSender
import org.springframework.mail.javamail.JavaMailSenderImpl

class DailyReportMailClientTest {
    private val token = "a".repeat(43)
    private val sender = mock(JavaMailSender::class.java)
    private val message = MimeMessage(Session.getInstance(Properties()))

    @Test
    fun disabledClientNeverCreatesOrSendsAMessage() {
        val client = client(DailyReportProperties())
        assertFalse(client.isAvailable())
        assertThrows(DailyReportMailException::class.java) { client.sendVerification("member@example.org", token) }
        verifyNoInteractions(sender)
    }

    @Test
    fun enabledWithoutSenderOrHostIsUnavailable() {
        val empty = StaticListableBeanFactory().getBeanProvider(JavaMailSender::class.java)
        assertFalse(DailyReportMailClient(properties(), empty).isAvailable())
        val factory = StaticListableBeanFactory(mapOf("mail" to JavaMailSenderImpl()))
        assertFalse(DailyReportMailClient(properties(), factory.getBeanProvider(JavaMailSender::class.java)).isAvailable())
    }

    @Test
    fun verificationUsesPlaintextAndFragmentTokenWithExplicitConfirmation() {
        doReturn(message).`when`(sender).createMimeMessage()
        client().sendVerification("member@example.org", token)
        message.saveChanges()
        assertEquals("member@example.org", message.allRecipients.single().toString())
        assertEquals("reports@example.org", message.from.single().toString())
        assertTrue(message.isMimeType("text/plain"))
        val body = message.content.toString()
        assertTrue(body.contains("https://govbiz.example/report-email#action=confirm&token=$token"))
        assertTrue(body.contains("30분"))
        assertTrue(body.contains("정기 발송이 시작되지는 않습니다"))
    }

    @Test
    fun reportHasUnsubscribeAndNeverRendersAiTextAsHtml() {
        doReturn(message).`when`(sender).createMimeMessage()
        client().sendReport("member@example.org", "한글\r\n기업", LocalDate.of(2026, 9, 9), "<script>미확인 내용</script>", token)
        message.saveChanges()
        assertTrue(message.isMimeType("text/plain"))
        assertFalse(message.subject.contains('\n'))
        val body = message.content.toString()
        assertTrue(body.contains("선정 확률이나 신청 자격 보장이 아닙니다"))
        assertTrue(body.contains("/report-email#action=unsubscribe&token=$token"))
        assertTrue(body.contains("/app/reports"))
        assertTrue(body.contains("<script>미확인 내용</script>"))
    }

    @Test
    fun recipientAndTokenCannotInjectHeadersOrAdditionalRecipients() {
        assertThrows(DailyReportMailException::class.java) {
            client().sendVerification("member@example.org\r\nBcc:other@example.org", token)
        }
        assertThrows(DailyReportMailException::class.java) {
            client().sendVerification("member@example.org,other@example.org", token)
        }
        assertThrows(IllegalArgumentException::class.java) {
            client().sendVerification("member@example.org", "bad&action=unsubscribe")
        }
        verifyNoInteractions(sender)
    }

    @Test
    fun smtpFailureIsExplicitAndDoesNotExposeServerResponse() {
        doReturn(message).`when`(sender).createMimeMessage()
        doThrow(MailSendException("smtp-password-or-recipient")).`when`(sender).send(any(MimeMessage::class.java))
        val error = assertThrows(DailyReportMailException::class.java) {
            client().sendVerification("member@example.org", token)
        }
        assertEquals("리포트 이메일 발송을 확인할 수 없습니다.", error.message)
    }

    private fun properties() = DailyReportProperties(
        mailEnabled = true, from = "reports@example.org", frontendBaseUrl = "https://govbiz.example",
    )

    private fun client(properties: DailyReportProperties = properties()): DailyReportMailClient =
        DailyReportMailClient(properties, StaticListableBeanFactory(mapOf("mail" to sender)).getBeanProvider(JavaMailSender::class.java))
}
