package ai.govbiz.core.account.web

import ai.govbiz.core._common.exception.ApiExceptionHandler
import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core.account.service.AccountSessionService
import ai.govbiz.core.account.service.exception.AccountSuspendedException
import ai.govbiz.core.account.service.exception.AuthenticationRequiredException
import jakarta.servlet.ServletException
import jakarta.servlet.http.Cookie
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.extension.ExtendWith
import org.mockito.Mock
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.doThrow
import org.mockito.Mockito.verifyNoInteractions
import org.mockito.junit.jupiter.MockitoExtension
import org.springframework.dao.DataAccessResourceFailureException
import org.springframework.http.HttpHeaders
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.content
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.cookie
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.header
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController

@ExtendWith(MockitoExtension::class)
class AuthenticatedAccountArgumentResolverTest {

    @Mock
    private lateinit var sessionService: AccountSessionService

    private lateinit var mockMvc: MockMvc

    @BeforeEach
    fun setUp() {
        mockMvc = MockMvcBuilders.standaloneSetup(ProbeController())
            .setCustomArgumentResolvers(
                AuthenticatedAccountArgumentResolver(sessionService, AccountTestHelper.cookieHelper(cookieSecure = true)),
            )
            .setControllerAdvice(ApiExceptionHandler())
            .build()
    }

    @Test
    fun optionalAccountTreatsAnInvalidSessionCookieAsAGuestAndExpiresTheCookie() {
        doThrow(AuthenticationRequiredException()).`when`(sessionService).requireAccount("stale")

        mockMvc.perform(get(OPTIONAL_PATH).cookie(Cookie(SessionCookieHelper.COOKIE_NAME, "stale")))
            .andExpect(status().isOk())
            .andExpect(content().string(GUEST))
            .andExpect(cookie().value(SessionCookieHelper.COOKIE_NAME, ""))
            .andExpect(cookie().maxAge(SessionCookieHelper.COOKIE_NAME, 0))
            .andExpect(cookie().path(SessionCookieHelper.COOKIE_NAME, "/"))
            .andExpect(cookie().httpOnly(SessionCookieHelper.COOKIE_NAME, true))
            .andExpect(cookie().secure(SessionCookieHelper.COOKIE_NAME, true))
            .andExpect(cookie().sameSite(SessionCookieHelper.COOKIE_NAME, "Lax"))
    }

    @Test
    fun requiredAccountKeeps401ForAnInvalidSessionCookieAndExpiresTheCookie() {
        doThrow(AuthenticationRequiredException()).`when`(sessionService).requireAccount("stale")

        mockMvc.perform(get(REQUIRED_PATH).cookie(Cookie(SessionCookieHelper.COOKIE_NAME, "stale")))
            .andExpect(status().isUnauthorized())
            .andExpect(jsonPath("$.code").value("AUTHENTICATION_REQUIRED"))
            .andExpect(header().string(HttpHeaders.WWW_AUTHENTICATE, "Bearer"))
            .andExpect(cookie().value(SessionCookieHelper.COOKIE_NAME, ""))
            .andExpect(cookie().maxAge(SessionCookieHelper.COOKIE_NAME, 0))
    }

    @Test
    fun suspendedSessionCookieIsAGuestOnOptionalAndStays403OnRequiredWithTheCookieExpired() {
        doThrow(AccountSuspendedException()).`when`(sessionService).requireAccount("suspended")
        val suspended = Cookie(SessionCookieHelper.COOKIE_NAME, "suspended")

        mockMvc.perform(get(OPTIONAL_PATH).cookie(suspended))
            .andExpect(status().isOk())
            .andExpect(content().string(GUEST))
            .andExpect(cookie().maxAge(SessionCookieHelper.COOKIE_NAME, 0))

        mockMvc.perform(get(REQUIRED_PATH).cookie(suspended))
            .andExpect(status().isForbidden())
            .andExpect(jsonPath("$.code").value("ACCOUNT_SUSPENDED"))
            .andExpect(cookie().maxAge(SessionCookieHelper.COOKIE_NAME, 0))
    }

    @Test
    fun validSessionCookieResolvesTheMemberWithoutTouchingTheCookie() {
        doReturn(AccountTestHelper.account()).`when`(sessionService).requireAccount("valid")
        val valid = Cookie(SessionCookieHelper.COOKIE_NAME, "valid")

        for (path in listOf(OPTIONAL_PATH, REQUIRED_PATH)) {
            mockMvc.perform(get(path).cookie(valid))
                .andExpect(status().isOk())
                .andExpect(content().string("manager@company.co.kr"))
                .andExpect(header().doesNotExist(HttpHeaders.SET_COOKIE))
        }
    }

    @Test
    fun missingCredentialsAreAGuestOnOptionalAnd401OnRequiredWithoutSetCookie() {
        doThrow(AuthenticationRequiredException()).`when`(sessionService).requireAccount(null)

        mockMvc.perform(get(OPTIONAL_PATH))
            .andExpect(status().isOk())
            .andExpect(content().string(GUEST))
            .andExpect(header().doesNotExist(HttpHeaders.SET_COOKIE))

        mockMvc.perform(get(REQUIRED_PATH))
            .andExpect(status().isUnauthorized())
            .andExpect(header().doesNotExist(HttpHeaders.SET_COOKIE))
    }

    @Test
    fun invalidBearerTokenStays401EvenOnOptionalAndNeverSetsACookie() {
        doThrow(AuthenticationRequiredException()).`when`(sessionService).requireAccount("stale-bearer")

        for (path in listOf(OPTIONAL_PATH, REQUIRED_PATH)) {
            mockMvc.perform(get(path).header(HttpHeaders.AUTHORIZATION, "Bearer stale-bearer"))
                .andExpect(status().isUnauthorized())
                .andExpect(header().doesNotExist(HttpHeaders.SET_COOKIE))
        }
    }

    @Test
    fun malformedBearerHeaderStays401OnOptionalWithoutCallingTheSessionService() {
        mockMvc.perform(get(OPTIONAL_PATH).header(HttpHeaders.AUTHORIZATION, "Basic abc"))
            .andExpect(status().isUnauthorized())
            .andExpect(header().doesNotExist(HttpHeaders.SET_COOKIE))

        verifyNoInteractions(sessionService)
    }

    @Test
    fun sessionStoreFailureIsNotTurnedIntoAGuest() {
        doThrow(DataAccessResourceFailureException("session store down")).`when`(sessionService).requireAccount("cookie")

        val failure = assertThrows<ServletException> {
            mockMvc.perform(get(OPTIONAL_PATH).cookie(Cookie(SessionCookieHelper.COOKIE_NAME, "cookie")))
        }
        assertInstanceOf(DataAccessResourceFailureException::class.java, failure.cause)
    }

    @RestController
    class ProbeController {
        @GetMapping(OPTIONAL_PATH)
        fun optional(account: Account?): String = account?.email ?: GUEST

        @GetMapping(REQUIRED_PATH)
        fun required(account: Account): String = account.email
    }

    companion object {
        const val OPTIONAL_PATH = "/probe/optional"
        const val REQUIRED_PATH = "/probe/required"
        const val GUEST = "guest"
    }
}
