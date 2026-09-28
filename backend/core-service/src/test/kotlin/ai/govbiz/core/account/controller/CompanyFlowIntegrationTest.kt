package ai.govbiz.core.account.controller

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.account.client.bizno.BiznoClient
import ai.govbiz.core.account.client.bizno.dto.BiznoBusiness
import ai.govbiz.core.account.client.bizno.exception.BiznoClientException
import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core.account.helper.SignupTestHelper
import jakarta.servlet.http.Cookie
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.doThrow
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc
import org.springframework.context.annotation.Import
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.context.bean.override.mockito.MockitoBean
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

/**
 * 가입 → 기업 조회·등록 → 권한 단계 상승 → 프로필 수정을 실제 MySQL 8.4에서 확인합니다.
 * 사업자등록번호 조회는 외부 호출이라 Bizno Client만 대역으로 바꿉니다.
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
class CompanyFlowIntegrationTest {

    @Autowired
    private lateinit var mockMvc: MockMvc

    @Autowired
    private lateinit var jdbcTemplate: JdbcTemplate

    @MockitoBean
    private lateinit var biznoClient: BiznoClient

    @BeforeEach
    fun resetRows() {
        jdbcTemplate.update("DELETE FROM company")
        jdbcTemplate.update("DELETE FROM account_session")
        jdbcTemplate.update("DELETE FROM account")
        doReturn(listOf(activeBusiness())).`when`(biznoClient).findByBusinessNumber("1248100998")
        doReturn(listOf(activeBusiness().copy(businessNumber = "1112233334", businessStatus = "폐업자", businessStatusCode = "03")))
            .`when`(biznoClient).findByBusinessNumber("1112233334")
        doReturn(listOf(activeBusiness().copy(businessNumber = "1208734519", companyName = "한빛정밀", businessStatus = "휴업자", businessStatusCode = "02")))
            .`when`(biznoClient).findByBusinessNumber("1208734519")
        doReturn(emptyList<BiznoBusiness>()).`when`(biznoClient).findByBusinessNumber("1234567890")
        doThrow(BiznoClientException.notConfigured()).`when`(biznoClient).findByBusinessNumber("9999999999")
    }

    @Test
    fun registersACompanyAfterLookupAndRaisesTheAccountTier() {
        val session = signUp("manager@company.co.kr", "password1")

        mockMvc.perform(get("/api/v1/me/company").cookie(session))
            .andExpect(status().isNotFound())
            .andExpect(jsonPath("$.code").value("COMPANY_NOT_REGISTERED"))

        mockMvc.perform(get("/api/v1/me/company/lookup").param("businessNumber", "124-81-00998").cookie(session))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.companyName").value("삼성전자(주)"))
            .andExpect(jsonPath("$.businessNumber").value("1248100998"))
            .andExpect(jsonPath("$.businessStatusCode").value("01"))
            .andExpect(jsonPath("$.isActive").value(true))
            .andExpect(jsonPath("$.canRegister").value(true))
        // 휴업자는 등록은 되고 파트너 기능만 막히므로 canRegister만 참입니다.
        mockMvc.perform(get("/api/v1/me/company/lookup").param("businessNumber", "120-87-34519").cookie(session))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.businessStatusCode").value("02"))
            .andExpect(jsonPath("$.isActive").value(false))
            .andExpect(jsonPath("$.canRegister").value(true))
        mockMvc.perform(get("/api/v1/me/company/lookup").param("businessNumber", "1234567890").cookie(session))
            .andExpect(status().isNotFound())
            .andExpect(jsonPath("$.code").value("BUSINESS_NOT_FOUND"))
        mockMvc.perform(get("/api/v1/me/company/lookup").param("businessNumber", "12-34").cookie(session))
            .andExpect(status().isBadRequest())
        mockMvc.perform(
            post("/api/v1/me/company").cookie(session).origin()
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"businessNumber":"124-81-00998","region":"서울특별시","industry":"제조업","foundedYear":1800}"""),
        )
            .andExpect(status().isBadRequest())
        // 올해를 넘는 설립연도와 http(s)가 아닌 홈페이지는 필드명을 실은 400입니다.
        mockMvc.perform(
            post("/api/v1/me/company").cookie(session).origin()
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"businessNumber":"124-81-00998","region":"서울특별시","industry":"제조업","foundedYear":2099}"""),
        )
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("REQUEST_VALIDATION_FAILED"))
            .andExpect(jsonPath("$.errors[0].field").value("foundedYear"))
        mockMvc.perform(
            post("/api/v1/me/company").cookie(session).origin()
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"businessNumber":"124-81-00998","region":"서울특별시","industry":"제조업","foundedYear":2020,"homepageUrl":"ftp://example.co.kr"}"""),
        )
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.errors[0].field").value("homepageUrl"))
        mockMvc.perform(get("/api/v1/me/company/lookup").param("businessNumber", "9999999999").cookie(session))
            .andExpect(status().isServiceUnavailable())
            .andExpect(jsonPath("$.code").value("BIZNO_NOT_CONFIGURED"))

        mockMvc.perform(
            post("/api/v1/me/company").cookie(session).origin()
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"businessNumber":"111-22-33334","region":"서울특별시","industry":"제조업","foundedYear":2020}"""),
        )
            .andExpect(status().isUnprocessableContent())
            .andExpect(jsonPath("$.code").value("BUSINESS_NOT_ACTIVE"))
            .andExpect(jsonPath("$.businessStatus").value("폐업자"))

        mockMvc.perform(
            post("/api/v1/me/company").cookie(session).origin()
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    """{"businessNumber":"124-81-00998","region":"서울특별시","industry":"정보통신업","foundedYear":2020,
                       "homepageUrl":" https://example.co.kr "}""",
                ),
        )
            .andExpect(status().isCreated())
            .andExpect(jsonPath("$.companyName").value("삼성전자(주)"))
            .andExpect(jsonPath("$.businessStatus").value("계속사업자"))
            .andExpect(jsonPath("$.homepageUrl").value("https://example.co.kr"))

        mockMvc.perform(get("/api/v1/auth/me").cookie(session))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.account.tier").value("COMPANY"))
            .andExpect(jsonPath("$.account.company.companyName").value("삼성전자(주)"))
            .andExpect(jsonPath("$.account.company.businessStatusCode").value("01"))

        mockMvc.perform(
            post("/api/v1/me/company").cookie(session).origin()
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"businessNumber":"124-81-00998","region":"서울특별시","industry":"제조업","foundedYear":2020}"""),
        )
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("COMPANY_ALREADY_REGISTERED"))

        val other = signUp("other@company.co.kr", "password1")
        mockMvc.perform(
            post("/api/v1/me/company").cookie(other).origin()
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"businessNumber":"124-81-00998","region":"서울특별시","industry":"제조업","foundedYear":2020}"""),
        )
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("BUSINESS_NUMBER_ALREADY_REGISTERED"))

        // 휴업 사업자는 등록되고 요약에 상태 코드 02가 실립니다.
        mockMvc.perform(
            post("/api/v1/me/company").cookie(other).origin()
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"businessNumber":"120-87-34519","region":"경기도","industry":"제조업","foundedYear":2015}"""),
        )
            .andExpect(status().isCreated())
            .andExpect(jsonPath("$.businessStatus").value("휴업자"))
            .andExpect(jsonPath("$.businessStatusCode").value("02"))
        mockMvc.perform(get("/api/v1/auth/me").cookie(other))
            .andExpect(jsonPath("$.account.tier").value("COMPANY"))
            .andExpect(jsonPath("$.account.company.businessStatusCode").value("02"))

        mockMvc.perform(
            put("/api/v1/me/company").cookie(session).origin()
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"region":"부산광역시","industry":"제조업","foundedYear":2019,"homepageUrl":""}"""),
        )
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.region").value("부산광역시"))
            .andExpect(jsonPath("$.companyName").value("삼성전자(주)"))
            .andExpect(jsonPath("$.homepageUrl").doesNotExist())
    }

    @Test
    fun savesAndReadsThePartnerProfileOnlyForARegisteredCompany() {
        val session = signUp("partner@company.co.kr", "password1")
        mockMvc.perform(get("/api/v1/me/company/partner-profile").cookie(session))
            .andExpect(status().isNotFound())
            .andExpect(jsonPath("$.code").value("COMPANY_NOT_REGISTERED"))

        mockMvc.perform(
            post("/api/v1/me/company").cookie(session).origin()
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"businessNumber":"124-81-00998","region":"서울특별시","industry":"정보통신업","foundedYear":2020}"""),
        ).andExpect(status().isCreated())

        mockMvc.perform(get("/api/v1/me/company/partner-profile").cookie(session))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.isSet").value(false))
            .andExpect(jsonPath("$.roles").isEmpty())
            .andExpect(jsonPath("$.introduction").value(""))

        mockMvc.perform(
            put("/api/v1/me/company/partner-profile").cookie(session).origin()
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    """{"roles":["LEAD","PARTICIPANT","LEAD"],"interestAreas":["기술"," 사업화 ",""],
                       "introduction":" AI 문서 분류 SaaS를 만드는 팀입니다. ","capabilities":["문서 분류 AI","공공 레퍼런스"]}""",
                ),
        )
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.isSet").value(true))
            .andExpect(jsonPath("$.roles.length()").value(2))
            .andExpect(jsonPath("$.interestAreas[1]").value("사업화"))
            .andExpect(jsonPath("$.interestAreas.length()").value(2))
            .andExpect(jsonPath("$.introduction").value("AI 문서 분류 SaaS를 만드는 팀입니다."))
            .andExpect(jsonPath("$.capabilities.length()").value(2))
            .andExpect(jsonPath("$.updatedAt").isNotEmpty())

        // 두 번째 저장은 같은 행을 덮어씁니다.
        mockMvc.perform(
            put("/api/v1/me/company/partner-profile").cookie(session).origin()
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"roles":["PARTICIPANT"],"interestAreas":[],"introduction":"","capabilities":[]}"""),
        )
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.roles[0]").value("PARTICIPANT"))
            .andExpect(jsonPath("$.roles.length()").value(1))
        mockMvc.perform(get("/api/v1/me/company/partner-profile").cookie(session))
            .andExpect(jsonPath("$.capabilities").isEmpty())

        // 역할이 비거나 항목 수를 넘기면 요청 검증 400입니다.
        mockMvc.perform(
            put("/api/v1/me/company/partner-profile").cookie(session).origin()
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"roles":[],"interestAreas":["a","b","c","d"]}"""),
        ).andExpect(status().isBadRequest())
    }

    private fun signUp(email: String, password: String): Cookie {
        val response = mockMvc.perform(
            post("/api/v1/auth/signup")
                .contentType(MediaType.APPLICATION_JSON)
                .content(SignupTestHelper.signupJson(jdbcTemplate, email, password)),
        )
            .andExpect(status().isCreated())
            .andReturn().response
        return requireNotNull(response.getCookie(SessionCookieHelper.COOKIE_NAME))
    }

    private fun org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder.origin() =
        header(HttpHeaders.ORIGIN, "http://localhost:5173")

    private fun activeBusiness() =
        BiznoBusiness(
            businessNumber = "1248100998",
            companyName = "삼성전자(주)",
            businessStatus = "계속사업자",
            businessStatusCode = "01",
        )
}
