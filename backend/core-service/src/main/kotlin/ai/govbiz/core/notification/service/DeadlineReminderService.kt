package ai.govbiz.core.notification.service

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.dailyreport.client.DailyReportMailClient
import ai.govbiz.core.dailyreport.client.DailyReportPushClient
import ai.govbiz.core.dailyreport.domain.DailyReportPushDevice
import ai.govbiz.core.dailyreport.domain.DailyReportPushOutcome
import ai.govbiz.core.dailyreport.repository.DailyReportPushRepository
import ai.govbiz.core.dailyreport.repository.DailyReportRepository
import ai.govbiz.core.dailyreport.service.DailyReportPushService
import ai.govbiz.core.notification.config.DeadlineReminderProperties
import ai.govbiz.core.notification.domain.DeadlineReminder
import ai.govbiz.core.notification.domain.DeadlineReminderChannel
import ai.govbiz.core.notification.domain.DeadlineReminderOutcome
import ai.govbiz.core.notification.domain.DeadlineReminderStatus
import ai.govbiz.core.notification.repository.DeadlineReminderRepository
import ai.govbiz.core.notification.repository.NotificationSettingsRepository
import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import ai.govbiz.core.supportprogram.repository.SavedSupportProgramRepository
import java.time.Clock
import java.time.LocalDate
import java.time.LocalTime
import java.time.temporal.ChronoUnit
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Service

/**
 * 관심 공고 마감 알림을 예약하고 채널별로 한 번만 보냅니다.
 *
 * `DeadlineReminderScheduler → DeadlineReminderService → DeadlineReminderRepository → MyBatis Mapper → XML → MySQL`로
 * 오늘 마감 7·3·1일 전이 된 관심 공고를 일수마다 예약하고, 채널을 PENDING → SENDING으로 선점한 뒤에만 기존 리포트 SMTP·Expo 발송 경계를 부릅니다.
 * 발송 직전에 계정·설정·관심 공고·접수 상태(서울 날짜로 다시 계산)·수신 주소·기기를 다시 확인하고, 보낼 수 없으면 이유 코드와 함께
 * SKIPPED로 끝냅니다. 결과를 알 수 없는 발송은 UNKNOWN으로 남기고 자동으로 다시 보내지 않습니다.
 */
