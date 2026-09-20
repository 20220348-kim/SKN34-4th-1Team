package ai.govbiz.core.account.controller

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.account.client.oauth.GoogleOAuthClient
import ai.govbiz.core.account.client.oauth.KakaoOAuthClient
import ai.govbiz.core.account.client.oauth.OAuthProviderClient
import ai.govbiz.core.account.domain.OAuthProfile
import ai.govbiz.core.account.domain.OAuthProvider
import ai.govbiz.core.account.helper.OAuthStateCookieHelper
import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core.account.helper.SignupTestHelper
import ai.govbiz.core.account.service.AccountOAuthUnlinkService
import jakarta.servlet.http.Cookie
import java.net.URI
import org.hamcrest.Matchers.contains
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
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
import org.springframework.test.context.bean.override.mockito.MockitoBean
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.MvcResult
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

/**
 * 소셜 로그인 시작 → 공급자 콜백 → 계정 생성·세션 발급 → 재로그인·탈퇴를 실제 MySQL 8.4에서 확인합니다.
 * 공급자 호출은 외부 시스템이라 Client만 대역으로 바꾸고, state 쿠키·계정 연결 규칙·트랜잭션은 실제로 거칩니다.
 */
@SpringBootTest(
    properties = [
        "app.account.jwt-secret=test-jwt-secret-0123456789abcdef0123456789",
        "app.ai-service.base-url=http://127.0.0.1:1",
        "app.ai-service.connect-timeout=10ms",
        "app.ai-service.read-timeout=10ms",
        "app.bizinfo.sync.enabled=false",
        "app.support-program-index.enabled=false",
        "app.account.cookie-secure=false",
        "app.account.oauth.unlink.enabled=false",
    ],
)
@AutoConfigureMockMvc
@Import(MySqlTestContainerConfig::class)
class AccountOAuthFlowIntegrationTest {

    @Autowired
    private lateinit var mockMvc: MockMvc

    @Autowired
    private lateinit var jdbcTemplate: JdbcTemplate

    @Autowired private lateinit var unlinkService: AccountOAuthUnlinkService

    @MockitoBean
    private lateinit var googleClient: GoogleOAuthClient

    @MockitoBean
    private lateinit var kakaoClient: KakaoOAuthClient

    /** 시작할 때 공급자 Client에 넘긴 nonce·verifier입니다. 콜백의 코드 교환에 같은 값이 와야 합니다. */
    private val started = mutableMapOf<OAuthProvider, Pair<String, String>>()

    @BeforeEach
    fun resetAccountsAndProviders() {
        jdbcTemplate.update("DELETE FROM partner_proposal")
        jdbcTemplate.update("DELETE FROM partner_recruitment")
        jdbcTemplate.update("DELETE FROM company")
        jdbcTemplate.update("DELETE FROM account_oauth_identity")
        jdbcTemplate.update("DELETE FROM account_session")
        jdbcTemplate.update("DELETE FROM account")
        started.clear()
        configure(googleClient, OAuthProvider.GOOGLE, "https://accounts.google.com/o/oauth2/v2/auth")
        configure(kakaoClient, OAuthProvider.KAKAO, "https://kauth.kakao.com/oauth/authorize")
    }

