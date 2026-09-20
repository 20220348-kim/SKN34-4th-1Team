package ai.govbiz.core.supportprogram.service.sync.config

import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(SupportProgramIndexSyncProperties::class)
class SupportProgramIndexSyncConfig {
    /** 기업마당 API 수집이 색인 작업을 지연시키지 않도록 전용 실행 스레드를 사용합니다. */
    @Bean
    fun supportProgramIndexTaskScheduler() = ThreadPoolTaskScheduler().apply {
        poolSize = 1
        setThreadNamePrefix("support-program-index-")
    }

    @Bean
    fun taskScheduler() = ThreadPoolTaskScheduler().apply {
        poolSize = 1
        setThreadNamePrefix("catalog-sync-")
    }
}
