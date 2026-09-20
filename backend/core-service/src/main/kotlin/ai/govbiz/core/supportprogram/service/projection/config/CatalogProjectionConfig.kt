package ai.govbiz.core.supportprogram.service.projection.config

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler

@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(prefix = "app.catalog.projection", name = ["enabled"], havingValue = "true")
class CatalogProjectionConfig {
    @Bean
    fun catalogProjectionTaskScheduler() = ThreadPoolTaskScheduler().apply {
        poolSize = 1
        setThreadNamePrefix("catalog-projection-")
    }
}
