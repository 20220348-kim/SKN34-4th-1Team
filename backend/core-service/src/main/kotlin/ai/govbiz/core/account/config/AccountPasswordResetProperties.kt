package ai.govbiz.core.account.config

import jakarta.mail.internet.InternetAddress
import java.time.Duration
import org.springframework.boot.context.properties.ConfigurationProperties

/**
 * 비밀번호 재설정 메일 설정입니다. SMTP 연결 자체는 `spring.mail.*`를 쓰고, 여기서는 발송 여부·발신 주소·인증번호 유효 시간·
 * 재전송 대기·입력 시도 한도·통행 토큰 유효 시간·시간당 요청 한도를 정합니다.
 * 메일이 꺼져 있으면 개발용 로그인이 켜진 환경에서만 인증번호를 로그로 대신 남깁니다.
 */
@ConfigurationProperties(prefix = "app.account.password-reset")
class AccountPasswordResetProperties(
    val mailEnabled: Boolean = false,
    val from: String = "",
    /** 6자리 인증번호를 입력할 수 있는 시간입니다. */
    val codeTtl: Duration = Duration.ofMinutes(10),
    /** 인증번호를 맞힌 뒤 새 비밀번호를 저장해야 하는 시간(통행 토큰 유효 시간)입니다. */
    val tokenTtl: Duration = Duration.ofMinutes(30),
    /** 같은 계정으로 인증번호를 다시 보낼 수 있기까지의 대기 시간입니다. */
    val resendCooldown: Duration = Duration.ofSeconds(60),
    /** 계정당 한 시간 안에 보낼 수 있는 인증번호 수입니다. */
    val maxRequestsPerHour: Int = 3,
    /** 인증번호 하나에 허용하는 입력 시도 수입니다. 넘기면 새로 받아야 합니다. */
    val maxAttempts: Int = 5,
) {
    init {
        require(codeTtl > Duration.ZERO && codeTtl <= Duration.ofHours(1)) {
            "app.account.password-reset.code-ttl must be between 1 second and 1 hour"
        }
        require(!tokenTtl.isNegative && !tokenTtl.isZero && tokenTtl <= Duration.ofHours(24)) {
            "app.account.password-reset.token-ttl must be between 1 second and 24 hours"
        }
        require(!resendCooldown.isNegative && resendCooldown <= Duration.ofHours(1)) {
            "app.account.password-reset.resend-cooldown must be between 0 and 1 hour"
        }
        require(maxRequestsPerHour in 1..20) { "app.account.password-reset.max-requests-per-hour must be 1..20" }
        require(maxAttempts in 1..10) { "app.account.password-reset.max-attempts must be 1..10" }
        if (mailEnabled) {
            require(from.isNotBlank() && from.none { it.isISOControl() }) {
                "app.account.password-reset.from must be a single sender mailbox when mail is enabled"
            }
            val address = InternetAddress(from, true)
            address.validate()
            require(address.address == from && address.personal == null && !address.isGroup) {
                "app.account.password-reset.from must be a single sender mailbox"
            }
        }
    }
}
