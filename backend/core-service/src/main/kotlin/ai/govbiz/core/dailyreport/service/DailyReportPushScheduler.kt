package ai.govbiz.core.dailyreport.service

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.scheduling.annotation.EnableScheduling
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component

@Component
@EnableScheduling
@ConditionalOnProperty(prefix = "app.daily-report.push", name = ["enabled"], havingValue = "true")
class DailyReportPushScheduler(private val service: DailyReportPushService) {
    @Scheduled(fixedDelayString = "PT30S", initialDelayString = "PT30S", scheduler = "dailyReportPushTaskScheduler")
    fun run() = service.dispatch()
}
