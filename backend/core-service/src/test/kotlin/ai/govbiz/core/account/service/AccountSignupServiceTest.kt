package ai.govbiz.core.account.service

import ai.govbiz.core.account.domain.NewAccount
import ai.govbiz.core.account.domain.NewAccountSession
import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.helper.AccountTestHelper.NOW
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.account.service.exception.EmailAlreadyRegisteredException
import ai.govbiz.core.account.service.exception.EmailVerificationRequiredException
import ai.govbiz.core.account.service.exception.LoginRateLimitedException
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.mockito.Mock
import org.mockito.Mockito.anyLong
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.doAnswer
import org.mockito.Mockito.doThrow
import org.mockito.Mockito.eq
import org.mockito.Mockito.never
import org.mockito.Mockito.verify
import org.mockito.Mockito.verifyNoInteractions
import org.mockito.junit.jupiter.MockitoExtension
import org.springframework.dao.DuplicateKeyException
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder

@ExtendWith(MockitoExtension::class)
class AccountSignupServiceTest {

    @Mock
    private lateinit var repository: AccountRepository

    @Mock
    private lateinit var verificationService: AccountSignupEmailVerificationService

    private val passwordEncoder = BCryptPasswordEncoder(4)
    private val passToken = "a".repeat(43)

    private lateinit var service: AccountSignupService

    @BeforeEach
    fun setUp() {
        service = AccountSignupService(
            repository,
            AccountSessionService(repository, AccountTestHelper.sessionProperties(), AccountTestHelper.FIXED_CLOCK),
            passwordEncoder,
            AccountLoginAttemptGuard(AccountTestHelper.FIXED_CLOCK),
            verificationService,
            AccountTestHelper.FIXED_CLOCK,
        )
    }

    private fun allowPass(email: String, id: Long = 11L) {
        doReturn(id).`when`(verificationService).findVerifiedPassId(email, passToken, NOW)
    }

    @Test
    fun createsAVerifiedMemberWithTheNormalizedEmailConsumesThePassAndIssuesABrowserSession() {
        allowPass("manager@company.co.kr")
        var created: NewAccount? = null
        doAnswer { invocation ->
            created = invocation.getArgument(0)
            AccountTestHelper.account(id = 7L, email = "manager@company.co.kr")
        }.`when`(repository).createAccount(AccountTestHelper.anyValue())
        var storedSession: NewAccountSession? = null
        doAnswer { invocation ->
            storedSession = invocation.getArgument(1)
            null
        }.`when`(repository).createSession(eq(7L), AccountTestHelper.anyValue())

        val result = service.signUp("  Manager@Company.co.kr ", "password1", passToken, "127.0.0.1")

        val newAccount = requireNotNull(created)
        assertEquals("manager@company.co.kr", newAccount.email)
        assertTrue(passwordEncoder.matches("password1", newAccount.passwordHash))
        assertEquals(NOW, newAccount.termsAgreedAt)
        assertEquals(NOW, newAccount.emailVerifiedAt)
        verify(verificationService).consumePass(11L, NOW)
        assertFalse(result.rememberMe)
        assertEquals(7L, result.account.id)
        assertNotNull(storedSession)
        assertEquals(NOW.plus(AccountTestHelper.SESSION_SHORT_TTL), storedSession?.expiresAt)
    }

    @Test
    fun reportsADuplicateEmailWithoutIssuingASessionOrConsumingThePass() {
        allowPass("manager@company.co.kr")
        doThrow(DuplicateKeyException("uq_account_email")).`when`(repository).createAccount(AccountTestHelper.anyValue())

        assertThrows(EmailAlreadyRegisteredException::class.java) {
            service.signUp("manager@company.co.kr", "password1", passToken, "127.0.0.1")
        }

        verify(repository, never()).createSession(anyLong(), AccountTestHelper.anyValue())
        verify(verificationService, never()).consumePass(anyLong(), AccountTestHelper.anyValue())
    }

    @Test
    fun rejectsAMissingOrForeignPassBeforeCreatingTheAccount() {
        doReturn(null).`when`(verificationService).findVerifiedPassId("manager@company.co.kr", passToken, NOW)

        assertThrows(EmailVerificationRequiredException::class.java) {
            service.signUp("manager@company.co.kr", "password1", passToken, "127.0.0.1")
        }

        verify(repository, never()).createAccount(AccountTestHelper.anyValue())
    }

    @Test
    fun rejectsPasswordsOutsideTheAllowedLengthBeforeTouchingTheRepository() {
        assertThrows(IllegalArgumentException::class.java) { service.signUp("manager@company.co.kr", "short1", passToken, "127.0.0.1") }
        assertThrows(IllegalArgumentException::class.java) {
            service.signUp("manager@company.co.kr", "p".repeat(73), passToken, "127.0.0.1")
        }

        verify(repository, never()).createAccount(AccountTestHelper.anyValue())
        verifyNoInteractions(verificationService)
    }

    @Test
    fun sharesTheAddressLimitWithLogin() {
        doAnswer { AccountTestHelper.account(id = 1L) }.`when`(repository).createAccount(AccountTestHelper.anyValue())
        doReturn(11L).`when`(verificationService).findVerifiedPassId(AccountTestHelper.anyValue(), eq(passToken) ?: passToken, eq(NOW) ?: NOW)

        repeat(AccountLoginAttemptGuard.ADDRESS_PER_MINUTE) { index ->
            service.signUp("member$index@company.co.kr", "password1", passToken, "10.0.0.9")
        }

        assertThrows(LoginRateLimitedException::class.java) {
            service.signUp("one-more@company.co.kr", "password1", passToken, "10.0.0.9")
        }
    }
}