    @Test
    fun signsUpAPasswordlessVerifiedMemberAndSignsTheSameGoogleAccountInAgain() {
        stubProfile(googleClient, OAuthProfile(OAuthProvider.GOOGLE, GOOGLE_SUBJECT, "Manager@Gmail.com"))

        mockMvc.perform(get("/api/v1/auth/oauth/providers"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.providers[*].provider", contains("kakao", "google")))

        val first = completeSignIn("google", next = "/app/partners")
        assertEquals("http://127.0.0.1:5173/oauth/complete?next=%2Fapp%2Fpartners", first.response.getHeader(HttpHeaders.LOCATION))
        val (nonce, verifier) = requireNotNull(started[OAuthProvider.GOOGLE])
        verify(googleClient).exchange("auth-code", verifier, nonce)

        mockMvc.perform(get("/api/v1/auth/me").cookie(sessionOf(first)))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.account.email").value("manager@gmail.com"))
            .andExpect(jsonPath("$.account.emailVerified").value(true))
            .andExpect(jsonPath("$.account.tier").value("MEMBER"))
        assertEquals(1, count("SELECT COUNT(*) FROM account WHERE password_hash IS NULL AND email_verified_at IS NOT NULL"))
        assertEquals(1, count("SELECT COUNT(*) FROM account_oauth_identity WHERE provider = 'GOOGLE' AND subject = '$GOOGLE_SUBJECT'"))

        val second = completeSignIn("google")
        mockMvc.perform(get("/api/v1/auth/me").cookie(sessionOf(second))).andExpect(status().isOk())
        assertEquals(1, count("SELECT COUNT(*) FROM account"))
        // 소셜로만 가입한 계정은 비밀번호가 없어 이메일 로그인이 되지 않습니다.
        mockMvc.perform(
            post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON)
                .content("""{"email":"manager@gmail.com","password":"password1"}"""),
        ).andExpect(status().isUnauthorized())
    }

    @Test
    fun doesNotLinkASocialAccountToAnExistingEmailAccount() {
        mockMvc.perform(
            post("/api/v1/auth/signup").contentType(MediaType.APPLICATION_JSON)
                .content(SignupTestHelper.signupJson(jdbcTemplate, "manager@company.co.kr", "password1")),
        ).andExpect(status().isCreated())
        stubProfile(kakaoClient, OAuthProfile(OAuthProvider.KAKAO, KAKAO_SUBJECT, "manager@company.co.kr"))

        val result = completeSignIn("kakao")

        assertEquals("http://127.0.0.1:5173/login?oauthError=account-exists&next=%2Fapp%2Fchat", result.response.getHeader(HttpHeaders.LOCATION))
        assertNull(result.response.getCookie(SessionCookieHelper.COOKIE_NAME))
        assertEquals(0, count("SELECT COUNT(*) FROM account_oauth_identity"))
        assertEquals(1, count("SELECT COUNT(*) FROM account"))
    }

    @Test
    fun rejectsCallbacksWithoutTheStartingBrowsersStateBeforeCallingTheProvider() {
        val start = authorize("kakao")
        val stateCookie = requireNotNull(start.response.getCookie(OAuthStateCookieHelper.COOKIE_NAME))
        val state = stateOf(start)

        val noCookie = callback("kakao", state, cookie = null)
        val wrongState = callback("kakao", "x".repeat(43), cookie = stateCookie)
        val otherProvider = callback("google", state, cookie = stateCookie)

        listOf(noCookie, wrongState, otherProvider).forEach { result ->
            assertEquals("http://127.0.0.1:5173/login?oauthError=expired&next=%2Fapp%2Fchat", result.response.getHeader(HttpHeaders.LOCATION))
            assertNull(result.response.getCookie(SessionCookieHelper.COOKIE_NAME))
        }
        verify(kakaoClient, never()).exchange(anyString(), anyString(), anyString())
        verify(googleClient, never()).exchange(anyString(), anyString(), anyString())
    }

    @Test
    fun deletingASocialAccountBlocksRejoiningUntilDurableUnlinkSucceeds() {
        stubProfile(kakaoClient, OAuthProfile(OAuthProvider.KAKAO, KAKAO_SUBJECT, "leaver@kakao.com"))
        val session = sessionOf(completeSignIn("kakao"))

        // 소셜로만 가입한 계정은 비밀번호가 없다고 내려받고, 삭제는 비밀번호 없이 세션만으로 합니다.
        mockMvc.perform(get("/api/v1/auth/me").cookie(session))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.account.hasPassword").value(false))
        mockMvc.perform(
            delete("/api/v1/me").cookie(session).origin()
                .contentType(MediaType.APPLICATION_JSON)
                .content("{}"),
        ).andExpect(status().isNoContent())

        verify(kakaoClient, never()).unlink(KAKAO_SUBJECT)
        val blocked = completeSignIn("kakao")
        assertEquals("http://127.0.0.1:5173/login?oauthError=unlink-pending&next=%2Fapp%2Fchat", blocked.response.getHeader(HttpHeaders.LOCATION))
        assertNull(blocked.response.getCookie(SessionCookieHelper.COOKIE_NAME))
        assertEquals(1, count("SELECT COUNT(*) FROM account_oauth_identity"))
        val jobId = requireNotNull(jdbcTemplate.queryForObject("SELECT id FROM account_oauth_unlink_job", Long::class.java))
        doReturn(true).`when`(kakaoClient).unlink(KAKAO_SUBJECT)
        unlinkService.execute(jobId)
        verify(kakaoClient).unlink(KAKAO_SUBJECT)
        assertEquals(0, count("SELECT COUNT(*) FROM account_oauth_identity"))

        val again = completeSignIn("kakao")
        assertNotNull(again.response.getCookie(SessionCookieHelper.COOKIE_NAME))
        assertEquals(2, count("SELECT COUNT(*) FROM account"))
        assertEquals(1, count("SELECT COUNT(*) FROM account_oauth_identity WHERE subject = '$KAKAO_SUBJECT'"))
        unlinkService.execute(jobId)
        verify(kakaoClient).unlink(KAKAO_SUBJECT)
        assertEquals(1, count("SELECT COUNT(*) FROM account_oauth_identity WHERE subject = '$KAKAO_SUBJECT'"))
    }

    private fun configure(client: OAuthProviderClient, provider: OAuthProvider, authorizationEndpoint: String) {
        doReturn(provider).`when`(client).provider
        doReturn(true).`when`(client).isConfigured()
        doAnswer { invocation ->
            started[provider] = invocation.getArgument<String>(1) to invocation.getArgument<String>(2)
            URI("$authorizationEndpoint?state=${invocation.getArgument<String>(0)}")
        }.`when`(client).authorizationUri(anyString(), anyString(), anyString())
    }

    /** 교환 인자(코드·verifier·nonce)는 각 테스트가 verify로 따로 확인합니다. Kotlin에서 `eq`는 String에 null을 돌려줘 쓰지 않습니다. */
    private fun stubProfile(client: OAuthProviderClient, profile: OAuthProfile) {
        doReturn(profile).`when`(client).exchange(anyString(), anyString(), anyString())
    }

    /** 시작 → 공급자 로그인(대역) → 콜백까지 브라우저처럼 state 쿠키를 들고 갑니다. */
    private fun completeSignIn(provider: String, next: String? = null): MvcResult {
        val start = authorize(provider, next)
        return callback(provider, stateOf(start), requireNotNull(start.response.getCookie(OAuthStateCookieHelper.COOKIE_NAME)))
    }

    private fun authorize(provider: String, next: String? = null): MvcResult =
        mockMvc.perform(get("/api/v1/auth/oauth/$provider/authorize").apply { if (next != null) param("next", next) })
            .andExpect(status().isFound())
            .andReturn()

    private fun callback(provider: String, state: String, cookie: Cookie?): MvcResult =
        mockMvc.perform(
            get("/api/v1/auth/oauth/$provider/callback")
                .param("code", "auth-code")
                .param("state", state)
                .apply { if (cookie != null) cookie(cookie) },
        )
            .andExpect(status().isFound())
            .andReturn()

    private fun stateOf(start: MvcResult): String =
        requireNotNull(start.response.getHeader(HttpHeaders.LOCATION)).substringAfter("state=")

    private fun sessionOf(result: MvcResult): Cookie =
        requireNotNull(result.response.getCookie(SessionCookieHelper.COOKIE_NAME)) { "session cookie was not issued" }

    private fun MockHttpServletRequestBuilder.origin(): MockHttpServletRequestBuilder =
        header(HttpHeaders.ORIGIN, "http://localhost:5173")

    private fun count(sql: String): Int =
        requireNotNull(jdbcTemplate.queryForObject(sql, Int::class.java))

    private companion object {
        const val GOOGLE_SUBJECT = "110169484474386276334"
        const val KAKAO_SUBJECT = "4012345678"
    }
}
