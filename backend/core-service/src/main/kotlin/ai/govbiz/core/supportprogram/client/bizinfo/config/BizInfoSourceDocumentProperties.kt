package ai.govbiz.core.supportprogram.client.bizinfo.config

import ai.govbiz.core._common.helper.validateHttpBaseUrl
import ai.govbiz.core._common.helper.validatePositiveDuration
import java.net.URI
import java.time.Duration
import org.springframework.boot.context.properties.ConfigurationProperties

/** 기업마당 상세 페이지 원문을 제한적으로 읽기 위한 HTTP 설정입니다. */
@ConfigurationProperties(prefix = "app.bizinfo.source-document")
class BizInfoSourceDocumentProperties(
    baseUrl: URI?,
    connectTimeout: Duration?,
    readTimeout: Duration?,
) {
    val baseUrl: URI = baseUrl
        ?: throw NullPointerException("app.bizinfo.source-document.base-url must be configured")
    val connectTimeout: Duration = connectTimeout
        ?: throw NullPointerException("app.bizinfo.source-document.connect-timeout must be configured")
    val readTimeout: Duration = readTimeout
        ?: throw NullPointerException("app.bizinfo.source-document.read-timeout must be configured")

    init {
        validateHttpBaseUrl(baseUrl = this.baseUrl, propertyName = "app.bizinfo.source-document.base-url")
        require(this.baseUrl.scheme.equals("https", ignoreCase = true)) {
            "app.bizinfo.source-document.base-url must use HTTPS"
        }
        require(isOfficialBizInfoHost(this.baseUrl.host)) {
            "app.bizinfo.source-document.base-url must use an official BizInfo host"
        }
        require(this.baseUrl.port == -1 || this.baseUrl.port == 443) {
            "app.bizinfo.source-document.base-url must use the default HTTPS port"
        }
        validatePositiveDuration(this.connectTimeout, "app.bizinfo.source-document.connect-timeout")
        validatePositiveDuration(this.readTimeout, "app.bizinfo.source-document.read-timeout")
    }

    private companion object {
        fun isOfficialBizInfoHost(host: String?): Boolean =
            host != null && (
                host.equals("bizinfo.go.kr", ignoreCase = true) ||
                    host.lowercase().endsWith(".bizinfo.go.kr")
                )
    }
}
