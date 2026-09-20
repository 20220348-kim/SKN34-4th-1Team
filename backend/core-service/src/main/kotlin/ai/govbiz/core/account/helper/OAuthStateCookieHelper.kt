package ai.govbiz.core.account.helper

import ai.govbiz.core.account.config.AccountOAuthProperties
import ai.govbiz.core.account.config.AccountSessionProperties
import ai.govbiz.core.account.domain.OAuthProvider
import jakarta.servlet.http.HttpServletRequest
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.http.ResponseCookie
import org.springframework.stereotype.Component
import tools.jackson.databind.JsonNode
import tools.jackson.databind.json.JsonMapper

/**
 * 소셜 로그인을 시작할 때 만든 state·nonce·PKCE verifier·복귀 경로를 서명한 HttpOnly 쿠키로 콜백까지 들고 갑니다.
 *
 * 서버에 저장하지 않으므로 Core가 재시작돼도 진행 중인 로그인이 이어집니다. 값은 세션 비밀키에서 용도별로 파생한 키로
 * HMAC-SHA256 서명해 위조를 막고, [TTL]이 지나면 읽지 않습니다. 쿠키는 소셜 로그인 경로에만 붙고 콜백에서 바로 지웁니다.
 * `SameSite=Lax`라 공급자에서 돌아오는 최상위 GET 이동에는 붙습니다.
 */
@Component
class OAuthStateCookieHelper(
    private val sessionProperties: AccountSessionProperties,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {

    /** 로그인 한 번의 확인 값입니다. [state]·[nonce]·[codeVerifier]는 모두 43자 URL-safe 무작위 값입니다. */
    data class Transaction(
        val provider: OAuthProvider,
        val state: String,
        val nonce: String,
        val codeVerifier: String,
        val returnPath: String,
        val rememberMe: Boolean,
        val expiresAt: Instant,
        val mobile: Boolean = false,
    )

    private val signingKey: ByteArray = hmac(sessionProperties.jwtSecret.toByteArray(StandardCharsets.UTF_8), KEY_PURPOSE)

    fun issue(transaction: Transaction): ResponseCookie {
        val payload = json.writeValueAsBytes(
            linkedMapOf(
                "p" to transaction.provider.pathName,
                "s" to transaction.state,
                "n" to transaction.nonce,
                "v" to transaction.codeVerifier,
                "r" to transaction.returnPath,
                "m" to transaction.rememberMe,
                "e" to transaction.expiresAt.epochSecond,
                "a" to transaction.mobile,
            ),
        )
        val encodedPayload = encoder.encodeToString(payload)
        return cookie("$encodedPayload.${encoder.encodeToString(sign(encodedPayload))}", TTL)
    }

    /** 콜백에서 성공·실패와 관계없이 쿠키를 지웁니다. 같은 이름·경로여야 브라우저가 지웁니다. */
    fun expire(): ResponseCookie = cookie("", Duration.ZERO)

    /** 서명이 맞고 만료되지 않은 쿠키만 읽습니다. 없거나 틀리면 null입니다. */
    fun read(request: HttpServletRequest): Transaction? {
        val value = request.cookies
            ?.firstOrNull { cookie -> cookie.name == COOKIE_NAME }
            ?.value
            ?.takeIf(String::isNotEmpty)
            ?: return null
        return decode(value)
    }

    private fun decode(value: String): Transaction? {
        val parts = value.split('.')
        if (parts.size != 2) return null
        val signature = decodeUrl(parts[1]) ?: return null
        if (!MessageDigest.isEqual(sign(parts[0]), signature)) return null

        val payload = decodeUrl(parts[0])?.let { bytes -> runCatching { json.readTree(bytes) }.getOrNull() } ?: return null
        val expiresAt = payload.path("e").takeIf(JsonNode::isIntegralNumber)?.asLong()?.let(Instant::ofEpochSecond) ?: return null
        if (!expiresAt.isAfter(Instant.now(clock))) return null

        return Transaction(
            provider = payload.text("p")?.let(OAuthProvider::fromPathName) ?: return null,
            state = payload.token("s") ?: return null,
            nonce = payload.token("n") ?: return null,
            codeVerifier = payload.token("v") ?: return null,
            returnPath = payload.text("r")?.takeIf { path -> path.startsWith('/') && !path.startsWith("//") } ?: return null,
            rememberMe = payload.path("m").takeIf(JsonNode::isBoolean)?.booleanValue() ?: return null,
            expiresAt = expiresAt,
            mobile = payload.path("a").takeIf(JsonNode::isBoolean)?.booleanValue() ?: false,
        )
    }

    private fun cookie(value: String, maxAge: Duration): ResponseCookie =
        ResponseCookie.from(COOKIE_NAME, value)
            .httpOnly(true)
            .secure(sessionProperties.cookieSecure)
            .sameSite("Lax")
            .path(COOKIE_PATH)
            .maxAge(maxAge)
            .build()

    private fun sign(encodedPayload: String): ByteArray =
        hmac(signingKey, encodedPayload)

    private fun JsonNode.text(field: String): String? =
        path(field).takeIf(JsonNode::isString)?.asString()

    private fun JsonNode.token(field: String): String? =
        text(field)?.takeIf(OneTimeTokenHelper.PATTERN::matches)

    private fun decodeUrl(value: String): ByteArray? =
        try {
            decoder.decode(value)
        } catch (_: IllegalArgumentException) {
            null
        }

    companion object {
        const val COOKIE_NAME = "govbiz_oauth"
        const val COOKIE_PATH = AccountOAuthProperties.PATH_PREFIX

        /** 공급자 로그인·동의 화면에 머물 수 있는 시간입니다. */
        val TTL: Duration = Duration.ofMinutes(10)

        /** 세션 JWT와 같은 비밀키를 쓰되 서명 키를 분리해 두 토큰이 서로를 대신하지 못하게 합니다. */
        private const val KEY_PURPOSE = "govbiz-oauth-state"
        private const val HMAC_ALGORITHM = "HmacSHA256"
        private val json = JsonMapper.builder().build()
        private val encoder = Base64.getUrlEncoder().withoutPadding()
        private val decoder = Base64.getUrlDecoder()

        private fun hmac(key: ByteArray, input: String): ByteArray =
            Mac.getInstance(HMAC_ALGORITHM).run {
                init(SecretKeySpec(key, HMAC_ALGORITHM))
                doFinal(input.toByteArray(StandardCharsets.US_ASCII))
            }
    }
}
