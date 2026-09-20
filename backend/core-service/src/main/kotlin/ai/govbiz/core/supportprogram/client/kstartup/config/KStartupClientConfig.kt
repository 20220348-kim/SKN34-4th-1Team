package ai.govbiz.core.supportprogram.client.kstartup.config

import ai.govbiz.core._common.helper.buildRestClient
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.web.client.RestClient

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(KStartupClientProperties::class)
class KStartupClientConfig {
    @Bean
    fun kStartupRestClient(builder: RestClient.Builder, properties: KStartupClientProperties): RestClient =
        buildRestClient(builder, properties.baseUrl, properties.connectTimeout, properties.readTimeout)

    @Bean
    fun kStartupSourceDocumentRestClient(builder: RestClient.Builder, properties: KStartupClientProperties): RestClient =
        buildRestClient(builder, null, properties.connectTimeout, properties.readTimeout)
}
