package ai.govbiz.core.dailyreport.service

import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.repository.CompanyRepository
import ai.govbiz.core.dailyreport.client.DailyReportMailClient
import ai.govbiz.core.dailyreport.config.DailyReportProperties
import ai.govbiz.core.dailyreport.domain.DailyReportSubscription
import ai.govbiz.core.dailyreport.domain.exception.DailyReportErrorCode
import ai.govbiz.core.dailyreport.domain.exception.DailyReportException
import ai.govbiz.core.dailyreport.repository.DailyReportRepository
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.mockito.ArgumentMatchers.*
import org.mockito.Mockito.*

class DailyReportSubscriptionServiceTest {
    private val repository = mock(DailyReportRepository::class.java)
    private val companies = mock(CompanyRepository::class.java)
    private val mail = mock(DailyReportMailClient::class.java)
    private val service = DailyReportSubscriptionService(repository, companies, mail, DailyReportProperties())
    private val account = AccountTestHelper.account(emailVerifiedAt = AccountTestHelper.NOW)

    @Test
    fun globallyVerifiedAccountDoesNotSkipReportConfirmationAndExposesDisabledScheduler() {
        val settings = service.settings(account)
        assertFalse(settings.emailConfirmed)
        assertFalse(settings.enabled)
        assertFalse(settings.schedulerEnabled)
    }

    @Test
    fun verificationOnlySendsToAccountEmailAndStoresHashNotToken() {
        doReturn(true).`when`(mail).isAvailable()
        var hash: String? = null
        var token: String? = null
        doAnswer { hash = it.getArgument(2); null }.`when`(repository).reserveVerification(eq(account.id), equalValue(account.email), anyString())
        doAnswer { token = it.getArgument(1); null }.`when`(mail).sendVerification(equalValue(account.email), anyString())
        service.requestVerification(account)
        assertTrue(requireNotNull(token).matches(Regex("[A-Za-z0-9_-]{43}")))
        assertEquals(64, hash?.length)
        assertNotEquals(hash, token)
        assertEquals(DailyReportSubscriptionService.hashToken(requireNotNull(token)), hash)
    }

    @Test
    fun disabledMailStillAllowsOptOutAndPurpose101IsRejectedBeforeSaving() {
        val disabled = DailyReportSubscription(account.id, "", false, account.email, AccountTestHelper.NOW, AccountTestHelper.NOW)
        doReturn(disabled).`when`(repository).saveSettings(account.id, account.email, "", false, false)
        doReturn(disabled).`when`(repository).subscription(account.id)
        assertFalse(service.update(account, "", false, false).enabled)
        verifyNoInteractions(companies)
        assertThrows(IllegalArgumentException::class.java) { service.update(account, "가".repeat(101), false, false) }
    }

    @Test
    fun invalidPublicTokensNeverReachTheRepository() {
        assertEquals(DailyReportErrorCode.INVALID_EMAIL_TOKEN, assertThrows(DailyReportException::class.java) { service.confirm("bad") }.code)
        assertThrows(DailyReportException::class.java) { service.unsubscribe("a".repeat(1000)) }
        verifyNoInteractions(repository, mail)
    }

    private fun <T> equalValue(value: T): T { eq(value); return value }
}
