package ai.govbiz.core.account.controller

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core.account.helper.SignupTestHelper
import jakarta.servlet.http.Cookie
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc
import org.springframework.context.annotation.Import
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.cookie
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

/** 실제 MySQL과 HTTP 계층으로 비밀번호 변경(다른 기기 세션 종료)과 계정 삭제(재로그인 차단·같은 이메일 재가입)를 확인합니다. */
@SpringBootTest(
    properties = [
        "app.account.jwt-secret=test-jwt-secret-0123456789abcdef0123456789",
        "app.ai-service.base-url=http://127.0.0.1:1",
        "app.ai-service.connect-timeout=10ms",
        "app.ai-service.read-timeout=10ms",
        "app.bizinfo.sync.enabled=false",
        "app.support-program-index.enabled=false",
        "app.account.cookie-secure=false",
    ],
)
@AutoConfigureMockMvc
@Import(MySqlTestContainerConfig::class)
class AccountProfileFlowIntegrationTest {

    @Autowired
    private lateinit var mockMvc: MockMvc

    @Autowired
    private lateinit var jdbcTemplate: JdbcTemplate

    @BeforeEach
    fun resetAccounts() {
        jdbcTemplate.update("DELETE FROM partner_proposal")
        jdbcTemplate.update("DELETE FROM partner_recruitment")
        jdbcTemplate.update("DELETE FROM company")
        jdbcTemplate.update("DELETE FROM account_session")
        jdbcTemplate.update("DELETE FROM account")
    }

