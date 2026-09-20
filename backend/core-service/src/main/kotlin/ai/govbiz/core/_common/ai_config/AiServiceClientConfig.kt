package ai.govbiz.core._common.ai_config

import ai.govbiz.core._common.helper.buildRestClient
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.web.client.RestClient

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(AiServiceClientProperties::class)
class AiServiceClientConfig {
    @Bean
    fun aiApplicationFormDiscoveryRestClient(restClientBuilder: RestClient.Builder, properties: AiServiceClientProperties): RestClient =
        buildRestClient(restClientBuilder, properties.baseUrl, properties.connectTimeout, properties.applicationFormDiscoveryReadTimeout)


    @Bean
    fun aiCombinationReviewRestClient(
        restClientBuilder: RestClient.Builder,
        properties: AiServiceClientProperties,
    ): RestClient = buildRestClient(
        restClientBuilder,
        properties.baseUrl,
        properties.connectTimeout,
        properties.combinationReviewReadTimeout,
    )

    @Bean
    fun aiRankingRestClient(
        restClientBuilder: RestClient.Builder,
        properties: AiServiceClientProperties,
    ): RestClient = buildRestClient(
        restClientBuilder,
        properties.baseUrl,
        properties.connectTimeout,
        properties.rankingReadTimeout,
    )

    @Bean
    fun aiSemanticSearchRestClient(
        restClientBuilder: RestClient.Builder,
        properties: AiServiceClientProperties,
    ): RestClient = buildRestClient(
        restClientBuilder,
        properties.baseUrl,
        properties.connectTimeout,
        properties.semanticSearchReadTimeout,
    )

    @Bean
    fun aiServiceRestClient(
        restClientBuilder: RestClient.Builder,
        properties: AiServiceClientProperties,
    ): RestClient = buildRestClient(
        restClientBuilder,
        properties.baseUrl,
        properties.connectTimeout,
        properties.readTimeout,
    )
}
