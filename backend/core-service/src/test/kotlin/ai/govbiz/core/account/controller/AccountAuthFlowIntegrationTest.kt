package ai.govbiz.core.account.controller

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.account.domain.NewAccount
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core.account.helper.SignupTestHelper
import jakarta.servlet.http.Cookie
import java.time.LocalDateTime
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc
import org.springframework.context.annotation.Import
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.cookie
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

/**
 * 실제 MySQL과 HTTP 계층을 통해 로그인 → 내 정보 → 로그아웃 → 재로그인, 정지 계정, 유휴 만료와
 * 개발용 시드 로그인을 세션 쿠키로 확인합니다.
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
        "app.account.session-idle-ttl=P7D",
        "app.account.dev-login.enabled=true",
        "app.account.dev-login.email=admin@govbiz.local",
        "app.account.dev-login.member-email=member@govbiz.local",
        "app.account.dev-login.password=govbiz-admin1",
    ],
)
@AutoConfigureMockMvc
@Import(MySqlTestContainerConfig::class)
class AccountAuthFlowIntegrationTest {

    @Autowired
    private lateinit var mockMvc: MockMvc

    @Autowired
    private lateinit var jdbcTemplate: JdbcTemplate

    @Autowired
    private lateinit var repository: AccountRepository

    @Autowired
    private lateinit var passwordEncoder: PasswordEncoder

    @BeforeEach
    fun resetAccounts() {
        jdbcTemplate.update("DELETE FROM account_session")
        jdbcTemplate.update("DELETE FROM account")
        repository.createAccount(
            NewAccount(
                email = "manager@company.co.kr",
                passwordHash = requireNotNull(passwordEncoder.encode("password1")),
                termsAgreedAt = LocalDateTime.of(2026, 9, 6, 12, 0),
            ),
        )
    }

    @Test
    fun logsInReadsTheCurrentAccountLogsOutAndLogsInAgain() {
        mockMvc.perform(
            post("/api/v1/auth/login")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"email":"manager@company.co.kr","password":"wrong-password1"}"""),
        )
            .andExpect(status().isUnauthorized())
            .andExpect(jsonPath("$.code").value("INVALID_CREDENTIALS"))
            .andExpect(cookie().doesNotExist(SessionCookieHelper.COOKIE_NAME))

        val session = logIn("Manager@Company.co.kr", "password1", rememberMe = true)
        assertTrue(Regex("[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+").matches(session.value))

        mockMvc.perform(get("/api/v1/auth/me").cookie(session))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.account.email").value("manager@company.co.kr"))
            .andExpect(jsonPath("$.account.role").value("USER"))
            .andExpect(jsonPath("$.account.tier").value("MEMBER"))
            .andExpect(jsonPath("$.account.emailVerified").value(false))

        mockMvc.perform(post("/api/v1/auth/logout").cookie(session).header(HttpHeaders.ORIGIN, "http://localhost:5173"))
            .andExpect(status().isNoContent())
            .andExpect(cookie().maxAge(SessionCookieHelper.COOKIE_NAME, 0))

        mockMvc.perform(get("/api/v1/auth/me").cookie(session))
            .andExpect(status().isUnauthorized())
            .andExpect(jsonPath("$.code").value("AUTHENTICATION_REQUIRED"))

        val newSession = logIn("MANAGER@company.co.kr", "password1", rememberMe = false)

        mockMvc.perform(get("/api/v1/auth/me").cookie(newSession))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.account.email").value("manager@company.co.kr"))
    }

    @Test
    fun signsUpIssuesASessionRejectsTheSameEmailAgainAndAllowsLoginWithThePassword() {
        val response = mockMvc.perform(
            post("/api/v1/auth/signup")
                .contentType(MediaType.APPLICATION_JSON)
                .content(SignupTestHelper.signupJson(jdbcTemplate, "New.Member@Company.co.kr", "welcome-12")),
        )
            .andExpect(status().isCreated())
            .andExpect(cookie().httpOnly(SessionCookieHelper.COOKIE_NAME, true))
            .andExpect(cookie().maxAge(SessionCookieHelper.COOKIE_NAME, -1))
            .andExpect(jsonPath("$.account.email").value("new.member@company.co.kr"))
            .andExpect(jsonPath("$.account.tier").value("MEMBER"))
            .andExpect(jsonPath("$.account.emailVerified").value(true))
            .andReturn().response
        val session = requireNotNull(response.getCookie(SessionCookieHelper.COOKIE_NAME))

        mockMvc.perform(get("/api/v1/auth/me").cookie(session))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.account.email").value("new.member@company.co.kr"))
        assertEquals(
            1,
            jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM account WHERE email = 'new.member@company.co.kr' AND email_verified_at IS NOT NULL AND terms_agreed_at IS NOT NULL",
                Int::class.java,
            ),
        )

        mockMvc.perform(
            post("/api/v1/auth/signup")
                .contentType(MediaType.APPLICATION_JSON)
                .content(SignupTestHelper.signupJson(jdbcTemplate, "NEW.MEMBER@company.co.kr", "another-12")),
        )
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("EMAIL_ALREADY_REGISTERED"))
            .andExpect(cookie().doesNotExist(SessionCookieHelper.COOKIE_NAME))

        logIn("new.member@company.co.kr", "welcome-12", rememberMe = false)
    }

    @Test
    fun endsAnIdleSessionAndBlocksASuspendedAccount() {
        val session = logIn("manager@company.co.kr", "password1", rememberMe = true)

        jdbcTemplate.update("UPDATE account_session SET last_used_at = DATE_SUB(last_used_at, INTERVAL 8 DAY)")
        mockMvc.perform(get("/api/v1/auth/me").cookie(session))
            .andExpect(status().isUnauthorized())
            .andExpect(jsonPath("$.code").value("AUTHENTICATION_REQUIRED"))

        val active = logIn("manager@company.co.kr", "password1", rememberMe = true)
        jdbcTemplate.update("UPDATE account SET suspended_at = NOW(6) WHERE email = 'manager@company.co.kr'")
        mockMvc.perform(get("/api/v1/auth/me").cookie(active))
            .andExpect(status().isForbidden())
            .andExpect(jsonPath("$.code").value("ACCOUNT_SUSPENDED"))
        mockMvc.perform(
            post("/api/v1/auth/login")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"email":"manager@company.co.kr","password":"password1"}"""),
        )
            .andExpect(status().isForbidden())
            .andExpect(jsonPath("$.code").value("ACCOUNT_SUSPENDED"))
    }

    @Test
    fun rejectsALoggedInStateChangeFromAnotherOriginAndLocksRepeatedFailures() {
        val session = logIn("manager@company.co.kr", "password1", rememberMe = false)

        // 전체 앱에서는 CORS 처리기가 허용되지 않은 origin을 먼저 403으로 거절하고, 그 뒤에 Origin interceptor가 한 번 더 막습니다.
        mockMvc.perform(post("/api/v1/auth/logout").cookie(session).header(HttpHeaders.ORIGIN, "https://evil.example"))
            .andExpect(status().isForbidden())
        mockMvc.perform(post("/api/v1/auth/logout").cookie(session))
            .andExpect(status().isForbidden())
            .andExpect(jsonPath("$.code").value("SESSION_ORIGIN_REJECTED"))
        mockMvc.perform(get("/api/v1/auth/me").cookie(session))
            .andExpect(status().isOk())

        repeat(5) {
            mockMvc.perform(
                post("/api/v1/auth/login")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("""{"email":"locked@company.co.kr","password":"password1"}"""),
            )
                .andExpect(status().isUnauthorized())
        }
        mockMvc.perform(
            post("/api/v1/auth/login")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"email":"locked@company.co.kr","password":"password1"}"""),
        )
            .andExpect(status().isTooManyRequests())
            .andExpect(jsonPath("$.code").value("LOGIN_RATE_LIMITED"))
    }

    @Test
    fun devLoginCreatesVerifiedSeedAccountsOnceAndAllowsTheRegularLoginWithTheConfiguredPassword() {
        val firstSession = mockMvc.perform(post("/api/v1/auth/dev-login"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.account.email").value("admin@govbiz.local"))
            .andExpect(jsonPath("$.account.tier").value("ADMIN"))
            .andExpect(jsonPath("$.account.emailVerified").value(true))
            .andReturn().response.getCookie(SessionCookieHelper.COOKIE_NAME)

        mockMvc.perform(post("/api/v1/auth/dev-login"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.account.email").value("admin@govbiz.local"))

        mockMvc.perform(post("/api/v1/auth/dev-login").contentType(MediaType.APPLICATION_JSON).content("""{"role":"USER"}"""))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.account.email").value("member@govbiz.local"))
            .andExpect(jsonPath("$.account.tier").value("MEMBER"))

        assertEquals(1, jdbcTemplate.queryForObject("SELECT COUNT(*) FROM account WHERE role = 'ADMIN'", Int::class.java))
        assertEquals(3, jdbcTemplate.queryForObject("SELECT COUNT(*) FROM account", Int::class.java))

        mockMvc.perform(get("/api/v1/auth/me").cookie(requireNotNull(firstSession)))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.account.role").value("ADMIN"))

        logIn("admin@govbiz.local", "govbiz-admin1", rememberMe = true)
        logIn("member@govbiz.local", "govbiz-admin1", rememberMe = true)
    }

    private fun logIn(email: String, password: String, rememberMe: Boolean): Cookie {
        val response = mockMvc.perform(
            post("/api/v1/auth/login")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"email":"$email","password":"$password","rememberMe":$rememberMe}"""),
        )
            .andExpect(status().isOk())
            .andExpect(cookie().httpOnly(SessionCookieHelper.COOKIE_NAME, true))
            .andExpect(cookie().maxAge(SessionCookieHelper.COOKIE_NAME, if (rememberMe) 30 * 24 * 60 * 60 else -1))
            .andReturn().response
        return requireNotNull(response.getCookie(SessionCookieHelper.COOKIE_NAME))
    }
}
