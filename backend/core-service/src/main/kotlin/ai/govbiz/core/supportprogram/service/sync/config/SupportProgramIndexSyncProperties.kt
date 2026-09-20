package ai.govbiz.core.supportprogram.service.sync.config

import ai.govbiz.core._common.helper.validatePositiveDuration
import java.time.Duration
import org.springframework.boot.context.properties.ConfigurationProperties

@ConfigurationProperties(prefix = "app.support-program-index")
data class SupportProgramIndexSyncProperties(
    val enabled: Boolean,
    val initialDelay: Duration,
    val fixedDelay: Duration,
) {
    init {
        require(!initialDelay.isNegative) { "app.support-program-index.initial-delay must not be negative" }
        validatePositiveDuration(fixedDelay, "app.support-program-index.fixed-delay")
    }
}
