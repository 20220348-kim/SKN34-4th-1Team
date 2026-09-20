package ai.govbiz.core.account.client.mail

import ai.govbiz.core.account.config.AccountEmailVerificationProperties
import ai.govbiz.core.account.service.exception.EmailVerificationMailUnavailableException
import jakarta.mail.MessagingException
import jakarta.mail.internet.InternetAddress
import org.springframework.beans.factory.ObjectProvider
import org.springframework.mail.MailException
import org.springframework.mail.javamail.JavaMailSender
import org.springframework.mail.javamail.JavaMailSenderImpl
import org.springframework.mail.javamail.MimeMessageHelper
import org.springframework.stereotype.Component

/** 회원가입 인증번호 메일의 SMTP 전송 경계입니다. 전송 성공은 받은 편지함 도착이 아니라 SMTP 접수입니다. */
@Component
class AccountEmailVerificationMailClient(
    private val properties: AccountEmailVerificationProperties,
    private val senders: ObjectProvider<JavaMailSender>,
) {

    fun isAvailable(): Boolean {
        if (!properties.mailEnabled) return false
        val sender = senders.ifAvailable ?: return false
        return sender !is JavaMailSenderImpl || !sender.host.isNullOrBlank()
    }

    fun sendSignupCode(email: String, code: String) {
        require(SIGNUP_CODE_PATTERN.matches(code)) { "Invalid signup code format" }
        val minutes = properties.codeTtl.toMinutes()
        send(
            email,
            "[GovBiz] 회원가입 인증번호 $code",
            """
                GovBiz 회원가입 인증번호입니다.

                인증번호: $code

                가입 화면의 인증번호 칸에 입력해 주세요. 인증번호는 ${minutes}분 동안 유효합니다.
                직접 요청하지 않았다면 이 메일을 무시하세요. 계정은 만들어지지 않습니다.
            """.trimIndent(),
        )
    }

    private fun send(email: String, subject: String, body: String) {
        if (!isAvailable()) throw EmailVerificationMailUnavailableException()
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
            throw EmailVerificationMailUnavailableException(exception)
        } catch (exception: MessagingException) {
            throw EmailVerificationMailUnavailableException(exception)
        }
    }

    companion object {
        val SIGNUP_CODE_PATTERN: Regex = Regex("[0-9]{6}")
    }
}
