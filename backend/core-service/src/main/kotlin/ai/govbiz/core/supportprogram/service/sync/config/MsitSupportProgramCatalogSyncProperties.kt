package ai.govbiz.core.supportprogram.service.sync.config

import ai.govbiz.core._common.helper.validatePositiveDuration
import java.time.Duration
import org.springframework.boot.context.properties.ConfigurationProperties

@ConfigurationProperties(prefix = "app.msit.sync")
data class MsitSupportProgramCatalogSyncProperties(
    val enabled: Boolean = false,
    val initialDelay: Duration = Duration.ofSeconds(15),
    val fixedDelay: Duration = Duration.ofHours(6),
) {
    init {
        require(!initialDelay.isNegative) { "app.msit.sync.initial-delay must not be negative" }
        validatePositiveDuration(fixedDelay, "app.msit.sync.fixed-delay")
    }
}
