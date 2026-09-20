package ai.govbiz.core.supportprogram.service.sync.config

import ai.govbiz.core._common.helper.validatePositiveDuration
import java.time.Duration
import org.springframework.boot.context.properties.ConfigurationProperties

@ConfigurationProperties(prefix = "app.cntrade-notice.sync")
data class CnTradeNoticeSupportProgramCatalogSyncProperties(
    val enabled: Boolean = false,
    val initialDelay: Duration = Duration.ofSeconds(15),
    val fixedDelay: Duration = Duration.ofHours(6),
) {
    init {
        require(!initialDelay.isNegative) { "app.cntrade-notice.sync.initial-delay must not be negative" }
        validatePositiveDuration(fixedDelay, "app.cntrade-notice.sync.fixed-delay")
    }
}
