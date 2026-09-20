package ai.govbiz.core.account.client.bizno.config

import ai.govbiz.core._common.helper.validateHttpBaseUrl
import ai.govbiz.core._common.helper.validatePositiveDuration
import java.net.URI
import java.time.Duration
import org.springframework.boot.context.properties.ConfigurationProperties

@ConfigurationProperties(prefix = "app.bizno")
class BiznoClientProperties(
    endpointUrl: URI?,
    apiKey: String?,
    connectTimeout: Duration?,
    readTimeout: Duration?,
) {

    /** 조회 endpoint 전체 URL. 경로는 Bizno가 고정한 `/api/fapi`여야 합니다. */
    val endpointUrl: URI = endpointUrl
        ?: throw NullPointerException("app.bizno.endpoint-url must be configured")

    /** 비어 있으면 조회 요청이 503으로 답하고 다른 기능에는 영향이 없습니다. */
    val apiKey: String = apiKey?.trim().orEmpty()
    val connectTimeout: Duration = connectTimeout
        ?: throw NullPointerException("app.bizno.connect-timeout must be configured")
    val readTimeout: Duration = readTimeout
        ?: throw NullPointerException("app.bizno.read-timeout must be configured")

    /** RestClient에 줄 scheme·host·port만 남긴 origin입니다. */
    val baseUrl: URI = URI.create("${this.endpointUrl.scheme}://${this.endpointUrl.rawAuthority}")

    init {
        validateHttpBaseUrl(baseUrl, "app.bizno.endpoint-url")
        require(this.endpointUrl.rawPath == LOOKUP_PATH) {
            "app.bizno.endpoint-url must point to $LOOKUP_PATH"
        }
        require(this.endpointUrl.rawQuery == null && this.endpointUrl.rawFragment == null) {
            "app.bizno.endpoint-url must not contain a query or fragment"
        }
        validatePositiveDuration(this.connectTimeout, "app.bizno.connect-timeout")
        validatePositiveDuration(this.readTimeout, "app.bizno.read-timeout")
    }

    companion object {
        const val LOOKUP_PATH = "/api/fapi"
    }
}
