package ai.govbiz.core.govagent.service.dto

import ai.govbiz.core.govagent.domain.GovAgentProgram
import ai.govbiz.core.partner.domain.PartnerMatchConditions
import ai.govbiz.core.supportprogram.service.dto.SupportProgramConversationResult
import ai.govbiz.core.supportprogram.service.dto.SupportProgramEvidenceAnswerResult

enum class GovAgentOutcome { SEARCH, EVIDENCE, APPLICATION, COMBINATION_REVIEW, PARTNERS, NEEDS_PROGRAM, UNSUPPORTED }

data class GovAgentResult(
    val outcome: GovAgentOutcome,
    val interpretation: SupportProgramConversationResult? = null,
    val evidence: SupportProgramEvidenceAnswerResult? = null,
    val program: GovAgentProgram? = null,
    val message: String? = null,
    /** PARTNERS일 때 사용자가 말한 모집글 조건입니다. 화면은 이 조건으로 맞춤 추천을 조회합니다. */
    val partnerConditions: PartnerMatchConditions? = null,
)
