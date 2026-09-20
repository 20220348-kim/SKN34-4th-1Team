package ai.govbiz.core.dailyreport.config

import jakarta.mail.internet.InternetAddress
import java.net.URI
import org.springframework.boot.context.properties.ConfigurationProperties

@ConfigurationProperties(prefix = "app.daily-report")
class DailyReportProperties(
    val enabled: Boolean = false,
    val mailEnabled: Boolean = false,
    val frontendBaseUrl: String = "http://127.0.0.1:5173",
    val from: String = "",
    val sendHour: Int = 8,
    val maxAccountsPerRun: Int = 20,
    val maxReportsPerDay: Int = 20,
    val maxPrograms: Int = 3,
) {
    init {
        require(sendHour in 0..23) { "app.daily-report.send-hour must be 0..23" }
        require(maxAccountsPerRun in 1..100) { "app.daily-report.max-accounts-per-run must be 1..100" }
        require(maxReportsPerDay in 1..1000) { "app.daily-report.max-reports-per-day must be 1..1000" }
        require(maxPrograms in 1..3) { "app.daily-report.max-programs must be 1..3" }
        val uri = URI(frontendBaseUrl)
        require(
            uri.host != null && uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null &&
                (uri.path.isNullOrEmpty() || uri.path == "/") &&
                (uri.scheme == "https" || (uri.scheme == "http" && uri.host in setOf("localhost", "127.0.0.1", "[::1]"))),
        ) { "app.daily-report.frontend-base-url must be an HTTPS origin (HTTP allowed only for loopback development)" }
        if (mailEnabled) {
            require(from.isNotBlank() && from.none { it.isISOControl() }) {
                "app.daily-report.from must be a single sender mailbox when mail is enabled"
            }
            val address = InternetAddress(from, true)
            address.validate()
            require(address.address == from && address.personal == null && !address.isGroup) {
                "app.daily-report.from must be a single sender mailbox"
            }
        }
    }
}
