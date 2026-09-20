package ai.govbiz.core.account.service

import ai.govbiz.core.account.domain.StoredAccountSession
import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.helper.AccountTestHelper.NOW
import ai.govbiz.core.account.helper.SessionTokenHelper
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.account.service.exception.AccountSuspendedException
import ai.govbiz.core.account.service.exception.AuthenticationRequiredException
import java.time.Instant
import java.time.LocalDateTime
import java.time.OffsetDateTime
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.NullSource
import org.junit.jupiter.params.provider.ValueSource
import org.mockito.Mock
import org.mockito.Mockito.anyString
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.never
import org.mockito.Mockito.verify
import org.mockito.Mockito.verifyNoInteractions
import org.mockito.junit.jupiter.MockitoExtension

@ExtendWith(MockitoExtension::class)
class AccountSessionServiceTest {

    @Mock
    private lateinit var repository: AccountRepository

    private lateinit var service: AccountSessionService

    @BeforeEach
    fun setUp() {
        service = AccountSessionService(
            repository,
            AccountTestHelper.sessionProperties(),
            AccountTestHelper.FIXED_CLOCK,
        )
    }

    @Test
    fun issuesAJwtForTheAccountWhoseHashAndExpiryAreStored() {
        val first = service.issue(7L, rememberMe = true)
        val second = service.issue(7L, rememberMe = true)

        val claims = requireNotNull(
            SessionTokenHelper.verify(first.sessionToken, AccountTestHelper.JWT_SECRET, Instant.now(AccountTestHelper.FIXED_CLOCK)),
        )
        assertEquals(7L, claims.accountId)
        assertEquals(Instant.parse("2026-09-06T03:00:00Z"), claims.issuedAt)
        assertEquals(Instant.parse("2026-10-06T03:00:00Z"), claims.expiresAt)
        assertNotEquals(first.sessionToken, second.sessionToken)
        assertEquals(SessionTokenHelper.hash(first.sessionToken), first.session.tokenHash)
        assertEquals(LocalDateTime.of(2026, 10, 6, 12, 0), first.session.expiresAt)
        assertTrue(first.rememberMe)
    }

    @Test
    fun usesTheShortExpiryWhenTheSessionShouldNotBeRemembered() {
        val issued = service.issue(7L, rememberMe = false)

        assertFalse(issued.rememberMe)
        assertEquals(LocalDateTime.of(2026, 9, 7, 0, 0), issued.session.expiresAt)
        assertEquals(OffsetDateTime.parse("2026-09-07T00:00:00+09:00"), service.toResult(issued, AccountTestHelper.account()).expiresAt)
    }

    @Test
    fun formatsTheExpiryWithTheSeoulOffset() {
        val result = service.toResult(service.issue(1L, rememberMe = true), AccountTestHelper.account())

        assertEquals(OffsetDateTime.parse("2026-10-06T12:00:00+09:00"), result.expiresAt)
        assertEquals(AccountTestHelper.account(), result.account)
        assertTrue(result.rememberMe)
    }

    @Test
    fun resolvesTheAccountOfAStoredSessionAndTouchesItAfterTheInterval() {
        val account = AccountTestHelper.account(id = 1L)
        val token = service.issue(1L, rememberMe = true).sessionToken
        val hash = SessionTokenHelper.hash(token)
        doReturn(session(lastUsedAt = NOW.minusMinutes(6))).`when`(repository).findSessionByTokenHash(hash)
        doReturn(account).`when`(repository).findById(1L)

        assertEquals(account, service.requireAccount(token))
        assertEquals(account, service.requireAccount(" $token "))

        verify(repository, org.mockito.Mockito.times(2)).touchSession(hash, NOW)
    }

    @Test
    fun doesNotTouchASessionUsedWithinTheInterval() {
        val token = service.issue(1L, rememberMe = true).sessionToken
        doReturn(session(lastUsedAt = NOW.minusMinutes(4))).`when`(repository).findSessionByTokenHash(SessionTokenHelper.hash(token))
        doReturn(AccountTestHelper.account(id = 1L)).`when`(repository).findById(1L)

        service.requireAccount(token)

        verify(repository, never()).touchSession(anyString(), AccountTestHelper.anyValue())
    }

