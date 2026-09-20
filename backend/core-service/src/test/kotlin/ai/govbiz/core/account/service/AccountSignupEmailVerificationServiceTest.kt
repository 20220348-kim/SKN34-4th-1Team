package ai.govbiz.core.account.service

import ai.govbiz.core.account.client.mail.AccountEmailVerificationMailClient
import ai.govbiz.core.account.config.AccountDevLoginProperties
import ai.govbiz.core.account.config.AccountEmailVerificationProperties
import ai.govbiz.core.account.domain.SignupEmailVerification
import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.helper.AccountTestHelper.NOW
import ai.govbiz.core.account.helper.OneTimeTokenHelper
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.account.repository.SignupEmailVerificationRepository
import ai.govbiz.core.account.service.exception.EmailAlreadyRegisteredException
import ai.govbiz.core.account.service.exception.EmailCodeExpiredException
import ai.govbiz.core.account.service.exception.EmailCodeInvalidException
import ai.govbiz.core.account.service.exception.EmailCodeRateLimitedException
import ai.govbiz.core.account.service.exception.EmailVerificationMailUnavailableException
import java.time.Duration
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
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

@ExtendWith(MockitoExtension::class)
class AccountSignupEmailVerificationServiceTest {

    @Mock
    private lateinit var accountRepository: AccountRepository

    @Mock
    private lateinit var verificationRepository: SignupEmailVerificationRepository

    @Mock
    private lateinit var mailClient: AccountEmailVerificationMailClient

    private val properties = AccountEmailVerificationProperties(
        codeTtl = Duration.ofMinutes(10), passTtl = Duration.ofMinutes(30), resendCooldown = Duration.ofSeconds(60),
        sendWindow = Duration.ofMinutes(10), maxSendsPerWindow = 3, maxAttempts = 5,
    )
    private lateinit var service: AccountSignupEmailVerificationService

    @BeforeEach
    fun setUp() {
        service = AccountSignupEmailVerificationService(
            accountRepository, verificationRepository, mailClient, AccountLoginAttemptGuard(AccountTestHelper.FIXED_CLOCK),
            properties, AccountTestHelper.devLoginProperties(), AccountTestHelper.FIXED_CLOCK,
        )
    }

    @Test
    fun sendCodeStoresOnlyTheHashWithTheTtlAndMailsASixDigitCode() {
        doReturn(true).`when`(mailClient).isAvailable()
        doReturn(null).`when`(accountRepository).findByEmail("manager@company.co.kr")
        doReturn(null).`when`(verificationRepository).findLatestSentAt("manager@company.co.kr")
        doReturn(0).`when`(verificationRepository).countSendsSince("manager@company.co.kr", NOW.minusMinutes(10))
        doReturn(verification()).`when`(verificationRepository).create(
            AccountTestHelper.anyValue(), AccountTestHelper.anyValue(), AccountTestHelper.anyValue(), AccountTestHelper.anyValue(),
        )

        service.sendCode(" Manager@Company.co.kr ", "10.0.0.1")

        val code = ArgumentCaptor.forClass(String::class.java)
        verify(mailClient).sendSignupCode(eqValue("manager@company.co.kr"), code.capture() ?: "")
        assertTrue(Regex("[0-9]{6}").matches(code.value))
        verify(verificationRepository).create(
            "manager@company.co.kr", OneTimeTokenHelper.hash("manager@company.co.kr:${code.value}"), NOW.plusMinutes(10), NOW,
        )
    }

    @Test
    fun sendCodeRejectsRegisteredEmailsCooldownAndTheSendLimit() {
        doReturn(true).`when`(mailClient).isAvailable()
        doReturn(AccountTestHelper.account(id = 3L, email = "taken@company.co.kr")).`when`(accountRepository).findByEmail("taken@company.co.kr")
        assertThrows(EmailAlreadyRegisteredException::class.java) { service.sendCode("taken@company.co.kr", "10.0.0.1") }

        doReturn(null).`when`(accountRepository).findByEmail("soon@company.co.kr")
        doReturn(NOW.minusSeconds(20)).`when`(verificationRepository).findLatestSentAt("soon@company.co.kr")
        val cooldown = assertThrows(EmailCodeRateLimitedException::class.java) { service.sendCode("soon@company.co.kr", "10.0.0.1") }
        assertEquals(40, cooldown.retryAfterSeconds)

        doReturn(null).`when`(accountRepository).findByEmail("busy@company.co.kr")
        doReturn(NOW.minusMinutes(5)).`when`(verificationRepository).findLatestSentAt("busy@company.co.kr")
        doReturn(3).`when`(verificationRepository).countSendsSince("busy@company.co.kr", NOW.minusMinutes(10))
        val limit = assertThrows(EmailCodeRateLimitedException::class.java) { service.sendCode("busy@company.co.kr", "10.0.0.1") }
        assertEquals(600, limit.retryAfterSeconds)

        verify(verificationRepository, never()).create(
            AccountTestHelper.anyValue(), AccountTestHelper.anyValue(), AccountTestHelper.anyValue(), AccountTestHelper.anyValue(),
        )
        verify(mailClient, never()).sendSignupCode(AccountTestHelper.anyValue(), AccountTestHelper.anyValue())
    }

