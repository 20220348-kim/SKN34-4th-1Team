package ai.govbiz.core.supportprogram.client.elasticsearch.config

import ai.govbiz.core._common.helper.validateHttpBaseUrl
import ai.govbiz.core._common.helper.validatePositiveDuration
import java.net.URI
import java.time.Duration
import org.springframework.boot.context.properties.ConfigurationProperties

@ConfigurationProperties("app.elasticsearch")
class ElasticsearchClientProperties(
    baseUrl: URI?, indexName: String?, apiKey: String?, connectTimeout: Duration?, readTimeout: Duration?,
) {
    val baseUrl: URI = baseUrl ?: URI.create("http://localhost:9200")
    val indexName: String = indexName ?: "govbiz-support-program-lexical-v2"
    val apiKey: String = apiKey?.trim().orEmpty()
    val connectTimeout: Duration = connectTimeout ?: Duration.ofSeconds(2)
    val readTimeout: Duration = readTimeout ?: Duration.ofSeconds(10)

    init {
        validateHttpBaseUrl(this.baseUrl, "app.elasticsearch.base-url")
        require(Regex("[a-z][a-z0-9_-]{0,100}").matches(this.indexName)) { "Invalid Elasticsearch index name" }
        require(!this.apiKey.contains('\r') && !this.apiKey.contains('\n')) { "Invalid Elasticsearch API key" }
        validatePositiveDuration(this.connectTimeout, "app.elasticsearch.connect-timeout")
        validatePositiveDuration(this.readTimeout, "app.elasticsearch.read-timeout")
    }
}
