package ai.govbiz.core.notification.service

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.dailyreport.client.DailyReportMailClient
import ai.govbiz.core.dailyreport.repository.DailyReportRepository
import ai.govbiz.core.dailyreport.service.DailyReportPushService
import ai.govbiz.core.notification.config.DeadlineReminderProperties
import ai.govbiz.core.notification.domain.DeadlineReminderSetting
import ai.govbiz.core.notification.domain.exception.NotificationSettingsErrorCode
import ai.govbiz.core.notification.domain.exception.NotificationSettingsException
import ai.govbiz.core.notification.repository.NotificationSettingsRepository
import ai.govbiz.core.notification.service.dto.NotificationSettingsResult
import org.springframework.stereotype.Service

/**
 * 로그인 회원 본인의 알림 설정을 읽고 저장합니다. 이메일 확인 여부는 맞춤 리포트의 수신 주소 확인을, 발송 가능 여부는
 * 리포트 메일·앱 푸시 설정을 그대로 씁니다. 끄기와 채널 해제는 언제든 저장하고, 켤 때 고른 채널은 지금 보낼 수 있어야 합니다.
 */
@Service
class NotificationSettingsService(
    private val repository: NotificationSettingsRepository,
    private val reports: DailyReportRepository,
    private val mail: DailyReportMailClient,
    private val push: DailyReportPushService,
    private val properties: DeadlineReminderProperties,
) {
    fun settings(account: Account): NotificationSettingsResult = result(account, repository.deadlineReminder(account.id))

    fun updateDeadlineReminder(account: Account, setting: DeadlineReminderSetting): NotificationSettingsResult {
        if (setting.enabled && setting.email) {
            if (!mail.isAvailable()) throw NotificationSettingsException(NotificationSettingsErrorCode.EMAIL_DELIVERY_UNAVAILABLE)
            if (!emailConfirmed(account)) throw NotificationSettingsException(NotificationSettingsErrorCode.EMAIL_CONFIRMATION_REQUIRED)
        }
        if (setting.enabled && setting.push && !push.available()) {
            throw NotificationSettingsException(NotificationSettingsErrorCode.PUSH_DELIVERY_UNAVAILABLE)
        }
        return result(account, repository.saveDeadlineReminder(account.id, setting))
    }

    private fun result(account: Account, setting: DeadlineReminderSetting) = NotificationSettingsResult(
        deadlineReminder = setting,
        emailConfirmed = emailConfirmed(account),
        emailDeliveryAvailable = mail.isAvailable(),
        pushDeliveryAvailable = push.available(),
        pushDeviceRegistered = push.hasSubscriber(account.id),
        schedulerEnabled = properties.enabled,
        sendHour = properties.sendHour,
    )

    private fun emailConfirmed(account: Account) = reports.subscription(account.id)?.isEmailConfirmedFor(account.email) == true
}
