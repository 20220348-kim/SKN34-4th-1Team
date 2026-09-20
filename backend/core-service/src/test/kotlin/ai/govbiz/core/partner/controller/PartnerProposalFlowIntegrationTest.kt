package ai.govbiz.core.partner.controller

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.account.client.bizno.BiznoClient
import ai.govbiz.core.account.client.bizno.dto.BiznoBusiness
import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core.account.helper.SignupTestHelper
import jakarta.servlet.http.Cookie
import java.time.LocalDate
import java.time.ZoneId
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.mockito.Mockito.doReturn
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc
import org.springframework.context.annotation.Import
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.context.bean.override.mockito.MockitoBean
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import tools.jackson.databind.ObjectMapper

/**
 * 두 기업 회원이 모집글을 올리고 제안을 주고받는 흐름을 실제 MySQL 8.4에서 확인합니다.
 * 수락 전에는 담당자 이메일이 실리지 않고, 수락 뒤에만 양쪽에 공개되는지 봅니다.
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
    ],
)
@AutoConfigureMockMvc
@Import(MySqlTestContainerConfig::class)
class PartnerProposalFlowIntegrationTest {

    @Autowired
    private lateinit var mockMvc: MockMvc

    @Autowired
    private lateinit var jdbcTemplate: JdbcTemplate

    @Autowired
    private lateinit var objectMapper: ObjectMapper

    @MockitoBean
    private lateinit var biznoClient: BiznoClient

    private val today: LocalDate = LocalDate.now(ZoneId.of("Asia/Seoul"))

    @BeforeEach
    fun resetRows() {
        jdbcTemplate.update("DELETE FROM partner_proposal")
        jdbcTemplate.update("DELETE FROM partner_recruitment")
        jdbcTemplate.update("DELETE FROM company")
        jdbcTemplate.update("DELETE FROM account_session")
        jdbcTemplate.update("DELETE FROM account")
        jdbcTemplate.update("DELETE FROM support_program WHERE source_code = 'TESTSRC'")
        jdbcTemplate.update(
            """
            INSERT INTO support_program (
                source_code, source_program_id, title, organization, summary, categories, regions,
                target_description, application_period_raw, application_start_date, application_end_date, source_url
            ) VALUES ('TESTSRC', 'open-program', '서울 AI 스타트업 실증 지원사업', '서울경제진흥원', '실증 과제를 지원합니다.', '["기술"]', '["서울"]',
                '서울 소재 AI 기업', ?, ?, ?, 'https://www.bizinfo.go.kr')
            """.trimIndent(),
            "${today.minusDays(30)} ~ ${today.plusDays(30)}",
            today.minusDays(30),
            today.plusDays(30),
        )
        doReturn(listOf(BiznoBusiness("1248100998", "삼성전자(주)", "계속사업자", "01"))).`when`(biznoClient).findByBusinessNumber("1248100998")
        doReturn(listOf(BiznoBusiness("2208162517", "네이버 주식회사", "계속사업자", "01"))).`when`(biznoClient).findByBusinessNumber("2208162517")
    }

    @Test
    fun proposalsFlowFromSendingToAcceptanceAndRevealContactsOnlyAfterAcceptance() {
        val owner = signUpWithCompany("owner@company.co.kr", "124-81-00998", "서울특별시")
        val proposer = signUpWithCompany("proposer@company.co.kr", "220-81-62517", "부산광역시")
        val member = signUp("member@company.co.kr")
        val recruitmentId = objectMapper.readTree(
            mockMvc.perform(
                post("/api/v1/partners/recruitments").cookie(owner).origin().json(
                    """{"sourceCode":"TESTSRC","sourceProgramId":"open-program","title":"AI 실증 참여기관 구합니다","body":"본문",
                       "ownRole":"LEAD","seekingRole":"PARTICIPANT","seekingCount":1,"region":"서울","capabilities":[],
                       "recruitmentDeadline":"${today.plusDays(10)}"}""",
                ),
            ).andExpect(status().isCreated()).andReturn().response.contentAsString,
        ).get("id").asLong()

        mockMvc.perform(post("/api/v1/partners/recruitments/$recruitmentId/proposals").cookie(member).origin().json(proposalBody()))
            .andExpect(status().isForbidden())
            .andExpect(jsonPath("$.code").value("COMPANY_REQUIRED"))
        mockMvc.perform(post("/api/v1/partners/recruitments/$recruitmentId/proposals").cookie(owner).origin().json(proposalBody()))
            .andExpect(status().isUnprocessableContent())
            .andExpect(jsonPath("$.code").value("PROPOSAL_OWN_RECRUITMENT"))
        mockMvc.perform(post("/api/v1/partners/recruitments/${recruitmentId + 1000}/proposals").cookie(proposer).origin().json(proposalBody()))
            .andExpect(status().isNotFound())
            .andExpect(jsonPath("$.code").value("RECRUITMENT_NOT_FOUND"))
        mockMvc.perform(post("/api/v1/partners/recruitments/$recruitmentId/proposals").cookie(proposer).origin().json("""{"message":"   "}"""))
            .andExpect(status().isBadRequest())

        val sent = mockMvc.perform(post("/api/v1/partners/recruitments/$recruitmentId/proposals").cookie(proposer).origin().json(proposalBody()))
            .andExpect(status().isCreated())
            .andExpect(jsonPath("$.status").value("PENDING"))
            .andExpect(jsonPath("$.isSent").value(true))
            .andExpect(jsonPath("$.message").value("라벨링 운영을 맡겠습니다."))
            .andExpect(jsonPath("$.recruitment.id").value(recruitmentId))
            .andExpect(jsonPath("$.counterpart.companyName").value("삼성전자(주)"))
            .andExpect(jsonPath("$.counterpart.profile.region").value("서울특별시"))
            .andExpect(jsonPath("$.counterpart.contact").doesNotExist())
            .andReturn().response.contentAsString
        val proposalId = objectMapper.readTree(sent).get("id").asLong()

        mockMvc.perform(post("/api/v1/partners/recruitments/$recruitmentId/proposals").cookie(proposer).origin().json(proposalBody()))
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("PROPOSAL_ALREADY_SENT"))

        // 모집글 상세에는 제안 수와 조회한 회원의 제안이 붙고, 제안함은 상자별로 나뉩니다.
        mockMvc.perform(get("/api/v1/partners/recruitments/$recruitmentId").cookie(proposer))
            .andExpect(jsonPath("$.proposalCount").value(1))
            .andExpect(jsonPath("$.myProposal.id").value(proposalId))
            .andExpect(jsonPath("$.myProposal.status").value("PENDING"))
        mockMvc.perform(get("/api/v1/partners/recruitments/$recruitmentId"))
            .andExpect(jsonPath("$.proposalCount").value(1))
            .andExpect(jsonPath("$.myProposal").doesNotExist())
        mockMvc.perform(get("/api/v1/partners/recruitments"))
            .andExpect(jsonPath("$.recruitments[0].proposalCount").value(1))
        mockMvc.perform(get("/api/v1/me/proposals").param("box", "received").cookie(owner))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.box").value("received"))
            .andExpect(jsonPath("$.pendingCount").value(1))
            .andExpect(jsonPath("$.proposals[0].id").value(proposalId))
            .andExpect(jsonPath("$.proposals[0].isSent").value(false))
        mockMvc.perform(get("/api/v1/me/proposals").param("box", "sent").cookie(owner))
            .andExpect(jsonPath("$.proposals.length()").value(0))
        mockMvc.perform(get("/api/v1/me/proposals").param("box", "sent").cookie(proposer))
            .andExpect(jsonPath("$.pendingCount").value(1))
            .andExpect(jsonPath("$.proposals[0].isSent").value(true))
        mockMvc.perform(get("/api/v1/me/proposals").param("box", "received").cookie(member))
            .andExpect(jsonPath("$.proposals.length()").value(0))
        mockMvc.perform(get("/api/v1/me/proposals").param("box", "all").cookie(owner))
            .andExpect(status().isBadRequest())
        mockMvc.perform(get("/api/v1/me/proposals").param("box", "received"))
            .andExpect(status().isUnauthorized())

        // 작성자는 제안자 기업명·기본정보(프로필 공유)를 보지만 이메일은 아직 못 봅니다. 제3자는 404입니다.
        mockMvc.perform(get("/api/v1/partners/proposals/$proposalId").cookie(owner))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.isSent").value(false))
            .andExpect(jsonPath("$.counterpart.companyName").value("네이버 주식회사"))
            .andExpect(jsonPath("$.counterpart.profile.region").value("부산광역시"))
            .andExpect(jsonPath("$.counterpart.contact").doesNotExist())
        mockMvc.perform(get("/api/v1/partners/proposals/$proposalId").cookie(member))
            .andExpect(status().isNotFound())
            .andExpect(jsonPath("$.code").value("PROPOSAL_NOT_FOUND"))
        mockMvc.perform(get("/api/v1/partners/proposals/$proposalId"))
            .andExpect(status().isUnauthorized())

        mockMvc.perform(post("/api/v1/partners/proposals/$proposalId/accept").cookie(proposer).origin())
            .andExpect(status().isForbidden())
            .andExpect(jsonPath("$.code").value("PROPOSAL_ACTION_FORBIDDEN"))
        mockMvc.perform(post("/api/v1/partners/proposals/$proposalId/withdraw").cookie(owner).origin())
            .andExpect(status().isForbidden())

        mockMvc.perform(post("/api/v1/partners/proposals/$proposalId/accept").cookie(owner).origin())
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.status").value("ACCEPTED"))
            .andExpect(jsonPath("$.counterpart.contact.email").value("proposer@company.co.kr"))
            .andExpect(jsonPath("$.counterpart.contact.businessNumber").value("2208162517"))
        mockMvc.perform(get("/api/v1/partners/proposals/$proposalId").cookie(proposer))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.status").value("ACCEPTED"))
            .andExpect(jsonPath("$.counterpart.contact.email").value("owner@company.co.kr"))
        mockMvc.perform(get("/api/v1/me/proposals").param("box", "received").cookie(owner))
            .andExpect(jsonPath("$.pendingCount").value(0))
            .andExpect(jsonPath("$.proposals[0].status").value("ACCEPTED"))
        mockMvc.perform(post("/api/v1/partners/proposals/$proposalId/decline").cookie(owner).origin())
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("PROPOSAL_NOT_PENDING"))
        mockMvc.perform(post("/api/v1/partners/proposals/$proposalId/withdraw").cookie(proposer).origin())
            .andExpect(status().isConflict())
    }

    @Test
    fun withdrawnAndExpiredProposalsStopBeingPendingAndClosedRecruitmentsRejectNewOnes() {
        val owner = signUpWithCompany("owner@company.co.kr", "124-81-00998", "서울특별시")
        val proposer = signUpWithCompany("proposer@company.co.kr", "220-81-62517", "부산광역시")
        val recruitmentId = objectMapper.readTree(
            mockMvc.perform(
                post("/api/v1/partners/recruitments").cookie(owner).origin().json(
                    """{"sourceCode":"TESTSRC","sourceProgramId":"open-program","title":"AI 실증 참여기관 구합니다","body":"본문",
                       "ownRole":"LEAD","seekingRole":"PARTICIPANT","seekingCount":1,"region":"서울","capabilities":[],
                       "recruitmentDeadline":"${today.plusDays(10)}"}""",
                ),
            ).andExpect(status().isCreated()).andReturn().response.contentAsString,
        ).get("id").asLong()
        val proposalId = objectMapper.readTree(
            mockMvc.perform(post("/api/v1/partners/recruitments/$recruitmentId/proposals").cookie(proposer).origin().json(proposalBody(shareProfile = false)))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.shareProfile").value(false))
                .andReturn().response.contentAsString,
        ).get("id").asLong()

        // 프로필 공유를 끈 제안은 작성자에게 기업명만 보입니다.
        mockMvc.perform(get("/api/v1/partners/proposals/$proposalId").cookie(owner))
            .andExpect(jsonPath("$.counterpart.companyName").value("네이버 주식회사"))
            .andExpect(jsonPath("$.counterpart.profile").doesNotExist())

        mockMvc.perform(post("/api/v1/partners/proposals/$proposalId/withdraw").cookie(proposer).origin())
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.status").value("WITHDRAWN"))
        mockMvc.perform(post("/api/v1/partners/proposals/$proposalId/accept").cookie(owner).origin())
            .andExpect(status().isConflict())
        mockMvc.perform(post("/api/v1/partners/recruitments/$recruitmentId/proposals").cookie(proposer).origin().json(proposalBody()))
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("PROPOSAL_ALREADY_SENT"))

        // 8일 전에 보낸 것으로 바꾸면 응답 없이 만료됩니다.
        jdbcTemplate.update("UPDATE partner_proposal SET withdrawn_at = NULL, created_at = ? WHERE id = ?", today.minusDays(8).atStartOfDay(), proposalId)
        mockMvc.perform(get("/api/v1/partners/proposals/$proposalId").cookie(proposer))
            .andExpect(jsonPath("$.status").value("EXPIRED"))
        mockMvc.perform(post("/api/v1/partners/proposals/$proposalId/accept").cookie(owner).origin())
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("PROPOSAL_NOT_PENDING"))

        jdbcTemplate.update("UPDATE partner_recruitment SET recruitment_deadline = ? WHERE id = ?", today.minusDays(1), recruitmentId)
        jdbcTemplate.update("DELETE FROM partner_proposal")
        mockMvc.perform(post("/api/v1/partners/recruitments/$recruitmentId/proposals").cookie(proposer).origin().json(proposalBody()))
            .andExpect(status().isUnprocessableContent())
            .andExpect(jsonPath("$.code").value("RECRUITMENT_CLOSED"))
    }

    private fun proposalBody(shareProfile: Boolean = true) =
        """{"message":" 라벨링 운영을 맡겠습니다. ","shareProfile":$shareProfile}"""

    private fun signUpWithCompany(email: String, businessNumber: String, region: String): Cookie {
        val session = signUp(email)
        mockMvc.perform(
            post("/api/v1/me/company").cookie(session).origin()
                .json("""{"businessNumber":"$businessNumber","region":"$region","industry":"정보통신업","foundedYear":2020}"""),
        ).andExpect(status().isCreated())
        return session
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
