package ai.govbiz.core.account.service

import ai.govbiz.core.account.domain.AccountType
import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.helper.AccountTestHelper.NOW
import ai.govbiz.core.account.repository.AccountRepository
import java.time.Clock
import java.time.ZoneId
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.mockito.Mock
import org.mockito.Mockito.`when`
import org.mockito.junit.jupiter.MockitoExtension

@ExtendWith(MockitoExtension::class)
class AccountOnboardingServiceTest {

    @Mock
    private lateinit var accountRepository: AccountRepository

    private val clock: Clock = Clock.fixed(NOW.atZone(ZoneId.of("Asia/Seoul")).toInstant(), ZoneId.of("Asia/Seoul"))

    @Test
    fun savesTheTypeWithTheCurrentTimeAndMarksTheAccountOnboarded() {
        val account = AccountTestHelper.account()
        val saved = account.copy(accountType = AccountType.BUSINESS, onboardedAt = NOW)
        `when`(accountRepository.completeOnboarding(account.id, AccountType.BUSINESS, NOW)).thenReturn(saved)

        val result = AccountOnboardingService(accountRepository, clock).complete(account, AccountType.BUSINESS)

        assertEquals(saved, result)
        assertEquals(true, result.isOnboarded)
    }

    @Test
    fun callingAgainOverwritesTheType() {
        val account = AccountTestHelper.account().copy(accountType = AccountType.BUSINESS, onboardedAt = NOW.minusDays(1))
        val saved = account.copy(accountType = AccountType.INDIVIDUAL, onboardedAt = NOW)
        `when`(accountRepository.completeOnboarding(account.id, AccountType.INDIVIDUAL, NOW)).thenReturn(saved)

        assertEquals(saved, AccountOnboardingService(accountRepository, clock).complete(account, AccountType.INDIVIDUAL))
    }
}
