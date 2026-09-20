package ai.govbiz.core._common.ai_config

import ai.govbiz.core._common.helper.validateHttpBaseUrl
import ai.govbiz.core._common.helper.validatePositiveDuration
import java.net.URI
import java.time.Duration
import org.springframework.boot.context.properties.ConfigurationProperties

@ConfigurationProperties(prefix = "app.ai-service")
data class AiServiceClientProperties(
    val baseUrl: URI,
    val connectTimeout: Duration,
    val readTimeout: Duration,
    val semanticSearchReadTimeout: Duration = Duration.ofSeconds(30),
    val rankingReadTimeout: Duration = Duration.ofSeconds(55),
    val combinationReviewReadTimeout: Duration = Duration.ofSeconds(75),
    val applicationFormDiscoveryReadTimeout: Duration = Duration.ofSeconds(270),
    val applicationFormWorkerLease: Duration = Duration.ofSeconds(1800),
) {

    init {
        validatePositiveDuration(applicationFormDiscoveryReadTimeout, "app.ai-service.application-form-discovery-read-timeout")
        require(applicationFormDiscoveryReadTimeout < applicationFormWorkerLease) { "Discovery read timeout must be less than worker lease" }
        validateHttpBaseUrl(baseUrl, "app.ai-service.base-url")
        validatePositiveDuration(connectTimeout, "app.ai-service.connect-timeout")
        validatePositiveDuration(readTimeout, "app.ai-service.read-timeout")
        validatePositiveDuration(semanticSearchReadTimeout, "app.ai-service.semantic-search-read-timeout")
        validatePositiveDuration(rankingReadTimeout, "app.ai-service.ranking-read-timeout")
        validatePositiveDuration(combinationReviewReadTimeout, "app.ai-service.combination-review-read-timeout")
    }
}
