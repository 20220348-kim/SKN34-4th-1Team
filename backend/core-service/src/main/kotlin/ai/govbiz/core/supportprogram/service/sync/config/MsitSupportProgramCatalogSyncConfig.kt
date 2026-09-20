package ai.govbiz.core.supportprogram.service.sync.config

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.scheduling.annotation.EnableScheduling
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler

@Configuration(proxyBeanMethods = false)
@EnableScheduling
@EnableConfigurationProperties(MsitSupportProgramCatalogSyncProperties::class)
class MsitSupportProgramCatalogSyncConfig {
    /** 많은 페이지를 읽는 동안 다른 제공처의 수집 스레드를 점유하지 않습니다. */
    @Bean
    @ConditionalOnProperty(prefix = "app.msit.sync", name = ["enabled"], havingValue = "true", matchIfMissing = false)
    fun msitCatalogTaskScheduler() = ThreadPoolTaskScheduler().apply {
        poolSize = 1
        setThreadNamePrefix("msit-catalog-sync-")
    }
}
