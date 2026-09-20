package ai.govbiz.core.account.controller

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.account.client.oauth.GoogleOAuthClient
import ai.govbiz.core.account.client.oauth.KakaoOAuthClient
import ai.govbiz.core.account.client.oauth.OAuthProviderClient
import ai.govbiz.core.account.domain.NewAccount
import ai.govbiz.core.account.domain.OAuthProfile
import ai.govbiz.core.account.domain.OAuthProvider
import ai.govbiz.core.account.helper.OAuthStateCookieHelper
import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core.account.helper.SignupTestHelper
import ai.govbiz.core.account.helper.SessionTokenHelper
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.account.repository.MobileOAuthTransactionRepository
import jakarta.servlet.http.Cookie
import java.net.URI
import java.security.MessageDigest
import java.time.LocalDateTime
import java.util.Base64
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.mockito.ArgumentMatchers.anyString
import org.mockito.Mockito.doAnswer
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.never
import org.mockito.Mockito.verify
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc
import org.springframework.context.annotation.Import
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.test.context.bean.override.mockito.MockitoBean
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.cookie
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.header
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import org.springframework.web.util.UriComponentsBuilder
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import tools.jackson.databind.json.JsonMapper

/** 실제 MySQL 8.4·세션 검증·HTTP 경계를 사용하고 외부 OAuth 공급자만 대역으로 대체합니다. */
@SpringBootTest(properties = [
    "app.account.jwt-secret=test-jwt-secret-0123456789abcdef0123456789",
    "app.ai-service.base-url=http://127.0.0.1:1", "app.ai-service.connect-timeout=10ms", "app.ai-service.read-timeout=10ms",
    "app.bizinfo.sync.enabled=false", "app.support-program-index.enabled=false", "app.account.cookie-secure=false",
    "app.account.oauth.unlink.enabled=false", "app.account.mobile-oauth.redirect-uris=govbiz://oauth/complete",
])
@AutoConfigureMockMvc
@Import(MySqlTestContainerConfig::class)
class AccountMobileAuthFlowIntegrationTest {
    @Autowired private lateinit var mockMvc: MockMvc
    @Autowired private lateinit var jdbc: JdbcTemplate
    @Autowired private lateinit var accounts: AccountRepository
    @Autowired private lateinit var transactions: MobileOAuthTransactionRepository
    @Autowired private lateinit var transactionManager: PlatformTransactionManager
    @Autowired private lateinit var passwords: PasswordEncoder
    @MockitoBean private lateinit var google: GoogleOAuthClient
    @MockitoBean private lateinit var kakao: KakaoOAuthClient
    private var address = "127.0.0.1"
    private val json = JsonMapper.builder().build()

    @BeforeEach
    fun reset() {
        jdbc.update("DELETE FROM mobile_oauth_transaction")
        jdbc.update("DELETE FROM partner_proposal")
        jdbc.update("DELETE FROM partner_recruitment")
        jdbc.update("DELETE FROM company")
        jdbc.update("DELETE FROM account_oauth_identity")
        jdbc.update("DELETE FROM account_session")
        jdbc.update("DELETE FROM account")
        address = "10.34.0.${addresses.incrementAndGet()}"
        accounts.createAccount(NewAccount(email = EMAIL, passwordHash = requireNotNull(passwords.encode(PASSWORD)),
            termsAgreedAt = LocalDateTime.now(), emailVerifiedAt = LocalDateTime.now()))
        configure(google, OAuthProvider.GOOGLE)
        configure(kakao, OAuthProvider.KAKAO)
    }

