package ai.govbiz.core.supportprogram.client.cntradenotice.config

import ai.govbiz.core._common.helper.buildRestClient
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.web.client.RestClient

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(CnTradeNoticeClientProperties::class)
class CnTradeNoticeClientConfig {
    @Bean
    fun cnTradeNoticeRestClient(builder: RestClient.Builder, properties: CnTradeNoticeClientProperties): RestClient =
        buildRestClient(builder, properties.baseUrl, properties.connectTimeout, properties.readTimeout)

    @Bean
    fun cnTradeNoticeSourceDocumentRestClient(builder: RestClient.Builder, properties: CnTradeNoticeClientProperties): RestClient =
        buildRestClient(builder, null, properties.connectTimeout, properties.readTimeout)
}
