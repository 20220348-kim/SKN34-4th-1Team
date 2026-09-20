package ai.govbiz.core.account.client.bizno.config

import ai.govbiz.core._common.helper.buildRestClient
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.web.client.RestClient

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(BiznoClientProperties::class)
class BiznoClientConfig {

    @Bean
    fun biznoRestClient(
        restClientBuilder: RestClient.Builder,
        properties: BiznoClientProperties,
    ): RestClient = buildRestClient(
        restClientBuilder,
        properties.baseUrl,
        properties.connectTimeout,
        properties.readTimeout,
    )
}
