package ai.govbiz.core.supportprogram.client.kstartup.config

import ai.govbiz.core._common.helper.validateHttpBaseUrl
import ai.govbiz.core._common.helper.validatePositiveDuration
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.time.Duration
import org.springframework.boot.context.properties.ConfigurationProperties

enum class KStartupCollectionScope { RECENT_YEAR, RECENT_THREE_MONTHS, OPEN }

@ConfigurationProperties(prefix = "app.kstartup")
class KStartupClientProperties(
    baseUrl: URI?,
    apiKey: String?,
    connectTimeout: Duration?,
    readTimeout: Duration?,
    val scope: KStartupCollectionScope = KStartupCollectionScope.RECENT_YEAR,
) {
    val baseUrl: URI = baseUrl ?: URI.create("https://apis.data.go.kr")
    val apiKey: String = apiKey?.trim().orEmpty()
    val connectTimeout: Duration = connectTimeout ?: Duration.ofSeconds(2)
    val readTimeout: Duration = readTimeout ?: Duration.ofSeconds(10)

    init {
        validateHttpBaseUrl(this.baseUrl, "app.kstartup.base-url")
        validatePositiveDuration(this.connectTimeout, "app.kstartup.connect-timeout")
        validatePositiveDuration(this.readTimeout, "app.kstartup.read-timeout")
    }

    /** 공공데이터포털 Encoding 키도 URI template에서 정확히 한 번만 인코딩합니다. */
    fun decodedApiKey(): String =
        if (PERCENT_ESCAPE.containsMatchIn(apiKey)) {
            try { URLDecoder.decode(apiKey, StandardCharsets.UTF_8) } catch (_: IllegalArgumentException) { apiKey }
        } else apiKey

    private companion object {
        val PERCENT_ESCAPE = Regex("%[0-9a-fA-F]{2}")
    }
}
