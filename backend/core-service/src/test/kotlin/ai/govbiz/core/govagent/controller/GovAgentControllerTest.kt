package ai.govbiz.core.govagent.controller

import ai.govbiz.core._common.exception.ApiExceptionHandler
import ai.govbiz.core.account.domain.AccountRole
import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.service.AccountSessionService
import ai.govbiz.core.admin.web.AdminPrincipalArgumentResolver
import ai.govbiz.core.govagent.domain.GovAgentProgram
import ai.govbiz.core.govagent.domain.GovAgentQuestion
import ai.govbiz.core.govagent.service.GovAgentService
import ai.govbiz.core.govagent.service.dto.GovAgentOutcome
import ai.govbiz.core.govagent.service.dto.GovAgentResult
import ai.govbiz.core.supportprogram.domain.SupportProgramCompanyConditions
import ai.govbiz.core.supportprogram.domain.SupportProgramConversationContext
import ai.govbiz.core.supportprogram.service.admission.SupportProgramRequestAdmissionService
import ai.govbiz.core.supportprogram.service.admission.config.SupportProgramRequestAdmissionProperties
import org.junit.jupiter.api.Test
import org.mockito.Mockito.*
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.*
import org.springframework.test.web.servlet.setup.MockMvcBuilders

class GovAgentControllerTest {
    private val sessions = mock(AccountSessionService::class.java)
    private val service = mock(GovAgentService::class.java)
    private val mvc = MockMvcBuilders.standaloneSetup(GovAgentController(service,
        SupportProgramRequestAdmissionService(SupportProgramRequestAdmissionProperties())))
        .setCustomArgumentResolvers(AdminPrincipalArgumentResolver { sessions })
        .setControllerAdvice(ApiExceptionHandler()).build()
    private val admin = AccountTestHelper.account(id = 7, role = AccountRole.ADMIN)
    private val body = """{"conversation":{"message":"지원 대상은?","context":{"query":null,"acceptingOnly":true,
        "companyConditions":{"region":null,"industry":null,"establishedOn":null,"supportPurpose":null}}},"selectedProgram":null}"""

    @Test
    fun memberCannotUseAdminEndpoint() {
        doReturn(admin.copy(role = AccountRole.USER)).`when`(sessions).requireAccount("test-session")
        mvc.perform(post("/api/v1/gov-agent/messages").header("Authorization", "Bearer test-session")
            .contentType(MediaType.APPLICATION_JSON).content(body)).andExpect(status().isForbidden())
        verifyNoInteractions(service)
    }

    @Test
    fun adminGetsTypedSelectionRequestWithoutCaching() {
        doReturn(admin).`when`(sessions).requireAccount("test-session")
        val question = GovAgentQuestion("지원 대상은?", SupportProgramConversationContext(null, true, SupportProgramCompanyConditions()), null, null, null, null)
        doReturn(GovAgentResult(GovAgentOutcome.NEEDS_PROGRAM, message = "공고를 선택해 주세요.")).`when`(service).answer(admin, "127.0.0.1", question, sampleProduction = true)
        mvc.perform(post("/api/v1/gov-agent/messages").header("Authorization", "Bearer test-session")
            .contentType(MediaType.APPLICATION_JSON).content(body)).andExpect(status().isOk())
            .andExpect(header().string("Cache-Control", "no-store"))
            .andExpect(jsonPath("$.outcome").value("NEEDS_PROGRAM"))
    }

    @Test
    fun evaluationHeaderExplicitlyDisablesProductionSampling() {
        doReturn(admin).`when`(sessions).requireAccount("test-session")
        val question = GovAgentQuestion("지원 대상은?", SupportProgramConversationContext(null, true, SupportProgramCompanyConditions()), null, null, null, null)
        doReturn(GovAgentResult(GovAgentOutcome.NEEDS_PROGRAM, message = "공고 선택 필요"))
            .`when`(service).answer(admin, "127.0.0.1", question, sampleProduction = false)
        mvc.perform(post("/api/v1/gov-agent/messages").header("Authorization", "Bearer test-session")
            .header("X-GovBiz-Evaluation", "evaluation-run").contentType(MediaType.APPLICATION_JSON).content(body))
            .andExpect(status().isOk())
        verify(service).answer(admin, "127.0.0.1", question, sampleProduction = false)
    }

