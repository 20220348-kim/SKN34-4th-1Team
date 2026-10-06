package ai.govbiz.core.notification.controller.dto

import ai.govbiz.core.notification.service.dto.NotificationSettingsResult

data class NotificationSettingsResponse(
    val deadlineReminder: DeadlineReminderSettingResponse,
    val emailConfirmed: Boolean,
    val emailDeliveryAvailable: Boolean,
    val pushDeliveryAvailable: Boolean,
    val pushDeviceRegistered: Boolean,
    val schedulerEnabled: Boolean,
    val sendHour: Int,
    /** 마감 며칠 전에 보내는지입니다(큰 값부터). */
    val reminderDaysBefore: List<Int>,
) {
    companion object {
        fun from(result: NotificationSettingsResult) = NotificationSettingsResponse(
            DeadlineReminderSettingResponse(result.deadlineReminder.enabled, result.deadlineReminder.email, result.deadlineReminder.push),
            result.emailConfirmed, result.emailDeliveryAvailable, result.pushDeliveryAvailable,
            result.pushDeviceRegistered, result.schedulerEnabled, result.sendHour, result.reminderDaysBefore,
        )
    }
}

data class DeadlineReminderSettingResponse(val enabled: Boolean, val email: Boolean, val push: Boolean)
