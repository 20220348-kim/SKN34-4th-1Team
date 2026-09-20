package ai.govbiz.core.supportprogram.controller

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core.account.helper.SignupTestHelper
import jakarta.servlet.http.Cookie
import java.time.LocalDate
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
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

/** 가입 → 공고 담기·상태·목록·빼기를 실제 MySQL 8.4에서 확인합니다. 공고는 테스트 제공처 행을 직접 넣습니다. */
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
class SavedSupportProgramFlowIntegrationTest {

    @Autowired
    private lateinit var mockMvc: MockMvc

    @Autowired
    private lateinit var jdbcTemplate: JdbcTemplate

    private val today: LocalDate = LocalDate.now()

    @BeforeEach
    fun resetRows() {
        jdbcTemplate.update("DELETE FROM saved_support_program")
        jdbcTemplate.update("DELETE FROM account_session")
        jdbcTemplate.update("DELETE FROM account")
        jdbcTemplate.update("DELETE FROM support_program WHERE source_code = 'TESTSRC'")
        insertProgram("open-program", today.plusDays(30), present = true)
        insertProgram("another-program", today.plusDays(45), present = true)
        insertProgram("hidden-program", today.plusDays(30), present = false)
    }

    @Test
    fun requiresASessionForEveryEndpoint() {
        mockMvc.perform(get("/api/v1/me/saved-programs")).andExpect(status().isUnauthorized())
        mockMvc.perform(get("/api/v1/me/saved-programs/status").param("sourceCode", "TESTSRC").param("sourceProgramId", "open-program"))
            .andExpect(status().isUnauthorized())
        mockMvc.perform(post("/api/v1/me/saved-programs").origin().json(saveBody("open-program")))
            .andExpect(status().isUnauthorized())
        mockMvc.perform(delete("/api/v1/me/saved-programs").origin().param("sourceCode", "TESTSRC").param("sourceProgramId", "open-program"))
            .andExpect(status().isUnauthorized())
    }

