package ai.govbiz.core.account.client.oauth.helper

import ai.govbiz.core.account.client.oauth.exception.OAuthClientException
import ai.govbiz.core.account.domain.OAuthProvider
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64
import tools.jackson.core.JacksonException
import tools.jackson.databind.JsonNode
import tools.jackson.databind.json.JsonMapper

/**
 * 토큰 endpoint에서 받은 ID 토큰의 클레임을 검사해 돌려줍니다.
 *
 * 서명(JWKS)은 확인하지 않습니다. 이 토큰은 우리 서버가 client secret으로 인증한 뒤 TLS로 공급자 토큰 endpoint에서 직접
 * 받은 것이라, OpenID Connect Core 3.1.3.7(6)은 이 경우 서명 대신 TLS 서버 검증을 쓸 수 있게 하고 Google 문서도 같은 이유로
 * 믿어도 된다고 안내합니다. 대신 발급자·대상(azp 포함)·만료·발급 시각·nonce는 항상 확인합니다.
 * 브라우저나 다른 구성 요소가 건넨 ID 토큰에는 이 helper를 쓰면 안 됩니다.
 */
internal object IdTokenHelper {

    private val json = JsonMapper.builder().build()
    private val decoder = Base64.getUrlDecoder()

    /** 시계가 조금 어긋난 공급자를 받아 주는 여유입니다. */
    private const val CLOCK_SKEW_SECONDS = 60L

    fun readClaims(
        provider: OAuthProvider,
        idToken: String,
        issuers: Set<String>,
        clientId: String,
        nonce: String,
        now: Instant,
    ): JsonNode {
        val parts = idToken.split('.')
        if (parts.size != 3) throw invalid(provider, "ID token is not a compact JWS")
        val claims = try {
            json.readTree(decoder.decode(parts[1]))
        } catch (_: IllegalArgumentException) {
            throw invalid(provider, "ID token payload is not base64url")
        } catch (exception: JacksonException) {
            throw OAuthClientException.invalidResponse(provider, "ID token payload is not JSON", exception)
        }
        if (!claims.isObject) throw invalid(provider, "ID token payload is not an object")

        if (claims.stringOrNull("iss") !in issuers) throw invalid(provider, "ID token issuer does not match")
        if (!hasAudience(claims, clientId)) throw invalid(provider, "ID token audience does not match")
        val expiresAt = claims.epochSecondsOrNull("exp") ?: throw invalid(provider, "ID token has no exp")
        if (expiresAt + CLOCK_SKEW_SECONDS <= now.epochSecond) throw invalid(provider, "ID token is expired")
        val issuedAt = claims.epochSecondsOrNull("iat") ?: throw invalid(provider, "ID token has no iat")
        if (issuedAt - CLOCK_SKEW_SECONDS > now.epochSecond) throw invalid(provider, "ID token is issued in the future")
        // nonce가 로그인을 시작한 이 브라우저의 값이어야 가로챈 ID 토큰을 다시 쓰는 공격을 막습니다.
        val tokenNonce = claims.stringOrNull("nonce") ?: throw invalid(provider, "ID token has no nonce")
        if (!MessageDigest.isEqual(tokenNonce.toByteArray(StandardCharsets.UTF_8), nonce.toByteArray(StandardCharsets.UTF_8))) {
            throw invalid(provider, "ID token nonce does not match")
        }
        if (claims.stringOrNull("sub").isNullOrEmpty()) throw invalid(provider, "ID token has no sub")
        return claims
    }

    /** 대상이 여럿이면 OIDC는 `azp`가 우리 클라이언트여야 한다고 정합니다. */
    private fun hasAudience(claims: JsonNode, clientId: String): Boolean {
        val audience = claims.path("aud")
        if (audience.isString) return audience.asString() == clientId
        if (!audience.isArray) return false
        val values = audience.mapNotNull { value -> value.takeIf(JsonNode::isString)?.asString() }
        return clientId in values && (values.size == 1 || claims.stringOrNull("azp") == clientId)
    }

    private fun JsonNode.epochSecondsOrNull(field: String): Long? =
        path(field).takeIf(JsonNode::isIntegralNumber)?.asLong()

    private fun invalid(provider: OAuthProvider, message: String): OAuthClientException =
        OAuthClientException.invalidResponse(provider, message)
}

/** 문자열 필드만 읽습니다. 없거나 다른 타입이면 null입니다. */
internal fun JsonNode.stringOrNull(field: String): String? =
    path(field).takeIf(JsonNode::isString)?.asString()

/** 불리언 필드만 true로 봅니다. 문자열 `"true"`로 오는 공급자도 받아 줍니다. */
internal fun JsonNode.isTrue(field: String): Boolean {
    val value = path(field)
    return (value.isBoolean && value.booleanValue()) || (value.isString && value.asString() == "true")
}
