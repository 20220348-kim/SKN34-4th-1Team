package ai.govbiz.core.dailyreport.service

import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.dailyreport.client.DailyReportMailClient
import ai.govbiz.core.dailyreport.config.DailyReportProperties
import ai.govbiz.core.dailyreport.config.DailyReportQueueProperties
import ai.govbiz.core.dailyreport.domain.*
import ai.govbiz.core.dailyreport.domain.exception.DailyReportErrorCode
import ai.govbiz.core.dailyreport.domain.exception.DailyReportException
import ai.govbiz.core.dailyreport.repository.DailyReportRepository
import java.time.Clock
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import org.junit.jupiter.api.Test
import org.mockito.Mockito.*

class DailyReportSchedulerTest {
    private val reports = mock(DailyReportService::class.java)
    private val repository = mock(DailyReportRepository::class.java)
    private val accounts = mock(AccountRepository::class.java)
    private val mail = mock(DailyReportMailClient::class.java)
    private val first = AccountTestHelper.account(id = 1)
    private val second = AccountTestHelper.account(id = 2)
    private val date = LocalDate.of(2026, 9, 9)
    private val report = DailyReport(1, 1, date, DailyReportStatus.READY, DailyReportDeliveryStatus.NOT_REQUESTED,
        DailyReportInput("기업", "서울", "정보통신업", ""), DailyReportContent(emptyList(), emptyList()), AccountTestHelper.NOW,
        null, 1, "key", AccountTestHelper.NOW)

    @Test
    fun beforeSendHourDoesNotStartGeneration() {
        doReturn(true).`when`(mail).isAvailable()
        scheduler(Clock.fixed(Instant.parse("2026-09-08T22:59:00Z"), ZoneId.of("Asia/Seoul"))).run()
        verifyNoInteractions(reports, accounts)
    }

    @Test
    fun generationCrossingMidnightDoesNotSendOrStartTheNextDaysBatch() {
        val clock = MutableClock(Instant.parse("2026-09-09T14:59:00Z"))
        doReturn(true).`when`(mail).isAvailable()
        doReturn(listOf(1L, 2L)).`when`(repository).dueAccountIds(date, 21)
        doReturn(first).`when`(accounts).findById(1)
        doAnswer { clock.current = Instant.parse("2026-09-09T15:01:00Z"); report }.`when`(reports).enqueueScheduled(first)
        scheduler(clock).run()
        verify(reports, never()).deliver(AccountTestHelper.anyValue())
        verify(accounts, never()).findById(2)
    }

    @Test
    fun storedReadyReportIsDeliveredBeforeNewGenerationHitsTheDailyBudget() {
        doReturn(true).`when`(mail).isAvailable()
        doReturn(listOf(2L, 1L)).`when`(repository).dueAccountIds(date, 21)
        doReturn(first).`when`(accounts).findById(1)
        doReturn(second).`when`(accounts).findById(2)
        val ready = report.copy(accountId = 2)
        doReturn(ready).`when`(reports).enqueueScheduled(second)
        doThrow(DailyReportException(DailyReportErrorCode.REPORT_DAILY_BUDGET_EXCEEDED)).`when`(reports).enqueueScheduled(first)
        scheduler(Clock.fixed(Instant.parse("2026-09-09T00:00:00Z"), ZoneId.of("Asia/Seoul"))).run()
        verify(reports).deliver(ready)
        verify(reports, times(1)).deliver(AccountTestHelper.anyValue())
    }

    @Test
    fun disabledQueueNeverFallsBackToSynchronousAiGeneration() {
        DailyReportScheduler(reports, repository, accounts, mail, DailyReportProperties(enabled = true),
            Clock.fixed(Instant.parse("2026-09-09T00:00:00Z"), ZoneId.of("Asia/Seoul")), DailyReportQueueProperties(false)).run()
        verifyNoInteractions(reports, accounts, mail)
    }

    @Test
    fun deliveryQueueStoresOutboxWithoutWaitingForSmtpAndExcludesAlreadyQueuedAccounts() {
        doReturn(true).`when`(mail).isAvailable()
        doReturn(listOf(1L)).`when`(repository).dueAccountIds(date, 21, false)
        doReturn(first).`when`(accounts).findById(1)
        doReturn(report).`when`(reports).enqueueScheduled(first)
        DailyReportScheduler(reports, repository, accounts, mail, DailyReportProperties(enabled = true),
            Clock.fixed(Instant.parse("2026-09-09T00:00:00Z"), ZoneId.of("Asia/Seoul")), DailyReportQueueProperties(true, true)).run()
        verify(repository).enqueueDelivery(report.id)
        verify(reports, never()).deliver(AccountTestHelper.anyValue())
    }

    private fun scheduler(clock: Clock) = DailyReportScheduler(reports, repository, accounts, mail, DailyReportProperties(enabled = true), clock, DailyReportQueueProperties(true))
    private class MutableClock(var current: Instant) : Clock() {
        override fun instant(): Instant = current
        override fun getZone(): ZoneId = ZoneId.of("Asia/Seoul")
        override fun withZone(zone: ZoneId): Clock = Clock.fixed(current, zone)
    }
}
