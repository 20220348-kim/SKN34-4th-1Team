package ai.govbiz.core.applicationpreparation.config

import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler

/** 문서 생성 작업은 긴 MCP 호출이라 공고 동기화·발견 scheduler와 스레드를 나누지 않는다. */
@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(name = ["app.application-document.jobs.enabled"], havingValue = "true", matchIfMissing = true)
class ApplicationDocumentGenerationConfig {
    @Bean fun applicationDocumentGenerationTaskScheduler() = ThreadPoolTaskScheduler().apply {
        poolSize = 1
        setThreadNamePrefix("application-document-jobs-")
    }

    @Bean(destroyMethod = "shutdown")
    fun applicationDocumentGenerationExecutor(@Value("\${app.application-document.jobs.concurrency:2}") concurrency: Int): ThreadPoolExecutor =
        ThreadPoolExecutor(concurrency, concurrency, 60, TimeUnit.SECONDS, LinkedBlockingQueue(concurrency)) { runnable ->
            Thread(runnable, "application-document-generation").apply { isDaemon = true }
        }
}
