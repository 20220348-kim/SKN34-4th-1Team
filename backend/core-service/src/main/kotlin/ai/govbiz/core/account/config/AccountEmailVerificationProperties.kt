package ai.govbiz.core.account.config

import jakarta.mail.internet.InternetAddress
import java.time.Duration
import org.springframework.boot.context.properties.ConfigurationProperties

/**
 * 회원가입 인증번호 메일 설정입니다. SMTP 연결은 `spring.mail.*`를 쓰고, 여기서는 발송 여부·발신 주소·인증번호 유효 시간·
 * 재전송 대기·발송 한도·입력 시도 한도를 정합니다. 발송 여부·발신 주소는 따로 주지 않으면 비밀번호 재설정 메일 설정을
 * 물려받도록 `application.properties`가 기본값을 잇습니다. 메일이 꺼져 있으면 개발용 로그인이 켜진 환경에서만 인증번호를
 * 로그로 대신 남깁니다.
 */
@ConfigurationProperties(prefix = "app.account.email-verification")
class AccountEmailVerificationProperties(
    val mailEnabled: Boolean = false,
    val from: String = "",
    /** 인증번호를 입력할 수 있는 시간입니다. */
    val codeTtl: Duration = Duration.ofMinutes(10),
    /** 인증을 마친 뒤 가입을 끝내야 하는 시간입니다. */
    val passTtl: Duration = Duration.ofMinutes(30),
    /** 같은 이메일로 다시 보낼 수 있기까지의 대기 시간입니다. */
    val resendCooldown: Duration = Duration.ofSeconds(60),
    /** 발송 횟수를 세는 창과 그 안의 최대 발송 수입니다. */
    val sendWindow: Duration = Duration.ofMinutes(10),
    val maxSendsPerWindow: Int = 3,
    /** 인증번호 하나에 허용하는 입력 시도 수입니다. 넘기면 새로 받아야 합니다. */
    val maxAttempts: Int = 5,
) {
    init {
        require(codeTtl > Duration.ZERO && codeTtl <= Duration.ofHours(1)) { "app.account.email-verification.code-ttl must be between 1 second and 1 hour" }
        require(passTtl > Duration.ZERO && passTtl <= Duration.ofHours(24)) { "app.account.email-verification.pass-ttl must be between 1 second and 24 hours" }
        require(!resendCooldown.isNegative && resendCooldown <= Duration.ofHours(1)) { "app.account.email-verification.resend-cooldown must be between 0 and 1 hour" }
        require(sendWindow > Duration.ZERO && sendWindow <= Duration.ofHours(24)) { "app.account.email-verification.send-window must be between 1 second and 24 hours" }
        require(maxSendsPerWindow in 1..20) { "app.account.email-verification.max-sends-per-window must be 1..20" }
        require(maxAttempts in 1..10) { "app.account.email-verification.max-attempts must be 1..10" }
        if (mailEnabled) {
            require(from.isNotBlank() && from.none { it.isISOControl() }) {
                "app.account.email-verification.from must be a single sender mailbox when mail is enabled"
            }
            val address = InternetAddress(from, true)
            address.validate()
            require(address.address == from && address.personal == null && !address.isGroup) {
                "app.account.email-verification.from must be a single sender mailbox"
            }
        }
    }
}
