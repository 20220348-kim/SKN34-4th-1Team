package ai.govbiz.core.notification.controller.dto

import ai.govbiz.core.notification.domain.DeadlineReminderSetting
import jakarta.validation.Valid
import jakarta.validation.constraints.AssertTrue

/** 알림 설정 전체를 바꿉니다. 지금 저장할 수 있는 항목은 관심 공고 마감 알림뿐입니다. */
data class NotificationSettingsRequest(@field:Valid val deadlineReminder: DeadlineReminderSettingRequest)

/** 알림 시점은 고르지 않고 마감 7·3·1일 전으로 정해져 있습니다. 예전 클라이언트가 보낸 `daysBefore`는 무시합니다. */
data class DeadlineReminderSettingRequest(
    val enabled: Boolean,
    val email: Boolean,
    val push: Boolean,
) {
    /** 켜려면 이메일·앱 알림 중 하나 이상을 골라야 합니다. */
    @get:AssertTrue
    val channelSelected: Boolean
        get() = !enabled || email || push

    fun toDomain() = DeadlineReminderSetting(enabled, email, push)
}
