package ai.govbiz.core.govagent.service

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core.account.domain.AccountRole
import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.admin.service.exception.AdminAccessDeniedException
import ai.govbiz.core.aiusage.domain.AiUsageAttribution
import ai.govbiz.core.aiusage.domain.AiUsageFeature
import ai.govbiz.core.aiusage.helper.AiUsageContextHelper
import ai.govbiz.core.govagent.client.AiGovAgentClient
import ai.govbiz.core.govagent.client.dto.AiGovAgentPayload
import ai.govbiz.core.govagent.client.dto.AiGovAgentRequest
import ai.govbiz.core.govagent.client.dto.AiGovPartnerConditionPayload
import ai.govbiz.core.govagent.client.dto.AiGovPartnerConditionsPayload
import ai.govbiz.core.govagent.domain.GovAgentProgram
import ai.govbiz.core.govagent.domain.GovAgentQuestion
import ai.govbiz.core.govagent.service.dto.GovAgentOutcome
import ai.govbiz.core.partner.domain.PartnerMatchConditions
import ai.govbiz.core.partner.domain.PartnerMatchProgram
import ai.govbiz.core.partner.domain.PartnerRole
import ai.govbiz.core.planusage.domain.PlanUsageFeature
import ai.govbiz.core.planusage.service.PlanUsageService
import ai.govbiz.core.supportprogram.domain.SupportProgramCompanyConditions
import ai.govbiz.core.supportprogram.domain.SupportProgramConversationContext
import ai.govbiz.core.supportprogram.domain.SupportProgramConversationStatus
import ai.govbiz.core.supportprogram.service.conversation.SupportProgramConversationService
import ai.govbiz.core.supportprogram.service.dto.SupportProgramConversationResult
import ai.govbiz.core.supportprogram.service.dto.SupportProgramEvidenceAnswerResult
import ai.govbiz.core.supportprogram.service.dto.SupportProgramEvidenceAnswerStatus
import ai.govbiz.core.supportprogram.service.evidence.SupportProgramEvidenceService
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.mockito.Mockito.*

class GovAgentServiceTest {
    private val client = mock(AiGovAgentClient::class.java)
    private val conversation = mock(SupportProgramConversationService::class.java)
    private val evidence = mock(SupportProgramEvidenceService::class.java)
    private val usage = mock(PlanUsageService::class.java)
    private val service = GovAgentService(client, conversation, evidence, usage)
    private val admin = AccountTestHelper.account(id = 7, role = AccountRole.ADMIN)
    private val context = SupportProgramConversationContext(null, true, SupportProgramCompanyConditions(null, null, null, null))
    private val program = GovAgentProgram("BIZINFO", "P001")
    private fun question(selected: GovAgentProgram? = program) = GovAgentQuestion("신청 방법은?", context, null, null, null, selected)
    private fun decide(action: String, selected: Boolean = true) {
        doReturn(AiGovAgentPayload(action)).`when`(client).decide(AiGovAgentRequest("신청 방법은?", selected, null, null))
    }

    @Test
    fun rejectsMembersBeforeAnyModelOrToolCall() {
        assertThrows(AdminAccessDeniedException::class.java) { service.answer(admin.copy(role = AccountRole.USER), "127.0.0.1", question()) }
        verifyNoInteractions(client, conversation, evidence, usage)
    }

    @Test
    fun searchOnlyPreparesAProposalAndDoesNotChargeOrAskEvidence() {
        decide("SEARCH")
        val proposed = SupportProgramConversationResult(SupportProgramConversationStatus.READY, context.copy(query = "창업 지원"), null, emptyList(), null)
        doReturn(proposed).`when`(conversation).interpret("신청 방법은?", context, null, null, null)
        assertEquals(proposed, service.answer(admin, "127.0.0.1", question()).interpretation)
        verifyNoInteractions(evidence, usage)
    }

    @Test
    fun recordsTheRouteDecisionAndSearchInterpretationUsageAsThisAdminsGovAgent() {
        val seen = mutableListOf<AiUsageAttribution?>()
        doAnswer { seen += AiUsageContextHelper.current(); AiGovAgentPayload("SEARCH") }
            .`when`(client).decide(AiGovAgentRequest("신청 방법은?", true, null, null))
        val proposed = SupportProgramConversationResult(SupportProgramConversationStatus.READY, context.copy(query = "창업 지원"), null, emptyList(), null)
        doAnswer { seen += AiUsageContextHelper.current(); proposed }.`when`(conversation).interpret("신청 방법은?", context, null, null, null)

        service.answer(admin, "127.0.0.1", question())

        assertEquals(List(2) { AiUsageAttribution(7, AiUsageFeature.GOV_AGENT) }, seen)
        // 한 요청이 끝나면 다음 요청에 기록 대상이 남지 않습니다.
        assertNull(AiUsageContextHelper.current())
    }

