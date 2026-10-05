package ai.govbiz.core.notification.config

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(DeadlineReminderProperties::class)
class DeadlineReminderConfig {
    /** 공고 수집·리포트 예약이 마감 알림 발송을 지연시키지 않도록 켜져 있을 때만 전용 단일 스레드를 만든다. */
    @Bean
    @ConditionalOnProperty(prefix = "app.deadline-reminder", name = ["enabled"], havingValue = "true")
    fun deadlineReminderTaskScheduler() = ThreadPoolTaskScheduler().apply {
        poolSize = 1
        setThreadNamePrefix("deadline-reminder-")
    }
}
