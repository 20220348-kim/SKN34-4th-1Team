package ai.govbiz.core.notification.controller.dto

import ai.govbiz.core.notification.domain.DeadlineReminderSetting
import jakarta.validation.Valid
import jakarta.validation.constraints.AssertTrue
import jakarta.validation.constraints.Max
import jakarta.validation.constraints.Min

/** 알림 설정 전체를 바꿉니다. 지금 저장할 수 있는 항목은 관심 공고 마감 알림뿐입니다. */
data class NotificationSettingsRequest(@field:Valid val deadlineReminder: DeadlineReminderSettingRequest)

data class DeadlineReminderSettingRequest(
    val enabled: Boolean,
    @field:Min(1) @field:Max(7) val daysBefore: Int,
    val email: Boolean,
    val push: Boolean,
) {
    /** 켜려면 이메일·앱 알림 중 하나 이상을 골라야 합니다. */
    @get:AssertTrue
    val channelSelected: Boolean
        get() = !enabled || email || push

    fun toDomain() = DeadlineReminderSetting(enabled, daysBefore, email, push)
}