    @Test
    fun asksForSelectionWithoutInventingProgramOrCharging() {
        decide("EVIDENCE", selected = false)
        assertEquals(GovAgentOutcome.NEEDS_PROGRAM, service.answer(admin, "127.0.0.1", question(null)).outcome)
        verifyNoInteractions(conversation, evidence, usage)
    }

    @Test
    fun evidenceUsesSelectedCompositeIdentityAndExistingQuotaBoundary() {
        decide("EVIDENCE")
        val answer = SupportProgramEvidenceAnswerResult("근거 부족", SupportProgramEvidenceAnswerStatus.INSUFFICIENT_EVIDENCE, emptyList())
        doReturn(answer).`when`(evidence).answer("BIZINFO", "P001", "신청 방법은?")
        doAnswer { invocation -> invocation.getArgument<() -> SupportProgramEvidenceAnswerResult>(3).invoke() }
            .`when`(usage).consume(eq(admin), eq("127.0.0.1") ?: "", eq(PlanUsageFeature.EVIDENCE_QUESTION) ?: PlanUsageFeature.EVIDENCE_QUESTION,
                any<() -> SupportProgramEvidenceAnswerResult>() ?: { answer })
        val result = service.answer(admin, "127.0.0.1", question())
        assertEquals(answer, result.evidence)
        assertEquals(program, result.program)
        verify(evidence).answer("BIZINFO", "P001", "신청 방법은?")
        verifyNoInteractions(conversation)
    }

    @Test
    fun applicationReturnsSelectedCompositeIdentityWithoutExecutingOrCharging() {
        decide("APPLICATION")
        val selected = GovAgentProgram("KSTARTUP", "P001")
        val result = service.answer(admin, "127.0.0.1", question(selected))

        assertEquals(GovAgentOutcome.APPLICATION, result.outcome)
        assertEquals(selected, result.program)
        assertNull(result.interpretation)
        assertNull(result.evidence)
        assertTrue(!result.message.isNullOrBlank())
        verifyNoInteractions(conversation, evidence, usage)
    }

    @Test
    fun applicationWithoutSelectionAsksForProgramWithoutExecutingOrCharging() {
        decide("APPLICATION", selected = false)
        val result = service.answer(admin, "127.0.0.1", question(null))

        assertEquals(GovAgentOutcome.NEEDS_PROGRAM, result.outcome)
        assertNull(result.program)
        assertNull(result.interpretation)
        assertNull(result.evidence)
        assertTrue(result.message!!.contains("신청서"))
        assertTrue(result.message.contains("공고"))
        verifyNoInteractions(conversation, evidence, usage)
    }

    @Test
    fun combinationReviewPreservesSelectedCompositeIdentityWithoutExecutingOrCharging() {
        decide("COMBINATION_REVIEW")
        val selected = GovAgentProgram("KSTARTUP", "P001")
        val result = service.answer(admin, "127.0.0.1", question(selected))

        assertEquals(GovAgentOutcome.COMBINATION_REVIEW, result.outcome)
        assertEquals(selected, result.program)
        assertNull(result.interpretation)
        assertNull(result.evidence)
        assertTrue(!result.message.isNullOrBlank())
        verifyNoInteractions(conversation, evidence, usage)
    }

    @Test
    fun combinationReviewWithoutSelectionStillPreparesReviewWithoutExecutingOrCharging() {
        decide("COMBINATION_REVIEW", selected = false)
        val result = service.answer(admin, "127.0.0.1", question(null))

        assertEquals(GovAgentOutcome.COMBINATION_REVIEW, result.outcome)
        assertNull(result.program)
        assertNull(result.interpretation)
        assertNull(result.evidence)
        assertTrue(result.message!!.contains("두 공고"))
        verifyNoInteractions(conversation, evidence, usage)
    }

    @Test
    fun partnersNeverScopesTheBrowseResponseToASelectedProgramOrExecutesAnotherFeature() {
        for (selected in listOf(null, program)) {
            decide("PARTNERS", selected = selected != null)
            val result = service.answer(admin, "127.0.0.1", question(selected))

            assertEquals(GovAgentOutcome.PARTNERS, result.outcome)
            assertNull(result.program)
            assertNull(result.interpretation)
            assertNull(result.evidence)
            assertTrue(!result.message.isNullOrBlank())
        }
        verifyNoInteractions(conversation, evidence, usage)
    }

    private val partnerMessage = "서울에서 AI 참여기관 구하는 이 공고 모집글 보여줘"
    private fun partnerQuestion(selected: GovAgentProgram? = program) = GovAgentQuestion(partnerMessage, context, null, null, null, selected)
    private fun condition(value: String, evidence: String) = AiGovPartnerConditionPayload(value, evidence)
    private fun partnerPayload(
        roles: List<AiGovPartnerConditionPayload> = listOf(condition("PARTICIPANT", "참여기관 구하는")),
        regions: List<AiGovPartnerConditionPayload> = listOf(condition("서울", "서울에서")),
        keywords: List<AiGovPartnerConditionPayload> = listOf(condition("AI", "AI")),
        selectedProgramEvidence: String? = "이 공고",
        action: String = "PARTNERS",
    ) = AiGovAgentPayload(action, AiGovPartnerConditionsPayload(roles, regions, keywords, selectedProgramEvidence))