    @Test
    fun rejectsAnIdleSessionEvenBeforeTheAbsoluteExpiry() {
        val token = service.issue(1L, rememberMe = true).sessionToken
        doReturn(session(lastUsedAt = NOW.minusDays(7))).`when`(repository).findSessionByTokenHash(SessionTokenHelper.hash(token))

        assertThrows(AuthenticationRequiredException::class.java) { service.requireAccount(token) }

        verify(repository, never()).findById(1L)
    }

    @Test
    fun rejectsAStoredSessionWhoseRowHasExpired() {
        val token = service.issue(1L, rememberMe = false).sessionToken
        doReturn(session(expiresAt = NOW)).`when`(repository).findSessionByTokenHash(SessionTokenHelper.hash(token))

        assertThrows(AuthenticationRequiredException::class.java) { service.requireAccount(token) }
    }

    @Test
    fun rejectsASuspendedAccountWithADistinctError() {
        val token = service.issue(1L, rememberMe = true).sessionToken
        doReturn(session()).`when`(repository).findSessionByTokenHash(SessionTokenHelper.hash(token))
        doReturn(AccountTestHelper.account(id = 1L, suspendedAt = NOW.minusDays(1))).`when`(repository).findById(1L)

        assertThrows(AccountSuspendedException::class.java) { service.requireAccount(token) }
    }

    @ParameterizedTest
    @NullSource
    @ValueSource(strings = ["", "   "])
    fun rejectsAMissingSessionCookieWithoutTouchingTheDatabase(sessionToken: String?) {
        assertThrows(AuthenticationRequiredException::class.java) {
            service.requireAccount(sessionToken)
        }
        assertThrows(AuthenticationRequiredException::class.java) {
            service.logOut(sessionToken)
        }

        verifyNoInteractions(repository)
    }

    @ParameterizedTest
    @ValueSource(strings = ["token-1", "Bearer token", "a.b", "a.b.c.d"])
    fun rejectsAMalformedTokenWithoutTouchingTheDatabase(sessionToken: String) {
        assertThrows(AuthenticationRequiredException::class.java) {
            service.requireAccount(sessionToken)
        }

        verifyNoInteractions(repository)
    }

    @Test
    fun rejectsATokenWithABadSignatureOrPastExpiryWithoutTouchingTheDatabase() {
        val foreign = SessionTokenHelper.issue(
            1L,
            Instant.parse("2026-09-06T03:00:00Z"),
            Instant.parse("2026-10-06T03:00:00Z"),
            "another-secret-that-is-long-enough-000",
        )
        val expired = SessionTokenHelper.issue(
            1L,
            Instant.parse("2026-08-01T03:00:00Z"),
            Instant.parse("2026-09-06T03:00:00Z"),
            AccountTestHelper.JWT_SECRET,
        )

        assertThrows(AuthenticationRequiredException::class.java) { service.requireAccount(foreign) }
        assertThrows(AuthenticationRequiredException::class.java) { service.requireAccount(expired) }

        verifyNoInteractions(repository)
    }

    @Test
    fun rejectsALoggedOutSessionEvenWhenTheJwtIsStillValid() {
        val token = service.issue(1L, rememberMe = true).sessionToken

        assertThrows(AuthenticationRequiredException::class.java) {
            service.requireAccount(token)
        }

        verify(repository).findSessionByTokenHash(SessionTokenHelper.hash(token))
        verify(repository, never()).findById(1L)
    }

    @Test
    fun rejectsASessionRowThatBelongsToAnotherAccountThanTheJwtSubject() {
        val token = service.issue(1L, rememberMe = true).sessionToken
        doReturn(session(accountId = 2L)).`when`(repository).findSessionByTokenHash(SessionTokenHelper.hash(token))

        assertThrows(AuthenticationRequiredException::class.java) {
            service.requireAccount(token)
        }
    }

    @Test
    fun logOutDeletesTheHashedSessionAndIgnoresMissingRows() {
        doReturn(false).`when`(repository).deleteSessionByTokenHash(SessionTokenHelper.hash("token-1"))

        service.logOut("token-1")

        verify(repository).deleteSessionByTokenHash(SessionTokenHelper.hash("token-1"))
    }

    private fun session(
        accountId: Long = 1L,
        expiresAt: LocalDateTime = NOW.plusDays(30),
        lastUsedAt: LocalDateTime = NOW,
    ) = StoredAccountSession(accountId = accountId, expiresAt = expiresAt, lastUsedAt = lastUsedAt)
}