    @Test
    fun savesListsAndRemovesProgramsForTheSignedInAccountOnly() {
        val session = signUp("member@company.co.kr")
        val other = signUp("other@company.co.kr")

        mockMvc.perform(get("/api/v1/me/saved-programs").cookie(session))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.programs").isEmpty())
        mockMvc.perform(get("/api/v1/me/saved-programs/status").cookie(session).param("sourceCode", "TESTSRC").param("sourceProgramId", "open-program"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.saved").value(false))

        // 담으면 현재 공고 내용과 담은 시각이 돌아오고, 다시 담아도 한 번만 남습니다.
        mockMvc.perform(post("/api/v1/me/saved-programs").cookie(session).origin().json(saveBody("open-program")))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.savedAt").isString())
            .andExpect(jsonPath("$.program.id").value("open-program"))
            .andExpect(jsonPath("$.program.sourceCode").value("TESTSRC"))
            .andExpect(jsonPath("$.program.title").value("서울 AI 스타트업 실증 지원사업"))
            .andExpect(jsonPath("$.program.status").value("OPEN"))
        mockMvc.perform(post("/api/v1/me/saved-programs").cookie(session).origin().json(saveBody("open-program")))
            .andExpect(status().isOk())
        mockMvc.perform(post("/api/v1/me/saved-programs").cookie(session).origin().json(saveBody("another-program")))
            .andExpect(status().isOk())
        mockMvc.perform(get("/api/v1/me/saved-programs/status").cookie(session).param("sourceCode", "TESTSRC").param("sourceProgramId", "open-program"))
            .andExpect(jsonPath("$.saved").value(true))

        // 최근에 담은 순서이고 다른 계정에는 보이지 않습니다.
        mockMvc.perform(get("/api/v1/me/saved-programs").cookie(session))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.programs.length()").value(2))
            .andExpect(jsonPath("$.programs[0].program.id").value("another-program"))
            .andExpect(jsonPath("$.programs[1].program.id").value("open-program"))
        mockMvc.perform(get("/api/v1/me/saved-programs").cookie(other))
            .andExpect(jsonPath("$.programs").isEmpty())

        // 노출되지 않거나 없는 공고는 담을 수 없고, 잘못된 제공처 코드는 400입니다.
        mockMvc.perform(post("/api/v1/me/saved-programs").cookie(session).origin().json(saveBody("hidden-program")))
            .andExpect(status().isNotFound())
            .andExpect(jsonPath("$.code").value("SUPPORT_PROGRAM_NOT_FOUND"))
        mockMvc.perform(post("/api/v1/me/saved-programs").cookie(session).origin().json(saveBody("missing-program")))
            .andExpect(status().isNotFound())
        mockMvc.perform(post("/api/v1/me/saved-programs").cookie(session).origin().json("""{"sourceCode":"bad code","sourceProgramId":"open-program"}"""))
            .andExpect(status().isBadRequest())

        // 담기지 않은 공고를 빼도 204이고, 뺀 뒤에는 목록과 상태에서 사라집니다.
        mockMvc.perform(delete("/api/v1/me/saved-programs").cookie(session).origin().param("sourceCode", "TESTSRC").param("sourceProgramId", "open-program"))
            .andExpect(status().isNoContent())
        mockMvc.perform(delete("/api/v1/me/saved-programs").cookie(session).origin().param("sourceCode", "TESTSRC").param("sourceProgramId", "open-program"))
            .andExpect(status().isNoContent())
        mockMvc.perform(get("/api/v1/me/saved-programs/status").cookie(session).param("sourceCode", "TESTSRC").param("sourceProgramId", "open-program"))
            .andExpect(jsonPath("$.saved").value(false))
        mockMvc.perform(get("/api/v1/me/saved-programs").cookie(session))
            .andExpect(jsonPath("$.programs.length()").value(1))
            .andExpect(jsonPath("$.programs[0].program.id").value("another-program"))
    }

    @Test
    fun hidesProgramsThatAreNoLongerPresentWithoutDeletingTheRow() {
        val session = signUp("member@company.co.kr")
        mockMvc.perform(post("/api/v1/me/saved-programs").cookie(session).origin().json(saveBody("open-program")))
            .andExpect(status().isOk())

        jdbcTemplate.update("UPDATE support_program SET is_source_present = FALSE WHERE source_code = 'TESTSRC' AND source_program_id = 'open-program'")

        mockMvc.perform(get("/api/v1/me/saved-programs").cookie(session))
            .andExpect(jsonPath("$.programs").isEmpty())
        mockMvc.perform(get("/api/v1/me/saved-programs/status").cookie(session).param("sourceCode", "TESTSRC").param("sourceProgramId", "open-program"))
            .andExpect(jsonPath("$.saved").value(false))
        val rows = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM saved_support_program", Int::class.java)
        assert(rows == 1) { "saved row must stay for when the program is published again" }
    }

    private fun saveBody(sourceProgramId: String): String =
        """{"sourceCode":"TESTSRC","sourceProgramId":"$sourceProgramId"}"""

    private fun insertProgram(sourceProgramId: String, applicationEndDate: LocalDate, present: Boolean) {
        jdbcTemplate.update(
            """
            INSERT INTO support_program (
                source_code, source_program_id, title, organization, summary, categories, regions,
                target_description, application_period_raw, application_start_date, application_end_date,
                source_url, is_source_present
            ) VALUES ('TESTSRC', ?, '서울 AI 스타트업 실증 지원사업', '서울경제진흥원', '실증 과제를 지원합니다.', '["기술"]', '["서울"]',
                '서울 소재 AI 기업', ?, ?, ?, 'https://www.bizinfo.go.kr', ?)
            """.trimIndent(),
            sourceProgramId,
            "${applicationEndDate.minusDays(60)} ~ $applicationEndDate",
            applicationEndDate.minusDays(60),
            applicationEndDate,
            present,
        )
    }

    private fun signUp(email: String): Cookie {
        val response = mockMvc.perform(
            post("/api/v1/auth/signup")
                .contentType(MediaType.APPLICATION_JSON)
                .content(SignupTestHelper.signupJson(jdbcTemplate, email, "password1")),
        )
            .andExpect(status().isCreated())
            .andReturn().response
        return requireNotNull(response.getCookie(SessionCookieHelper.COOKIE_NAME))
    }

    private fun MockHttpServletRequestBuilder.origin() = header(HttpHeaders.ORIGIN, "http://localhost:5173")

    private fun MockHttpServletRequestBuilder.json(body: String) = contentType(MediaType.APPLICATION_JSON).content(body)
}
