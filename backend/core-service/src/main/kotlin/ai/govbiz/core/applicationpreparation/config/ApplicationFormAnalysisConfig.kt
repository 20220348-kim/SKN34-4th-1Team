package ai.govbiz.core.applicationpreparation.config

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler

/** 긴 discovery 실행이 공고 동기화의 단일 scheduler 스레드를 점유하지 않게 한다. */
@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(name = ["app.application-form-analysis.enabled"], havingValue = "true")
class ApplicationFormAnalysisConfig {
    @Bean fun applicationFormAnalysisTaskScheduler() = ThreadPoolTaskScheduler().apply {
        poolSize = 1
        setThreadNamePrefix("application-form-analysis-")
    }
}
