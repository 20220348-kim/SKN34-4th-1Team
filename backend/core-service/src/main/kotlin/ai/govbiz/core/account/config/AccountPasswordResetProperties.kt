package ai.govbiz.core.account.config

import jakarta.mail.internet.InternetAddress
import java.net.URI
import java.time.Duration
import org.springframework.boot.context.properties.ConfigurationProperties

/**
 * 비밀번호 재설정 메일 설정입니다. SMTP 연결 자체는 `spring.mail.*`를 쓰고, 여기서는 발송 여부·발신 주소·링크 origin·
 * 토큰 유효 시간을 정합니다. 메일이 꺼져 있으면 개발용 로그인이 켜진 환경에서만 링크를 로그로 대신 남깁니다.
 */
@ConfigurationProperties(prefix = "app.account.password-reset")
class AccountPasswordResetProperties(
    val mailEnabled: Boolean = false,
    val from: String = "",
    val frontendBaseUrl: String = "http://127.0.0.1:5173",
    val tokenTtl: Duration = Duration.ofMinutes(30),
    val maxRequestsPerHour: Int = 3,
) {
    init {
        require(!tokenTtl.isNegative && !tokenTtl.isZero && tokenTtl <= Duration.ofHours(24)) {
            "app.account.password-reset.token-ttl must be between 1 second and 24 hours"
        }
        require(maxRequestsPerHour in 1..20) { "app.account.password-reset.max-requests-per-hour must be 1..20" }
        val uri = URI(frontendBaseUrl)
        require(
            uri.host != null && uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null &&
                (uri.path.isNullOrEmpty() || uri.path == "/") &&
                (uri.scheme == "https" || (uri.scheme == "http" && uri.host in setOf("localhost", "127.0.0.1", "[::1]"))),
        ) { "app.account.password-reset.frontend-base-url must be an HTTPS origin (HTTP allowed only for loopback development)" }
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
