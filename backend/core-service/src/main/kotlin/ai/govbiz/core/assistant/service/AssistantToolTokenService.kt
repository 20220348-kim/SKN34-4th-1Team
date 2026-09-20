package ai.govbiz.core.assistant.service

import ai.govbiz.core.assistant.config.AssistantAgentProperties
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.Clock
import java.time.Instant
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** 에이전트 요청 하나에 발급하는 계정 묶음 토큰입니다. AI Service의 도구가 Core를 되부를 때 그대로 돌려줍니다. */
data class AssistantToolToken(
    val value: String,
    val expiresAt: Instant,
)

/**
 * 도구 API용 단기 토큰을 만들고 검증합니다. 토큰은 `계정.만료시각.서명` 꼴이고 서명은 공유 비밀의 HMAC-SHA256입니다.
 * 계정 번호가 서명에 묶여 있어 AI Service가 잘못돼도 다른 계정 자료를 요청할 수 없습니다.
 */
class AssistantToolTokenService(
    private val properties: AssistantAgentProperties,
    private val clock: Clock,
) {
    fun issue(accountId: Long): AssistantToolToken {
        require(accountId > 0) { "accountId must be positive" }
        require(properties.toolsEnabled) { "assistant tools are disabled" }
        val expiresAt = clock.instant().plus(properties.toolTokenTtl).epochSecond
        val payload = "$accountId.$expiresAt"
        return AssistantToolToken("$payload.${sign(payload)}", Instant.ofEpochSecond(expiresAt))
    }

    /** 형식·서명·만료·계정 일치를 모두 확인합니다. 비교는 길이가 같을 때만 상수 시간입니다. */
    fun verify(token: String?, accountId: Long): Boolean {
        if (!properties.toolsEnabled || token == null) return false
        val parts = token.split('.')
        if (parts.size != 3) return false
        val tokenAccountId = parts[0].toLongOrNull() ?: return false
        val expiresAt = parts[1].toLongOrNull() ?: return false
        if (tokenAccountId != accountId || expiresAt < clock.instant().epochSecond) return false
        val expected = sign("${parts[0]}.${parts[1]}").toByteArray(StandardCharsets.US_ASCII)
        val actual = parts[2].toByteArray(StandardCharsets.US_ASCII)
        return MessageDigest.isEqual(expected, actual)
    }

    /** 공유 비밀 헤더 비교입니다. */
    fun matchesSecret(candidate: String?): Boolean {
        if (!properties.toolsEnabled || candidate == null) return false
        return MessageDigest.isEqual(
            properties.toolsSecret.toByteArray(StandardCharsets.UTF_8),
            candidate.toByteArray(StandardCharsets.UTF_8),
        )
    }

    private fun sign(payload: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(properties.toolsSecret.toByteArray(StandardCharsets.UTF_8), "HmacSHA256"))
        return Base64.getUrlEncoder().withoutPadding().encodeToString(mac.doFinal(payload.toByteArray(StandardCharsets.UTF_8)))
    }
}
