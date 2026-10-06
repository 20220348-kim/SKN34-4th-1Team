package ai.govbiz.core.notification.repository

import ai.govbiz.core.notification.domain.DeadlineReminderSetting
import ai.govbiz.core.notification.repository.mapper.NotificationSettingsMapper
import java.time.Clock
import java.time.LocalDateTime
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional

/** 계정별 알림 설정을 MySQL에 저장하고 읽습니다. 저장한 적이 없으면 기본 설정(꺼짐)입니다. */
@Repository
class NotificationSettingsRepository(
    private val mapper: NotificationSettingsMapper,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {
    fun deadlineReminder(accountId: Long): DeadlineReminderSetting = mapper.find(accountId)?.let {
        DeadlineReminderSetting(it.deadlineReminderEnabled, it.deadlineReminderEmail, it.deadlineReminderPush)
    } ?: DeadlineReminderSetting.DEFAULT

    @Transactional
    fun saveDeadlineReminder(accountId: Long, setting: DeadlineReminderSetting): DeadlineReminderSetting {
        mapper.upsert(accountId, setting.enabled, setting.email, setting.push, LocalDateTime.now(clock))
        return deadlineReminder(accountId)
    }
}
