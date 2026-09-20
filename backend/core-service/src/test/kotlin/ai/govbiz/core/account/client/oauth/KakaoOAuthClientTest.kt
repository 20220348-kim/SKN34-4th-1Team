package ai.govbiz.core.account.client.oauth

import ai.govbiz.core.account.client.oauth.OAuthClientTestHelper.KAKAO_CLIENT_ID
import ai.govbiz.core.account.client.oauth.OAuthClientTestHelper.NONCE
import ai.govbiz.core.account.client.oauth.OAuthClientTestHelper.NOW_EPOCH
import ai.govbiz.core.account.client.oauth.OAuthClientTestHelper.PKCE_VERIFIER
import ai.govbiz.core.account.client.oauth.OAuthClientTestHelper.idToken
import ai.govbiz.core.account.client.oauth.OAuthClientTestHelper.queryParams
import ai.govbiz.core.account.client.oauth.exception.OAuthClientException
import ai.govbiz.core.account.domain.OAuthProfile
import ai.govbiz.core.account.domain.OAuthProvider
import ai.govbiz.core.account.helper.AccountTestHelper
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpMethod
import org.springframework.http.MediaType
import org.springframework.test.web.client.MockRestServiceServer
import org.springframework.test.web.client.match.MockRestRequestMatchers.content
import org.springframework.test.web.client.match.MockRestRequestMatchers.header
import org.springframework.test.web.client.match.MockRestRequestMatchers.method
import org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo
import org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess
import org.springframework.util.LinkedMultiValueMap
import org.springframework.web.client.RestClient

class KakaoOAuthClientTest {

    private lateinit var server: MockRestServiceServer
    private lateinit var client: KakaoOAuthClient

    @BeforeEach
    fun setUp() {
        client = clientWith(OAuthClientTestHelper.properties())
    }

    @AfterEach
    fun verifiesEveryExpectedRequest() {
        server.verify()
    }

    @Test
    fun buildsTheAuthorizationUriWithOpenIdAndEmailScopesWithoutPkce() {
        val uri = client.authorizationUri("state-value", NONCE, PKCE_VERIFIER)

        assertEquals("kauth.kakao.com", uri.host)
        assertEquals("/oauth/authorize", uri.path)
        assertEquals(
            mapOf(
                "client_id" to KAKAO_CLIENT_ID,
                "redirect_uri" to "http://127.0.0.1:5173/api/v1/auth/oauth/kakao/callback",
                "response_type" to "code",
                "scope" to "openid,account_email",
                "state" to "state-value",
                "nonce" to NONCE,
            ),
            queryParams(uri),
        )
    }

    @Test
    fun exchangesTheCodeWithTheClientSecretAndTrustsOnlyAValidVerifiedKakaoEmail() {
        server.expect(requestTo(TOKEN_URL))
            .andExpect(method(HttpMethod.POST))
            .andExpect(
                content().formData(
                    LinkedMultiValueMap(
                        mapOf(
                            "grant_type" to listOf("authorization_code"),
                            "client_id" to listOf(KAKAO_CLIENT_ID),
                            "redirect_uri" to listOf("http://127.0.0.1:5173/api/v1/auth/oauth/kakao/callback"),
                            "code" to listOf("auth-code"),
                            "client_secret" to listOf("kakao-secret"),
                        ),
                    ),
                ),
            )
            .andRespond(withSuccess(tokenResponse(), MediaType.APPLICATION_JSON))
        server.expect(requestTo(USER_URL))
            .andExpect(method(HttpMethod.GET))
            .andExpect(header(HttpHeaders.AUTHORIZATION, "Bearer kakao-access"))
            .andRespond(withSuccess(userResponse(), MediaType.APPLICATION_JSON))

        val profile = client.exchange("auth-code", PKCE_VERIFIER, NONCE)

        assertEquals(OAuthProfile(OAuthProvider.KAKAO, SUBJECT.toString(), "manager@kakao.com"), profile)
    }

    @Test
    fun dropsAnEmailThatIsUnverifiedInvalidOrNotShared() {
        listOf(
            userResponse(verified = false),
            userResponse(valid = false),
            """{"id":$SUBJECT,"kakao_account":{"has_email":true,"email_needs_agreement":true}}""",
        ).forEach { user ->
            server.expect(requestTo(TOKEN_URL)).andRespond(withSuccess(tokenResponse(), MediaType.APPLICATION_JSON))
            server.expect(requestTo(USER_URL)).andRespond(withSuccess(user, MediaType.APPLICATION_JSON))
        }

        repeat(3) {
            assertEquals(OAuthProfile(OAuthProvider.KAKAO, SUBJECT.toString(), null), client.exchange("auth-code", PKCE_VERIFIER, NONCE))
        }
    }