    @Test
    fun emailLoginUsesBearerForReadWriteAndLogoutWithoutIssuingCookies() {
        val token = login()
        perform(get("/api/v1/auth/me").header(HttpHeaders.AUTHORIZATION, "Bearer $token"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.account.email").value(EMAIL))
        perform(get("/api/v1/me/saved-programs").header(HttpHeaders.AUTHORIZATION, "Bearer $token"))
            .andExpect(status().isOk())
        perform(put("/api/v1/me/password").header(HttpHeaders.AUTHORIZATION, "Bearer $token")
            .contentType(MediaType.APPLICATION_JSON).content("""{"newPassword":"changed-password1"}"""))
            .andExpect(status().isNoContent())
        perform(get("/api/v1/auth/me").header(HttpHeaders.AUTHORIZATION, "Bearer $token")).andExpect(status().isOk())
        perform(post("/api/v1/auth/mobile/logout").header(HttpHeaders.AUTHORIZATION, "Bearer $token"))
            .andExpect(status().isNoContent()).andExpect(header().doesNotExist(HttpHeaders.SET_COOKIE))
        perform(get("/api/v1/auth/me").header(HttpHeaders.AUTHORIZATION, "Bearer $token"))
            .andExpect(status().isUnauthorized())
    }

    @Test
    fun mobileSignupRequiresExistingEmailVerificationAndReturnsTheSameAccountContract() {
        val payload = SignupTestHelper.signupJson(jdbc, "new.mobile@company.co.kr", PASSWORD)
        val body = perform(post("/api/v1/auth/mobile/signup").contentType(MediaType.APPLICATION_JSON).content(payload))
            .andExpect(status().isCreated()).andExpect(header().doesNotExist(HttpHeaders.SET_COOKIE))
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.tokenType").value("Bearer"))
            .andExpect(jsonPath("$.account.emailVerified").value(true)).andReturn().response.contentAsString
        val token = json.readTree(body).path("accessToken").asString()
        perform(get("/api/v1/auth/me").header(HttpHeaders.AUTHORIZATION, "Bearer $token"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.account.email").value("new.mobile@company.co.kr"))
        perform(post("/api/v1/auth/mobile/signup").contentType(MediaType.APPLICATION_JSON).content(payload))
            .andExpect(status().`is`(422)).andExpect(jsonPath("$.code").value("EMAIL_VERIFICATION_REQUIRED"))
        perform(post("/api/v1/auth/mobile/login").contentType(MediaType.APPLICATION_JSON)
            .content("""{"email":"$EMAIL","password":"wrong-password"}"""))
            .andExpect(status().isUnauthorized()).andExpect(jsonPath("$.accessToken").doesNotExist())
    }

    @Test
    fun bearerDoesNotBypassCookieCsrfAndInvalidCookieDoesNotFallBackToBearer() {
        val token = login()
        val cookie = Cookie(SessionCookieHelper.COOKIE_NAME, token)
        perform(post("/api/v1/auth/mobile/logout").cookie(cookie).header(HttpHeaders.AUTHORIZATION, "Bearer $token"))
            .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("SESSION_ORIGIN_REJECTED"))
        perform(post("/api/v1/auth/mobile/logout").cookie(cookie).header(HttpHeaders.AUTHORIZATION, "Bearer $token")
            .header(HttpHeaders.ORIGIN, "https://evil.example")).andExpect(status().isForbidden())
        perform(get("/api/v1/auth/me").cookie(Cookie(SessionCookieHelper.COOKIE_NAME, "invalid"))
            .header(HttpHeaders.AUTHORIZATION, "Bearer $token")).andExpect(status().isUnauthorized())
        perform(get("/api/v1/auth/me").header(HttpHeaders.AUTHORIZATION, "Bearer $token")).andExpect(status().isOk())
        perform(get("/api/v1/partners/recruitments").header(HttpHeaders.AUTHORIZATION, "Basic invalid"))
            .andExpect(status().isUnauthorized())
    }

    @Test
    fun revokedExpiredAndSuspendedSessionsUseExistingChecks() {
        var token = login()
        jdbc.update("UPDATE account_session SET last_used_at = DATE_SUB(last_used_at, INTERVAL 8 DAY)")
        perform(get("/api/v1/auth/me").header(HttpHeaders.AUTHORIZATION, "Bearer $token")).andExpect(status().isUnauthorized())
        token = login()
        jdbc.update("UPDATE account_session SET expires_at = DATE_SUB(NOW(), INTERVAL 1 DAY)")
        perform(get("/api/v1/auth/me").header(HttpHeaders.AUTHORIZATION, "Bearer $token")).andExpect(status().isUnauthorized())
        token = login()
        jdbc.update("UPDATE account SET suspended_at = NOW() WHERE email = ?", EMAIL)
        perform(get("/api/v1/auth/me").header(HttpHeaders.AUTHORIZATION, "Bearer $token")).andExpect(status().isForbidden())
    }

    @Test
    fun googleAndKakaoUseShortOneTimePkceCodesAndDoNotIssueBrowserSessions() {
        listOf("google", "kakao").forEach { provider ->
            val flow = start(provider)
            val callback = callback(flow).andExpect(status().isFound())
                .andExpect(cookie().doesNotExist(SessionCookieHelper.COOKIE_NAME))
                .andExpect(header().string("Referrer-Policy", "no-referrer")).andReturn().response
            val location = requireNotNull(callback.getHeader(HttpHeaders.LOCATION))
            assertFalse(location.contains("accessToken"))
            val params = UriComponentsBuilder.fromUriString(location).build().queryParams
            assertEquals(APP_STATE, params.getFirst("state"))
            val code = requireNotNull(params.getFirst("code"))
            assertEquals(43, code.length)
            assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM account_session", Int::class.java))
            val stored = jdbc.queryForObject("SELECT code_hash FROM mobile_oauth_transaction WHERE provider = ?", String::class.java, provider.uppercase())
            assertNotNull(stored)
            assertFalse(code == stored)
            callback(flow).andExpect(status().isUnauthorized())
            exchange(code, "wrong".repeat(13)).andExpect(status().isUnauthorized())
            exchange(code, VERIFIER, "govbiz://oauth/other").andExpect(status().isUnauthorized())
            val body = exchange(code).andExpect(status().isOk()).andExpect(header().doesNotExist(HttpHeaders.SET_COOKIE))
                .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store")).andReturn().response.contentAsString
            val token = json.readTree(body).path("accessToken").asString()
            perform(get("/api/v1/auth/me").header(HttpHeaders.AUTHORIZATION, "Bearer $token")).andExpect(status().isOk())
            exchange(code).andExpect(status().isUnauthorized())
            perform(post("/api/v1/auth/mobile/logout").header(HttpHeaders.AUTHORIZATION, "Bearer $token"))
                .andExpect(status().isNoContent())
        }
    }

    @Test
    fun rejectsUnknownRedirectAndInvalidStateBeforeCallingProviders() {
        perform(get("/api/v1/auth/mobile/oauth/google/authorize").param("redirectUri", "govbiz://evil/complete")
            .param("state", APP_STATE).param("codeChallenge", challenge())).andExpect(status().isBadRequest())
        perform(get("/api/v1/auth/mobile/oauth/google/authorize").param("redirectUri", REDIRECT)
            .param("state", "short").param("codeChallenge", challenge())).andExpect(status().isBadRequest())
        verify(google, never()).authorizationUri(anyString(), anyString(), anyString())
    }

    @Test
    fun rejectsWrongProviderAndStateWithoutConsumingTheLegitimateCallback() {
        val flow = start("google")
        perform(get("/api/v1/auth/oauth/google/callback").cookie(flow.cookie).param("code", "provider-code").param("state", "wrong"))
            .andExpect(status().isUnauthorized())
        perform(get("/api/v1/auth/oauth/kakao/callback").cookie(flow.cookie).param("code", "provider-code").param("state", flow.state))
            .andExpect(status().isUnauthorized())
        callback(flow).andExpect(status().isFound())
    }

    @Test
    fun expiresOAuthTransactionsAndExchangeCodes() {
        val expired = start("google")
        jdbc.update("UPDATE mobile_oauth_transaction SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE)")
        callback(expired).andExpect(status().isUnauthorized())
        val flow = start("google")
        val code = callbackCode(flow)
        jdbc.update("UPDATE mobile_oauth_transaction SET code_expires_at = DATE_SUB(NOW(), INTERVAL 1 SECOND)")
        exchange(code).andExpect(status().isUnauthorized())
    }

    @Test
    fun cancellationReturnsOnlyAllowlistedCallbackAndAppState() {
        val flow = start("google")
        perform(get("/api/v1/auth/oauth/google/callback").cookie(flow.cookie).param("state", flow.state).param("error", "access_denied"))
            .andExpect(status().isFound()).andExpect(header().string(HttpHeaders.LOCATION, "$REDIRECT?state=$APP_STATE&error=cancelled"))
        verify(google, never()).exchange(anyString(), anyString(), anyString())
    }

    @Test
    fun concurrentCodeExchangesCreateOnlyOneSession() {
        val code = callbackCode(start("google"))
        Executors.newFixedThreadPool(2).use { pool ->
            val responses = pool.invokeAll(List(2) { java.util.concurrent.Callable { exchange(code).andReturn().response.status } })
            assertEquals(listOf(200, 401), responses.map { it.get() }.sorted())
        }
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM account_session", Int::class.java))
    }

    @Test
    fun callbackIsClaimedOnceAcrossConcurrentRequestsAndExchangeRechecksAccountSuspension() {
        val flow = start("google")
        val responses = Executors.newFixedThreadPool(2).use { pool ->
            pool.invokeAll(List(2) { java.util.concurrent.Callable { callback(flow).andReturn().response } }).map { it.get() }
        }
        assertEquals(listOf(302, 401), responses.map { it.status }.sorted())
        verify(google).exchange(anyString(), anyString(), anyString())
        val uri = requireNotNull(responses.single { it.status == 302 }.getHeader(HttpHeaders.LOCATION))
        val code = requireNotNull(UriComponentsBuilder.fromUriString(uri).build().queryParams.getFirst("code"))
        jdbc.update("UPDATE account SET suspended_at = NOW() WHERE email = ?", "google@mobile.example")
        exchange(code).andExpect(status().isForbidden())
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM account_session", Int::class.java))
    }

    @Test
    fun rollbackRestoresCodeConsumptionAndCallbackStillRequiresItsBrowserCookie() {
        val flow = start("google")
        perform(get("/api/v1/auth/oauth/google/callback").param("state", flow.state).param("code", "provider-code"))
            .andExpect(status().isFound())
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM mobile_oauth_transaction WHERE code_hash IS NOT NULL", Int::class.java))
        val code = callbackCode(flow)
        assertThrows(IllegalStateException::class.java) {
            TransactionTemplate(transactionManager).execute {
                assertNotNull(transactions.consumeCode(SessionTokenHelper.hash(code), REDIRECT, challenge(), LocalDateTime.now()))
                throw IllegalStateException("Simulated session storage failure")
            }
        }
        exchange(code).andExpect(status().isOk())
    }

    private fun login(): String {
        val body = perform(post("/api/v1/auth/mobile/login").contentType(MediaType.APPLICATION_JSON)
            .content("""{"email":"$EMAIL","password":"$PASSWORD","rememberMe":true}"""))
            .andExpect(status().isOk()).andExpect(header().doesNotExist(HttpHeaders.SET_COOKIE))
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.tokenType").value("Bearer")).andReturn().response.contentAsString
        return json.readTree(body).path("accessToken").asString()
    }

    private fun configure(client: OAuthProviderClient, provider: OAuthProvider) {
        doReturn(provider).`when`(client).provider
        doReturn(true).`when`(client).isConfigured()
        doAnswer { invocation -> URI("https://provider.example/authorize?state=${invocation.getArgument<String>(0)}") }
            .`when`(client).authorizationUri(anyString(), anyString(), anyString())
        doReturn(OAuthProfile(provider, "mobile-${provider.name}", "${provider.pathName}@mobile.example"))
            .`when`(client).exchange(anyString(), anyString(), anyString())
    }

    private fun start(provider: String): Flow {
        val response = perform(get("/api/v1/auth/mobile/oauth/$provider/authorize").param("redirectUri", REDIRECT)
            .param("state", APP_STATE).param("codeChallenge", challenge()).param("rememberMe", "true"))
            .andExpect(status().isFound()).andReturn().response
        val state = UriComponentsBuilder.fromUriString(requireNotNull(response.getHeader(HttpHeaders.LOCATION))).build().queryParams.getFirst("state")
        return Flow(provider, requireNotNull(state), requireNotNull(response.getCookie(OAuthStateCookieHelper.COOKIE_NAME)))
    }

    private fun callback(flow: Flow) = perform(get("/api/v1/auth/oauth/${flow.provider}/callback")
        .cookie(flow.cookie).param("code", "provider-code").param("state", flow.state))

    private fun callbackCode(flow: Flow): String {
        val location = callback(flow).andExpect(status().isFound()).andReturn().response.getHeader(HttpHeaders.LOCATION)
        return requireNotNull(UriComponentsBuilder.fromUriString(requireNotNull(location)).build().queryParams.getFirst("code"))
    }

    private fun exchange(code: String, verifier: String = VERIFIER, redirect: String = REDIRECT) =
        perform(post("/api/v1/auth/mobile/oauth/exchange").contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(mapOf("code" to code, "codeVerifier" to verifier, "redirectUri" to redirect))))

    private fun perform(request: MockHttpServletRequestBuilder) = mockMvc.perform(request.with { it.remoteAddr = address; it })
    private fun challenge(): String = Base64.getUrlEncoder().withoutPadding()
        .encodeToString(MessageDigest.getInstance("SHA-256").digest(VERIFIER.toByteArray(Charsets.US_ASCII)))
    private data class Flow(val provider: String, val state: String, val cookie: Cookie)
    companion object {
        private val addresses = AtomicInteger()
        private const val EMAIL = "mobile@company.co.kr"
        private const val PASSWORD = "password-12"
        private const val REDIRECT = "govbiz://oauth/complete"
        private val APP_STATE = "s".repeat(43)
        private val VERIFIER = "v".repeat(64)
    }
}
