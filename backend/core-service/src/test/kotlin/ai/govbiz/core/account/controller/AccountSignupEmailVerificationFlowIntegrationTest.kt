package ai.govbiz.core.account.controller

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.account.client.mail.AccountEmailVerificationMailClient
import ai.govbiz.core.account.helper.OneTimeTokenHelper
import ai.govbiz.core.account.helper.SessionCookieHelper
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.mockito.ArgumentCaptor
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.times
import org.mockito.Mockito.verify
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.context.annotation.Import
import org.springframework.http.MediaType
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.context.bean.override.mockito.MockitoBean
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.header
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

/**
 * 인증번호 요청 → 확인 → 통행 토큰으로 가입 → `/auth/me`의 `emailVerified=true`를 실제 MySQL 8.4에서 확인합니다.
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
        "app.account.email-verification.max-attempts=2",
        "app.account.email-verification.max-sends-per-window=2",
    ],
)
@AutoConfigureMockMvc
@Import(MySqlTestContainerConfig::class)
class AccountSignupEmailVerificationFlowIntegrationTest {

    @Autowired
    private lateinit var mockMvc: MockMvc

    @Autowired
    private lateinit var jdbcTemplate: JdbcTemplate

    @MockitoBean
    private lateinit var mailClient: AccountEmailVerificationMailClient

    @BeforeEach
    fun resetRows() {
        jdbcTemplate.update("DELETE FROM signup_email_verification")
        jdbcTemplate.update("DELETE FROM account_session")
        jdbcTemplate.update("DELETE FROM account")
        doReturn(true).`when`(mailClient).isAvailable()
    }

    @Test
    fun signsUpOnlyWithAPassEarnedByTheMailedCodeAndCreatesAVerifiedAccount() {
        signUp("manager@company.co.kr", "password1", OneTimeTokenHelper.newToken())
            .andExpect(status().isUnprocessableContent())
            .andExpect(jsonPath("$.code").value("EMAIL_VERIFICATION_REQUIRED"))
        signUp("manager@company.co.kr", "password1", "short").andExpect(status().isBadRequest())

        sendCode("Manager@Company.co.kr").andExpect(status().isNoContent())
        val code = ArgumentCaptor.forClass(String::class.java)
        verify(mailClient, times(1)).sendSignupCode(eqValue("manager@company.co.kr"), code.capture() ?: "")
        assertTrue(Regex("[0-9]{6}").matches(code.value))
        assertEquals(1, count("SELECT COUNT(*) FROM signup_email_verification WHERE code_hash = '${OneTimeTokenHelper.hash("manager@company.co.kr:${code.value}")}'"))

        verifyCode("manager@company.co.kr", "12345").andExpect(status().isBadRequest())
        val wrong = if (code.value == "000000") "000001" else "000000"
        verifyCode("manager@company.co.kr", wrong)
            .andExpect(status().isUnprocessableContent())
            .andExpect(jsonPath("$.code").value("EMAIL_CODE_INVALID"))

        val body = verifyCode("MANAGER@company.co.kr", code.value)
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.expiresAt").isString())
            .andReturn().response.contentAsString
        val passToken = requireNotNull(Regex("\"passToken\":\"([A-Za-z0-9_-]{43})\"").find(body)).groupValues[1]
        assertTrue(OneTimeTokenHelper.PATTERN.matches(passToken))

        // 통행 토큰은 인증한 이메일과 짝이어야 합니다.
        signUp("other@company.co.kr", "password1", passToken)
            .andExpect(status().isUnprocessableContent())
            .andExpect(jsonPath("$.code").value("EMAIL_VERIFICATION_REQUIRED"))

        val session = requireNotNull(
            signUp("Manager@Company.co.kr", "password1", passToken)
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.account.email").value("manager@company.co.kr"))
                .andExpect(jsonPath("$.account.emailVerified").value(true))
                .andReturn().response.getCookie(SessionCookieHelper.COOKIE_NAME),
        )
        mockMvc.perform(get("/api/v1/auth/me").cookie(session))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.account.emailVerified").value(true))
        assertEquals(1, count("SELECT COUNT(*) FROM account WHERE email = 'manager@company.co.kr' AND email_verified_at IS NOT NULL"))
        assertEquals(1, count("SELECT COUNT(*) FROM signup_email_verification WHERE consumed_at IS NOT NULL"))

        // 쓴 통행 토큰은 다시 쓸 수 없고, 가입된 이메일로는 인증번호도 보내지 않습니다.
        signUp("manager@company.co.kr", "password1", passToken)
            .andExpect(status().isUnprocessableContent())
            .andExpect(jsonPath("$.code").value("EMAIL_VERIFICATION_REQUIRED"))
        sendCode("manager@company.co.kr")
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("EMAIL_ALREADY_REGISTERED"))
    }

    @Test
    fun limitsResendsAndAttemptsAndRejectsExpiredCodes() {
        sendCode("manager@company.co.kr").andExpect(status().isNoContent())
        sendCode("manager@company.co.kr")
            .andExpect(status().isTooManyRequests())
            .andExpect(header().exists("Retry-After"))
            .andExpect(jsonPath("$.code").value("EMAIL_CODE_RATE_LIMITED"))
            .andExpect(jsonPath("$.retryAfterSeconds").isNumber())

        // 재전송 대기가 지나면 다시 보낼 수 있고, 창 안의 발송 한도(2회)를 넘기면 다시 429입니다.
        jdbcTemplate.update("UPDATE signup_email_verification SET created_at = created_at - INTERVAL 2 MINUTE")
        sendCode("manager@company.co.kr").andExpect(status().isNoContent())
        jdbcTemplate.update("UPDATE signup_email_verification SET created_at = created_at - INTERVAL 2 MINUTE")
        sendCode("manager@company.co.kr")
            .andExpect(status().isTooManyRequests())
            .andExpect(jsonPath("$.code").value("EMAIL_CODE_RATE_LIMITED"))

        val code = ArgumentCaptor.forClass(String::class.java)
        verify(mailClient, times(2)).sendSignupCode(eqValue("manager@company.co.kr"), code.capture() ?: "")
        val latest = code.value
        val wrong = if (latest == "000000") "000001" else "000000"

        // 시도 한도(2회)를 다 쓰면 맞는 번호도 만료로 거절합니다.
        repeat(2) {
            verifyCode("manager@company.co.kr", wrong)
                .andExpect(status().isUnprocessableContent())
                .andExpect(jsonPath("$.code").value("EMAIL_CODE_INVALID"))
        }
        verifyCode("manager@company.co.kr", latest)
            .andExpect(status().isUnprocessableContent())
            .andExpect(jsonPath("$.code").value("EMAIL_CODE_EXPIRED"))

        // 만료된 인증번호도 같은 오류입니다.
        jdbcTemplate.update("UPDATE signup_email_verification SET expires_at = expires_at - INTERVAL 1 DAY, attempt_count = 0")
        verifyCode("manager@company.co.kr", latest)
            .andExpect(status().isUnprocessableContent())
            .andExpect(jsonPath("$.code").value("EMAIL_CODE_EXPIRED"))
    }

    private fun sendCode(email: String) =
        mockMvc.perform(
            post("/api/v1/auth/signup/email-code")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"email":"$email"}"""),
        )

    private fun verifyCode(email: String, code: String) =
        mockMvc.perform(
            post("/api/v1/auth/signup/email-code/verify")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"email":"$email","code":"$code"}"""),
        )

    private fun signUp(email: String, password: String, passToken: String) =
        mockMvc.perform(
            post("/api/v1/auth/signup")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"email":"$email","password":"$password","emailPassToken":"$passToken"}"""),
        )

    private fun count(sql: String): Int = requireNotNull(jdbcTemplate.queryForObject(sql, Int::class.java))

    /** Kotlin의 non-null 인자에 eq matcher를 넘길 수 있게 null 대신 값을 돌려줍니다. */
    private fun <T : Any> eqValue(value: T): T = org.mockito.Mockito.eq(value) ?: value
}
