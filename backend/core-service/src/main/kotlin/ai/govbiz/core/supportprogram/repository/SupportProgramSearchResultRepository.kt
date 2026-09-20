package ai.govbiz.core.supportprogram.repository

import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramSearchSnapshot
import ai.govbiz.core.supportprogram.repository.exception.SupportProgramSearchResultStoreException
import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import java.security.MessageDigest
import java.time.Duration
import java.time.Instant
import org.springframework.core.io.ClassPathResource
import org.springframework.data.redis.core.StringRedisTemplate
import org.springframework.data.redis.core.script.RedisScript
import org.springframework.stereotype.Repository
import tools.jackson.databind.json.JsonMapper

/** Redis 한 키에 결과·소유 계정·고정 TTL을 함께 보관합니다. 대화 기록 원본은 MySQL에 남습니다. */
@Repository
class SupportProgramSearchResultRepository(
    private val redis: StringRedisTemplate,
    objectMapper: JsonMapper,
) {
    // 계산 프로퍼티는 저장하지 않으며 HTTP 직렬화 설정에는 영향을 주지 않습니다.
    private val json = objectMapper.rebuild().addMixIn(SupportProgram::class.java, ProgramJson::class.java).build()

    fun save(token: String, snapshot: SupportProgramSearchSnapshot): Instant = storeOperation {
        require(TOKEN_PATTERN.matches(token))
        val payload = json.writeValueAsString(snapshot)
        if (payload.toByteArray(Charsets.UTF_8).size > MAX_PAYLOAD_BYTES) throw SupportProgramSearchResultStoreException()
        val expiresAt = redis.execute(SAVE, listOf(key(token)), payload, TTL.toMillis().toString())
            ?: throw SupportProgramSearchResultStoreException()
        if (expiresAt <= 0) throw SupportProgramSearchResultStoreException()
        Instant.ofEpochMilli(expiresAt)
    }

    /** 최초 계정 연결과 소유권 확인은 Redis에서 원자적으로 실행하고 만료를 연장하지 않습니다. */
    fun claim(token: String, accountId: Long): SupportProgramSearchSnapshot? {
        if (!TOKEN_PATTERN.matches(token)) return null
        return storeOperation {
            val payload = redis.execute(CLAIM, listOf(key(token)), accountId.toString())
            payload?.let { json.readValue(it, SupportProgramSearchSnapshot::class.java) }
        }
    }

    private fun key(token: String): String = "govbiz:search-result:v1:" +
        MessageDigest.getInstance("SHA-256").digest(token.toByteArray(Charsets.UTF_8)).toHexString()

    private fun <T> storeOperation(operation: () -> T): T = try {
        operation()
    } catch (error: SupportProgramSearchResultStoreException) {
        throw error
    } catch (error: RuntimeException) {
        // 연결·타임아웃·용량·JSON 오류를 만료나 정상 응답으로 바꾸지 않습니다.
        throw SupportProgramSearchResultStoreException(error)
    }

    @JsonIgnoreProperties("sourceQualifiedId")
    private abstract class ProgramJson

    private companion object {
        val TOKEN_PATTERN = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
        val TTL: Duration = Duration.ofMinutes(30)
        const val MAX_PAYLOAD_BYTES = 2 * 1024 * 1024
        val SAVE: RedisScript<Long> = RedisScript.of(ClassPathResource("redis/supportprogram/save-search-result.lua"), Long::class.javaObjectType)
        val CLAIM: RedisScript<String> = RedisScript.of(ClassPathResource("redis/supportprogram/claim-search-result.lua"), String::class.java)
    }
}
