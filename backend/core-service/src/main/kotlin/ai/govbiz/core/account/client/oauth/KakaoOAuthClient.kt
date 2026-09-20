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
import java.time.Clock
import java.time.Instant
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.stereotype.Component
import org.springframework.util.LinkedMultiValueMap
import org.springframework.web.client.RestClient
import org.springframework.web.util.UriComponentsBuilder
import tools.jackson.databind.JsonNode

/**
 * 카카오 로그인(OpenID Connect)의 인가 주소를 만들고 인가 코드를 사용자로 바꿉니다.
 *
 * 카카오 REST 문서에는 PKCE가 없어 보내지 않고, client secret과 nonce로 코드·토큰 탈취를 막습니다. ID 토큰에는 이메일
 * 인증 여부가 없어 사용자 정보 API의 `is_email_valid`·`is_email_verified`가 둘 다 true일 때만 이메일을 인정합니다.
 * 카카오는 서비스 탈퇴에 연결 끊기를 넣도록 요구하므로 어드민 키로 [unlink]합니다.
 */
@Component
class KakaoOAuthClient(
    @param:Qualifier("oauthRestClient") private val restClient: RestClient,
    private val properties: AccountOAuthProperties,
    @param:Qualifier("seoulClock") private val clock: Clock,
) : OAuthProviderClient {

    override val provider: OAuthProvider = OAuthProvider.KAKAO

    override fun isConfigured(): Boolean = properties.kakao.isConfigured

    override fun authorizationUri(state: String, nonce: String, codeVerifier: String): URI {
        requireConfigured()
        return UriComponentsBuilder.fromUriString(AUTHORIZATION_ENDPOINT)
            .queryParam("client_id", "{clientId}")
            .queryParam("redirect_uri", "{redirectUri}")
            .queryParam("response_type", "code")
            .queryParam("scope", "{scope}")
            .queryParam("state", "{state}")
            .queryParam("nonce", "{nonce}")
            .encode()
            .buildAndExpand(
                mapOf(
                    "clientId" to properties.kakao.clientId,
                    "redirectUri" to properties.callbackUri(provider),
                    "scope" to SCOPE,
                    "state" to state,
                    "nonce" to nonce,
                ),
            )
            .toUri()
    }

    override fun exchange(code: String, codeVerifier: String, nonce: String): OAuthProfile {
        requireConfigured()
        val form = LinkedMultiValueMap<String, String>().apply {
            add("grant_type", "authorization_code")
            add("client_id", properties.kakao.clientId)
            add("redirect_uri", properties.callbackUri(provider))
            add("code", code)
            add("client_secret", properties.kakao.clientSecret)
        }
        val tokens = executeOAuthHttpCall(provider) {
            restClient.post()
                .uri(TOKEN_ENDPOINT)
                .contentType(FORM_UTF8)
                .body(form)
                .retrieve()
                .body(JsonNode::class.java)
        } ?: throw OAuthClientException.invalidResponse(provider, "token response was empty")
        // OpenID Connect가 꺼진 앱은 id_token 없이 액세스 토큰만 줍니다.
        val idToken = tokens.stringOrNull("id_token")
            ?: throw OAuthClientException.invalidResponse(provider, "token response has no id_token")
        val accessToken = tokens.stringOrNull("access_token")
            ?: throw OAuthClientException.invalidResponse(provider, "token response has no access_token")

        val claims = IdTokenHelper.readClaims(provider, idToken, setOf(ISSUER), properties.kakao.clientId, nonce, Instant.now(clock))
        val subject = requireNotNull(claims.stringOrNull("sub"))

        val user = executeOAuthHttpCall(provider) {
            restClient.get()
                .uri(USER_ENDPOINT)
                .header(HttpHeaders.AUTHORIZATION, "Bearer $accessToken")
                .retrieve()
                .body(JsonNode::class.java)
        } ?: throw OAuthClientException.invalidResponse(provider, "user response was empty")
        val userId = user.path("id").takeIf(JsonNode::isIntegralNumber)?.asLong()?.toString()
        if (userId != subject) throw OAuthClientException.invalidResponse(provider, "user id does not match the ID token subject")

        val kakaoAccount = user.path("kakao_account")
        val email = kakaoAccount.stringOrNull("email")?.trim()?.takeIf(String::isNotEmpty)
        val trusted = kakaoAccount.isTrue("is_email_valid") && kakaoAccount.isTrue("is_email_verified")
        return OAuthProfile(provider = provider, subject = subject, verifiedEmail = email?.takeIf { trusted })
    }

    /**
     * 어드민 키로 사용자와 앱의 연결을 끊습니다. 카카오가 동의를 철회하고 발급한 토큰을 폐기합니다.
     * 어드민 키가 없으면 호출하지 않고 false입니다.
     */
    fun unlink(subject: String): Boolean {
        val adminKey = properties.kakao.adminKey
        if (adminKey.isEmpty()) return false
        require(subject.isNotEmpty() && subject.all(Char::isDigit)) { "Kakao user id must be digits" }

        val form = LinkedMultiValueMap<String, String>().apply {
            add("target_id_type", "user_id")
            add("target_id", subject)
        }
        val response = executeOAuthHttpCall(provider) {
            restClient.post()
                .uri(UNLINK_ENDPOINT)
                .header(HttpHeaders.AUTHORIZATION, "KakaoAK $adminKey")
                .contentType(FORM_UTF8)
                .body(form)
                .retrieve()
                .body(JsonNode::class.java)
        }
        val id = response?.path("id")
        if (id == null || !id.isIntegralNumber || id.asText() != subject) {
            throw OAuthClientException.invalidResponse(provider, "unlink user id does not match")
        }
        return true
    }

    private fun requireConfigured() {
        if (!isConfigured()) throw OAuthClientException.notConfigured(provider)
    }

    private companion object {
        const val AUTHORIZATION_ENDPOINT = "https://kauth.kakao.com/oauth/authorize"
        const val TOKEN_ENDPOINT = "https://kauth.kakao.com/oauth/token"
        const val USER_ENDPOINT = "https://kapi.kakao.com/v2/user/me"
        const val UNLINK_ENDPOINT = "https://kapi.kakao.com/v1/user/unlink"
        const val ISSUER = "https://kauth.kakao.com"

        /** 카카오 동의항목 ID를 쉼표로 잇습니다. `openid`가 있어야 ID 토큰이 옵니다. */
        const val SCOPE = "openid,account_email"

        val FORM_UTF8 = MediaType("application", "x-www-form-urlencoded", StandardCharsets.UTF_8)
    }
}
