package ai.govbiz.core.account.client.mail

import ai.govbiz.core.account.config.AccountPasswordResetProperties
import ai.govbiz.core.account.helper.OneTimeTokenHelper
import ai.govbiz.core.account.service.exception.PasswordResetMailUnavailableException
import jakarta.mail.MessagingException
import jakarta.mail.internet.InternetAddress
import org.springframework.beans.factory.ObjectProvider
import org.springframework.mail.MailException
import org.springframework.mail.javamail.JavaMailSender
import org.springframework.mail.javamail.JavaMailSenderImpl
import org.springframework.mail.javamail.MimeMessageHelper
import org.springframework.stereotype.Component

/** 비밀번호 재설정 메일의 SMTP 전송 경계입니다. 전송 성공은 받은 편지함 도착이 아니라 SMTP 접수입니다. */
@Component
class AccountPasswordResetMailClient(
    private val properties: AccountPasswordResetProperties,
    private val senders: ObjectProvider<JavaMailSender>,
) {

    fun isAvailable(): Boolean {
        if (!properties.mailEnabled) return false
        val sender = senders.ifAvailable ?: return false
        return sender !is JavaMailSenderImpl || !sender.host.isNullOrBlank()
    }

    /** 재설정 화면 주소입니다. 토큰은 fragment에 실어 HTTP 요청·접속 로그·Referer에 남지 않게 합니다. */
    fun resetLink(token: String): String {
        require(OneTimeTokenHelper.PATTERN.matches(token)) { "Invalid reset token format" }
        return "${properties.frontendBaseUrl.trimEnd('/')}/reset-password#token=$token"
    }

    fun sendPasswordReset(email: String, token: String) {
        val link = resetLink(token)
        val minutes = properties.tokenTtl.toMinutes()
        send(
            email,
            "[GovBiz] 비밀번호 재설정 안내",
            """
                GovBiz 계정의 비밀번호 재설정을 요청하셨습니다.
                아래 링크를 열어 새 비밀번호를 정해 주세요. 링크는 ${minutes}분 동안 한 번만 쓸 수 있습니다.
                $link
                직접 요청하지 않았다면 이 메일을 무시하세요. 비밀번호는 바뀌지 않습니다.
            """.trimIndent(),
        )
    }

    private fun send(email: String, subject: String, body: String) {
        if (!isAvailable()) throw PasswordResetMailUnavailableException()
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
            throw PasswordResetMailUnavailableException(exception)
        } catch (exception: MessagingException) {
            throw PasswordResetMailUnavailableException(exception)
        }
    }
}
