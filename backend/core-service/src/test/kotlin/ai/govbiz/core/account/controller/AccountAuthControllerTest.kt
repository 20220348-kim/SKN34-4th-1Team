package ai.govbiz.core.account.controller

import ai.govbiz.core._common.exception.ApiExceptionHandler
import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.domain.AccountRole
import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.helper.AccountTestHelper.NOW
import ai.govbiz.core.account.service.AccountDevLoginService
import ai.govbiz.core.account.service.AccountLoginService
import ai.govbiz.core.account.service.AccountSessionService
import ai.govbiz.core.account.service.AccountSignupService
import ai.govbiz.core.account.service.dto.AccountSessionResult
import ai.govbiz.core.account.service.exception.AccountSuspendedException
import ai.govbiz.core.account.service.exception.AuthenticationRequiredException
import ai.govbiz.core.account.service.exception.EmailAlreadyRegisteredException
import ai.govbiz.core.account.service.exception.InvalidCredentialsException
import ai.govbiz.core.account.service.exception.LoginRateLimitedException
import ai.govbiz.core.account.web.AuthenticatedAccountArgumentResolver
import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core.account.web.SessionOriginInterceptor
import jakarta.servlet.http.Cookie
import java.time.OffsetDateTime
import org.hamcrest.Matchers.containsString
import org.hamcrest.Matchers.not
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.mockito.Mock
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.doThrow
import org.mockito.Mockito.verify
import org.mockito.Mockito.verifyNoInteractions
import org.mockito.junit.jupiter.MockitoExtension
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.content
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.cookie
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.header
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import org.springframework.test.web.servlet.setup.MockMvcBuilders

@ExtendWith(MockitoExtension::class)
class AccountAuthControllerTest {

    @Mock
    private lateinit var loginService: AccountLoginService

    @Mock
    private lateinit var signupService: AccountSignupService

    @Mock
    private lateinit var sessionService: AccountSessionService

    @Mock
    private lateinit var devLoginService: AccountDevLoginService

    private val cookieHelper = AccountTestHelper.cookieHelper(cookieSecure = true)

    private lateinit var mockMvc: MockMvc

    @BeforeEach
    fun setUp() {
        mockMvc = MockMvcBuilders
            .standaloneSetup(
                AccountAuthController(loginService, signupService, sessionService, cookieHelper),
                AccountDevLoginController(devLoginService, cookieHelper),
            )
            .setCustomArgumentResolvers(AuthenticatedAccountArgumentResolver(sessionService))
            .addInterceptors(SessionOriginInterceptor(listOf("http://localhost:5173")))
            .setControllerAdvice(ApiExceptionHandler())
            .build()
    }

