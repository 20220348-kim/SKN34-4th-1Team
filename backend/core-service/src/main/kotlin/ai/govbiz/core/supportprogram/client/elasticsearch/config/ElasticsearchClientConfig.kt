package ai.govbiz.core.supportprogram.client.elasticsearch.config

import ai.govbiz.core._common.helper.buildRestClient
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.http.HttpHeaders
import org.springframework.web.client.RestClient

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(ElasticsearchClientProperties::class)
class ElasticsearchClientConfig {
    @Bean
    fun elasticsearchRestClient(builder: RestClient.Builder, properties: ElasticsearchClientProperties): RestClient {
        if (properties.apiKey.isNotEmpty()) builder.defaultHeader(HttpHeaders.AUTHORIZATION, "ApiKey ${properties.apiKey}")
        return buildRestClient(builder, properties.baseUrl, properties.connectTimeout, properties.readTimeout)
    }
}
