package ai.govbiz.core.supportprogram.client.cntradenotice.config

import ai.govbiz.core._common.helper.validateHttpBaseUrl
import ai.govbiz.core._common.helper.validatePositiveDuration
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.time.Duration
import org.springframework.boot.context.properties.ConfigurationProperties

@ConfigurationProperties(prefix = "app.cntrade-notice")
class CnTradeNoticeClientProperties(
    baseUrl: URI?,
    apiKey: String?,
    connectTimeout: Duration?,
    readTimeout: Duration?,
) {
    val baseUrl: URI = baseUrl ?: URI.create("https://apis.data.go.kr")
    val apiKey: String = apiKey?.trim().orEmpty()
    val connectTimeout: Duration = connectTimeout ?: Duration.ofSeconds(2)
    val readTimeout: Duration = readTimeout ?: Duration.ofSeconds(10)

    init {
        validateHttpBaseUrl(this.baseUrl, "app.cntrade-notice.base-url")
        validatePositiveDuration(this.connectTimeout, "app.cntrade-notice.connect-timeout")
        validatePositiveDuration(this.readTimeout, "app.cntrade-notice.read-timeout")
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
