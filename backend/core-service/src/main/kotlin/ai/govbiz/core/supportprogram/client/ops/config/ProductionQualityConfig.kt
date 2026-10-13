package ai.govbiz.core.supportprogram.client.ops.config

import ai.govbiz.core.supportprogram.client.ops.ProductionQualityClient
import java.net.http.HttpClient
import java.time.Duration
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import tools.jackson.databind.ObjectMapper

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(ProductionQualityProperties::class)
class ProductionQualityConfig {
    @Bean
    fun productionQualityClient(properties: ProductionQualityProperties, mapper: ObjectMapper): ProductionQualityClient =
        ProductionQualityClient(
            properties,
            mapper,
            HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(2))
                .followRedirects(HttpClient.Redirect.NEVER)
                .build(),
        )
}
