package ai.govbiz.core.supportprogram.client.bizinfo.config

import ai.govbiz.core._common.helper.buildRestClient
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.web.client.RestClient

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(
    BizInfoClientProperties::class,
    BizInfoSourceDocumentProperties::class,
)
class BizInfoClientConfig {

    @Bean
    fun bizInfoRestClient(
        restClientBuilder: RestClient.Builder,
        properties: BizInfoClientProperties,
    ): RestClient = buildRestClient(
        restClientBuilder,
        properties.baseUrl,
        properties.connectTimeout,
        properties.readTimeout,
    )

    @Bean
    fun bizInfoSourceDocumentRestClient(
        restClientBuilder: RestClient.Builder,
        properties: BizInfoSourceDocumentProperties,
    ): RestClient = buildRestClient(
        restClientBuilder,
        properties.baseUrl,
        properties.connectTimeout,
        properties.readTimeout,
    )
}
