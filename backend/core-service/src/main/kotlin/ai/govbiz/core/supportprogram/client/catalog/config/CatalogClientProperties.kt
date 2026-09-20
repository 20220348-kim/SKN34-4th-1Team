package ai.govbiz.core.supportprogram.client.catalog.config

import ai.govbiz.core._common.helper.validateHttpBaseUrl
import ai.govbiz.core._common.helper.validatePositiveDuration
import java.net.URI
import java.time.Duration
import org.springframework.boot.context.properties.ConfigurationProperties

/** 서버 간 토큰은 사용자 인증키와 별개이며 toString으로 노출하지 않습니다. */
@ConfigurationProperties("app.catalog")
class CatalogClientProperties(
    val baseUrl: URI,
    val internalToken: String,
    val connectTimeout: Duration = Duration.ofSeconds(2),
    val readTimeout: Duration = Duration.ofSeconds(30),
    val sources: List<String> = listOf("BIZINFO", "KSTARTUP", "MSIT", "CNTRADE_NOTICE"),
) {
    init {
        validateHttpBaseUrl(baseUrl, "app.catalog.base-url")
        validatePositiveDuration(connectTimeout, "app.catalog.connect-timeout")
        validatePositiveDuration(readTimeout, "app.catalog.read-timeout")
        require(internalToken.length in 32..1024 && internalToken.all { it in '!'..'~' }) {
            "CATALOG_INTERNAL_TOKEN must contain 32..1024 visible ASCII characters"
        }
        require(sources.isNotEmpty() && sources.toSet().size == sources.size && sources.all { it in SUPPORTED_SOURCES }) {
            "app.catalog.sources must contain distinct supported source codes"
        }
    }

    companion object {
        val SUPPORTED_SOURCES = setOf("BIZINFO", "KSTARTUP", "MSIT", "CNTRADE_NOTICE")
    }
}