    @Test
    fun logInSetsAPersistentSessionCookieWhenRememberMeIsOnAndKeepsTheTokenOutOfTheBody() {
        doReturn(sessionResult(rememberMe = true)).`when`(loginService)
            .logIn("manager@company.co.kr", "password1", "127.0.0.1", true)

        mockMvc.perform(
            post(LOGIN_PATH)
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"email":"manager@company.co.kr","password":"password1","rememberMe":true}"""),
        )
            .andExpect(status().isOk())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
            .andExpect(cookie().value(SessionCookieHelper.COOKIE_NAME, "session-token"))
            .andExpect(cookie().httpOnly(SessionCookieHelper.COOKIE_NAME, true))
            .andExpect(cookie().secure(SessionCookieHelper.COOKIE_NAME, true))
            .andExpect(cookie().path(SessionCookieHelper.COOKIE_NAME, "/"))
            .andExpect(cookie().maxAge(SessionCookieHelper.COOKIE_NAME, 30 * 24 * 60 * 60))
            .andExpect(header().string(HttpHeaders.SET_COOKIE, containsString("SameSite=Lax")))
            .andExpect(jsonPath("$.expiresAt").value("2026-10-06T12:00:00+09:00"))
            .andExpect(jsonPath("$.account.email").value("manager@company.co.kr"))
            .andExpect(jsonPath("$.account.role").value("USER"))
            .andExpect(jsonPath("$.account.tier").value("MEMBER"))
            .andExpect(jsonPath("$.account.emailVerified").value(false))
            .andExpect(content().string(not(containsString("session-token"))))
            .andExpect(content().string(not(containsString("password"))))
    }

    @Test
    fun signUpCreatesTheAccountAndIssuesABrowserSessionCookieWithoutTheTokenInTheBody() {
        doReturn(sessionResult(rememberMe = false)).`when`(signupService)
            .signUp("manager@company.co.kr", "password1", "a".repeat(43), "127.0.0.1")

        mockMvc.perform(
            post(SIGNUP_PATH)
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"email":"manager@company.co.kr","password":"password1","emailPassToken":"${"a".repeat(43)}"}"""),
        )
            .andExpect(status().isCreated())
            .andExpect(cookie().value(SessionCookieHelper.COOKIE_NAME, "session-token"))
            .andExpect(cookie().httpOnly(SessionCookieHelper.COOKIE_NAME, true))
            .andExpect(cookie().maxAge(SessionCookieHelper.COOKIE_NAME, -1))
            .andExpect(jsonPath("$.account.email").value("manager@company.co.kr"))
            .andExpect(jsonPath("$.account.tier").value("MEMBER"))
            .andExpect(jsonPath("$.account.emailVerified").value(false))
            .andExpect(content().string(not(containsString("session-token"))))
            .andExpect(content().string(not(containsString("password"))))
    }

    @Test
    fun signUpRejectsShortPasswordsAndMalformedEmailsBeforeTheService() {
        for (body in listOf(
            """{"email":"manager@company.co.kr","password":"short1","emailPassToken":"${"a".repeat(43)}"}""",
            """{"email":"not-an-email","password":"password1","emailPassToken":"${"a".repeat(43)}"}""",
            """{"email":"manager@company.co.kr","password":"${"p".repeat(73)}","emailPassToken":"${"a".repeat(43)}"}""",
            """{"email":"manager@company.co.kr","password":"password1"}""",
            """{"email":"manager@company.co.kr","password":"password1","emailPassToken":"short"}""",
        )) {
            mockMvc.perform(post(SIGNUP_PATH).contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isBadRequest())
                .andExpect(cookie().doesNotExist(SessionCookieHelper.COOKIE_NAME))
                .andExpect(content().string(not(containsString("password1"))))
        }

        verifyNoInteractions(signupService)
    }

    @Test
    fun signUpMapsADuplicateEmailToAStableConflictProblem() {
        doThrow(EmailAlreadyRegisteredException()).`when`(signupService).signUp("taken@company.co.kr", "password1", "a".repeat(43), "127.0.0.1")

        mockMvc.perform(
            post(SIGNUP_PATH)
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"email":"taken@company.co.kr","password":"password1","emailPassToken":"${"a".repeat(43)}"}"""),
        )
            .andExpect(status().isConflict())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
            .andExpect(jsonPath("$.code").value("EMAIL_ALREADY_REGISTERED"))
            .andExpect(cookie().doesNotExist(SessionCookieHelper.COOKIE_NAME))
    }

    @Test
    fun logInDefaultsToABrowserSessionCookieWithoutMaxAge() {
        doReturn(sessionResult(rememberMe = false)).`when`(loginService)
            .logIn("manager@company.co.kr", "password1", "127.0.0.1", false)

        mockMvc.perform(
            post(LOGIN_PATH)
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"email":"manager@company.co.kr","password":"password1"}"""),
        )
            .andExpect(status().isOk())
            .andExpect(cookie().value(SessionCookieHelper.COOKIE_NAME, "session-token"))
            .andExpect(cookie().maxAge(SessionCookieHelper.COOKIE_NAME, -1))
            .andExpect(header().string(HttpHeaders.SET_COOKIE, not(containsString("Max-Age"))))
    }

    @Test
    fun logInMapsInvalidCredentialsSuspensionAndRateLimitsToStableProblems() {
        doThrow(InvalidCredentialsException()).`when`(loginService).logIn("manager@company.co.kr", "wrong", "127.0.0.1", false)
        doThrow(LoginRateLimitedException(30)).`when`(loginService).logIn("locked@company.co.kr", "password1", "127.0.0.1", false)
        doThrow(AccountSuspendedException()).`when`(loginService).logIn("banned@company.co.kr", "password1", "127.0.0.1", false)

        mockMvc.perform(
            post(LOGIN_PATH)
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"email":"manager@company.co.kr","password":"wrong"}"""),
        )
            .andExpect(status().isUnauthorized())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
            .andExpect(jsonPath("$.code").value("INVALID_CREDENTIALS"))
            .andExpect(jsonPath("$.detail").value("The email or password is incorrect."))
            .andExpect(cookie().doesNotExist(SessionCookieHelper.COOKIE_NAME))

        mockMvc.perform(
            post(LOGIN_PATH)
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"email":"locked@company.co.kr","password":"password1"}"""),
        )
            .andExpect(status().isTooManyRequests())
            .andExpect(header().string(HttpHeaders.RETRY_AFTER, "30"))
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
            .andExpect(jsonPath("$.code").value("LOGIN_RATE_LIMITED"))
            .andExpect(jsonPath("$.retryAfterSeconds").value(30))

        mockMvc.perform(
            post(LOGIN_PATH)
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"email":"banned@company.co.kr","password":"password1"}"""),
        )
            .andExpect(status().isForbidden())
            .andExpect(jsonPath("$.code").value("ACCOUNT_SUSPENDED"))
            .andExpect(jsonPath("$.type").value("urn:govbiz:problem:account-suspended"))
            .andExpect(cookie().doesNotExist(SessionCookieHelper.COOKIE_NAME))
    }

    @Test
    fun logInRejectsInvalidFieldsBeforeReachingTheService() {
        mockMvc.perform(
            post(LOGIN_PATH)
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"email":"manager@company.co.kr","password":""}"""),
        )
            .andExpect(status().isBadRequest())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
            .andExpect(jsonPath("$.code").value("REQUEST_VALIDATION_FAILED"))
            .andExpect(jsonPath("$.errors[0].field").value("password"))

        mockMvc.perform(
            post(LOGIN_PATH)
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"email":"not-an-email","password":"password1"}"""),
        )
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.errors[0].field").value("email"))
            .andExpect(content().string(not(containsString("password1"))))

        verifyNoInteractions(loginService)
    }

    @Test
    fun meReturnsTheAccountWithItsTierForAValidSessionCookie() {
        doReturn(AccountTestHelper.account(role = AccountRole.ADMIN, emailVerifiedAt = NOW))
            .`when`(sessionService).requireAccount("session-token")

        mockMvc.perform(get(ME_PATH).cookie(sessionCookie()))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.account.email").value("manager@company.co.kr"))
            .andExpect(jsonPath("$.account.role").value("ADMIN"))
            .andExpect(jsonPath("$.account.tier").value("ADMIN"))
            .andExpect(jsonPath("$.account.emailVerified").value(true))
    }

    @Test
    fun meAnswers403ForASuspendedAccount() {
        doThrow(AccountSuspendedException()).`when`(sessionService).requireAccount("session-token")

        mockMvc.perform(get(ME_PATH).cookie(sessionCookie()))
            .andExpect(status().isForbidden())
            .andExpect(jsonPath("$.code").value("ACCOUNT_SUSPENDED"))
    }

    @Test
    fun meAndLogoutAnswer401WhenTheSessionCookieIsMissing() {
        doThrow(AuthenticationRequiredException()).`when`(sessionService).requireAccount(null)
        doThrow(AuthenticationRequiredException()).`when`(sessionService).logOut(null)

        mockMvc.perform(get(ME_PATH))
            .andExpect(status().isUnauthorized())
            .andExpect(header().string(HttpHeaders.WWW_AUTHENTICATE, "Bearer"))
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
            .andExpect(jsonPath("$.code").value("AUTHENTICATION_REQUIRED"))
            .andExpect(jsonPath("$.type").value("urn:govbiz:problem:authentication-required"))

        mockMvc.perform(post(LOGOUT_PATH))
            .andExpect(status().isUnauthorized())
            .andExpect(jsonPath("$.code").value("AUTHENTICATION_REQUIRED"))
    }

    @Test
    fun logOutDeletesTheSessionAndExpiresTheCookie() {
        mockMvc.perform(post(LOGOUT_PATH).cookie(sessionCookie()).header(HttpHeaders.ORIGIN, "http://localhost:5173"))
            .andExpect(status().isNoContent())
            .andExpect(cookie().value(SessionCookieHelper.COOKIE_NAME, ""))
            .andExpect(cookie().maxAge(SessionCookieHelper.COOKIE_NAME, 0))
            .andExpect(cookie().httpOnly(SessionCookieHelper.COOKIE_NAME, true))
            .andExpect(content().string(""))

        verify(sessionService).logOut("session-token")
    }

    @Test
    fun rejectsStateChangingRequestsWithASessionCookieFromAnotherOrUnknownOrigin() {
        mockMvc.perform(post(LOGOUT_PATH).cookie(sessionCookie()).header(HttpHeaders.ORIGIN, "https://evil.example"))
            .andExpect(status().isForbidden())
            .andExpect(jsonPath("$.code").value("SESSION_ORIGIN_REJECTED"))

        // 브라우저는 상태 변경 요청에 항상 Origin을 붙이므로, 둘 다 없는 요청은 세션 쿠키를 쓸 수 없습니다.
        mockMvc.perform(post(LOGOUT_PATH).cookie(sessionCookie()))
            .andExpect(status().isForbidden())
            .andExpect(jsonPath("$.code").value("SESSION_ORIGIN_REJECTED"))

        mockMvc.perform(post(LOGOUT_PATH).cookie(sessionCookie()).header(HttpHeaders.ORIGIN, "http://localhost:5173/"))
            .andExpect(status().isNoContent())

        // Origin이 없는 구형 브라우저는 Referer의 origin으로 판단합니다.
        mockMvc.perform(post(LOGOUT_PATH).cookie(sessionCookie()).header(HttpHeaders.REFERER, "http://localhost:5173/login?next=%2Fchat"))
            .andExpect(status().isNoContent())
        mockMvc.perform(post(LOGOUT_PATH).cookie(sessionCookie()).header(HttpHeaders.REFERER, "https://evil.example/localhost:5173"))
            .andExpect(status().isForbidden())

        // 쿠키가 없거나 읽기 요청이면 Origin을 검사하지 않습니다.
        doReturn(AccountTestHelper.account()).`when`(sessionService).requireAccount("session-token")
        mockMvc.perform(get(ME_PATH).cookie(sessionCookie()).header(HttpHeaders.ORIGIN, "https://evil.example"))
            .andExpect(status().isOk())
        doReturn(sessionResult(rememberMe = false)).`when`(loginService).logIn("manager@company.co.kr", "password1", "127.0.0.1", false)
        mockMvc.perform(
            post(LOGIN_PATH)
                .header(HttpHeaders.ORIGIN, "https://evil.example")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"email":"manager@company.co.kr","password":"password1"}"""),
        )
            .andExpect(status().isOk())
    }

    @Test
    fun devLoginSetsTheAdminSessionCookieWithoutABodyAndTheMemberSessionWithARole() {
        doReturn(sessionResult(AccountTestHelper.account(email = "admin@govbiz.local", role = AccountRole.ADMIN, emailVerifiedAt = NOW), rememberMe = true))
            .`when`(devLoginService).logInAs(AccountRole.ADMIN)
        doReturn(sessionResult(AccountTestHelper.account(email = "member@govbiz.local", emailVerifiedAt = NOW), rememberMe = true))
            .`when`(devLoginService).logInAs(AccountRole.USER)

        mockMvc.perform(post(DEV_LOGIN_PATH))
            .andExpect(status().isOk())
            .andExpect(cookie().value(SessionCookieHelper.COOKIE_NAME, "session-token"))
            .andExpect(cookie().maxAge(SessionCookieHelper.COOKIE_NAME, 30 * 24 * 60 * 60))
            .andExpect(jsonPath("$.account.email").value("admin@govbiz.local"))
            .andExpect(jsonPath("$.account.tier").value("ADMIN"))

        mockMvc.perform(post(DEV_LOGIN_PATH).contentType(MediaType.APPLICATION_JSON).content("""{"role":"USER"}"""))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.account.email").value("member@govbiz.local"))
            .andExpect(jsonPath("$.account.role").value("USER"))
            .andExpect(jsonPath("$.account.tier").value("MEMBER"))
            .andExpect(jsonPath("$.account.emailVerified").value(true))
    }

    private fun sessionCookie() = Cookie(SessionCookieHelper.COOKIE_NAME, "session-token")

    private fun sessionResult(account: Account = AccountTestHelper.account(), rememberMe: Boolean) =
        AccountSessionResult(
            sessionToken = "session-token",
            expiresAt = OffsetDateTime.parse("2026-10-06T12:00:00+09:00"),
            rememberMe = rememberMe,
            account = account,
        )

    private companion object {
        const val LOGIN_PATH = "/api/v1/auth/login"
        const val SIGNUP_PATH = "/api/v1/auth/signup"
        const val LOGOUT_PATH = "/api/v1/auth/logout"
        const val ME_PATH = "/api/v1/auth/me"
        const val DEV_LOGIN_PATH = "/api/v1/auth/dev-login"
    }
}