    @Test
    fun sendCodeFailsFastWithoutMailUnlessTheDevLoginIsEnabled() {
        doReturn(false).`when`(mailClient).isAvailable()
        val withoutDevLogin = AccountSignupEmailVerificationService(
            accountRepository, verificationRepository, mailClient, AccountLoginAttemptGuard(AccountTestHelper.FIXED_CLOCK),
            properties, AccountDevLoginProperties(false, null, null), AccountTestHelper.FIXED_CLOCK,
        )
        assertThrows(EmailVerificationMailUnavailableException::class.java) { withoutDevLogin.sendCode("manager@company.co.kr", "10.0.0.1") }
        verifyNoInteractions(accountRepository, verificationRepository)

        // 개발용 로그인이 켜져 있으면 인증번호를 저장하고 로그로 남깁니다.
        doReturn(null).`when`(accountRepository).findByEmail("manager@company.co.kr")
        doReturn(null).`when`(verificationRepository).findLatestSentAt("manager@company.co.kr")
        doReturn(0).`when`(verificationRepository).countSendsSince("manager@company.co.kr", NOW.minusMinutes(10))
        doReturn(verification()).`when`(verificationRepository).create(
            AccountTestHelper.anyValue(), AccountTestHelper.anyValue(), AccountTestHelper.anyValue(), AccountTestHelper.anyValue(),
        )

        service.sendCode("manager@company.co.kr", "10.0.0.1")

        verify(verificationRepository).create(eqValue("manager@company.co.kr"), AccountTestHelper.anyValue(), eqValue(NOW.plusMinutes(10)), eqValue(NOW))
        verify(mailClient, never()).sendSignupCode(AccountTestHelper.anyValue(), AccountTestHelper.anyValue())
    }

    @Test
    fun verifyCodeCountsWrongAttemptsAndExpiresMissingOrExhaustedCodes() {
        doReturn(null).`when`(verificationRepository).findLatestUnverifiedByEmail("nobody@company.co.kr", NOW)
        assertThrows(EmailCodeExpiredException::class.java) { service.verifyCode("nobody@company.co.kr", "123456", "10.0.0.1") }

        doReturn(verification(attemptCount = 5)).`when`(verificationRepository).findLatestUnverifiedByEmail("manager@company.co.kr", NOW)
        assertThrows(EmailCodeExpiredException::class.java) { service.verifyCode("manager@company.co.kr", "123456", "10.0.0.1") }
        verify(verificationRepository, never()).incrementAttempts(ArgumentMatchers.anyLong())

        doReturn(verification(attemptCount = 1)).`when`(verificationRepository).findLatestUnverifiedByEmail("manager@company.co.kr", NOW)
        assertThrows(EmailCodeInvalidException::class.java) { service.verifyCode("manager@company.co.kr", "000000", "10.0.0.1") }
        verify(verificationRepository).incrementAttempts(1L)
        verify(verificationRepository, never()).markVerified(
            ArgumentMatchers.anyLong(), AccountTestHelper.anyValue(), AccountTestHelper.anyValue(), AccountTestHelper.anyValue(),
        )
    }

    @Test
    fun verifyCodeIssuesAPassWhoseHashIsStoredAndThePassIsFoundOnlyWhileValid() {
        doReturn(verification()).`when`(verificationRepository).findLatestUnverifiedByEmail("manager@company.co.kr", NOW)

        val pass = service.verifyCode(" Manager@Company.co.kr ", "123456", "10.0.0.1")

        assertTrue(OneTimeTokenHelper.PATTERN.matches(pass.passToken))
        assertEquals(NOW.plusMinutes(30), pass.expiresAt)
        verify(verificationRepository).markVerified(1L, OneTimeTokenHelper.hash(pass.passToken), NOW, NOW.plusMinutes(30))

        doReturn(1L).`when`(verificationRepository).findVerifiedPassId("manager@company.co.kr", OneTimeTokenHelper.hash(pass.passToken), NOW)
        assertEquals(1L, service.findVerifiedPassId("manager@company.co.kr", pass.passToken, NOW))
        assertNull(service.findVerifiedPassId("manager@company.co.kr", "not-a-token", NOW))
    }

    private fun verification(attemptCount: Int = 0): SignupEmailVerification =
        SignupEmailVerification(
            id = 1L, email = "manager@company.co.kr",
            codeHash = OneTimeTokenHelper.hash("manager@company.co.kr:123456"),
            expiresAt = NOW.plusMinutes(10), attemptCount = attemptCount,
        )

    /** Kotlin의 non-null 인자에 eq matcher를 넘길 수 있게 null 대신 값을 돌려줍니다. */
    private fun <T : Any> eqValue(value: T): T = org.mockito.Mockito.eq(value) ?: value
}
