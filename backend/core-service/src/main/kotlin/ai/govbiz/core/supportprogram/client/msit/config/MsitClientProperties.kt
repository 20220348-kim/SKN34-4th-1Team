package ai.govbiz.core.supportprogram.client.msit.config

import ai.govbiz.core._common.helper.validateHttpBaseUrl
import ai.govbiz.core._common.helper.validatePositiveDuration
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.time.Duration
import org.springframework.boot.context.properties.ConfigurationProperties

@ConfigurationProperties(prefix = "app.msit")
class MsitClientProperties(
    baseUrl: URI?,
    apiKey: String?,
    connectTimeout: Duration?,
    readTimeout: Duration?,
) {
    val baseUrl: URI = baseUrl ?: URI.create("https://apis.data.go.kr")
    val apiKey: String = apiKey?.trim().orEmpty()
    val connectTimeout: Duration = connectTimeout ?: Duration.ofSeconds(2)
    val readTimeout: Duration = readTimeout ?: Duration.ofSeconds(20)

    init {
        validateHttpBaseUrl(this.baseUrl, "app.msit.base-url")
        validatePositiveDuration(this.connectTimeout, "app.msit.connect-timeout")
        validatePositiveDuration(this.readTimeout, "app.msit.read-timeout")
    }

    fun decodedApiKey(): String =
        if (PERCENT_ESCAPE.containsMatchIn(apiKey)) {
            try { URLDecoder.decode(apiKey, StandardCharsets.UTF_8) } catch (_: IllegalArgumentException) { apiKey }
        } else apiKey

    private companion object {
        val PERCENT_ESCAPE = Regex("%[0-9a-fA-F]{2}")
    }
}