    private fun decidePartners(payload: AiGovAgentPayload, selected: Boolean = true) {
        doReturn(payload).`when`(client).decide(AiGovAgentRequest(partnerMessage, selected, null, null))
    }

    @Test
    fun partnersReturnsConditionsWhoseEvidenceIsInTheUserMessage() {
        decidePartners(partnerPayload())
        val result = service.answer(admin, "127.0.0.1", partnerQuestion())

        assertEquals(GovAgentOutcome.PARTNERS, result.outcome)
        assertEquals(
            PartnerMatchConditions(setOf(PartnerRole.PARTICIPANT), setOf("서울"), listOf("AI"), PartnerMatchProgram("BIZINFO", "P001")),
            result.partnerConditions,
        )
        assertEquals("말씀하신 조건으로 모집글을 찾아봤어요.", result.message)
        verifyNoInteractions(conversation, evidence, usage)
    }

    @Test
    fun partnersWithoutSpokenConditionsChoosesFromTheAccountInformation() {
        decidePartners(AiGovAgentPayload("PARTNERS"))
        val result = service.answer(admin, "127.0.0.1", partnerQuestion())

        assertEquals(PartnerMatchConditions(), result.partnerConditions)
        assertEquals("우리 회사 정보와 관심 공고에 맞는 모집글을 찾아봤어요.", result.message)
    }

    @Test
    fun capitalAreaEvidenceCoversSeoulGyeonggiAndIncheonEvenWhenTheModelNamesOnlyOne() {
        val message = "수도권 데이터 회사 파트너 찾아줘"
        val payload = AiGovAgentPayload("PARTNERS", AiGovPartnerConditionsPayload(
            emptyList(), listOf(condition("서울", "수도권")), listOf(condition("데이터", "데이터")), null,
        ))
        doReturn(payload).`when`(client).decide(AiGovAgentRequest(message, false, null, null))
        val result = service.answer(admin, "127.0.0.1", GovAgentQuestion(message, context, null, null, null, null))

        assertEquals(PartnerMatchConditions(emptySet(), setOf("서울", "경기", "인천"), listOf("데이터")), result.partnerConditions)
    }

    @Test
    fun rolesWithoutTheRoleWordInTheirEvidenceAreNotApplied() {
        // 모델이 "모집글"만 보고 참여기관을 붙여도, 사용자가 역할을 말하지 않았으므로 역할로 거르지 않습니다.
        decidePartners(partnerPayload(roles = listOf(condition("PARTICIPANT", "모집글"), condition("LEAD", "참여기관 구하는"))))
        val result = service.answer(admin, "127.0.0.1", partnerQuestion())
        assertEquals(emptySet<PartnerRole>(), result.partnerConditions?.seekingRoles)
        assertEquals(setOf("서울"), result.partnerConditions?.regions)
    }

    @Test
    fun partnerConditionsOutsideTheContractFailInsteadOfBeingDropped() {
        val invalid = listOf(
            partnerPayload(regions = listOf(condition("부산", "부산에서"))),
            partnerPayload(regions = listOf(condition("전국", "서울에서"))),
            partnerPayload(roles = listOf(condition("OWNER", "참여기관 구하는"))),
            partnerPayload(keywords = listOf(condition("데이터", "AI"))),
            partnerPayload(keywords = List(4) { condition("AI", "AI") }),
            partnerPayload(regions = listOf(condition("서울", "AI"))),
            partnerPayload(action = "SEARCH"),
        )
        for (payload in invalid) {
            decidePartners(payload)
            assertThrows(AiServiceCallException::class.java) { service.answer(admin, "127.0.0.1", partnerQuestion()) }
        }
        // 고른 공고가 없는데 "이 공고"로 좁히라고 하면 공고를 지어내지 않고 오류입니다.
        decidePartners(partnerPayload(), selected = false)
        assertThrows(AiServiceCallException::class.java) { service.answer(admin, "127.0.0.1", partnerQuestion(null)) }
        verifyNoInteractions(conversation, evidence, usage)
    }

    @Test
    fun unsupportedRequestsDoNotExecuteAnyFeature() {
        decide("UNSUPPORTED")
        assertEquals(GovAgentOutcome.UNSUPPORTED, service.answer(admin, "127.0.0.1", question()).outcome)
        verifyNoInteractions(conversation, evidence, usage)
    }

    @Test
    fun unknownDecisionFailsInsteadOfSearching() {
        decide("DELETE")
        assertThrows(AiServiceCallException::class.java) { service.answer(admin, "127.0.0.1", question()) }
        verifyNoInteractions(conversation, evidence, usage)
    }
}
