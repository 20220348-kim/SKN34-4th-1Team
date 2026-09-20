package ai.govbiz.core.supportprogram.repository

import ai.govbiz.core._common.test.RedisTestConnection
import ai.govbiz.core.supportprogram.domain.*
import ai.govbiz.core.supportprogram.repository.exception.SupportProgramSearchResultStoreException
import java.security.MessageDigest
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import tools.jackson.databind.json.JsonMapper
import tools.jackson.module.kotlin.KotlinModule

class SupportProgramSearchResultRepositoryTest {
    private val connection = RedisTestConnection()
    private val json = JsonMapper.builder().addModule(KotlinModule.Builder().build()).build()
    private val repository = SupportProgramSearchResultRepository(connection.redis, json)
    private val token = UUID.randomUUID().toString()
    private val key = "govbiz:search-result:v1:" + MessageDigest.getInstance("SHA-256").digest(token.toByteArray()).toHexString()
    private val conditions = SupportProgramCompanyConditions("서울", "AI", LocalDate.of(2020, 1, 2), "기술 개발")
    private val snapshot = SupportProgramSearchSnapshot("서울 AI \"지원\" 😀", listOf(program("BIZINFO"), program("KSTARTUP")),
        SupportProgramConversationContext("서울 AI \"지원\" 😀", false, conditions))

    @AfterEach
    fun close() { connection.close() }

    @Test
    fun anotherClientRestoresExactJsonDatesCompositeIdsAndOwnershipEvenAfterOriginalClientCloses() {
        repository.save(token, snapshot)
        connection.close()
        RedisTestConnection().use { other ->
            val restarted = SupportProgramSearchResultRepository(other.redis, json)
            assertEquals(snapshot, restarted.claim(token, Long.MAX_VALUE))
            assertEquals(snapshot, restarted.claim(token, Long.MAX_VALUE))
            assertNull(restarted.claim(token, Long.MAX_VALUE - 1))
        }
    }

    @Test
    fun expirationIsThirtyMinutesOnRedisClockAndClaimsNeverExtendIt() {
        val expiresAt = repository.save(token, snapshot)
        assertTrue(Duration.between(Instant.now(), expiresAt).seconds in 1790..1800)
        assertTrue(connection.redis.getExpire(key) in 1790..1800)
        connection.redis.expire(key, Duration.ofSeconds(30))
        repository.claim(token, 1L)
        assertTrue(connection.redis.getExpire(key) in 1..30)
        connection.redis.expireAt(key, Instant.EPOCH)
        assertNull(repository.claim(token, 1L))
        assertNull(repository.claim(UUID.randomUUID().toString(), 1L))
        assertNull(repository.claim("invalid", 1L))
    }

    @Test
    fun simultaneousClaimsThroughIndependentClientsHaveExactlyOneOwner() {
        repository.save(token, snapshot)
        RedisTestConnection().use { other ->
            val second = SupportProgramSearchResultRepository(other.redis, json)
            val start = CountDownLatch(1)
            val pool = Executors.newFixedThreadPool(2)
            try {
                val attempts = listOf(repository to 1L, second to 2L).map { (store, accountId) ->
                    pool.submit<Boolean> { start.await(); store.claim(token, accountId) != null }
                }
                start.countDown()
                val successes = attempts.map { it.get(5, TimeUnit.SECONDS) }
                assertEquals(1, successes.count { it })
                val owner = if (successes[0]) 1L else 2L
                assertEquals(snapshot, second.claim(token, owner))
                assertNull(repository.claim(token, if (owner == 1L) 2L else 1L))
            } finally { pool.shutdownNow() }
        }
    }

    @Test
    fun tokenCollisionNeverOverwritesPayloadOrClaimAndReturnedObjectsAreIndependent() {
        repository.save(token, snapshot)
        repository.claim(token, 10L)
        assertThrows(SupportProgramSearchResultStoreException::class.java) { repository.save(token, snapshot.copy(query = "다른 검색")) }
        val first = requireNotNull(repository.claim(token, 10L))
        (first.programs as MutableList).clear()
        assertEquals(snapshot, repository.claim(token, 10L))
        assertNull(repository.claim(token, 11L))
    }

    @Test
    fun storedPayloadIsPlainJsonWithoutDerivedPropertiesOrBearerTokenInTheKey() {
        repository.save(token, snapshot)
        val payload = connection.redis.opsForHash<String, String>().get(key, "payload")!!
        assertEquals(snapshot.query, json.readTree(payload).get("query").asText())
        assertFalse(payload.contains("sourceQualifiedId"))
        assertFalse(key.contains(token))
        assertFalse(connection.redis.hasKey("govbiz:search-result:v1:$token"))
    }

    @Test
    fun malformedJsonAndMissingExpiryAreErrorsNotExpiredOrSuccessfulResults() {
        repository.save(token, snapshot)
        connection.redis.opsForHash<String, String>().put(key, "payload", "not-json")
        assertThrows(SupportProgramSearchResultStoreException::class.java) { repository.claim(token, 1L) }
        connection.redis.persist(key)
        try {
            assertThrows(SupportProgramSearchResultStoreException::class.java) { repository.claim(token, 1L) }
        } finally { connection.redis.delete(key) }
    }

    @Test
    fun oversizedPayloadFailsWithoutCreatingAToken() {
        val large = snapshot.copy(programs = listOf(program("BIZINFO").copy(summary = "가".repeat(750_000))))
        assertThrows(SupportProgramSearchResultStoreException::class.java) { repository.save(token, large) }
        assertFalse(connection.redis.hasKey(key))
    }

    @Test
    fun redisOutOfMemoryRejectsNewSaveWithoutEvictingExistingResults() {
        repository.save(token, snapshot)
        connection.redis.connectionFactory!!.connection.use { control ->
            control.serverCommands().setConfig("maxmemory", "1")
            try {
                assertThrows(SupportProgramSearchResultStoreException::class.java) { repository.save(UUID.randomUUID().toString(), snapshot) }
            } finally { control.serverCommands().setConfig("maxmemory", "128mb") }
        }
        assertEquals(snapshot, repository.claim(token, 1L))
    }

    private fun program(source: String) = SupportProgram(
        id = "same-id", sourceCode = source, title = "지원 공고 😀", organization = "기관", summary = "서울 AI 지원\n중소기업 대상",
        categories = listOf("AI", "기술"), regions = listOf("서울"), targetDescription = "중소기업",
        applicationPeriod = "2026-01-01 ~ 상시", applicationStartDate = LocalDate.of(2026, 1, 1), applicationEndDate = null,
        status = SupportProgramStatus.OPEN, sourceName = source, sourceUrl = "https://example.invalid/?a=1&b=2",
        matchedReasons = listOf("지역 일치"), recommendationScore = 96,
        eligibilityReview = SupportProgramEligibilityReview(SupportProgramEligibilityReviewStatus.MATCH,
            assessment(), assessment()),
    )

    private fun assessment() = SupportProgramEligibilityAssessment(SupportProgramEligibilityStatus.MATCH, "본문 확인",
        listOf(SupportProgramEligibilityEvidence(SupportProgramEligibilityEvidenceField.SUMMARY, "서울 AI 지원")))
}