    @Test
    fun changesThePasswordWithTheSessionAloneAndKeepsOnlyTheCurrentSession() {
        val phone = signUp("manager@company.co.kr", "password1")
        val laptop = logIn("manager@company.co.kr", "password1")

        // 현재 비밀번호는 받지 않고 세션만으로 본인을 확인합니다. 새 비밀번호 규칙과 세션·Origin 검사는 그대로입니다.
        mockMvc.perform(
            put("/api/v1/me/password").cookie(laptop).origin()
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"newPassword":"short"}"""),
        )
            .andExpect(status().isBadRequest())
        mockMvc.perform(
            put("/api/v1/me/password").origin()
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"newPassword":"new-password-2"}"""),
        )
            .andExpect(status().isUnauthorized())
        mockMvc.perform(
            put("/api/v1/me/password").cookie(laptop)
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"newPassword":"new-password-2"}"""),
        )
            .andExpect(status().isForbidden())

        mockMvc.perform(
            put("/api/v1/me/password").cookie(laptop).origin()
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"newPassword":"new-password-2"}"""),
        )
            .andExpect(status().isNoContent())

        // 바꾼 기기의 세션은 남고 다른 기기는 끝납니다. 새 비밀번호로만 로그인됩니다.
        mockMvc.perform(get("/api/v1/auth/me").cookie(laptop)).andExpect(status().isOk())
        mockMvc.perform(get("/api/v1/auth/me").cookie(phone)).andExpect(status().isUnauthorized())
        mockMvc.perform(
            post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON)
                .content("""{"email":"manager@company.co.kr","password":"password1"}"""),
        ).andExpect(status().isUnauthorized())
        logIn("manager@company.co.kr", "new-password-2")
    }

    @Test
    fun deletesTheAccountAfterAPreviewBlocksLoginAndAllowsSigningUpAgainWithTheSameEmail() {
        val session = signUp("leaver@company.co.kr", "password1")

        mockMvc.perform(get("/api/v1/me/deletion-preview").cookie(session))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.hasCompany").value(false))
            .andExpect(jsonPath("$.openRecruitmentCount").value(0))
            .andExpect(jsonPath("$.receivedPendingProposalCount").value(0))
            .andExpect(jsonPath("$.sentPendingProposalCount").value(0))

        mockMvc.perform(
            delete("/api/v1/me").cookie(session).origin()
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"password":"wrong-password"}"""),
        )
            .andExpect(status().isUnprocessableContent())
            .andExpect(jsonPath("$.code").value("CURRENT_PASSWORD_MISMATCH"))
        mockMvc.perform(get("/api/v1/auth/me").cookie(session)).andExpect(status().isOk())

        mockMvc.perform(
            delete("/api/v1/me").cookie(session).origin()
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"password":"password1"}"""),
        )
            .andExpect(status().isNoContent())
            .andExpect(cookie().maxAge(SessionCookieHelper.COOKIE_NAME, 0))

        mockMvc.perform(get("/api/v1/auth/me").cookie(session)).andExpect(status().isUnauthorized())
        mockMvc.perform(
            post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON)
                .content("""{"email":"leaver@company.co.kr","password":"password1"}"""),
        )
            .andExpect(status().isUnauthorized())
            .andExpect(jsonPath("$.code").value("INVALID_CREDENTIALS"))
        // 삭제된 행은 이메일이 익명화돼 남고, 같은 이메일로 새 계정을 만들 수 있습니다.
        assertEquals(
            1,
            jdbcTemplate.queryForObject("SELECT COUNT(*) FROM account WHERE email LIKE 'deleted+%@deleted.invalid' AND deleted_at IS NOT NULL", Int::class.java),
        )
        assertEquals(0, jdbcTemplate.queryForObject("SELECT COUNT(*) FROM account_session", Int::class.java))
        val fresh = signUp("leaver@company.co.kr", "password2")
        mockMvc.perform(get("/api/v1/auth/me").cookie(fresh))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.account.email").value("leaver@company.co.kr"))
        assertEquals(2, jdbcTemplate.queryForObject("SELECT COUNT(*) FROM account", Int::class.java))
    }

    @Test
    fun savesTheWelcomeAnswerOnTheAccountAndLetsItBeChanged() {
        val session = signUp("founder@company.co.kr", "password1")
        // 가입 직후에는 아직 환영 화면을 거치지 않았습니다.
        mockMvc.perform(get("/api/v1/auth/me").cookie(session))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.account.onboarded").value(false))
            .andExpect(jsonPath("$.account.accountType").doesNotExist())

        // 유형이 없으면 400입니다.
        mockMvc.perform(
            put("/api/v1/me/onboarding").cookie(session).origin()
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{}"""),
        )
            .andExpect(status().isBadRequest())

        mockMvc.perform(
            put("/api/v1/me/onboarding").cookie(session).origin()
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"accountType":"INDIVIDUAL"}"""),
        )
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.account.accountType").value("INDIVIDUAL"))
            .andExpect(jsonPath("$.account.onboarded").value(true))

        // 다시 부르면 유형을 바꾸고, 다시 읽어도 답이 남습니다.
        mockMvc.perform(
            put("/api/v1/me/onboarding").cookie(session).origin()
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"accountType":"BUSINESS"}"""),
        )
            .andExpect(status().isOk())
        mockMvc.perform(get("/api/v1/auth/me").cookie(session))
            .andExpect(jsonPath("$.account.accountType").value("BUSINESS"))
            .andExpect(jsonPath("$.account.onboarded").value(true))
    }

    private fun signUp(email: String, password: String): Cookie {
        val response = mockMvc.perform(
            post("/api/v1/auth/signup").contentType(MediaType.APPLICATION_JSON)
                .content(SignupTestHelper.signupJson(jdbcTemplate, email, password)),
        )
            .andExpect(status().isCreated())
            .andReturn().response
        return requireNotNull(response.getCookie(SessionCookieHelper.COOKIE_NAME))
    }

    private fun logIn(email: String, password: String): Cookie {
        val response = mockMvc.perform(
            post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON)
                .content("""{"email":"$email","password":"$password"}"""),
        )
            .andExpect(status().isOk())
            .andReturn().response
        return requireNotNull(response.getCookie(SessionCookieHelper.COOKIE_NAME))
    }

    private fun MockHttpServletRequestBuilder.origin() = header(HttpHeaders.ORIGIN, "http://localhost:5173")
}
