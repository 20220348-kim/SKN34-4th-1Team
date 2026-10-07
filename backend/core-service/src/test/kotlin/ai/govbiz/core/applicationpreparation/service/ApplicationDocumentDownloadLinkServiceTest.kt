package ai.govbiz.core.applicationpreparation.service

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.domain.AccountRole
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentFile
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationNotFoundException
import ai.govbiz.core.applicationpreparation.repository.ApplicationDocumentRepository
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationDocumentDownloadLinkException
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneOffset
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.mockito.Mockito.*
import org.springframework.data.redis.core.StringRedisTemplate
import org.springframework.data.redis.core.ValueOperations
import tools.jackson.databind.json.JsonMapper
import tools.jackson.module.kotlin.KotlinModule

class ApplicationDocumentDownloadLinkServiceTest {
    private val files = mock(ApplicationDocumentRepository::class.java)
    private val accounts = mock(AccountRepository::class.java)
    private val redis = mock(StringRedisTemplate::class.java)
    @Suppress("UNCHECKED_CAST")
    private val values = mock(ValueOperations::class.java) as ValueOperations<String, String>
    private val json = JsonMapper.builder().addModule(KotlinModule.Builder().build()).build()
    private val now = Instant.parse("2026-10-07T03:00:00Z")
    private val clock = Clock.fixed(now, ZoneOffset.UTC)
    private val stored = mutableMapOf<String, String>()
    private val account = Account(1, "owner@test.com", AccountRole.USER, null, null, LocalDateTime.now(clock))
    private val file = ApplicationDocumentFile(11, 2, "신청서-초안.hwpx", "application/hwp+zip", byteArrayOf(1, 2, 3))
    private val service = ApplicationDocumentDownloadLinkService(files, accounts, redis, json, clock)

    @BeforeEach fun setup() {
        doReturn(values).`when`(redis).opsForValue()
        doAnswer { invocation ->
            assertEquals(Duration.ofMinutes(2), invocation.getArgument<Duration>(2))
            stored[invocation.getArgument(0)] = invocation.getArgument(1)
            null
        }.`when`(values).set(anyString(), anyString(), any(Duration::class.java) ?: Duration.ZERO)
        doAnswer { stored[it.getArgument<String>(0)] }.`when`(values).get(anyString())
        doReturn(account).`when`(accounts).findById(1)
        doReturn(file).`when`(files).findOwned(1, 9, 11)
    }

    @Test fun createsRandomFileScopedTicketsWithoutStoringTheTicketOrSession() {
        val first = service.create(account, 9, 11)
        val second = service.create(account, 9, 11)
        assertTrue(first.ticket.matches(Regex("[A-Za-z0-9_-]{43}")))
        assertNotEquals(first.ticket, second.ticket)
        assertEquals(now.plusSeconds(120), first.expiresAt.toInstant())
        assertEquals(2, stored.size)
        assertTrue(stored.keys.all { it.matches(Regex("application-document-download:[a-f0-9]{64}")) })
        assertFalse(stored.toString().contains(first.ticket))
        assertFalse(stored.toString().contains(account.email))
        val entry = json.readTree(stored.values.first())
        assertEquals(1, entry["ownerId"].asLong())
        assertEquals(9, entry["preparationId"].asLong())
        assertEquals(11, entry["fileId"].asLong())
    }

    @Test fun requiresOwnedFileBeforeIssuingAnyTicket() {
        assertThrows(ApplicationPreparationNotFoundException::class.java) { service.create(account, 8, 11) }
        assertThrows(ApplicationPreparationNotFoundException::class.java) { service.create(account.copy(id = 2), 9, 11) }
        verifyNoInteractions(redis)
    }

    @Test fun returnsExactFileAndAllowsBrowserHeadAndRetryWithinTheExpiry() {
        val link = service.create(account, 9, 11)
        assertSame(file, service.download(9, 11, link.ticket))
        assertSame(file, service.download(9, 11, link.ticket))
        verify(files, times(3)).findOwned(1, 9, 11)
        verify(accounts, times(2)).findById(1)
    }

    @Test fun rejectsMissingMalformedAndWrongPathTickets() {
        val link = service.create(account, 9, 11)
        for (ticket in listOf("", "session.jwt.token", "a".repeat(43)))
            assertThrows(ApplicationDocumentDownloadLinkException::class.java) { service.download(9, 11, ticket) }
        assertThrows(ApplicationDocumentDownloadLinkException::class.java) { service.download(8, 11, link.ticket) }
        assertThrows(ApplicationDocumentDownloadLinkException::class.java) { service.download(9, 12, link.ticket) }
        verifyNoInteractions(accounts)
    }

    @Test fun checksExpiryEvenIfRedisHasNotRemovedTheEntryYet() {
        val link = service.create(account, 9, 11)
        val expired = ApplicationDocumentDownloadLinkService(files, accounts, redis, json, Clock.offset(clock, Duration.ofSeconds(120)))
        assertThrows(ApplicationDocumentDownloadLinkException::class.java) { expired.download(9, 11, link.ticket) }
        stored.clear()
        assertThrows(ApplicationDocumentDownloadLinkException::class.java) { service.download(9, 11, link.ticket) }
        verifyNoInteractions(accounts)
    }

    @Test fun deniesDeletedOrSuspendedAccountAndDeletedFileAfterIssuing() {
        val link = service.create(account, 9, 11)
        doReturn(null).`when`(accounts).findById(1)
        assertThrows(ApplicationDocumentDownloadLinkException::class.java) { service.download(9, 11, link.ticket) }
        doReturn(account.copy(suspendedAt = LocalDateTime.now(clock))).`when`(accounts).findById(1)
        assertThrows(ApplicationDocumentDownloadLinkException::class.java) { service.download(9, 11, link.ticket) }
        doReturn(account).`when`(accounts).findById(1)
        doReturn(null).`when`(files).findOwned(1, 9, 11)
        assertThrows(ApplicationDocumentDownloadLinkException::class.java) { service.download(9, 11, link.ticket) }
    }

    @Test fun preservesRedisAndMalformedStorageFailuresInsteadOfTreatingThemAsExpiry() {
        val link = service.create(account, 9, 11)
        stored.replaceAll { _, _ -> "broken json" }
        val corrupt = assertThrows(RuntimeException::class.java) { service.download(9, 11, link.ticket) }
        assertFalse(corrupt is ApplicationDocumentDownloadLinkException)
        val unavailable = IllegalStateException("redis unavailable")
        doThrow(unavailable).`when`(redis).opsForValue()
        assertSame(unavailable, assertThrows(IllegalStateException::class.java) { service.create(account, 9, 11) })
        assertSame(unavailable, assertThrows(IllegalStateException::class.java) { service.download(9, 11, link.ticket) })
    }
}
