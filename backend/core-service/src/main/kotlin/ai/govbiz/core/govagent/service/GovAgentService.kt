package ai.govbiz.core.govagent.service

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.admin.service.exception.AdminAccessDeniedException
import ai.govbiz.core.aiusage.domain.AiUsageFeature
import ai.govbiz.core.aiusage.helper.AiUsageContextHelper
import ai.govbiz.core.assistant.service.AssistantPiiMasker
import ai.govbiz.core.govagent.client.AiGovAgentClient
import ai.govbiz.core.govagent.client.dto.AiGovAgentRequest
import ai.govbiz.core.govagent.client.dto.AiGovPartnerConditionPayload
import ai.govbiz.core.govagent.client.dto.AiGovPartnerConditionsPayload
import ai.govbiz.core.govagent.domain.GovAgentProgram
import ai.govbiz.core.govagent.domain.GovAgentQuestion
import ai.govbiz.core.govagent.service.dto.GovAgentOutcome
import ai.govbiz.core.govagent.service.dto.GovAgentResult
import ai.govbiz.core.partner.domain.PartnerMatchConditions
import ai.govbiz.core.partner.domain.PartnerMatchProgram
import ai.govbiz.core.partner.domain.PartnerRegionNames
import ai.govbiz.core.partner.domain.PartnerRole
import ai.govbiz.core.planusage.domain.PlanUsageFeature
import ai.govbiz.core.planusage.service.PlanUsageService
import ai.govbiz.core.supportprogram.service.conversation.SupportProgramConversationService
import ai.govbiz.core.supportprogram.service.evidence.SupportProgramEvidenceService
import org.springframework.stereotype.Service

