package ai.govbiz.catalog.supportprogram.client.bizinfo.config

import ai.govbiz.catalog._common.helper.buildRestClient
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.web.client.RestClient

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(
    BizInfoClientProperties::class,
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

}
