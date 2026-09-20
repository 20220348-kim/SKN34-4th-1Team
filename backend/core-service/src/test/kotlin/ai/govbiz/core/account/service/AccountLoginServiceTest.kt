package ai.govbiz.core.account.service

import ai.govbiz.core.account.domain.AccountCredential
import ai.govbiz.core.account.domain.NewAccountSession
import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.helper.AccountTestHelper.NOW
import ai.govbiz.core.account.helper.SessionTokenHelper
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.account.service.exception.AccountSuspendedException
import ai.govbiz.core.account.service.exception.InvalidCredentialsException
import ai.govbiz.core.account.service.exception.LoginRateLimitedException
import java.time.LocalDateTime
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.mockito.Mock
import org.mockito.Mockito.anyLong
import org.mockito.Mockito.doAnswer
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.eq
import org.mockito.Mockito.never
import org.mockito.Mockito.verify
import org.mockito.junit.jupiter.MockitoExtension
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder

@ExtendWith(MockitoExtension::class)
class AccountLoginServiceTest {

    @Mock
    private lateinit var repository: AccountRepository

    private val passwordEncoder = BCryptPasswordEncoder(4)

    private lateinit var service: AccountLoginService

    @BeforeEach
    fun setUp() {
        service = AccountLoginService(
            repository,
            AccountSessionService(repository, AccountTestHelper.sessionProperties(), AccountTestHelper.FIXED_CLOCK),
            passwordEncoder,
            AccountLoginAttemptGuard(AccountTestHelper.FIXED_CLOCK),
        )
    }

    @Test
    fun issuesAndStoresANewSessionWhenThePasswordMatches() {
        val account = AccountTestHelper.account(id = 7L)
        doReturn(AccountCredential(account, requireNotNull(passwordEncoder.encode("password1"))))
            .`when`(repository).findCredentialByEmail("manager@company.co.kr")
        var storedSession: NewAccountSession? = null
        doAnswer { invocation ->
            storedSession = invocation.getArgument(1)
            null
        }.`when`(repository).createSession(eq(7L), AccountTestHelper.anyValue())

        val result = service.logIn(" MANAGER@company.co.kr", "password1", ADDRESS, rememberMe = true)

        val session = requireNotNull(storedSession)
        assertEquals(SessionTokenHelper.hash(result.sessionToken), session.tokenHash)
        assertEquals(LocalDateTime.of(2026, 10, 6, 12, 0), session.expiresAt)
        assertEquals(account, result.account)
        assertTrue(result.rememberMe)
    }

    @Test
    fun issuesAShortSessionWhenRememberMeIsOff() {
        doReturn(AccountCredential(AccountTestHelper.account(id = 7L), requireNotNull(passwordEncoder.encode("password1"))))
            .`when`(repository).findCredentialByEmail("manager@company.co.kr")
        var storedSession: NewAccountSession? = null
        doAnswer { invocation ->
            storedSession = invocation.getArgument(1)
            null
        }.`when`(repository).createSession(eq(7L), AccountTestHelper.anyValue())

        val result = service.logIn("manager@company.co.kr", "password1", ADDRESS, rememberMe = false)

        assertFalse(result.rememberMe)
        assertEquals(LocalDateTime.of(2026, 9, 7, 0, 0), requireNotNull(storedSession).expiresAt)
    }

    @Test
    fun rejectsAWrongPasswordWithoutCreatingASession() {
        doReturn(AccountCredential(AccountTestHelper.account(), requireNotNull(passwordEncoder.encode("password1"))))
            .`when`(repository).findCredentialByEmail("manager@company.co.kr")

        assertThrows(InvalidCredentialsException::class.java) {
            service.logIn("manager@company.co.kr", "password2", ADDRESS, rememberMe = false)
        }

        verify(repository, never()).createSession(anyLong(), AccountTestHelper.anyValue())
    }

    @Test
    fun rejectsAnUnknownEmailWithTheSameErrorAsAWrongPassword() {
        assertThrows(InvalidCredentialsException::class.java) {
            service.logIn("unknown@company.co.kr", "password1", ADDRESS, rememberMe = false)
        }

        verify(repository, never()).createSession(anyLong(), AccountTestHelper.anyValue())
    }

    @Test
    fun rejectsASuspendedAccountOnlyAfterThePasswordMatched() {
        val suspended = AccountTestHelper.account(id = 5L, suspendedAt = NOW.minusDays(1))
        doReturn(AccountCredential(suspended, requireNotNull(passwordEncoder.encode("password1"))))
            .`when`(repository).findCredentialByEmail("manager@company.co.kr")

        assertThrows(InvalidCredentialsException::class.java) {
            service.logIn("manager@company.co.kr", "wrong-password", ADDRESS, rememberMe = false)
        }
        assertThrows(AccountSuspendedException::class.java) {
            service.logIn("manager@company.co.kr", "password1", ADDRESS, rememberMe = false)
        }

        verify(repository, never()).createSession(anyLong(), AccountTestHelper.anyValue())
    }

    @Test
    fun locksTheAccountAfterRepeatedFailuresWithoutTouchingTheRepository() {
        repeat(AccountLoginAttemptGuard.FAILURE_THRESHOLD) {
            assertThrows(InvalidCredentialsException::class.java) {
                service.logIn("unknown@company.co.kr", "password1", ADDRESS, rememberMe = false)
            }
        }

        val exception = assertThrows(LoginRateLimitedException::class.java) {
            service.logIn("Unknown@company.co.kr", "password1", ADDRESS, rememberMe = false)
        }

        assertEquals(30, exception.retryAfterSeconds)
        verify(repository, org.mockito.Mockito.times(AccountLoginAttemptGuard.FAILURE_THRESHOLD))
            .findCredentialByEmail("unknown@company.co.kr")
    }

    private companion object {
        const val ADDRESS = "10.0.0.1"
    }
}
