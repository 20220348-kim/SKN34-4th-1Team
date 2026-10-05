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
) {
    companion object {
        fun from(result: NotificationSettingsResult) = NotificationSettingsResponse(
            DeadlineReminderSettingResponse(result.deadlineReminder.enabled, result.deadlineReminder.daysBefore,
                result.deadlineReminder.email, result.deadlineReminder.push),
            result.emailConfirmed, result.emailDeliveryAvailable, result.pushDeliveryAvailable,
            result.pushDeviceRegistered, result.schedulerEnabled, result.sendHour,
        )
    }
}

data class DeadlineReminderSettingResponse(val enabled: Boolean, val daysBefore: Int, val email: Boolean, val push: Boolean)
