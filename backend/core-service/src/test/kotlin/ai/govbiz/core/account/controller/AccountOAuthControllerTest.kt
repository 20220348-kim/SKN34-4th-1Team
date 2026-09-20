package ai.govbiz.core.account.controller

import ai.govbiz.core._common.exception.ApiExceptionHandler
import ai.govbiz.core.account.config.AccountOAuthProperties
import ai.govbiz.core.account.domain.OAuthProvider
import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.helper.OAuthStateCookieHelper
import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core.account.service.AccountOAuthService
import ai.govbiz.core.account.service.AccountMobileOAuthService
import ai.govbiz.core.account.service.dto.AccountSessionResult
import ai.govbiz.core.account.service.dto.OAuthCallback
import ai.govbiz.core.account.service.dto.OAuthCompletionResult
import ai.govbiz.core.account.service.dto.OAuthFailure
import ai.govbiz.core.account.service.dto.OAuthStartResult
import jakarta.servlet.http.Cookie
import java.net.URI
import java.time.OffsetDateTime
import org.hamcrest.Matchers.allOf
import org.hamcrest.Matchers.containsString
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.mockito.Mock
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.verifyNoInteractions
import org.mockito.junit.jupiter.MockitoExtension
import org.springframework.http.HttpHeaders
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.cookie
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.header
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import org.springframework.test.web.servlet.setup.MockMvcBuilders

@ExtendWith(MockitoExtension::class)
class AccountOAuthControllerTest {

    @Mock
    private lateinit var oauthService: AccountOAuthService

    @Mock
    private lateinit var mobileOAuthService: AccountMobileOAuthService

    private val stateCookieHelper = OAuthStateCookieHelper(AccountTestHelper.sessionProperties(), AccountTestHelper.FIXED_CLOCK)

    private lateinit var mockMvc: MockMvc

    @BeforeEach
    fun setUp() {
        mockMvc = MockMvcBuilders
            .standaloneSetup(
                AccountOAuthController(oauthService, stateCookieHelper, AccountTestHelper.cookieHelper(), AccountOAuthProperties(), mobileOAuthService),
            )
            .setControllerAdvice(ApiExceptionHandler())
            .build()
    }

    @Test
    fun listsConfiguredProvidersWithStartUrlsOnTheCallbackHost() {
        doReturn(listOf(OAuthProvider.KAKAO, OAuthProvider.GOOGLE)).`when`(oauthService).availableProviders()

        mockMvc.perform(get("/api/v1/auth/oauth/providers"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.providers.length()").value(2))
            .andExpect(jsonPath("$.providers[0].provider").value("kakao"))
            .andExpect(jsonPath("$.providers[0].startUrl").value("http://127.0.0.1:5173/api/v1/auth/oauth/kakao/authorize"))
            .andExpect(jsonPath("$.providers[1].provider").value("google"))
    }

    @Test
    fun authorizeRedirectsToTheProviderWithASignedStateCookieOnTheSocialLoginPath() {
        doReturn(OAuthStartResult(URI("https://kauth.kakao.com/oauth/authorize?state=abc"), transaction()))
            .`when`(oauthService).start(OAuthProvider.KAKAO, "/app/partners", true)

        mockMvc.perform(get("/api/v1/auth/oauth/kakao/authorize").param("next", "/app/partners").param("rememberMe", "true"))
            .andExpect(status().isFound())
            .andExpect(header().string(HttpHeaders.LOCATION, "https://kauth.kakao.com/oauth/authorize?state=abc"))
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(
                header().string(
                    HttpHeaders.SET_COOKIE,
                    allOf(
                        containsString("govbiz_oauth="),
                        containsString("Path=/api/v1/auth/oauth"),
                        containsString("Max-Age=600"),
                        containsString("HttpOnly"),
                        containsString("SameSite=Lax"),
                    ),
                ),
            )
    }

    @Test
    fun authorizeSendsUnknownProvidersBackToLoginWithoutStarting() {
        mockMvc.perform(get("/api/v1/auth/oauth/naver/authorize").param("next", "//evil.example"))
            .andExpect(status().isFound())
            .andExpect(header().string(HttpHeaders.LOCATION, "http://127.0.0.1:5173/login?oauthError=unavailable&next=%2Fapp%2Fchat"))

        verifyNoInteractions(oauthService)
    }

    @Test
    fun callbackSignsInClearsTheStateCookieAndOpensTheFrontendCompletionPage() {
        val transaction = transaction()
        val session = AccountSessionResult(
            sessionToken = "session-token",
            expiresAt = OffsetDateTime.parse("2026-10-06T12:00:00+09:00"),
            rememberMe = true,
            account = AccountTestHelper.account(),
        )
        doReturn(OAuthCompletionResult.SignedIn(session, "/app/partners?tab=mine")).`when`(oauthService)
            .complete(OAuthProvider.KAKAO, OAuthCallback("auth-code", "state-value", null), transaction, "127.0.0.1")

        mockMvc.perform(
            get("/api/v1/auth/oauth/kakao/callback")
                .param("code", "auth-code")
                .param("state", "state-value")
                .cookie(Cookie(OAuthStateCookieHelper.COOKIE_NAME, stateCookieHelper.issue(transaction).value)),
        )
            .andExpect(status().isFound())
            .andExpect(header().string(HttpHeaders.LOCATION, "http://127.0.0.1:5173/oauth/complete?next=%2Fapp%2Fpartners%3Ftab%3Dmine"))
            .andExpect(cookie().value(SessionCookieHelper.COOKIE_NAME, "session-token"))
            .andExpect(cookie().httpOnly(SessionCookieHelper.COOKIE_NAME, true))
            .andExpect(cookie().maxAge(OAuthStateCookieHelper.COOKIE_NAME, 0))
    }

    @Test
    fun callbackFailureReturnsToLoginWithTheReasonAndTheReturnPathButNoSession() {
        doReturn(OAuthCompletionResult.Failed(OAuthFailure.ACCOUNT_EXISTS, "/app/partners")).`when`(oauthService)
            .complete(OAuthProvider.GOOGLE, OAuthCallback(null, "state-value", "access_denied"), null, "127.0.0.1")

        mockMvc.perform(get("/api/v1/auth/oauth/google/callback").param("state", "state-value").param("error", "access_denied"))
            .andExpect(status().isFound())
            .andExpect(header().string(HttpHeaders.LOCATION, "http://127.0.0.1:5173/login?oauthError=account-exists&next=%2Fapp%2Fpartners"))
            .andExpect(cookie().doesNotExist(SessionCookieHelper.COOKIE_NAME))
            .andExpect(cookie().maxAge(OAuthStateCookieHelper.COOKIE_NAME, 0))
    }

    private fun transaction() = OAuthStateCookieHelper.Transaction(
        provider = OAuthProvider.KAKAO,
        state = "s".repeat(43),
        nonce = "n".repeat(43),
        codeVerifier = "v".repeat(43),
        returnPath = "/app/partners",
        rememberMe = true,
        expiresAt = AccountTestHelper.FIXED_CLOCK.instant().plus(OAuthStateCookieHelper.TTL),
    )
}
