package ai.govbiz.core.account.helper

import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Instant
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import tools.jackson.core.JacksonException
import tools.jackson.databind.json.JsonMapper

/** HS256 JWT 세션 토큰을 발급·검증하고, DB에 저장할 SHA-256 해시로 바꿉니다. */
object SessionTokenHelper {

    /** 서명이 맞고 만료되지 않은 토큰에서 읽은 값입니다. */
    data class Claims(
        val accountId: Long,
        val issuedAt: Instant,
        val expiresAt: Instant,
    )

    private val random = SecureRandom()
    private val json = JsonMapper.builder().build()
    private val encoder = Base64.getUrlEncoder().withoutPadding()
    private val decoder = Base64.getUrlDecoder()

    /** `sub`=계정 ID, `iat`·`exp`=초 단위 epoch, `jti`=무작위 값인 HS256 JWT를 만듭니다. 원본은 브라우저에만 전달합니다. */
    fun issue(accountId: Long, issuedAt: Instant, expiresAt: Instant, secret: String): String {
        val jti = ByteArray(JTI_BYTES).also(random::nextBytes)
        val payload = """{"sub":"$accountId","iat":${issuedAt.epochSecond},"exp":${expiresAt.epochSecond},"jti":"${encoder.encodeToString(jti)}"}"""
        val signingInput = "$HEADER.${encodeUrl(payload)}"
        return "$signingInput.${encoder.encodeToString(sign(signingInput, secret))}"
    }

    /** 형식·서명·만료를 검사해 유효하면 Claims, 아니면 null입니다. DB를 보지 않습니다. */
    fun verify(token: String, secret: String, now: Instant): Claims? {
        val parts = token.split('.')
        if (parts.size != 3 || parts[0] != HEADER) return null
        val signature = decodeUrl(parts[2]) ?: return null
        val expected = sign("${parts[0]}.${parts[1]}", secret)
        if (!MessageDigest.isEqual(expected, signature)) return null

        val payloadBytes = decodeUrl(parts[1]) ?: return null
        val payload = try {
            json.readTree(payloadBytes)
        } catch (_: JacksonException) {
            return null
        }
        val accountId = payload.path("sub").asString().toLongOrNull() ?: return null
        val issuedAt = payload.path("iat").takeIf { it.isIntegralNumber }?.asLong() ?: return null
        val expiresAt = payload.path("exp").takeIf { it.isIntegralNumber }?.asLong() ?: return null
        if (expiresAt <= now.epochSecond) return null
        return Claims(
            accountId = accountId,
            issuedAt = Instant.ofEpochSecond(issuedAt),
            expiresAt = Instant.ofEpochSecond(expiresAt),
        )
    }

    /** 토큰의 소문자 SHA-256 hex 해시입니다. DB에는 이 값만 저장합니다. */
    fun hash(token: String): String =
        MessageDigest.getInstance("SHA-256")
            .digest(token.toByteArray(Charsets.UTF_8))
            .joinToString("") { byte -> "%02x".format(byte) }

    private fun sign(signingInput: String, secret: String): ByteArray =
        Mac.getInstance(HMAC_ALGORITHM).run {
            init(SecretKeySpec(secret.toByteArray(StandardCharsets.UTF_8), HMAC_ALGORITHM))
            doFinal(signingInput.toByteArray(StandardCharsets.US_ASCII))
        }

    private fun encodeUrl(value: String): String =
        encoder.encodeToString(value.toByteArray(StandardCharsets.UTF_8))

    private fun decodeUrl(value: String): ByteArray? =
        try {
            decoder.decode(value)
        } catch (_: IllegalArgumentException) {
            null
        }

    private const val HMAC_ALGORITHM = "HmacSHA256"
    private const val JTI_BYTES = 16

    /** `{"alg":"HS256","typ":"JWT"}`의 base64url입니다. 다른 헤더(예: `alg: none`)는 받지 않습니다. */
    private const val HEADER = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
}
