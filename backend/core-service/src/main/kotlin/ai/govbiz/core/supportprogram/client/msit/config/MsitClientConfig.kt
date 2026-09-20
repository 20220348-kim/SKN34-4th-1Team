package ai.govbiz.core.supportprogram.client.msit.config

import ai.govbiz.core._common.helper.buildRestClient
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.web.client.RestClient

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(MsitClientProperties::class)
class MsitClientConfig {
    @Bean
    fun msitRestClient(builder: RestClient.Builder, properties: MsitClientProperties): RestClient =
        buildRestClient(builder, properties.baseUrl, properties.connectTimeout, properties.readTimeout)

    @Bean
    fun msitSourceDocumentRestClient(builder: RestClient.Builder, properties: MsitClientProperties): RestClient =
        buildRestClient(builder, null, properties.connectTimeout, properties.readTimeout)
}