/** 한 턴에 한 업무만 위임한다. 검색·신청 준비·중복 검토는 안내 뒤 사용자의 명시적인 실행을 기다린다. */
@Service
class GovAgentService(
    private val client: AiGovAgentClient,
    private val conversationService: SupportProgramConversationService,
    private val evidenceService: SupportProgramEvidenceService,
    private val planUsageService: PlanUsageService,
) {
    fun answer(account: Account, clientIp: String, question: GovAgentQuestion): GovAgentResult {
        if (!account.isAdmin) throw AdminAccessDeniedException()
        // 경로 선택과 검색 조건 해석의 OpenAI 사용량을 이 관리자와 Gov 에이전트로 기록합니다. 원문 답변은 이용량 차감 안에서 EVIDENCE_QUESTION으로 바뀝니다.
        return AiUsageContextHelper.attribute(account.id, AiUsageFeature.GOV_AGENT) { decideAndRun(account, clientIp, question) }
    }

    private fun decideAndRun(account: Account, clientIp: String, question: GovAgentQuestion): GovAgentResult {
        val maskedMessage = AssistantPiiMasker.mask(question.message)
        val decision = client.decide(AiGovAgentRequest(
            maskedMessage, question.selectedProgram != null,
            question.context.query?.let(AssistantPiiMasker::mask),
            question.pendingClarification?.question?.let(AssistantPiiMasker::mask),
        ))
        if (decision.action != "PARTNERS" && decision.partnerConditions != null) {
            throw AiServiceCallException.invalidResponse("Partner conditions outside PARTNERS", null)
        }
        return when (decision.action) {
            "SEARCH" -> GovAgentResult(GovAgentOutcome.SEARCH, interpretation = conversationService.interpret(
                question.message, question.context, question.pendingClarification, question.pendingProposal, question.lastSearch,
            ))
            "EVIDENCE" -> {
                val program = question.selectedProgram ?: return GovAgentResult(
                    GovAgentOutcome.NEEDS_PROGRAM, message = "검색 결과에서 공고를 선택한 뒤 질문해 주세요.",
                )
                // AI가 만든 공고 ID·URL로 호출하지 않는다. 사용자가 선택한 복합 식별자로 기존 근거 검증을 거친다.
                val evidence = planUsageService.consume(account, clientIp, PlanUsageFeature.EVIDENCE_QUESTION) {
                    evidenceService.answer(program.sourceCode, program.sourceProgramId, question.message)
                }
                GovAgentResult(GovAgentOutcome.EVIDENCE, evidence = evidence, program = program)
            }
            "APPLICATION" -> {
                val program = question.selectedProgram ?: return GovAgentResult(
                    GovAgentOutcome.NEEDS_PROGRAM, message = "신청서를 준비할 공고를 검색 결과에서 선택한 뒤 요청해 주세요.",
                )
                GovAgentResult(GovAgentOutcome.APPLICATION, program = program,
                    message = "신청 양식과 지원 분야를 확인한 뒤 작성을 시작해 주세요. 저장된 양식이 없으면 분석을 요청할 수 있습니다.")
            }
            "COMBINATION_REVIEW" -> GovAgentResult(GovAgentOutcome.COMBINATION_REVIEW, program = question.selectedProgram,
                message = "함께 지원할 두 공고를 선택하고 참여 상태와 사업 관계를 확인한 뒤 중복 검토를 실행해 주세요.")
            "PARTNERS" -> {
                val conditions = partnerConditions(decision.partnerConditions, maskedMessage, question.selectedProgram)
                val spoken = conditions.seekingRoles.isNotEmpty() || conditions.regions.isNotEmpty() ||
                    conditions.keywords.isNotEmpty() || conditions.program != null
                GovAgentResult(GovAgentOutcome.PARTNERS, partnerConditions = conditions,
                    message = if (spoken) "말씀하신 조건으로 모집글을 찾아봤어요." else "우리 회사 정보와 관심 공고에 맞는 모집글을 찾아봤어요.")
            }
            "UNSUPPORTED" -> GovAgentResult(GovAgentOutcome.UNSUPPORTED,
                message = "현재 Gov 에이전트에서는 지원사업 검색, 선택한 공고의 원문 질문과 신청서 준비, 중복 검토 준비와 파트너 모집글 조회를 지원합니다. 외부 기관 제출·제안 발송·모집글 작성·저장·삭제·여러 작업 자동 실행은 지원하지 않습니다.")
            else -> throw AiServiceCallException.invalidResponse("Unknown Gov agent action", null)
        }
    }

    /**
     * 경로 선택 모델이 함께 돌려준 파트너 조건을 검증합니다. 모든 값은 모델이 본 사용자 말(개인정보를 가린 원문)에 근거 문구가
     * 그대로 있어야 하고, 지역은 근거 문구에 그 지역 이름이나 "수도권"이, 분야 말은 근거 문구 안의 낱말이어야 합니다. 맞지 않으면 오류입니다.
     * 역할은 근거 문구에 그 역할 말(주관·참여·수요)이 없으면 사용자가 말하지 않은 역할로 보고 적용하지 않습니다("파트너"만으로 역할을
     * 정하면 결과가 사용자가 묻지 않은 조건으로 줄어들기 때문). 근거 문구가 원문에 없는 출력은 이때도 오류입니다.
     * 근거가 "수도권"인 지역은 서울·경기·인천을 모두 담습니다. "이 공고"는 사용자가 고른 공고가 있을 때만 그 공고로 좁힙니다.
     * 모델이 조건을 비워 보내면 내 정보만으로 고릅니다.
     */
    private fun partnerConditions(
        payload: AiGovPartnerConditionsPayload?,
        message: String,
        selectedProgram: GovAgentProgram?,
    ): PartnerMatchConditions {
        if (payload == null) return PartnerMatchConditions()
        fun items(list: List<AiGovPartnerConditionPayload?>?, max: Int): List<Pair<String, String>> {
            val values = list ?: invalidPartnerConditions()
            if (values.size > max) invalidPartnerConditions()
            return values.map { item ->
                val value = item?.value?.trim()?.takeIf { it.isNotEmpty() } ?: invalidPartnerConditions()
                val evidence = item.evidence?.takeIf { it.isNotBlank() && it.length <= MAX_EVIDENCE_LENGTH && message.contains(it) }
                    ?: invalidPartnerConditions()
                value to evidence
            }
        }
        val compact = { text: String -> text.filterNot { it.isWhitespace() } }
        val roles = items(payload.seekingRoles, PartnerRole.entries.size).mapNotNull { (value, evidence) ->
            val role = PartnerRole.entries.firstOrNull { it.name == value } ?: invalidPartnerConditions()
            role.takeIf { compact(evidence).contains(ROLE_WORDS.getValue(it)) }
        }
        val regions = items(payload.regions, PartnerRegionNames.SHORT_NAMES.size).flatMap { (value, evidence) ->
            if (value !in PartnerRegionNames.SHORT_NAMES) invalidPartnerConditions()
            when {
                evidence.contains(CAPITAL_AREA) && value in CAPITAL_AREA_REGIONS -> CAPITAL_AREA_REGIONS
                evidence.contains(value) || PartnerRegionNames.shortName(evidence.trim()) == value ||
                    evidence.split(WHITESPACE).any { PartnerRegionNames.shortName(it) == value } -> listOf(value)
                else -> invalidPartnerConditions()
            }
        }
        val keywords = items(payload.keywords, PartnerMatchConditions.MAX_KEYWORDS).map { (value, evidence) ->
            value.takeIf { it.length <= PartnerMatchConditions.MAX_KEYWORD_LENGTH && compact(evidence).contains(compact(it)) }
                ?: invalidPartnerConditions()
        }.distinct()
        val programEvidence = payload.selectedProgramEvidence
        val program = if (programEvidence == null) null else {
            if (programEvidence.isBlank() || !message.contains(programEvidence) || selectedProgram == null) invalidPartnerConditions()
            PartnerMatchProgram(selectedProgram.sourceCode, selectedProgram.sourceProgramId)
        }
        return PartnerMatchConditions(roles.toSet(), regions.toSet(), keywords, program)
    }

    private fun invalidPartnerConditions(): Nothing =
        throw AiServiceCallException.invalidResponse("Invalid Gov agent partner conditions", null)

    companion object {
        private const val MAX_EVIDENCE_LENGTH = 80
        private const val CAPITAL_AREA = "수도권"
        private val CAPITAL_AREA_REGIONS = listOf("서울", "경기", "인천")
        private val WHITESPACE = Regex("\\s+")
        /** 역할 근거 문구에 있어야 하는 말입니다. "파트너"·"회사"만으로는 역할을 정하지 않습니다. */
        private val ROLE_WORDS = mapOf(PartnerRole.LEAD to "주관", PartnerRole.PARTICIPANT to "참여", PartnerRole.DEMAND to "수요")
    }
}
