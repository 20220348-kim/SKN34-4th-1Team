package ai.govbiz.core.notification.service

import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.helper.AccountTestHelper.anyValue
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.dailyreport.client.DailyReportMailClient
import ai.govbiz.core.dailyreport.client.DailyReportPushClient
import ai.govbiz.core.dailyreport.client.exception.DailyReportMailException
import ai.govbiz.core.dailyreport.client.exception.DailyReportPushException
import ai.govbiz.core.dailyreport.domain.DailyReportPushDevice
import ai.govbiz.core.dailyreport.domain.DailyReportPushOutcome
import ai.govbiz.core.dailyreport.domain.DailyReportSubscription
import ai.govbiz.core.dailyreport.repository.DailyReportPushRepository
import ai.govbiz.core.dailyreport.repository.DailyReportRepository
import ai.govbiz.core.dailyreport.service.DailyReportPushService
import ai.govbiz.core.notification.config.DeadlineReminderProperties
import ai.govbiz.core.notification.domain.DeadlineReminder
import ai.govbiz.core.notification.domain.DeadlineReminderChannel.EMAIL
import ai.govbiz.core.notification.domain.DeadlineReminderChannel.PUSH
import ai.govbiz.core.notification.domain.DeadlineReminderOutcome
import ai.govbiz.core.notification.domain.DeadlineReminderSetting
import ai.govbiz.core.notification.domain.DeadlineReminderStatus
import ai.govbiz.core.notification.repository.DeadlineReminderRepository
import ai.govbiz.core.notification.repository.NotificationSettingsRepository
import ai.govbiz.core.supportprogram.domain.SavedSupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import ai.govbiz.core.supportprogram.repository.SavedSupportProgramRepository
import java.time.LocalDate
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.mockito.ArgumentMatchers.anyInt
import org.mockito.ArgumentMatchers.anyLong
import org.mockito.Mockito.clearInvocations
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.doThrow
import org.mockito.Mockito.mock
import org.mockito.Mockito.never
import org.mockito.Mockito.times
import org.mockito.Mockito.verify
import org.mockito.Mockito.verifyNoInteractions

/** FIXED_CLOCK은 서울 2026-09-06 12시입니다. 공고 마감일은 3일 뒤인 9월 9일입니다. */
class DeadlineReminderServiceTest {
    private val reminders = mock(DeadlineReminderRepository::class.java)
    private val settings = mock(NotificationSettingsRepository::class.java)
    private val accounts = mock(AccountRepository::class.java)
    private val savedPrograms = mock(SavedSupportProgramRepository::class.java)
    private val reports = mock(DailyReportRepository::class.java)
    private val mail = mock(DailyReportMailClient::class.java)
    private val push = mock(DailyReportPushService::class.java)
    private val pushDevices = mock(DailyReportPushRepository::class.java)
    private val pushClient = mock(DailyReportPushClient::class.java)
    private val account = AccountTestHelper.account(id = 7, email = "member@example.org")
    private val today = LocalDate.of(2026, 9, 6)
    private val due = today.plusDays(3)
    private val reminder = DeadlineReminder(1, 7, "BIZINFO", "PBLN_1", due, DeadlineReminderStatus.PENDING, DeadlineReminderStatus.PENDING)
    private val program = SupportProgram(
        id = "PBLN_1", sourceCode = "BIZINFO", title = "AI 바우처 지원사업", organization = "정보통신산업진흥원", summary = "요약",
        categories = emptyList(), regions = emptyList(), targetDescription = "중소기업", applicationPeriod = "2026-08-01 ~ 2026-09-09",
        applicationStartDate = LocalDate.of(2026, 8, 1), applicationEndDate = due, status = SupportProgramStatus.OPEN,
        sourceName = "기업마당", sourceUrl = "https://www.bizinfo.go.kr/web/detail?pblancId=PBLN_1", matchedReasons = emptyList(),
    )
    private val phone = DailyReportPushDevice("device-phone", "ExpoPushToken[phone]")
    private val tablet = DailyReportPushDevice("device-tablet", "ExpoPushToken[tablet]")

