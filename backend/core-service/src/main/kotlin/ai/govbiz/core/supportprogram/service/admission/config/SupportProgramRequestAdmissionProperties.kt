package ai.govbiz.core.supportprogram.service.admission.config

import org.springframework.boot.context.properties.ConfigurationProperties

@ConfigurationProperties(prefix = "app.support-program-request")
data class SupportProgramRequestAdmissionProperties(
    val perClientPerMinute: Int = 6,
    val globalPerMinute: Int = 60,
    val maxConcurrent: Int = 4,
) {
    init {
        require(perClientPerMinute in 1..10_000) {
            "app.support-program-request.per-client-per-minute must be between 1 and 10000"
        }
        require(globalPerMinute in 1..10_000) {
            "app.support-program-request.global-per-minute must be between 1 and 10000"
        }
        require(maxConcurrent in 1..100) {
            "app.support-program-request.max-concurrent must be between 1 and 100"
        }
    }
}