    @Test
    fun applicationResponseKeepsTheSelectedCompositeIdentityAndPreparationMessage() {
        doReturn(admin).`when`(sessions).requireAccount("test-session")
        val program = GovAgentProgram("KSTARTUP", "P001")
        val question = GovAgentQuestion("신청서 작성해 줘", SupportProgramConversationContext(null, true, SupportProgramCompanyConditions()), null, null, null, program)
        val message = "신청서를 선택한 뒤 양식 분석과 초안 작성 버튼을 눌러 주세요."
        doReturn(GovAgentResult(GovAgentOutcome.APPLICATION, program = program, message = message))
            .`when`(service).answer(admin, "127.0.0.1", question, sampleProduction = true)
        val request = body.replace("지원 대상은?", question.message)
            .replace("\"selectedProgram\":null", "\"selectedProgram\":{\"sourceCode\":\"KSTARTUP\",\"sourceProgramId\":\"P001\"}")

        mvc.perform(post("/api/v1/gov-agent/messages").header("Authorization", "Bearer test-session")
            .contentType(MediaType.APPLICATION_JSON).content(request)).andExpect(status().isOk())
            .andExpect(header().string("Cache-Control", "no-store"))
            .andExpect(jsonPath("$.outcome").value("APPLICATION"))
            .andExpect(jsonPath("$.program.sourceCode").value("KSTARTUP"))
            .andExpect(jsonPath("$.program.sourceProgramId").value("P001"))
            .andExpect(jsonPath("$.message").value(message))
            .andExpect(jsonPath("$.interpretation").isEmpty())
            .andExpect(jsonPath("$.evidence").isEmpty())
    }

    @Test
    fun rejectsInvalidCompositeIdentityBeforeAnyExecution() {
        doReturn(admin).`when`(sessions).requireAccount("test-session")
        val invalid = body.replace("\"selectedProgram\":null", "\"selectedProgram\":{\"sourceCode\":\"https://invalid\",\"sourceProgramId\":\"P001\"}")
        mvc.perform(post("/api/v1/gov-agent/messages").header("Authorization", "Bearer test-session")
            .contentType(MediaType.APPLICATION_JSON).content(invalid)).andExpect(status().isBadRequest())
        verifyNoInteractions(service)
    }

    @Test
    fun combinationReviewResponseAllowsAnOptionalSelectedCompositeIdentity() {
        doReturn(admin).`when`(sessions).requireAccount("test-session")
        for (program in listOf(null, GovAgentProgram("KSTARTUP", "P001"))) {
            val question = GovAgentQuestion("중복 수혜를 검토해 줘", SupportProgramConversationContext(null, true, SupportProgramCompanyConditions()), null, null, null, program)
            val message = "두 공고와 참여 상태를 확인한 뒤 검토를 실행해 주세요."
            doReturn(GovAgentResult(GovAgentOutcome.COMBINATION_REVIEW, program = program, message = message))
                .`when`(service).answer(admin, "127.0.0.1", question, sampleProduction = true)
            var request = body.replace("지원 대상은?", question.message)
            if (program != null) request = request.replace("\"selectedProgram\":null", "\"selectedProgram\":{\"sourceCode\":\"KSTARTUP\",\"sourceProgramId\":\"P001\"}")

            val response = mvc.perform(post("/api/v1/gov-agent/messages").header("Authorization", "Bearer test-session")
                .contentType(MediaType.APPLICATION_JSON).content(request)).andExpect(status().isOk())
                .andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(jsonPath("$.outcome").value("COMBINATION_REVIEW"))
                .andExpect(jsonPath("$.message").value(message))
                .andExpect(jsonPath("$.interpretation").isEmpty())
                .andExpect(jsonPath("$.evidence").isEmpty())
            if (program == null) response.andExpect(jsonPath("$.program").isEmpty())
            else response.andExpect(jsonPath("$.program.sourceCode").value("KSTARTUP"))
                .andExpect(jsonPath("$.program.sourceProgramId").value("P001"))
        }
    }

    @Test
    fun partnersResponseHasGuidanceWithoutAProgramOrAnalysis() {
        doReturn(admin).`when`(sessions).requireAccount("test-session")
        val question = GovAgentQuestion("협업 파트너 찾아줘", SupportProgramConversationContext(null, true, SupportProgramCompanyConditions()), null, null, null, null)
        val message = "모집 역할과 지역으로 파트너 모집글을 조회해 주세요."
        doReturn(GovAgentResult(GovAgentOutcome.PARTNERS, message = message))
            .`when`(service).answer(admin, "127.0.0.1", question, sampleProduction = true)

        mvc.perform(post("/api/v1/gov-agent/messages").header("Authorization", "Bearer test-session")
            .contentType(MediaType.APPLICATION_JSON).content(body.replace("지원 대상은?", question.message)))
            .andExpect(status().isOk())
            .andExpect(header().string("Cache-Control", "no-store"))
            .andExpect(jsonPath("$.outcome").value("PARTNERS"))
            .andExpect(jsonPath("$.message").value(message))
            .andExpect(jsonPath("$.program").isEmpty())
            .andExpect(jsonPath("$.interpretation").isEmpty())
            .andExpect(jsonPath("$.evidence").isEmpty())
    }
}