    @BeforeEach
    fun eligibleReminder() {
        doReturn(listOf(reminder)).`when`(reminders).dispatchable(50)
        doReturn(true).`when`(reminders).claim(1, EMAIL)
        doReturn(true).`when`(reminders).claim(1, PUSH)
        doReturn(account).`when`(accounts).findById(7)
        doReturn(DeadlineReminderSetting(enabled = true, email = true, push = true)).`when`(settings).deadlineReminder(7)
        doReturn(SavedSupportProgram(AccountTestHelper.NOW, program)).`when`(savedPrograms).findByIdentity(7, "BIZINFO", "PBLN_1")
        doReturn(DailyReportSubscription(7, "", false, "member@example.org", AccountTestHelper.NOW, null)).`when`(reports).subscription(7)
        doReturn(true).`when`(mail).isAvailable()
        doReturn(true).`when`(push).available()
        doReturn(listOf(phone)).`when`(pushDevices).activeDevices(7)
        doReturn(DailyReportPushOutcome("ACCEPTED", "ticket")).`when`(pushClient).sendDeadlineReminder(phone.expoToken, program.title, "BIZINFO", "PBLN_1", due, 3)
    }

    @Test
    fun beforeSendHourOnlyExpiresStaleWorkAndNeverReservesOrSends() {
        service(sendHour = 13).run()
        verify(reminders).expire()
        verify(reminders, never()).reserveDue(anyValue())
        verify(reminders, never()).dispatchable(anyInt())
        verifyNoInteractions(mail, pushClient)
    }

    @Test
    fun eligibleReminderIsReservedForTodayAndSentOnceOnEachSelectedChannel() {
        service().run()
        verify(reminders).reserveDue(today)
        verify(mail, times(1)).sendDeadlineReminder("member@example.org", "AI 바우처 지원사업", "BIZINFO", "PBLN_1", due, 3)
        verify(pushClient, times(1)).sendDeadlineReminder(phone.expoToken, "AI 바우처 지원사업", "BIZINFO", "PBLN_1", due, 3)
        verify(reminders).finish(1, EMAIL, DeadlineReminderOutcome.SENT)
        verify(reminders).finish(1, PUSH, DeadlineReminderOutcome.SENT)
    }

    @Test
    fun channelClaimedElsewhereOrAlreadyFinishedIsNeverSentAgain() {
        doReturn(false).`when`(reminders).claim(1, EMAIL)
        doReturn(listOf(reminder.copy(pushStatus = DeadlineReminderStatus.NOT_REQUESTED))).`when`(reminders).dispatchable(50)
        service().run()
        verify(reminders, never()).claim(1, PUSH)
        verify(reminders, never()).finish(anyLong(), anyValue(), anyValue())
        verifyNoInteractions(pushClient)
        verify(mail, never()).sendDeadlineReminder(anyValue(), anyValue(), anyValue(), anyValue(), anyValue(), anyInt())
    }

    @Test
    fun emailWithoutConfirmedCurrentAddressOrSmtpIsSkippedWithAReason() {
        doReturn(DailyReportSubscription(7, "", false, "old@example.org", AccountTestHelper.NOW, null)).`when`(reports).subscription(7)
        service().run()
        verify(reminders).finish(1, EMAIL, DeadlineReminderOutcome.skipped("EmailNotConfirmed"))

        clearInvocations(reminders)
        doReturn(false).`when`(mail).isAvailable()
        service().run()
        verify(reminders).finish(1, EMAIL, DeadlineReminderOutcome.skipped("MailUnavailable"))
        verify(mail, never()).sendDeadlineReminder(anyValue(), anyValue(), anyValue(), anyValue(), anyValue(), anyInt())
    }

    @Test
    fun smtpFailureIsUnknownAndNotRetriedAutomatically() {
        doThrow(DailyReportMailException()).`when`(mail).sendDeadlineReminder("member@example.org", program.title, "BIZINFO", "PBLN_1", due, 3)
        service().run()
        verify(reminders).finish(1, EMAIL, DeadlineReminderOutcome.unknown())
        verify(mail, times(1)).sendDeadlineReminder(anyValue(), anyValue(), anyValue(), anyValue(), anyValue(), anyInt())
    }

    @Test
    fun removedClosedOrRescheduledProgramIsSkippedOnBothChannels() {
        listOf(
            null to "ProgramUnavailable",
            program.copy(status = SupportProgramStatus.CLOSED) to "ProgramClosed",
            program.copy(applicationEndDate = due.plusDays(7)) to "DeadlineChanged",
        ).forEach { (current, reason) ->
            clearInvocations(reminders)
            doReturn(current?.let { SavedSupportProgram(AccountTestHelper.NOW, it) }).`when`(savedPrograms).findByIdentity(7, "BIZINFO", "PBLN_1")
            service().run()
            verify(reminders).finish(1, EMAIL, DeadlineReminderOutcome.skipped(reason))
            verify(reminders).finish(1, PUSH, DeadlineReminderOutcome.skipped(reason))
        }
        verify(mail, never()).sendDeadlineReminder(anyValue(), anyValue(), anyValue(), anyValue(), anyValue(), anyInt())
        verifyNoInteractions(pushClient)
    }

