package ai.govbiz.core.account.client.oauth

import ai.govbiz.core.account.config.AccountOAuthProperties
import ai.govbiz.core.account.helper.AccountTestHelper
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.util.Base64

/** 소셜 로그인 Client 테스트가 함께 쓰는 설정과 서명 없는 ID 토큰 예시입니다. 서명은 검증하지 않으므로 형식만 맞춥니다. */
object OAuthClientTestHelper {

    const val GOOGLE_CLIENT_ID = "google-client-id.apps.googleusercontent.com"
    const val KAKAO_CLIENT_ID = "kakao-rest-api-key"
    const val NONCE = "nonce-value-0123456789abcdefghijklmnopqrstu"

    /** RFC 7636 부록 B의 예시 verifier와 S256 challenge입니다. */
    const val PKCE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    const val PKCE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"

    val NOW_EPOCH: Long = AccountTestHelper.FIXED_CLOCK.instant().epochSecond

    fun properties(
        googleConfigured: Boolean = true,
        kakaoConfigured: Boolean = true,
        kakaoAdminKey: String = "kakao-admin-key",
    ): AccountOAuthProperties =
        AccountOAuthProperties(
            google = AccountOAuthProperties.ClientCredentials(
                clientId = if (googleConfigured) GOOGLE_CLIENT_ID else "",
                clientSecret = if (googleConfigured) "google-secret" else "",
            ),
            kakao = AccountOAuthProperties.KakaoCredentials(
                clientId = if (kakaoConfigured) KAKAO_CLIENT_ID else "",
                clientSecret = if (kakaoConfigured) "kakao-secret" else "",
                adminKey = kakaoAdminKey,
            ),
        )

    /** 헤더·서명은 형식만 갖춘 compact JWS입니다. */
    fun idToken(claimsJson: String): String {
        val encoder = Base64.getUrlEncoder().withoutPadding()
        return "${encoder.encodeToString("""{"alg":"RS256","kid":"test"}""".toByteArray())}." +
            "${encoder.encodeToString(claimsJson.toByteArray(StandardCharsets.UTF_8))}.c2lnbmF0dXJl"
    }

    /** 인가 주소의 쿼리 값을 디코딩해 돌려줍니다. */
    fun queryParams(uri: URI): Map<String, String> =
        uri.rawQuery.split('&').associate { pair ->
            val (name, value) = pair.split('=', limit = 2)
            name to URLDecoder.decode(value, StandardCharsets.UTF_8)
        }
}
