package ai.govbiz.core.account.client.oauth

import ai.govbiz.core.account.client.oauth.exception.OAuthClientException
import ai.govbiz.core.account.client.oauth.helper.IdTokenHelper
import ai.govbiz.core.account.client.oauth.helper.executeOAuthHttpCall
import ai.govbiz.core.account.client.oauth.helper.isTrue
import ai.govbiz.core.account.client.oauth.helper.stringOrNull
import ai.govbiz.core.account.config.AccountOAuthProperties
import ai.govbiz.core.account.domain.OAuthProfile
import ai.govbiz.core.account.domain.OAuthProvider
import java.net.URI
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.Clock
import java.time.Instant
import java.util.Base64
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.http.MediaType
import org.springframework.stereotype.Component
import org.springframework.util.LinkedMultiValueMap
import org.springframework.web.client.RestClient
import org.springframework.web.util.UriComponentsBuilder
import tools.jackson.databind.JsonNode

/**
 * Google 로그인(OpenID Connect)의 인가 주소를 만들고 인가 코드를 사용자로 바꿉니다.
 *
 * 웹 서버 앱 흐름에 PKCE(S256)를 함께 쓰고, 요청 scope는 `openid email`뿐이라 Google 앱 검수가 필요 없습니다.
 * 이메일은 ID 토큰의 `email_verified`가 true일 때만 인정합니다.
 */
@Component
class GoogleOAuthClient(
    @param:Qualifier("oauthRestClient") private val restClient: RestClient,
    private val properties: AccountOAuthProperties,
    @param:Qualifier("seoulClock") private val clock: Clock,
) : OAuthProviderClient {

    override val provider: OAuthProvider = OAuthProvider.GOOGLE

    override fun isConfigured(): Boolean = properties.google.isConfigured

    override fun authorizationUri(state: String, nonce: String, codeVerifier: String): URI {
        requireConfigured()
        return UriComponentsBuilder.fromUriString(AUTHORIZATION_ENDPOINT)
            .queryParam("client_id", "{clientId}")
            .queryParam("redirect_uri", "{redirectUri}")
            .queryParam("response_type", "code")
            .queryParam("scope", "{scope}")
            .queryParam("state", "{state}")
            .queryParam("nonce", "{nonce}")
            .queryParam("code_challenge", "{codeChallenge}")
            .queryParam("code_challenge_method", "S256")
            // prompt를 두지 않아 이미 로그인·동의한 Google 계정은 선택 화면 없이 바로 돌아옵니다. 계정이 여럿이면 Google이 고르게 합니다.
            .encode()
            .buildAndExpand(
                mapOf(
                    "clientId" to properties.google.clientId,
                    "redirectUri" to properties.callbackUri(provider),
                    "scope" to SCOPE,
                    "state" to state,
                    "nonce" to nonce,
                    "codeChallenge" to codeChallenge(codeVerifier),
                ),
            )
            .toUri()
    }

    override fun exchange(code: String, codeVerifier: String, nonce: String): OAuthProfile {
        requireConfigured()
        val form = LinkedMultiValueMap<String, String>().apply {
            add("grant_type", "authorization_code")
            add("code", code)
            add("client_id", properties.google.clientId)
            add("client_secret", properties.google.clientSecret)
            add("redirect_uri", properties.callbackUri(provider))
            add("code_verifier", codeVerifier)
        }
        val tokens = executeOAuthHttpCall(provider) {
            restClient.post()
                .uri(TOKEN_ENDPOINT)
                .contentType(MediaType.APPLICATION_FORM_URLENCODED)
                .body(form)
                .retrieve()
                .body(JsonNode::class.java)
        } ?: throw OAuthClientException.invalidResponse(provider, "token response was empty")
        val idToken = tokens.stringOrNull("id_token")
            ?: throw OAuthClientException.invalidResponse(provider, "token response has no id_token")

        val claims = IdTokenHelper.readClaims(provider, idToken, ISSUERS, properties.google.clientId, nonce, Instant.now(clock))
        val email = claims.stringOrNull("email")?.trim()?.takeIf(String::isNotEmpty)
        return OAuthProfile(
            provider = provider,
            subject = requireNotNull(claims.stringOrNull("sub")),
            verifiedEmail = email?.takeIf { claims.isTrue("email_verified") },
        )
    }

    private fun requireConfigured() {
        if (!isConfigured()) throw OAuthClientException.notConfigured(provider)
    }

    private companion object {
        const val AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
        const val TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
        const val SCOPE = "openid email"

        /** Google은 발급자를 두 표기로 씁니다. */
        val ISSUERS = setOf("https://accounts.google.com", "accounts.google.com")

        /** RFC 7636 S256: verifier의 SHA-256을 패딩 없는 base64url로 씁니다. */
        fun codeChallenge(codeVerifier: String): String =
            Base64.getUrlEncoder().withoutPadding().encodeToString(
                MessageDigest.getInstance("SHA-256").digest(codeVerifier.toByteArray(StandardCharsets.US_ASCII)),
            )
    }
}
