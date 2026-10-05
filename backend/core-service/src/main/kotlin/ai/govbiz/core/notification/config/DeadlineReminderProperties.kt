package ai.govbiz.core.notification.config

import org.springframework.boot.context.properties.ConfigurationProperties

/**
 * 관심 공고 마감 알림 스케줄러 설정입니다. 기본은 꺼져 있습니다. 메일은 맞춤 리포트의 SMTP 설정(`app.daily-report.mail-enabled`),
 * 앱 알림은 리포트 앱 푸시 설정(`app.daily-report.push.enabled`)을 그대로 따릅니다.
 */
@ConfigurationProperties(prefix = "app.deadline-reminder")
class DeadlineReminderProperties(
    val enabled: Boolean = false,
    /** 서울 기준 이 시각 이후에만 예약·발송합니다. */
    val sendHour: Int = 9,
    /** 스케줄러 한 번에 발송을 시도하는 알림 상한입니다. 남은 알림은 다음 실행에서 이어 보냅니다. */
    val maxPerRun: Int = 50,
) {
    init {
        require(sendHour in 0..23) { "app.deadline-reminder.send-hour must be 0..23" }
        require(maxPerRun in 1..500) { "app.deadline-reminder.max-per-run must be 1..500" }
    }
}
