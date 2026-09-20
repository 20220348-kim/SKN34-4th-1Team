package ai.govbiz.core.account.client.oauth

import ai.govbiz.core.account.client.oauth.OAuthClientTestHelper.GOOGLE_CLIENT_ID
import ai.govbiz.core.account.client.oauth.OAuthClientTestHelper.NONCE
import ai.govbiz.core.account.client.oauth.OAuthClientTestHelper.NOW_EPOCH
import ai.govbiz.core.account.client.oauth.OAuthClientTestHelper.PKCE_CHALLENGE
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
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.http.HttpMethod
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.test.web.client.MockRestServiceServer
import org.springframework.test.web.client.match.MockRestRequestMatchers.content
import org.springframework.test.web.client.match.MockRestRequestMatchers.method
import org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo
import org.springframework.test.web.client.response.MockRestResponseCreators.withStatus
import org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess
import org.springframework.util.LinkedMultiValueMap
import org.springframework.web.client.RestClient

class GoogleOAuthClientTest {

    private lateinit var server: MockRestServiceServer
    private lateinit var client: GoogleOAuthClient

    @BeforeEach
    fun setUp() {
        val builder = RestClient.builder()
        server = MockRestServiceServer.bindTo(builder).build()
        client = GoogleOAuthClient(builder.build(), OAuthClientTestHelper.properties(), AccountTestHelper.FIXED_CLOCK)
    }

    @AfterEach
    fun verifiesEveryExpectedRequest() {
        server.verify()
    }

    @Test
    fun buildsTheAuthorizationUriWithPkceNonceAndTheRegisteredRedirectUri() {
        val uri = client.authorizationUri("state-value", NONCE, PKCE_VERIFIER)

        assertEquals("https", uri.scheme)
        assertEquals("accounts.google.com", uri.host)
        assertEquals("/o/oauth2/v2/auth", uri.path)
        assertEquals(
            mapOf(
                "client_id" to GOOGLE_CLIENT_ID,
                "redirect_uri" to "http://127.0.0.1:5173/api/v1/auth/oauth/google/callback",
                "response_type" to "code",
                "scope" to "openid email",
                "state" to "state-value",
                "nonce" to NONCE,
                "code_challenge" to PKCE_CHALLENGE,
                "code_challenge_method" to "S256",
            ),
            queryParams(uri),
        )
    }

    @Test
    fun exchangesTheCodeWithTheVerifierAndReturnsTheSubjectWithAVerifiedEmail() {
        server.expect(requestTo(TOKEN_URL))
            .andExpect(method(HttpMethod.POST))
            .andExpect(
                content().formData(
                    LinkedMultiValueMap(
                        mapOf(
                            "grant_type" to listOf("authorization_code"),
                            "code" to listOf("auth-code"),
                            "client_id" to listOf(GOOGLE_CLIENT_ID),
                            "client_secret" to listOf("google-secret"),
                            "redirect_uri" to listOf("http://127.0.0.1:5173/api/v1/auth/oauth/google/callback"),
                            "code_verifier" to listOf(PKCE_VERIFIER),
                        ),
                    ),
                ),
            )
            .andRespond(withSuccess(tokenResponse(claims()), MediaType.APPLICATION_JSON))

        val profile = client.exchange("auth-code", PKCE_VERIFIER, NONCE)

        assertEquals(OAuthProfile(OAuthProvider.GOOGLE, SUBJECT, "Manager@Company.co.kr"), profile)
    }

    @Test
    fun dropsAnEmailThatGoogleHasNotVerified() {
        server.expect(requestTo(TOKEN_URL))
            .andRespond(withSuccess(tokenResponse(claims(emailVerified = "false")), MediaType.APPLICATION_JSON))

        assertEquals(OAuthProfile(OAuthProvider.GOOGLE, SUBJECT, null), client.exchange("auth-code", PKCE_VERIFIER, NONCE))
    }

