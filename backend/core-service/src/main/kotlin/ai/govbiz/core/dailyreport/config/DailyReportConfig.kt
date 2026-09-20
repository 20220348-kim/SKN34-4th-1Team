package ai.govbiz.core.dailyreport.config

import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(DailyReportProperties::class, DailyReportQueueProperties::class)
class DailyReportConfig(properties: DailyReportProperties, queue: DailyReportQueueProperties) {
    init {
        require(!properties.enabled || queue.enabled) {
            "정기 리포트 실행에는 app.daily-report.queue.enabled=true가 필요합니다."
        }
    }

    /** 공고 수집이 정기 리포트 생성·발송 예약을 지연시키지 않도록 실행 스레드를 분리한다. */
    @Bean
    @ConditionalOnProperty(prefix = "app.daily-report", name = ["enabled"], havingValue = "true")
    fun dailyReportTaskScheduler() = ThreadPoolTaskScheduler().apply {
        poolSize = 1
        setThreadNamePrefix("daily-report-schedule-")
    }
}
