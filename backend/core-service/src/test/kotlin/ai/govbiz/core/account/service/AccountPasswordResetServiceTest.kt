package ai.govbiz.core.account.service

import ai.govbiz.core.account.client.mail.AccountPasswordResetMailClient
import ai.govbiz.core.account.config.AccountPasswordResetProperties
import ai.govbiz.core.account.domain.PasswordReset
import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.helper.AccountTestHelper.NOW
import ai.govbiz.core.account.helper.OneTimeTokenHelper
import ai.govbiz.core.account.repository.AccountPasswordResetRepository
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.account.service.exception.AccountSuspendedException
import ai.govbiz.core.account.service.exception.PasswordResetMailUnavailableException
import ai.govbiz.core.account.service.exception.PasswordResetTokenInvalidException
import java.time.Duration
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.mockito.ArgumentCaptor
import org.mockito.ArgumentMatchers
import org.mockito.Mock
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.never
import org.mockito.Mockito.verify
import org.mockito.Mockito.verifyNoInteractions
import org.mockito.junit.jupiter.MockitoExtension
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder

@ExtendWith(MockitoExtension::class)
class AccountPasswordResetServiceTest {

    @Mock
    private lateinit var accountRepository: AccountRepository

    @Mock
    private lateinit var resetRepository: AccountPasswordResetRepository

    @Mock
    private lateinit var mailClient: AccountPasswordResetMailClient

    private val passwordEncoder = BCryptPasswordEncoder(4)
    private val properties = AccountPasswordResetProperties(tokenTtl = Duration.ofMinutes(30), maxRequestsPerHour = 3)
    private lateinit var service: AccountPasswordResetService

    @BeforeEach
    fun setUp() {
        service = AccountPasswordResetService(
            accountRepository,
            resetRepository,
            mailClient,
            AccountLoginAttemptGuard(AccountTestHelper.FIXED_CLOCK),
            passwordEncoder,
            properties,
            AccountTestHelper.devLoginProperties(),
            AccountTestHelper.FIXED_CLOCK,
        )
    }

    @Test
    fun requestStoresOnlyTheTokenHashWithTheTtlAndMailsTheRawToken() {
        val account = AccountTestHelper.account(id = 5L, email = "manager@company.co.kr")
        doReturn(true).`when`(mailClient).isAvailable()
        doReturn(account).`when`(accountRepository).findByEmail("manager@company.co.kr")
        doReturn(0).`when`(resetRepository).countRequestsSince(5L, NOW.minusHours(1))
        doReturn(PasswordReset(1L, 5L, NOW.plusMinutes(30))).`when`(resetRepository).create(
            ArgumentMatchers.anyLong(), AccountTestHelper.anyValue(), AccountTestHelper.anyValue(), AccountTestHelper.anyValue(),
        )

        service.request(" Manager@Company.co.kr ", "10.0.0.1")

        val token = ArgumentCaptor.forClass(String::class.java)
        verify(mailClient).sendPasswordReset(eqValue("manager@company.co.kr"), token.capture() ?: "")
        assertTrue(OneTimeTokenHelper.PATTERN.matches(token.value))
        verify(resetRepository).create(5L, OneTimeTokenHelper.hash(token.value), NOW.plusMinutes(30), NOW)
    }

    @Test
    fun requestStaysSilentForUnknownSuspendedAndOverLimitAccounts() {
        doReturn(true).`when`(mailClient).isAvailable()
        doReturn(null).`when`(accountRepository).findByEmail("nobody@company.co.kr")
        doReturn(AccountTestHelper.account(id = 6L, email = "stopped@company.co.kr", suspendedAt = NOW))
            .`when`(accountRepository).findByEmail("stopped@company.co.kr")
        val busy = AccountTestHelper.account(id = 7L, email = "busy@company.co.kr")
        doReturn(busy).`when`(accountRepository).findByEmail("busy@company.co.kr")
        doReturn(3).`when`(resetRepository).countRequestsSince(7L, NOW.minusHours(1))

        service.request("nobody@company.co.kr", "10.0.0.1")
        service.request("stopped@company.co.kr", "10.0.0.1")
        service.request("busy@company.co.kr", "10.0.0.1")

        verify(resetRepository, never()).create(
            ArgumentMatchers.anyLong(), AccountTestHelper.anyValue(), AccountTestHelper.anyValue(), AccountTestHelper.anyValue(),
        )
        verify(mailClient, never()).sendPasswordReset(AccountTestHelper.anyValue(), AccountTestHelper.anyValue())
    }