    @Test
    fun turnedOffSettingOrSuspendedAccountIsSkippedBeforeAnyProviderCall() {
        doReturn(DeadlineReminderSetting(enabled = true, email = false, push = true)).`when`(settings).deadlineReminder(7)
        service().run()
        verify(reminders).finish(1, EMAIL, DeadlineReminderOutcome.skipped("ReminderDisabled"))
        verify(reminders).finish(1, PUSH, DeadlineReminderOutcome.SENT)

        clearInvocations(reminders, pushClient)
        doReturn(AccountTestHelper.account(id = 7, suspendedAt = AccountTestHelper.NOW)).`when`(accounts).findById(7)
        service().run()
        verify(reminders).finish(1, EMAIL, DeadlineReminderOutcome.skipped("AccountInactive"))
        verify(reminders).finish(1, PUSH, DeadlineReminderOutcome.skipped("AccountInactive"))
        verifyNoInteractions(pushClient)
    }

    @Test
    fun pushWithoutConfiguredDeliveryOrActiveDeviceIsSkippedExplicitly() {
        doReturn(false).`when`(push).available()
        service().run()
        verify(reminders).finish(1, PUSH, DeadlineReminderOutcome.skipped("PushUnavailable"))

        clearInvocations(reminders)
        doReturn(true).`when`(push).available()
        doReturn(emptyList<DailyReportPushDevice>()).`when`(pushDevices).activeDevices(7)
        service().run()
        verify(reminders).finish(1, PUSH, DeadlineReminderOutcome.skipped("NoActiveDevice"))
        verifyNoInteractions(pushClient)
    }

    @Test
    fun anyAcceptedDeviceMakesPushSentAndUnregisteredTokenIsDisabled() {
        doReturn(listOf(tablet, phone)).`when`(pushDevices).activeDevices(7)
        doReturn(DailyReportPushOutcome("FAILED", errorCode = "DeviceNotRegistered")).`when`(pushClient)
            .sendDeadlineReminder(tablet.expoToken, program.title, "BIZINFO", "PBLN_1", due, 3)
        service().run()
        verify(reminders).finish(1, PUSH, DeadlineReminderOutcome.SENT)
        verify(pushDevices).invalidateToken(tablet)
        verify(pushDevices, never()).invalidateToken(phone)
    }

    @Test
    fun unconfirmedPushIsUnknownAndRejectedPushIsFailedWithTheProviderCode() {
        doThrow(DailyReportPushException()).`when`(pushClient).sendDeadlineReminder(phone.expoToken, program.title, "BIZINFO", "PBLN_1", due, 3)
        service().run()
        verify(reminders).finish(1, PUSH, DeadlineReminderOutcome.unknown())

        clearInvocations(reminders)
        doReturn(DailyReportPushOutcome("FAILED", errorCode = "MessageRateExceeded")).`when`(pushClient)
            .sendDeadlineReminder(phone.expoToken, program.title, "BIZINFO", "PBLN_1", due, 3)
        service().run()
        verify(reminders).finish(1, PUSH, DeadlineReminderOutcome.failed("MessageRateExceeded"))
    }

    @Test
    fun failureBeforeSendingIsRecordedAsFailedInsteadOfLeftSending() {
        doThrow(IllegalStateException("database unavailable")).`when`(accounts).findById(7)
        service().run()
        verify(reminders).finish(1, EMAIL, DeadlineReminderOutcome.failed("CheckFailed"))
        verify(reminders).finish(1, PUSH, DeadlineReminderOutcome.failed("CheckFailed"))
        verifyNoInteractions(pushClient)
    }

    private fun service(sendHour: Int = 9) = DeadlineReminderService(
        reminders, settings, accounts, savedPrograms, reports, mail, push, pushDevices, pushClient,
        DeadlineReminderProperties(enabled = true, sendHour = sendHour), AccountTestHelper.FIXED_CLOCK,
    )
}
