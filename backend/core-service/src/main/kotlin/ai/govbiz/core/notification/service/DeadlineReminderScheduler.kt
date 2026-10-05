package ai.govbiz.core.notification.service

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.scheduling.annotation.EnableScheduling
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component

/** `DEADLINE_REMINDER_ENABLED=true`일 때만 만들어집니다. 이전 실행이 끝난 뒤 1분 간격으로 예약·발송합니다. */
@Component
@EnableScheduling
@ConditionalOnProperty(prefix = "app.deadline-reminder", name = ["enabled"], havingValue = "true")
class DeadlineReminderScheduler(private val service: DeadlineReminderService) {
    @Scheduled(fixedDelayString = "PT1M", initialDelayString = "PT1M", scheduler = "deadlineReminderTaskScheduler")
    fun run() = service.run()
}
