package ai.govbiz.core.account.controller

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.account.client.mail.AccountPasswordResetMailClient
import ai.govbiz.core.account.helper.OneTimeTokenHelper
import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core.account.helper.SignupTestHelper
import ai.govbiz.core.account.service.AccountPasswordResetService
import ai.govbiz.core.account.service.exception.PasswordResetTokenInvalidException
import jakarta.servlet.http.Cookie
import java.util.concurrent.Callable
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.mockito.ArgumentCaptor
import org.mockito.Mockito.doAnswer
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.times
import org.mockito.Mockito.verify
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc
import org.springframework.context.annotation.Import
import org.springframework.http.MediaType
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.test.context.bean.override.mockito.MockitoBean
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

/**
 * 가입 → 인증번호 요청 → 인증번호 확인 → 통행 토큰으로 비밀번호 변경 → 옛 세션 종료·새 비밀번호 로그인을 실제 MySQL 8.4에서 확인합니다.
 * SMTP는 외부 호출이라 메일 Client만 대역으로 바꿔 인증번호 원문을 받습니다.
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
        "app.account.password-reset.max-requests-per-hour=2",
        "app.account.password-reset.resend-cooldown=PT0S",
        "app.account.password-reset.max-attempts=2",
    ],
)
@AutoConfigureMockMvc
@Import(MySqlTestContainerConfig::class)
class AccountPasswordResetFlowIntegrationTest {

    @Autowired
    private lateinit var mockMvc: MockMvc

    @Autowired
    private lateinit var jdbcTemplate: JdbcTemplate

    @MockitoBean
    private lateinit var mailClient: AccountPasswordResetMailClient

    @Autowired
    private lateinit var resetService: AccountPasswordResetService

    @MockitoSpyBean
    private lateinit var passwordEncoder: PasswordEncoder

    @BeforeEach
    fun resetRows() {
        jdbcTemplate.update("DELETE FROM account_password_reset")
        jdbcTemplate.update("DELETE FROM account_session")
        jdbcTemplate.update("DELETE FROM account")
        doReturn(true).`when`(mailClient).isAvailable()
    }

    @Test
    fun resetsThePasswordWithTheMailedCodeOnceAndEndsTheOldSessions() {
        val oldSession = signUp("manager@company.co.kr", "password1")

        requestCode("Manager@Company.co.kr").andExpect(status().isNoContent())
        // 가입하지 않은 이메일은 인증번호 없이 404로 알린다.
        requestCode("nobody@company.co.kr")
            .andExpect(status().isNotFound())
            .andExpect(jsonPath("$.code").value("PASSWORD_RESET_ACCOUNT_NOT_FOUND"))

        val code = ArgumentCaptor.forClass(String::class.java)
        verify(mailClient, times(1)).sendPasswordResetCode(eqValue("manager@company.co.kr"), code.capture() ?: "")
        assertTrue(AccountPasswordResetMailClient.CODE_PATTERN.matches(code.value))
        assertEquals(1, count("SELECT COUNT(*) FROM account_password_reset"))
        assertEquals(1, count("SELECT COUNT(*) FROM account_password_reset WHERE code_hash = '${OneTimeTokenHelper.hash("manager@company.co.kr:${code.value}")}'"))

        // 틀린 인증번호는 422로 알리고 시도 횟수를 올린다. 통행 토큰이 없으니 비밀번호는 바꿀 수 없다.
        verifyCode("manager@company.co.kr", "12345").andExpect(status().isBadRequest())
        verifyCode("manager@company.co.kr", wrongCode(code.value))
            .andExpect(status().isUnprocessableContent())
            .andExpect(jsonPath("$.code").value("EMAIL_CODE_INVALID"))
        assertEquals(1, count("SELECT COUNT(*) FROM account_password_reset WHERE attempt_count = 1"))
        confirm(OneTimeTokenHelper.newToken(), "new-password-2")
            .andExpect(status().isUnprocessableContent())
            .andExpect(jsonPath("$.code").value("PASSWORD_RESET_TOKEN_INVALID"))

        val body = verifyCode("Manager@Company.co.kr", code.value).andExpect(status().isOk()).andReturn().response.contentAsString
        val passToken = requireNotNull(Regex("\"passToken\":\"([A-Za-z0-9_-]{43})\"").find(body)).groupValues[1]
        assertTrue(OneTimeTokenHelper.PATTERN.matches(passToken))
        // 같은 인증번호는 두 번 쓸 수 없다.
        verifyCode("manager@company.co.kr", code.value)
            .andExpect(status().isUnprocessableContent())
            .andExpect(jsonPath("$.code").value("EMAIL_CODE_EXPIRED"))

        confirm("not-a-token", "new-password-2").andExpect(status().isBadRequest())
        confirm(passToken, "short").andExpect(status().isBadRequest())
        confirm(passToken, "new-password-2").andExpect(status().isNoContent())

        confirm(passToken, "new-password-3")
            .andExpect(status().isUnprocessableContent())
            .andExpect(jsonPath("$.code").value("PASSWORD_RESET_TOKEN_INVALID"))
        assertEquals(0, count("SELECT COUNT(*) FROM account_password_reset"))
        mockMvc.perform(get("/api/v1/auth/me").cookie(oldSession)).andExpect(status().isUnauthorized())
        logIn("manager@company.co.kr", "password1").andExpect(status().isUnauthorized())
        logIn("manager@company.co.kr", "new-password-2").andExpect(status().isOk())
    }

    @Test
    fun concurrentRequestsCannotReuseTheSamePasswordResetToken() {
        signUp("manager@company.co.kr", "password1")
        requestCode("manager@company.co.kr").andExpect(status().isNoContent())
        val code = ArgumentCaptor.forClass(String::class.java)
        verify(mailClient).sendPasswordResetCode(eqValue("manager@company.co.kr"), code.capture() ?: "")
        val body = verifyCode("manager@company.co.kr", code.value).andExpect(status().isOk()).andReturn().response.contentAsString
        val passToken = requireNotNull(Regex("\"passToken\":\"([A-Za-z0-9_-]{43})\"").find(body)).groupValues[1]
        val firstHasToken = CountDownLatch(1)
        val releaseFirst = CountDownLatch(1)
        val secondStarted = CountDownLatch(1)
        doAnswer { invocation ->
            firstHasToken.countDown()
            check(releaseFirst.await(30, TimeUnit.SECONDS))
            invocation.callRealMethod()
        }.`when`(passwordEncoder).encode("first-new-password")

        Executors.newFixedThreadPool(2).use { executor ->
            val first = executor.submit(Callable { resetService.reset(passToken, "first-new-password") })
            try {
                assertTrue(firstHasToken.await(30, TimeUnit.SECONDS))
                val second = executor.submit(Callable {
                    secondStarted.countDown()
                    runCatching { resetService.reset(passToken, "second-new-password") }
                })
                assertTrue(secondStarted.await(30, TimeUnit.SECONDS))
                // The first request holds the token while the second attempts to reuse it.
                try {
                    second.get(1, TimeUnit.SECONDS)
                } catch (_: TimeoutException) {
                    // A locking read correctly waits for the first transaction to finish.
                } finally {
                    releaseFirst.countDown()
                }
                first.get(30, TimeUnit.SECONDS)
                assertInstanceOf(PasswordResetTokenInvalidException::class.java,
                    second.get(30, TimeUnit.SECONDS).exceptionOrNull())
            } finally {
                releaseFirst.countDown()
            }
        }
        logIn("manager@company.co.kr", "first-new-password").andExpect(status().isOk())
        logIn("manager@company.co.kr", "second-new-password").andExpect(status().isUnauthorized())
    }

    @Test
    fun limitsRequestsPerAccountExpiresExhaustedCodesAndRefusesSocialOnlyAccounts() {
        signUp("manager@company.co.kr", "password1")

        requestCode("manager@company.co.kr").andExpect(status().isNoContent())
        requestCode("manager@company.co.kr").andExpect(status().isNoContent())
        requestCode("manager@company.co.kr")
            .andExpect(status().isTooManyRequests())
            .andExpect(jsonPath("$.code").value("EMAIL_CODE_RATE_LIMITED"))

        val code = ArgumentCaptor.forClass(String::class.java)
        verify(mailClient, times(2)).sendPasswordResetCode(eqValue("manager@company.co.kr"), code.capture() ?: "")
        assertEquals(2, count("SELECT COUNT(*) FROM account_password_reset"))

        // 시도 한도(2)를 다 쓰면 맞는 번호도 만료로 답한다. 가장 최근 인증번호만 유효하다.
        val latest = code.allValues.last()
        repeat(2) {
            verifyCode("manager@company.co.kr", wrongCode(latest))
                .andExpect(status().isUnprocessableContent())
                .andExpect(jsonPath("$.code").value("EMAIL_CODE_INVALID"))
        }
        verifyCode("manager@company.co.kr", latest)
            .andExpect(status().isUnprocessableContent())
            .andExpect(jsonPath("$.code").value("EMAIL_CODE_EXPIRED"))
        logIn("manager@company.co.kr", "password1").andExpect(status().isOk())

        // 소셜로만 가입해 비밀번호가 없는 계정은 요청·확인 모두 409다.
        jdbcTemplate.update("UPDATE account SET password_hash = NULL WHERE email = 'manager@company.co.kr'")
        requestCode("manager@company.co.kr")
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("PASSWORD_RESET_SOCIAL_ACCOUNT"))
        verifyCode("manager@company.co.kr", latest)
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("PASSWORD_RESET_SOCIAL_ACCOUNT"))
    }

    private fun signUp(email: String, password: String): Cookie =
        requireNotNull(
            mockMvc.perform(
                post("/api/v1/auth/signup")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(SignupTestHelper.signupJson(jdbcTemplate, email, password)),
            )
                .andExpect(status().isCreated())
                .andReturn().response.getCookie(SessionCookieHelper.COOKIE_NAME),
        )

    private fun requestCode(email: String) =
        mockMvc.perform(
            post("/api/v1/auth/password-reset")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"email":"$email"}"""),
        )

    private fun verifyCode(email: String, code: String) =
        mockMvc.perform(
            post("/api/v1/auth/password-reset/verify")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"email":"$email","code":"$code"}"""),
        )

    private fun confirm(token: String, newPassword: String) =
        mockMvc.perform(
            post("/api/v1/auth/password-reset/confirm")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"token":"$token","newPassword":"$newPassword"}"""),
        )

    private fun logIn(email: String, password: String) =
        mockMvc.perform(
            post("/api/v1/auth/login")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"email":"$email","password":"$password","rememberMe":false}"""),
        )

    private fun count(sql: String): Int = requireNotNull(jdbcTemplate.queryForObject(sql, Int::class.java))

    /** 받은 인증번호와 다른 6자리 번호입니다. */
    private fun wrongCode(code: String): String = if (code == "000000") "000001" else "000000"

    /** Kotlin의 non-null 인자에 eq matcher를 넘길 수 있게 null 대신 값을 돌려줍니다. */
    private fun <T : Any> eqValue(value: T): T = org.mockito.Mockito.eq(value) ?: value
}
