package ai.govbiz.core.notification.service.dto

import ai.govbiz.core.notification.domain.DeadlineReminderSetting

/** 저장한 알림 설정과, 그 설정이 지금 실제로 발송될 수 있는지 판단할 상태입니다. */
data class NotificationSettingsResult(
    val deadlineReminder: DeadlineReminderSetting,
    /** 맞춤 리포트 화면에서 확인을 마친 수신 주소가 지금 계정 이메일과 같은지입니다. */
    val emailConfirmed: Boolean,
    val emailDeliveryAvailable: Boolean,
    val pushDeliveryAvailable: Boolean,
    /** 앱 알림을 켠 유효한 기기가 하나 이상 있는지입니다. */
    val pushDeviceRegistered: Boolean,
    val schedulerEnabled: Boolean,
    val sendHour: Int,
)
