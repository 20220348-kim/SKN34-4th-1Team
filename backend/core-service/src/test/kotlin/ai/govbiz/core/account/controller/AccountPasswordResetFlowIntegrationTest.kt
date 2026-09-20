package ai.govbiz.core.account.controller

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.account.client.mail.AccountPasswordResetMailClient
import ai.govbiz.core.account.helper.OneTimeTokenHelper
import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core.account.helper.SignupTestHelper
import jakarta.servlet.http.Cookie
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
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

/**
 * 가입 → 재설정 링크 요청 → 토큰으로 비밀번호 변경 → 옛 세션 종료·새 비밀번호 로그인을 실제 MySQL 8.4에서 확인합니다.
 * SMTP는 외부 호출이라 메일 Client만 대역으로 바꿔 토큰 원문을 받습니다.
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

    @BeforeEach
    fun resetRows() {
        jdbcTemplate.update("DELETE FROM account_password_reset")
        jdbcTemplate.update("DELETE FROM account_session")
        jdbcTemplate.update("DELETE FROM account")
        doReturn(true).`when`(mailClient).isAvailable()
    }

    @Test
    fun resetsThePasswordWithTheMailedTokenOnceAndEndsTheOldSessions() {
        val oldSession = signUp("manager@company.co.kr", "password1")

        requestReset("Manager@Company.co.kr")
        requestReset("nobody@company.co.kr")

        val token = ArgumentCaptor.forClass(String::class.java)
        verify(mailClient, times(1)).sendPasswordReset(eqValue("manager@company.co.kr"), token.capture() ?: "")
        assertTrue(OneTimeTokenHelper.PATTERN.matches(token.value))
        assertEquals(1, count("SELECT COUNT(*) FROM account_password_reset"))
        assertEquals(1, count("SELECT COUNT(*) FROM account_password_reset WHERE token_hash = '${OneTimeTokenHelper.hash(token.value)}'"))

        confirm("not-a-token", "new-password-2").andExpect(status().isBadRequest())
        confirm(OneTimeTokenHelper.newToken(), "new-password-2")
            .andExpect(status().isUnprocessableContent())
            .andExpect(jsonPath("$.code").value("PASSWORD_RESET_TOKEN_INVALID"))
        confirm(token.value, "short").andExpect(status().isBadRequest())

        confirm(token.value, "new-password-2").andExpect(status().isNoContent())

        confirm(token.value, "new-password-3")
            .andExpect(status().isUnprocessableContent())
            .andExpect(jsonPath("$.code").value("PASSWORD_RESET_TOKEN_INVALID"))
        assertEquals(0, count("SELECT COUNT(*) FROM account_password_reset"))
        mockMvc.perform(get("/api/v1/auth/me").cookie(oldSession)).andExpect(status().isUnauthorized())
        logIn("manager@company.co.kr", "password1").andExpect(status().isUnauthorized())
        logIn("manager@company.co.kr", "new-password-2").andExpect(status().isOk())
    }

    @Test
    fun limitsResetRequestsPerAccountAndRejectsExpiredTokens() {
        signUp("manager@company.co.kr", "password1")

        repeat(3) { requestReset("manager@company.co.kr") }

        val token = ArgumentCaptor.forClass(String::class.java)
        verify(mailClient, times(2)).sendPasswordReset(eqValue("manager@company.co.kr"), token.capture() ?: "")
        assertEquals(2, count("SELECT COUNT(*) FROM account_password_reset"))

        jdbcTemplate.update("UPDATE account_password_reset SET expires_at = expires_at - INTERVAL 1 DAY")
        confirm(token.value, "new-password-2")
            .andExpect(status().isUnprocessableContent())
            .andExpect(jsonPath("$.code").value("PASSWORD_RESET_TOKEN_INVALID"))
        logIn("manager@company.co.kr", "password1").andExpect(status().isOk())
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

    private fun requestReset(email: String) {
        mockMvc.perform(
            post("/api/v1/auth/password-reset")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"email":"$email"}"""),
        ).andExpect(status().isNoContent())
    }

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

    /** Kotlin의 non-null 인자에 eq matcher를 넘길 수 있게 null 대신 값을 돌려줍니다. */
    private fun <T : Any> eqValue(value: T): T = org.mockito.Mockito.eq(value) ?: value
}
