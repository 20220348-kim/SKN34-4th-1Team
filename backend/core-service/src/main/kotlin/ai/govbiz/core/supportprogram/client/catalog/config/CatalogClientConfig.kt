package ai.govbiz.core.supportprogram.client.catalog.config

import ai.govbiz.core._common.helper.buildRestClient
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.web.client.RestClient

@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(prefix = "app.catalog.projection", name = ["enabled"], havingValue = "true")
@EnableConfigurationProperties(CatalogClientProperties::class)
class CatalogClientConfig {
    @Bean
    fun catalogRestClient(builder: RestClient.Builder, properties: CatalogClientProperties): RestClient =
        buildRestClient(builder, properties.baseUrl, properties.connectTimeout, properties.readTimeout)
}
