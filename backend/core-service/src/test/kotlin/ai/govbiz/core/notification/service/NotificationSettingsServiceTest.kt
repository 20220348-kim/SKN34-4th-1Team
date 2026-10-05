package ai.govbiz.core.notification.service

import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.helper.AccountTestHelper.anyValue
import ai.govbiz.core.dailyreport.client.DailyReportMailClient
import ai.govbiz.core.dailyreport.domain.DailyReportSubscription
import ai.govbiz.core.dailyreport.repository.DailyReportRepository
import ai.govbiz.core.dailyreport.service.DailyReportPushService
import ai.govbiz.core.notification.config.DeadlineReminderProperties
import ai.govbiz.core.notification.domain.DeadlineReminderSetting
import ai.govbiz.core.notification.domain.exception.NotificationSettingsErrorCode
import ai.govbiz.core.notification.domain.exception.NotificationSettingsException
import ai.govbiz.core.notification.repository.NotificationSettingsRepository
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.mockito.ArgumentMatchers.anyLong
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.mock
import org.mockito.Mockito.never
import org.mockito.Mockito.verify

class NotificationSettingsServiceTest {
    private val repository = mock(NotificationSettingsRepository::class.java)
    private val reports = mock(DailyReportRepository::class.java)
    private val mail = mock(DailyReportMailClient::class.java)
    private val push = mock(DailyReportPushService::class.java)
    private val account = AccountTestHelper.account(id = 3, email = "member@example.org")
    private val service = NotificationSettingsService(repository, reports, mail, push, DeadlineReminderProperties(enabled = false, sendHour = 9))
    private val emailOn = DeadlineReminderSetting(enabled = true, daysBefore = 3, email = true, push = false)
    private val pushOn = DeadlineReminderSetting(enabled = true, daysBefore = 1, email = false, push = true)

    @BeforeEach
    fun deliveryConfigured() {
        doReturn(DeadlineReminderSetting.DEFAULT).`when`(repository).deadlineReminder(3)
        doReturn(true).`when`(mail).isAvailable()
        doReturn(true).`when`(push).available()
        doReturn(false).`when`(push).hasSubscriber(3)
        doReturn(DailyReportSubscription(3, "", false, "member@example.org", AccountTestHelper.NOW, null)).`when`(reports).subscription(3)
    }

    @Test
    fun accountWithoutSavedSettingsGetsTheOffDefaultAndCurrentDeliveryState() {
        doReturn(null).`when`(reports).subscription(3)
        val result = service.settings(account)
        assertEquals(DeadlineReminderSetting(enabled = false, daysBefore = 3, email = false, push = false), result.deadlineReminder)
        assertFalse(result.emailConfirmed)
        assertTrue(result.emailDeliveryAvailable)
        assertTrue(result.pushDeliveryAvailable)
        assertFalse(result.pushDeviceRegistered)
        assertFalse(result.schedulerEnabled)
        assertEquals(9, result.sendHour)
    }

    @Test
    fun enablingEmailNeedsSmtpAndTheReportAddressConfirmationOfTheCurrentEmail() {
        doReturn(false).`when`(mail).isAvailable()
        assertEquals(NotificationSettingsErrorCode.EMAIL_DELIVERY_UNAVAILABLE,
            assertThrows(NotificationSettingsException::class.java) { service.updateDeadlineReminder(account, emailOn) }.code)
        doReturn(true).`when`(mail).isAvailable()
        doReturn(DailyReportSubscription(3, "", false, "old@example.org", AccountTestHelper.NOW, null)).`when`(reports).subscription(3)
        assertEquals(NotificationSettingsErrorCode.EMAIL_CONFIRMATION_REQUIRED,
            assertThrows(NotificationSettingsException::class.java) { service.updateDeadlineReminder(account, emailOn) }.code)
        verify(repository, never()).saveDeadlineReminder(anyLong(), anyValue())

        doReturn(DailyReportSubscription(3, "", false, "member@example.org", AccountTestHelper.NOW, null)).`when`(reports).subscription(3)
        doReturn(emailOn).`when`(repository).saveDeadlineReminder(3, emailOn)
        val saved = service.updateDeadlineReminder(account, emailOn)
        assertEquals(emailOn, saved.deadlineReminder)
        assertTrue(saved.emailConfirmed)
    }

    @Test
    fun enablingPushNeedsConfiguredDeliveryButCanBeSavedBeforeADeviceIsRegistered() {
        doReturn(false).`when`(push).available()
        assertEquals(NotificationSettingsErrorCode.PUSH_DELIVERY_UNAVAILABLE,
            assertThrows(NotificationSettingsException::class.java) { service.updateDeadlineReminder(account, pushOn) }.code)
        doReturn(true).`when`(push).available()
        doReturn(pushOn).`when`(repository).saveDeadlineReminder(3, pushOn)
        val saved = service.updateDeadlineReminder(account, pushOn)
        assertEquals(pushOn, saved.deadlineReminder)
        assertFalse(saved.pushDeviceRegistered)
    }

    @Test
    fun turningOffIsAlwaysSavedEvenWhenTheChosenChannelsCannotDeliver() {
        doReturn(false).`when`(mail).isAvailable()
        doReturn(false).`when`(push).available()
        doReturn(null).`when`(reports).subscription(3)
        val off = DeadlineReminderSetting(enabled = false, daysBefore = 7, email = true, push = true)
        doReturn(off).`when`(repository).saveDeadlineReminder(3, off)
        assertEquals(off, service.updateDeadlineReminder(account, off).deadlineReminder)
        verify(repository).saveDeadlineReminder(3, off)
    }

    @Test
    fun domainRejectsAnEnabledReminderWithoutChannelOrOutOfRangeDays() {
        assertThrows(IllegalArgumentException::class.java) { DeadlineReminderSetting(enabled = true, daysBefore = 3, email = false, push = false) }
        assertThrows(IllegalArgumentException::class.java) { DeadlineReminderSetting(enabled = false, daysBefore = 0, email = false, push = false) }
        assertThrows(IllegalArgumentException::class.java) { DeadlineReminderSetting(enabled = false, daysBefore = 8, email = false, push = false) }
    }
}