    @Test
    fun rejectsIdTokensForAnotherClientIssuerOrLoginAndExpiredTokens() {
        val forged = listOf(
            claims(audience = "\"other-client\""),
            claims(audience = "[\"$GOOGLE_CLIENT_ID\",\"other-client\"]"),
            claims(issuer = "https://evil.example"),
            claims(nonce = "another-nonce"),
            claims(expiresAt = NOW_EPOCH - 61),
            claims(issuedAt = NOW_EPOCH + 61),
            """{"iss":"https://accounts.google.com","aud":"$GOOGLE_CLIENT_ID","exp":${NOW_EPOCH + 3600},"iat":$NOW_EPOCH,"nonce":"$NONCE"}""",
        )
        forged.forEach { claimsJson ->
            server.expect(requestTo(TOKEN_URL)).andRespond(withSuccess(tokenResponse(claimsJson), MediaType.APPLICATION_JSON))
        }

        forged.forEach { _ ->
            val failure = assertThrows(OAuthClientException::class.java) { client.exchange("auth-code", PKCE_VERIFIER, NONCE) }
            assertEquals(OAuthClientException.Failure.INVALID_RESPONSE, failure.failure)
        }
    }

    @Test
    fun acceptsMultipleAudiencesOnlyWhenAuthorizedPartyIsThisClient() {
        server.expect(requestTo(TOKEN_URL)).andRespond(
            withSuccess(
                tokenResponse(claims(audience = "[\"$GOOGLE_CLIENT_ID\",\"other-client\"]", extra = ""","azp":"$GOOGLE_CLIENT_ID"""")),
                MediaType.APPLICATION_JSON,
            ),
        )

        assertEquals(SUBJECT, client.exchange("auth-code", PKCE_VERIFIER, NONCE).subject)
    }

    @Test
    fun turnsTokenEndpointRejectionsAndMissingIdTokensIntoClientExceptions() {
        server.expect(requestTo(TOKEN_URL))
            .andRespond(withStatus(HttpStatus.BAD_REQUEST).contentType(MediaType.APPLICATION_JSON).body("""{"error":"invalid_grant"}"""))
        server.expect(requestTo(TOKEN_URL))
            .andRespond(withSuccess("""{"access_token":"access"}""", MediaType.APPLICATION_JSON))

        val rejected = assertThrows(OAuthClientException::class.java) { client.exchange("reused-code", PKCE_VERIFIER, NONCE) }
        assertEquals(OAuthClientException.Failure.REJECTED, rejected.failure)
        assertFalse(rejected.message.orEmpty().contains("invalid_grant"))

        val missing = assertThrows(OAuthClientException::class.java) { client.exchange("auth-code", PKCE_VERIFIER, NONCE) }
        assertEquals(OAuthClientException.Failure.INVALID_RESPONSE, missing.failure)
    }

    @Test
    fun refusesToStartOrExchangeWhenTheClientIsNotConfigured() {
        val unconfigured = GoogleOAuthClient(
            RestClient.builder().build(),
            OAuthClientTestHelper.properties(googleConfigured = false),
            AccountTestHelper.FIXED_CLOCK,
        )

        assertFalse(unconfigured.isConfigured())
        assertEquals(
            OAuthClientException.Failure.NOT_CONFIGURED,
            assertThrows(OAuthClientException::class.java) { unconfigured.authorizationUri("s", NONCE, PKCE_VERIFIER) }.failure,
        )
        assertEquals(
            OAuthClientException.Failure.NOT_CONFIGURED,
            assertThrows(OAuthClientException::class.java) { unconfigured.exchange("c", PKCE_VERIFIER, NONCE) }.failure,
        )
    }

    private fun claims(
        audience: String = "\"$GOOGLE_CLIENT_ID\"",
        issuer: String = "https://accounts.google.com",
        nonce: String = NONCE,
        expiresAt: Long = NOW_EPOCH + 3600,
        issuedAt: Long = NOW_EPOCH,
        emailVerified: String = "true",
        extra: String = "",
    ): String =
        """{"iss":"$issuer","aud":$audience,"sub":"$SUBJECT","exp":$expiresAt,"iat":$issuedAt,"nonce":"$nonce",""" +
            """"email":" Manager@Company.co.kr ","email_verified":$emailVerified$extra}"""

    private fun tokenResponse(claimsJson: String): String =
        """{"access_token":"access","expires_in":3599,"token_type":"Bearer","id_token":"${idToken(claimsJson)}"}"""

    private companion object {
        const val TOKEN_URL = "https://oauth2.googleapis.com/token"
        const val SUBJECT = "110169484474386276334"
    }
}
