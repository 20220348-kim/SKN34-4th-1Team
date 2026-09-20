package ai.govbiz.core.supportprogram.service.sync.config

import ai.govbiz.core._common.helper.validatePositiveDuration
import java.time.Duration
import org.springframework.boot.context.properties.ConfigurationProperties

@ConfigurationProperties(prefix = "app.bizinfo.sync")
data class BizInfoSupportProgramCatalogSyncProperties(
    val enabled: Boolean,
    val initialDelay: Duration,
    val fixedDelay: Duration,
) {

    init {
        if (initialDelay.isNegative) {
            throw IllegalArgumentException("app.bizinfo.sync.initial-delay must not be negative")
        }
        validatePositiveDuration(fixedDelay, "app.bizinfo.sync.fixed-delay")
    }
}
