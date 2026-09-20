package ai.govbiz.catalog.supportprogram.client.ai.config

import ai.govbiz.catalog._common.helper.buildRestClient
import ai.govbiz.catalog._common.helper.validateHttpBaseUrl
import ai.govbiz.catalog._common.helper.validatePositiveDuration
import java.net.URI
import java.time.Duration
import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.web.client.RestClient

@ConfigurationProperties("app.ai-service")
data class AiIndexClientProperties(
    val baseUrl: URI,
    val connectTimeout: Duration,
    val semanticSearchReadTimeout: Duration,
) {
    init {
        validateHttpBaseUrl(baseUrl, "app.ai-service.base-url")
        validatePositiveDuration(connectTimeout, "app.ai-service.connect-timeout")
        validatePositiveDuration(semanticSearchReadTimeout, "app.ai-service.semantic-search-read-timeout")
    }
}

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(AiIndexClientProperties::class)
class AiIndexClientConfig {
    @Bean
    fun aiSemanticSearchRestClient(builder: RestClient.Builder, properties: AiIndexClientProperties): RestClient =
        buildRestClient(builder, properties.baseUrl, properties.connectTimeout, properties.semanticSearchReadTimeout)
}
