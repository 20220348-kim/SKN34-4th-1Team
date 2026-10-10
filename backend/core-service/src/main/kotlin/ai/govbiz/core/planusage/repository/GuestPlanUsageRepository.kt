package ai.govbiz.core.planusage.repository

import ai.govbiz.core.planusage.domain.PlanUsageWindow
import ai.govbiz.core.planusage.repository.exception.PlanUsageStoreException
import java.security.MessageDigest
import org.springframework.core.io.ClassPathResource
import org.springframework.data.redis.core.StringRedisTemplate
import org.springframework.data.redis.core.script.RedisScript
import org.springframework.stereotype.Repository

/**
 * 로그인하지 않은 접속 주소의 하루 사용량을 Redis에 다음 서울 자정까지만 둡니다. 접속 주소는 해시로만 키에 넣고,
 * 로그인 전 검색 결과 보관처럼 DB에는 남기지 않습니다.
 */
@Repository
class GuestPlanUsageRepository(private val redis: StringRedisTemplate) {

    /** 한도 안일 때만 1을 더하고 더했는지 돌려줍니다. */
    fun reserve(clientAddress: String, window: PlanUsageWindow, limit: Int): Boolean = store {
        val used = redis.execute(
            RESERVE, listOf(key(clientAddress, window)), limit.toString(), window.resetsAt.toInstant().toEpochMilli().toString(),
        ) ?: throw PlanUsageStoreException()
        used > 0
    }

    fun release(clientAddress: String, window: PlanUsageWindow) {
        store { redis.execute(RELEASE, listOf(key(clientAddress, window))) }
    }

    fun used(clientAddress: String, window: PlanUsageWindow): Int = store {
        redis.opsForValue().get(key(clientAddress, window))?.toIntOrNull() ?: 0
    }

    private fun key(clientAddress: String, window: PlanUsageWindow): String = "govbiz:plan-usage:v1:guest:${window.key}:" +
        MessageDigest.getInstance("SHA-256").digest(clientAddress.toByteArray(Charsets.UTF_8)).toHexString()

    private fun <T> store(operation: () -> T): T = try {
        operation()
    } catch (error: PlanUsageStoreException) {
        throw error
    } catch (error: RuntimeException) {
        // 연결·타임아웃 오류를 한도 여유나 초과로 바꾸지 않습니다.
        throw PlanUsageStoreException(error)
    }

    private companion object {
        val RESERVE: RedisScript<Long> =
            RedisScript.of(ClassPathResource("redis/planusage/reserve-guest-usage.lua"), Long::class.javaObjectType)
        val RELEASE: RedisScript<Long> =
            RedisScript.of(ClassPathResource("redis/planusage/release-guest-usage.lua"), Long::class.javaObjectType)
    }
}
