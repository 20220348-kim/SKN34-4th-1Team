package ai.govbiz.core.supportprogram.service.sync.config

import java.math.BigDecimal
import java.nio.file.Path
import org.springframework.boot.context.properties.ConfigurationProperties

/** 실행마다 승인한 제공처·달러 예산과 재실행 방지 기록의 영속 경로를 명시합니다. */
@ConfigurationProperties("app.catalog-sync-once")
data class SupportProgramCatalogSyncOnceProperties(
    val sources: List<String>,
    val maxUsd: BigDecimal,
    val receiptPath: Path,
    val apply: Boolean = false,
) {
    init {
        require(sources.isNotEmpty() && sources.distinct().size == sources.size) { "sources must be nonempty and unique" }
        require(sources.all { it in setOf("BIZINFO", "KSTARTUP", "MSIT", "CNTRADE_NOTICE") }) { "unsupported source" }
        require(maxUsd > BigDecimal.ZERO && maxUsd <= BigDecimal.ONE) { "max-usd must be positive and at most 1 USD" }
        require(receiptPath.isAbsolute && receiptPath.fileName != null) { "receipt-path must be an absolute file path" }
    }
}