@Service
class DeadlineReminderService(
    private val reminders: DeadlineReminderRepository,
    private val settings: NotificationSettingsRepository,
    private val accounts: AccountRepository,
    private val savedPrograms: SavedSupportProgramRepository,
    private val reports: DailyReportRepository,
    private val mail: DailyReportMailClient,
    private val push: DailyReportPushService,
    private val pushDevices: DailyReportPushRepository,
    private val pushClient: DailyReportPushClient,
    private val properties: DeadlineReminderProperties,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    fun run() {
        reminders.expire()
        if (LocalTime.now(clock).hour < properties.sendHour) return
        val today = LocalDate.now(clock)
        reminders.reserveDue(today)
        for (reminder in reminders.dispatchable(properties.maxPerRun)) {
            if (LocalDate.now(clock) != today) break
            for (channel in DeadlineReminderChannel.entries) {
                if (reminder.status(channel) != DeadlineReminderStatus.PENDING) continue
                try {
                    deliver(reminder, channel, today)
                } catch (_: Exception) {
                    // 결과 저장까지 끝내지 못한 SENDING은 만료 정리에서 UNKNOWN이 되며 다시 보내지 않는다.
                    log.warn("Deadline reminder delivery was not recorded; reminderId={}, channel={}", reminder.id, channel)
                }
            }
        }
    }

    private fun deliver(reminder: DeadlineReminder, channel: DeadlineReminderChannel, today: LocalDate) {
        if (!reminders.claim(reminder.id, channel)) return
        val outcome = try {
            attempt(reminder, channel, today)
        } catch (_: Exception) {
            // 외부 발송 전 확인 단계의 실패다. 아무것도 보내지 않았으므로 FAILED로 끝낸다.
            log.warn("Deadline reminder check failed before sending; reminderId={}, channel={}", reminder.id, channel)
            DeadlineReminderOutcome.failed("CheckFailed")
        }
        reminders.finish(reminder.id, channel, outcome)
    }

    private fun attempt(reminder: DeadlineReminder, channel: DeadlineReminderChannel, today: LocalDate): DeadlineReminderOutcome {
        val account = accounts.findById(reminder.accountId)?.takeUnless { it.isSuspended }
            ?: return DeadlineReminderOutcome.skipped("AccountInactive")
        val setting = settings.deadlineReminder(account.id)
        val selected = when (channel) {
            DeadlineReminderChannel.EMAIL -> setting.email
            DeadlineReminderChannel.PUSH -> setting.push
        }
        if (!setting.enabled || !selected) return DeadlineReminderOutcome.skipped("ReminderDisabled")
        // 관심 공고함에서 뺐거나 동기화로 더 이상 노출되지 않는 공고는 찾지 못한다.
        val program = savedPrograms.findByIdentity(account.id, reminder.sourceCode, reminder.sourceProgramId)?.program
            ?: return DeadlineReminderOutcome.skipped("ProgramUnavailable")
        if (program.status == SupportProgramStatus.CLOSED) return DeadlineReminderOutcome.skipped("ProgramClosed")
        if (program.applicationEndDate != reminder.dueDate) return DeadlineReminderOutcome.skipped("DeadlineChanged")
        val daysLeft = ChronoUnit.DAYS.between(today, reminder.dueDate).toInt()
        if (daysLeft < 0) return DeadlineReminderOutcome.skipped("ProgramClosed")
        return when (channel) {
            DeadlineReminderChannel.EMAIL -> sendEmail(account, program, reminder.dueDate, daysLeft)
            DeadlineReminderChannel.PUSH -> sendPush(account, program, reminder.dueDate, daysLeft)
        }
    }

    private fun sendEmail(account: Account, program: SupportProgram, dueDate: LocalDate, daysLeft: Int): DeadlineReminderOutcome {
        if (!mail.isAvailable()) return DeadlineReminderOutcome.skipped("MailUnavailable")
        if (reports.subscription(account.id)?.isEmailConfirmedFor(account.email) != true) {
            return DeadlineReminderOutcome.skipped("EmailNotConfirmed")
        }
        return try {
            mail.sendDeadlineReminder(account.email, program.title, program.sourceCode, program.id, dueDate, daysLeft)
            DeadlineReminderOutcome.SENT
        } catch (_: Exception) {
            // SMTP timeout은 서버 접수 이후일 수도 있다. 자동 재발송하지 않고 확인 필요 상태로 남긴다.
            log.warn("Deadline reminder email outcome unknown; accountId={}", account.id)
            DeadlineReminderOutcome.unknown()
        }
    }

    /** 유효한 기기마다 한 번 보냅니다. 하나라도 Expo가 접수하면 SENT, 접수 없이 결과를 모르는 기기가 있으면 UNKNOWN입니다. */
    private fun sendPush(account: Account, program: SupportProgram, dueDate: LocalDate, daysLeft: Int): DeadlineReminderOutcome {
        if (!push.available()) return DeadlineReminderOutcome.skipped("PushUnavailable")
        val devices = pushDevices.activeDevices(account.id)
        if (devices.isEmpty()) return DeadlineReminderOutcome.skipped("NoActiveDevice")
        val results: List<DailyReportPushOutcome?> = devices.map { device ->
            val result = try {
                pushClient.sendDeadlineReminder(device.expoToken, program.title, program.sourceCode, program.id, dueDate, daysLeft)
            } catch (_: Exception) {
                log.warn("Deadline reminder push outcome unknown; accountId={}", account.id)
                null
            }
            if (result?.errorCode == "DeviceNotRegistered") invalidate(device)
            result
        }
        return when {
            results.any { it?.status == "ACCEPTED" } -> DeadlineReminderOutcome.SENT
            results.any { it == null } -> DeadlineReminderOutcome.unknown()
            else -> DeadlineReminderOutcome.failed(results.firstNotNullOfOrNull { it?.errorCode } ?: "PushRejected")
        }
    }

    private fun invalidate(device: DailyReportPushDevice) {
        try {
            pushDevices.invalidateToken(device)
        } catch (_: Exception) {
            log.warn("Unregistered push token could not be disabled; deviceId={}", device.deviceId)
        }
    }
}
