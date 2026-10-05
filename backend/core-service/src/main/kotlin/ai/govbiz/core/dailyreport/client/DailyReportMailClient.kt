package ai.govbiz.core.dailyreport.client

import ai.govbiz.core.dailyreport.client.exception.DailyReportMailException
import ai.govbiz.core.dailyreport.config.DailyReportProperties
import jakarta.mail.MessagingException
import jakarta.mail.internet.InternetAddress
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.time.LocalDate
import org.springframework.beans.factory.ObjectProvider
import org.springframework.mail.MailException
import org.springframework.mail.javamail.JavaMailSender
import org.springframework.mail.javamail.JavaMailSenderImpl
import org.springframework.mail.javamail.MimeMessageHelper
import org.springframework.stereotype.Component

/** SMTP 전송 경계. HTML을 만들지 않으며, 전송 성공은 받은 편지함 도착이 아니라 SMTP 접수입니다. */
@Component
class DailyReportMailClient(
    private val properties: DailyReportProperties,
    private val senders: ObjectProvider<JavaMailSender>,
) {
    fun isAvailable(): Boolean {
        if (!properties.mailEnabled) return false
        val sender = senders.ifAvailable ?: return false
        return sender !is JavaMailSenderImpl || !sender.host.isNullOrBlank()
    }

    fun sendVerification(email: String, token: String) {
        val link = tokenLink("confirm", token)
        send(
            email,
            "[GovBiz] 맞춤 리포트 수신 주소 확인",
            """
                GovBiz 맞춤 리포트 수신 주소 확인을 요청하셨습니다.

                아래 페이지에서 '수신 주소 확인' 버튼을 눌러 주세요. 링크는 30분 동안 유효합니다.
                $link

                주소 확인만으로 정기 발송이 시작되지는 않습니다. 로그인 후 리포트 화면에서 별도로 수신에 동의해 주세요.
                직접 요청하지 않았다면 이 메일을 무시하세요.
            """.trimIndent(),
        )
    }

    fun sendReport(email: String, companyName: String, reportDate: LocalDate, summary: String, unsubscribeToken: String) {
        val company = companyName.map { if (it.isISOControl()) ' ' else it }.joinToString("").take(100)
        val unsubscribe = tokenLink("unsubscribe", unsubscribeToken)
        send(
            email,
            "[GovBiz] $reportDate $company 맞춤 지원사업 리포트",
            """
                $company 님의 $reportDate 맞춤 지원사업 리포트입니다.
                관련도 점수는 선정 확률이나 신청 자격 보장이 아닙니다. 실제 신청 전 공식 공고를 확인하세요.

            """.trimIndent() + "\n\n" + summary + "\n\n" +
                "내 리포트 보기: ${properties.frontendBaseUrl.trimEnd('/')}/app/reports\n" +
                "수신 해지: $unsubscribe\n" +
                "해지 페이지에서 버튼을 누르면 정기 발송이 중단됩니다. 로그인은 필요하지 않습니다.",
        )
    }

    /**
     * 관심 공고 마감 알림도 같은 SMTP 발송 경계와 발신 주소를 씁니다. 공고 제목·마감일과 상세 링크만 담고,
     * 설정 변경은 로그인 뒤 프로필 화면에서 하도록 안내합니다.
     */
    fun sendDeadlineReminder(
        email: String, programTitle: String, sourceCode: String, sourceProgramId: String, dueDate: LocalDate, daysLeft: Int,
    ) {
        require(daysLeft >= 0) { "daysLeft must not be negative" }
        val title = programTitle.map { if (it.isISOControl()) ' ' else it }.joinToString("").trim()
        val base = properties.frontendBaseUrl.trimEnd('/')
        val link = "$base/support-programs/detail?sourceCode=${encode(sourceCode)}&sourceProgramId=${encode(sourceProgramId)}"
        send(
            email,
            "[GovBiz] 관심 공고 마감 D-$daysLeft: ${shorten(title, 60)}",
            "관심 공고함에 담은 공고의 신청 마감이 다가왔어요.\n\n" +
                "$title\n" +
                "마감일: ${dueDate.year}년 ${dueDate.monthValue}월 ${dueDate.dayOfMonth}일 (D-$daysLeft)\n" +
                "공고 보기: $link\n\n" +
                "실제 접수 기간과 제출 서류는 공고 원문에서 다시 확인해 주세요.\n" +
                "마감 알림 설정: $base/app/profile",
        )
    }

    private fun encode(value: String) = URLEncoder.encode(value, StandardCharsets.UTF_8)

    private fun shorten(value: String, maxCodePoints: Int): String =
        if (value.codePointCount(0, value.length) <= maxCodePoints) value
        else value.substring(0, value.offsetByCodePoints(0, maxCodePoints)) + "…"

    private fun tokenLink(action: String, token: String): String {
        require(Regex("[A-Za-z0-9_-]{43}").matches(token)) { "Invalid email token format" }
        // fragment는 HTTP URL·접속 로그·Referer로 전송되지 않습니다. 페이지에서 명시적인 POST로 확인합니다.
        return "${properties.frontendBaseUrl.trimEnd('/')}/report-email#action=$action&token=$token"
    }

    private fun send(email: String, subject: String, body: String) {
        if (!isAvailable()) throw DailyReportMailException()
        try {
            require(email.none { it.isISOControl() }) { "Invalid recipient" }
            val recipient = InternetAddress(email, true).also { it.validate() }
            require(recipient.address == email && recipient.personal == null && !recipient.isGroup) { "Invalid recipient" }
            val sender = senders.getObject()
            val message = sender.createMimeMessage()
            MimeMessageHelper(message, false, "UTF-8").apply {
                setFrom(properties.from)
                setTo(recipient)
                setSubject(subject)
                setText(body, false)
            }
            sender.send(message)
        } catch (exception: MailException) {
            throw DailyReportMailException(exception)
        } catch (exception: MessagingException) {
            throw DailyReportMailException(exception)
        } catch (exception: IllegalArgumentException) {
            throw DailyReportMailException(exception)
        }
    }
}
