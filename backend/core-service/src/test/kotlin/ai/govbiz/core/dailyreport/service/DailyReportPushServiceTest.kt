package ai.govbiz.core.dailyreport.service

import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.repository.CompanyRepository
import ai.govbiz.core.account.service.AccountSessionService
import ai.govbiz.core.dailyreport.client.DailyReportPushClient
import ai.govbiz.core.dailyreport.config.DailyReportProperties
import ai.govbiz.core.dailyreport.config.DailyReportPushProperties
import ai.govbiz.core.dailyreport.domain.*
import ai.govbiz.core.dailyreport.repository.DailyReportPushRepository
import java.time.LocalDate
import org.junit.jupiter.api.Test
import org.mockito.Mockito.*

class DailyReportPushServiceTest {
    private val repository = mock(DailyReportPushRepository::class.java)
    private val client = mock(DailyReportPushClient::class.java)
    private val delivery = DailyReportPushDelivery(1, 2, "device", "ExpoPushToken[test]", LocalDate.of(2026, 9, 6), null)
    private fun service(enabled: Boolean = true, hour: Int = 8) = DailyReportPushService(repository, client,
        DailyReportPushProperties(enabled), DailyReportProperties(enabled = true, sendHour = hour),
        mock(AccountSessionService::class.java), mock(CompanyRepository::class.java), AccountTestHelper.FIXED_CLOCK)

    @Test
    fun disabledAndBeforeSendHourNeverSend() {
        service(false).dispatch()
        verifyNoInteractions(repository, client)
        service(hour = 23).dispatch()
        verify(repository, never()).reserveDeliveries(AccountTestHelper.anyValue())
        verifyNoInteractions(client)
    }

    @Test
    fun timeoutIsRecordedUnknownAndDoesNotRegenerateReportOrRetrySend() {
        doReturn(listOf(delivery)).`when`(repository).pending()
        doReturn(true).`when`(repository).claim(1)
        doReturn(true).`when`(repository).valid(1)
        doThrow(RuntimeException("timeout")).`when`(client).send(delivery)
        service().dispatch()
        verify(repository).finish(delivery, DailyReportPushOutcome("UNKNOWN", errorCode = "SendUnconfirmed"))
        verify(client, times(1)).send(delivery)
    }

    @Test
    fun accountOrPermissionChangeAfterClaimSkipsProviderCall() {
        doReturn(listOf(delivery)).`when`(repository).pending()
        doReturn(true).`when`(repository).claim(1)
        doReturn(false).`when`(repository).valid(1)
        service().dispatch()
        verify(repository).finish(delivery, DailyReportPushOutcome("SKIPPED"))
        verifyNoInteractions(client)
    }
}
