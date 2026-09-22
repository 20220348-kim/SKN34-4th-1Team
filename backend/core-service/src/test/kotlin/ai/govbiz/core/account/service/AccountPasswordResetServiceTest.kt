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
import ai.govbiz.core.account.service.exception.EmailCodeExpiredException
import ai.govbiz.core.account.service.exception.EmailCodeInvalidException
import ai.govbiz.core.account.service.exception.EmailCodeRateLimitedException
import ai.govbiz.core.account.service.exception.PasswordResetAccountNotFoundException
import ai.govbiz.core.account.service.exception.PasswordResetMailUnavailableException
import ai.govbiz.core.account.service.exception.PasswordResetSocialAccountException
import ai.govbiz.core.account.service.exception.PasswordResetTokenInvalidException
import java.time.Duration
import org.junit.jupiter.api.Assertions.assertEquals
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
    private val properties = AccountPasswordResetProperties(
        codeTtl = Duration.ofMinutes(10), tokenTtl = Duration.ofMinutes(30), resendCooldown = Duration.ofSeconds(60),
        maxRequestsPerHour = 3, maxAttempts = 5,
    )
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
    fun requestStoresOnlyTheCodeHashWithTheTtlAndMailsTheSixDigitCode() {
        val account = AccountTestHelper.account(id = 5L, email = "manager@company.co.kr")
        doReturn(true).`when`(mailClient).isAvailable()
        doReturn(account).`when`(accountRepository).findByEmail("manager@company.co.kr")
        doReturn(null).`when`(resetRepository).findLatestSentAt(5L)
        doReturn(0).`when`(resetRepository).countRequestsSince(5L, NOW.minusHours(1))
        doReturn(PasswordReset(1L, 5L, "hash", NOW.plusMinutes(10), 0)).`when`(resetRepository).create(
            ArgumentMatchers.anyLong(), AccountTestHelper.anyValue(), AccountTestHelper.anyValue(), AccountTestHelper.anyValue(),
        )

        service.request(" Manager@Company.co.kr ", "10.0.0.1")

        val code = ArgumentCaptor.forClass(String::class.java)
        verify(mailClient).sendPasswordResetCode(eqValue("manager@company.co.kr"), code.capture() ?: "")
        assertTrue(AccountPasswordResetMailClient.CODE_PATTERN.matches(code.value))
        verify(resetRepository).create(5L, OneTimeTokenHelper.hash("manager@company.co.kr:${code.value}"), NOW.plusMinutes(10), NOW)
    }

    @Test
    fun requestRejectsUnregisteredEmailsAndSocialOnlyAccountsWithoutSendingAnything() {
        doReturn(true).`when`(mailClient).isAvailable()
        doReturn(null).`when`(accountRepository).findByEmail("nobody@company.co.kr")
        doReturn(AccountTestHelper.account(id = 9L, email = "social@company.co.kr", hasPassword = false))
            .`when`(accountRepository).findByEmail("social@company.co.kr")

        assertThrows(PasswordResetAccountNotFoundException::class.java) { service.request(" Nobody@Company.co.kr ", "10.0.0.1") }
        assertThrows(PasswordResetSocialAccountException::class.java) { service.request("social@company.co.kr", "10.0.0.1") }

        verifyNoInteractions(resetRepository)
        verify(mailClient, never()).sendPasswordResetCode(AccountTestHelper.anyValue(), AccountTestHelper.anyValue())
    }

    @Test
    fun requestStaysSilentForSuspendedAccountsAndRateLimitsResendsAndHourlyRequests() {
        doReturn(true).`when`(mailClient).isAvailable()
        doReturn(AccountTestHelper.account(id = 6L, email = "stopped@company.co.kr", suspendedAt = NOW))
            .`when`(accountRepository).findByEmail("stopped@company.co.kr")
        val recent = AccountTestHelper.account(id = 7L, email = "recent@company.co.kr")
        doReturn(recent).`when`(accountRepository).findByEmail("recent@company.co.kr")
        doReturn(NOW.minusSeconds(20)).`when`(resetRepository).findLatestSentAt(7L)
        val busy = AccountTestHelper.account(id = 8L, email = "busy@company.co.kr")
        doReturn(busy).`when`(accountRepository).findByEmail("busy@company.co.kr")
        doReturn(NOW.minusMinutes(5)).`when`(resetRepository).findLatestSentAt(8L)
        doReturn(3).`when`(resetRepository).countRequestsSince(8L, NOW.minusHours(1))

        service.request("stopped@company.co.kr", "10.0.0.1")
        val cooldown = assertThrows(EmailCodeRateLimitedException::class.java) { service.request("recent@company.co.kr", "10.0.0.1") }
        assertEquals(40, cooldown.retryAfterSeconds)
        val limit = assertThrows(EmailCodeRateLimitedException::class.java) { service.request("busy@company.co.kr", "10.0.0.1") }
        assertEquals(3600, limit.retryAfterSeconds)

        verify(resetRepository, never()).create(
            ArgumentMatchers.anyLong(), AccountTestHelper.anyValue(), AccountTestHelper.anyValue(), AccountTestHelper.anyValue(),
        )
        verify(mailClient, never()).sendPasswordResetCode(AccountTestHelper.anyValue(), AccountTestHelper.anyValue())
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

        // 개발용 로그인이 켜져 있으면 인증번호를 저장하고 로그로 남깁니다.
        val account = AccountTestHelper.account(id = 5L, email = "manager@company.co.kr")
        doReturn(account).`when`(accountRepository).findByEmail("manager@company.co.kr")
        doReturn(null).`when`(resetRepository).findLatestSentAt(5L)
        doReturn(0).`when`(resetRepository).countRequestsSince(5L, NOW.minusHours(1))
        doReturn(PasswordReset(1L, 5L, "hash", NOW.plusMinutes(10), 0)).`when`(resetRepository).create(
            ArgumentMatchers.anyLong(), AccountTestHelper.anyValue(), AccountTestHelper.anyValue(), AccountTestHelper.anyValue(),
        )

        service.request("manager@company.co.kr", "10.0.0.1")

        verify(resetRepository).create(ArgumentMatchers.eq(5L), AccountTestHelper.anyValue(), eqValue(NOW.plusMinutes(10)), eqValue(NOW))
        verify(mailClient, never()).sendPasswordResetCode(AccountTestHelper.anyValue(), AccountTestHelper.anyValue())
    }

    @Test
    fun verifyIssuesAPassTokenForTheRightCodeAndCountsWrongOrExhaustedAttempts() {
        val account = AccountTestHelper.account(id = 5L, email = "manager@company.co.kr")
        doReturn(account).`when`(accountRepository).findByEmail("manager@company.co.kr")
        val hash = OneTimeTokenHelper.hash("manager@company.co.kr:482137")
        doReturn(PasswordReset(11L, 5L, hash, NOW.plusMinutes(10), 0)).`when`(resetRepository).findLatestUnverifiedByAccountId(5L, NOW)

        assertThrows(EmailCodeInvalidException::class.java) { service.verify(" Manager@Company.co.kr ", "000000", "10.0.0.1") }
        verify(resetRepository).incrementAttempts(11L)

        val pass = service.verify("manager@company.co.kr", "482137", "10.0.0.1")
        assertTrue(OneTimeTokenHelper.PATTERN.matches(pass.passToken))
        assertEquals(NOW.plusMinutes(30), pass.expiresAt)
        verify(resetRepository).markVerified(11L, OneTimeTokenHelper.hash(pass.passToken), NOW, NOW.plusMinutes(30))

        // 시도를 다 쓴 인증번호는 맞아도 만료로 봅니다. 보낸 인증번호가 없어도 같습니다.
        doReturn(PasswordReset(12L, 5L, hash, NOW.plusMinutes(10), 5)).`when`(resetRepository).findLatestUnverifiedByAccountId(5L, NOW)
        assertThrows(EmailCodeExpiredException::class.java) { service.verify("manager@company.co.kr", "482137", "10.0.0.1") }
        doReturn(null).`when`(resetRepository).findLatestUnverifiedByAccountId(5L, NOW)
        assertThrows(EmailCodeExpiredException::class.java) { service.verify("manager@company.co.kr", "482137", "10.0.0.1") }
    }

    @Test
    fun verifyAnswersUnregisteredAndSocialAccountsLikeTheRequestDoes() {
        doReturn(null).`when`(accountRepository).findByEmail("nobody@company.co.kr")
        doReturn(AccountTestHelper.account(id = 9L, email = "social@company.co.kr", hasPassword = false))
            .`when`(accountRepository).findByEmail("social@company.co.kr")

        assertThrows(PasswordResetAccountNotFoundException::class.java) { service.verify("nobody@company.co.kr", "482137", "10.0.0.1") }
        assertThrows(PasswordResetSocialAccountException::class.java) { service.verify("social@company.co.kr", "482137", "10.0.0.1") }
        verifyNoInteractions(resetRepository)
    }

    @Test
    fun resetRejectsMalformedUnknownSuspendedAndSocialPassTokensWithoutTouchingThePassword() {
        assertThrows(PasswordResetTokenInvalidException::class.java) { service.reset("short", "new-password-2") }

        val unknown = OneTimeTokenHelper.newToken()
        doReturn(null).`when`(resetRepository).findVerifiedPass(OneTimeTokenHelper.hash(unknown), NOW)
        assertThrows(PasswordResetTokenInvalidException::class.java) { service.reset(unknown, "new-password-2") }

        val suspendedToken = OneTimeTokenHelper.newToken()
        doReturn(PasswordReset(2L, 8L, "hash", NOW.plusMinutes(5), 0)).`when`(resetRepository).findVerifiedPass(OneTimeTokenHelper.hash(suspendedToken), NOW)
        doReturn(AccountTestHelper.account(id = 8L, suspendedAt = NOW)).`when`(accountRepository).findById(8L)
        assertThrows(AccountSuspendedException::class.java) { service.reset(suspendedToken, "new-password-2") }

        val socialToken = OneTimeTokenHelper.newToken()
        doReturn(PasswordReset(3L, 9L, "hash", NOW.plusMinutes(5), 0)).`when`(resetRepository).findVerifiedPass(OneTimeTokenHelper.hash(socialToken), NOW)
        doReturn(AccountTestHelper.account(id = 9L, hasPassword = false)).`when`(accountRepository).findById(9L)
        assertThrows(PasswordResetSocialAccountException::class.java) { service.reset(socialToken, "new-password-2") }

        verify(accountRepository, never()).updatePasswordHash(ArgumentMatchers.anyLong(), AccountTestHelper.anyValue())
    }

    @Test
    fun resetStoresTheNewHashAndEndsEveryCodeAndSession() {
        val token = OneTimeTokenHelper.newToken()
        doReturn(PasswordReset(3L, 5L, "hash", NOW.plusMinutes(5), 0)).`when`(resetRepository).findVerifiedPass(OneTimeTokenHelper.hash(token), NOW)
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