    @Test
    fun rejectsATokenResponseWithoutAnIdTokenAndAUserThatDoesNotMatchTheIdToken() {
        server.expect(requestTo(TOKEN_URL))
            .andRespond(withSuccess("""{"access_token":"kakao-access","token_type":"bearer"}""", MediaType.APPLICATION_JSON))
        server.expect(requestTo(TOKEN_URL)).andRespond(withSuccess(tokenResponse(), MediaType.APPLICATION_JSON))
        server.expect(requestTo(USER_URL)).andRespond(withSuccess(userResponse(id = 999L), MediaType.APPLICATION_JSON))

        repeat(2) {
            val failure = assertThrows(OAuthClientException::class.java) { client.exchange("auth-code", PKCE_VERIFIER, NONCE) }
            assertEquals(OAuthClientException.Failure.INVALID_RESPONSE, failure.failure)
        }
    }

    @Test
    fun unlinksTheKakaoUserWithTheAdminKey() {
        server.expect(requestTo(UNLINK_URL))
            .andExpect(method(HttpMethod.POST))
            .andExpect(header(HttpHeaders.AUTHORIZATION, "KakaoAK kakao-admin-key"))
            .andExpect(
                content().formData(
                    LinkedMultiValueMap(mapOf("target_id_type" to listOf("user_id"), "target_id" to listOf(SUBJECT.toString()))),
                ),
            )
            .andRespond(withSuccess("""{"id":$SUBJECT}""", MediaType.APPLICATION_JSON))

        assertTrue(client.unlink(SUBJECT.toString()))
    }

    @Test
    fun skipsUnlinkingWithoutAnAdminKey() {
        client = clientWith(OAuthClientTestHelper.properties(kakaoAdminKey = ""))

        assertFalse(client.unlink(SUBJECT.toString()))
    }

    @Test
    fun doesNotConfirmUnlinkWithAnEmptyMismatchedOrNonNumericResponseId() {
        for (body in listOf("{}", "{\"id\":999}", "{\"id\":\"$SUBJECT\"}", "null")) {
            client = clientWith(OAuthClientTestHelper.properties())
            server.expect(requestTo(UNLINK_URL)).andRespond(withSuccess(body, MediaType.APPLICATION_JSON))
            val failure = assertThrows(OAuthClientException::class.java) { client.unlink(SUBJECT.toString()) }
            assertEquals(OAuthClientException.Failure.INVALID_RESPONSE, failure.failure)
        }
    }

    private fun clientWith(properties: ai.govbiz.core.account.config.AccountOAuthProperties): KakaoOAuthClient {
        val builder = RestClient.builder()
        server = MockRestServiceServer.bindTo(builder).build()
        return KakaoOAuthClient(builder.build(), properties, AccountTestHelper.FIXED_CLOCK)
    }

    private fun tokenResponse(): String {
        val claims = """{"aud":"$KAKAO_CLIENT_ID","sub":"$SUBJECT","auth_time":$NOW_EPOCH,"iss":"https://kauth.kakao.com",""" +
            """"exp":${NOW_EPOCH + 43199},"iat":$NOW_EPOCH,"nonce":"$NONCE","email":"manager@kakao.com"}"""
        return """{"token_type":"bearer","access_token":"kakao-access","id_token":"${idToken(claims)}",""" +
            """"expires_in":43199,"refresh_token":"kakao-refresh","refresh_token_expires_in":5184000,"scope":"openid account_email"}"""
    }

    private fun userResponse(id: Long = SUBJECT, valid: Boolean = true, verified: Boolean = true): String =
        """{"id":$id,"connected_at":"2026-09-06T03:00:00Z","kakao_account":{"has_email":true,"email_needs_agreement":false,""" +
            """"is_email_valid":$valid,"is_email_verified":$verified,"email":"manager@kakao.com"}}"""

    private companion object {
        const val TOKEN_URL = "https://kauth.kakao.com/oauth/token"
        const val USER_URL = "https://kapi.kakao.com/v2/user/me"
        const val UNLINK_URL = "https://kapi.kakao.com/v1/user/unlink"
        const val SUBJECT = 4012345678L
    }
}
