package ai.govbiz.core.supportprogram.client.bizinfo.config

import ai.govbiz.core._common.helper.validateHttpBaseUrl
import ai.govbiz.core._common.helper.validatePositiveDuration
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.time.Duration
import java.util.regex.Pattern
import org.springframework.boot.context.properties.ConfigurationProperties

@ConfigurationProperties(prefix = "app.bizinfo")
class BizInfoClientProperties(
    baseUrl: URI?,
    serviceKey: String?,
    connectTimeout: Duration?,
    readTimeout: Duration?,
) {

    val baseUrl: URI = baseUrl
        ?: throw NullPointerException("app.bizinfo.base-url must be configured")
    val serviceKey: String = serviceKey?.trim().orEmpty()
    val connectTimeout: Duration = connectTimeout
        ?: throw NullPointerException("app.bizinfo.connect-timeout must be configured")
    val readTimeout: Duration = readTimeout
        ?: throw NullPointerException("app.bizinfo.read-timeout must be configured")

    init {
        validateHttpBaseUrl(this.baseUrl, "app.bizinfo.base-url")
        validatePositiveDuration(this.connectTimeout, "app.bizinfo.connect-timeout")
        validatePositiveDuration(this.readTimeout, "app.bizinfo.read-timeout")
    }

    /**
     * 공공데이터포털은 Encoding/Decoding 키를 모두 보여준다. URI template이 값을 정확히
     * 한 번 인코딩할 수 있도록 percent-encoded 키만 한 번 디코딩한다.
     */
    fun decodedServiceKey(): String {
        if (!PERCENT_ESCAPE.matcher(serviceKey).find()) {
            return serviceKey
        }
        return try {
            URLDecoder.decode(serviceKey, StandardCharsets.UTF_8)
        } catch (_: IllegalArgumentException) {
            serviceKey
        }
    }

    companion object {
        private val PERCENT_ESCAPE: Pattern = Pattern.compile("%[0-9a-fA-F]{2}")
    }
}
