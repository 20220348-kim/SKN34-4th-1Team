package ai.govbiz.core.planusage.repository

import ai.govbiz.core._common.test.RedisTestConnection
import ai.govbiz.core.planusage.domain.PlanUsagePeriod
import ai.govbiz.core.planusage.domain.PlanUsageWindow
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.UUID
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** 실제 Redis에서 로그인 전 체험 횟수가 한도·만료·되돌리기를 지키는지 확인합니다. */
class GuestPlanUsageRepositoryTest {
    private val connection = RedisTestConnection()
    private val repository = GuestPlanUsageRepository(connection.redis)
    private val now = ZonedDateTime.now(ZoneId.of("Asia/Seoul"))
    private val window = PlanUsageWindow.current(PlanUsagePeriod.DAY, now)

    @AfterEach
    fun close() = connection.close()

    @Test
    fun countsOnlyUpToTheLimitEvenWhenRequestsRaceAndExpiresAtTheNextSeoulMidnight() {
        val address = "198.51.100.${(1..250).random()}-${UUID.randomUUID()}"
        val pool = Executors.newFixedThreadPool(8)
        val accepted = try {
            (1..12).map { pool.submit(Callable { repository.reserve(address, window, 3) }) }.count { it.get(10, TimeUnit.SECONDS) }
        } finally {
            pool.shutdownNow()
        }

        assertEquals(3, accepted)
        assertEquals(3, repository.used(address, window))
        val keys = connection.redis.keys("govbiz:plan-usage:v1:guest:${window.key}:*")
        // 접속 주소 원문은 키에 남기지 않습니다.
        assertTrue(keys.none { it.contains(address) })
        val ttl = connection.redis.getExpire(keys.first { connection.redis.opsForValue().get(it) == "3" }, TimeUnit.MILLISECONDS)
        assertTrue(ttl in 1..(window.resetsAt.toInstant().toEpochMilli() - now.toInstant().toEpochMilli() + 1_000))
    }

    @Test
    fun releasingGivesBackOneUseWithoutGoingBelowZero() {
        val address = "203.0.113.7-${UUID.randomUUID()}"
        assertTrue(repository.reserve(address, window, 1))
        assertFalse(repository.reserve(address, window, 1))

        repository.release(address, window)
        assertEquals(0, repository.used(address, window))
        repository.release(address, window)
        assertEquals(0, repository.used(address, window))
        assertTrue(repository.reserve(address, window, 1))
    }
}