    @Test
    fun requestFailsFastWithoutMailUnlessTheDevLoginIsEnabled() {
        doReturn(false).`when`(mailClient).isAvailable()
        val withoutDevLogin = AccountPasswordResetService(
            accountRepository, resetRepository, mailClient, AccountLoginAttemptGuard(AccountTestHelper.FIXED_CLOCK),
            passwordEncoder, properties,
            ai.govbiz.core.account.config.AccountDevLoginProperties(false, null, null),
            AccountTestHelper.FIXED_CLOCK,
        )

        assertThrows(PasswordResetMailUnavailableException::class.java) { withoutDevLogin.request("manager@company.co.kr", "10.0.0.1") }
        verifyNoInteractions(accountRepository)

        // 개발용 로그인이 켜져 있으면 토큰을 저장하고 링크를 로그로 남깁니다.
        val account = AccountTestHelper.account(id = 5L, email = "manager@company.co.kr")
        doReturn(account).`when`(accountRepository).findByEmail("manager@company.co.kr")
        doReturn(0).`when`(resetRepository).countRequestsSince(5L, NOW.minusHours(1))
        doReturn(PasswordReset(1L, 5L, NOW.plusMinutes(30))).`when`(resetRepository).create(
            ArgumentMatchers.anyLong(), AccountTestHelper.anyValue(), AccountTestHelper.anyValue(), AccountTestHelper.anyValue(),
        )
        doReturn("http://127.0.0.1:5173/reset-password#token=x").`when`(mailClient).resetLink(AccountTestHelper.anyValue())

        service.request("manager@company.co.kr", "10.0.0.1")

        verify(resetRepository).create(ArgumentMatchers.eq(5L), AccountTestHelper.anyValue(), eqValue(NOW.plusMinutes(30)), eqValue(NOW))
        verify(mailClient, never()).sendPasswordReset(AccountTestHelper.anyValue(), AccountTestHelper.anyValue())
    }

    @Test
    fun resetRejectsMalformedUnknownAndSuspendedTokensWithoutTouchingThePassword() {
        assertThrows(PasswordResetTokenInvalidException::class.java) { service.reset("short", "new-password-2") }

        val unknown = OneTimeTokenHelper.newToken()
        doReturn(null).`when`(resetRepository).findActiveByTokenHash(OneTimeTokenHelper.hash(unknown), NOW)
        assertThrows(PasswordResetTokenInvalidException::class.java) { service.reset(unknown, "new-password-2") }

        val suspendedToken = OneTimeTokenHelper.newToken()
        doReturn(PasswordReset(2L, 8L, NOW.plusMinutes(5))).`when`(resetRepository).findActiveByTokenHash(OneTimeTokenHelper.hash(suspendedToken), NOW)
        doReturn(AccountTestHelper.account(id = 8L, suspendedAt = NOW)).`when`(accountRepository).findById(8L)
        assertThrows(AccountSuspendedException::class.java) { service.reset(suspendedToken, "new-password-2") }

        verify(accountRepository, never()).updatePasswordHash(ArgumentMatchers.anyLong(), AccountTestHelper.anyValue())
    }

    @Test
    fun resetStoresTheNewHashAndEndsEveryTokenAndSession() {
        val token = OneTimeTokenHelper.newToken()
        doReturn(PasswordReset(3L, 5L, NOW.plusMinutes(5))).`when`(resetRepository).findActiveByTokenHash(OneTimeTokenHelper.hash(token), NOW)
        doReturn(AccountTestHelper.account(id = 5L, email = "manager@company.co.kr")).`when`(accountRepository).findById(5L)

        service.reset(token, "new-password-2")

        val hash = ArgumentCaptor.forClass(String::class.java)
        verify(accountRepository).updatePasswordHash(ArgumentMatchers.eq(5L), hash.capture() ?: "")
        assertTrue(passwordEncoder.matches("new-password-2", hash.value))
        verify(resetRepository).deleteAllByAccountId(5L)
        verify(accountRepository).deleteAllSessionsByAccountId(5L)
    }

    /** Kotlin의 non-null 인자에 eq matcher를 넘길 수 있게 null 대신 값을 돌려줍니다. */
    private fun <T : Any> eqValue(value: T): T = org.mockito.Mockito.eq(value) ?: value
}
