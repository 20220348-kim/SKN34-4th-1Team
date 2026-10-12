package ai.govbiz.core.govagent.controller.dto

import ai.govbiz.core.govagent.domain.GovAgentProgram
import ai.govbiz.core.govagent.domain.GovAgentQuestion
import ai.govbiz.core.govagent.service.dto.GovAgentResult
import ai.govbiz.core.govagent.service.dto.GovAgentOutcome
import ai.govbiz.core.partner.domain.PartnerRole
import ai.govbiz.core.supportprogram.controller.dto.SupportProgramConversationRequest
import ai.govbiz.core.supportprogram.controller.dto.SupportProgramConversationResponse
import ai.govbiz.core.supportprogram.controller.dto.SupportProgramEvidenceAnswerResponse
import ai.govbiz.core.supportprogram.controller.validation.CodePointMax
import jakarta.validation.Valid
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Pattern
import jakarta.validation.constraints.Size

data class GovAgentProgramRequest(
    @field:NotBlank @field:Size(max = 64) @field:Pattern(regexp = "[A-Z][A-Z0-9_]{0,63}")
    val sourceCode: String,
    @field:NotBlank @field:CodePointMax(max = 255) @field:Pattern(regexp = "(?Us)^(?!\\s)(?!.*\\s$)(?!.*\\p{C}).+$")
    val sourceProgramId: String,
) {
    fun toDomain() = GovAgentProgram(sourceCode, sourceProgramId)
}

data class GovAgentMessageRequest(
    @field:Valid val conversation: SupportProgramConversationRequest,
    @field:Valid val selectedProgram: GovAgentProgramRequest? = null,
) {
    fun toDomain() = GovAgentQuestion(
        conversation.message, conversation.context.toDomain(), conversation.pendingClarification?.toDomain(),
        conversation.pendingProposal?.toDomain(), conversation.lastSearch?.toDomain(), selectedProgram?.toDomain(),
    )
}

data class GovAgentProgramResponse(val sourceCode: String, val sourceProgramId: String)

data class GovAgentMessageResponse(
    val outcome: GovAgentOutcome,
    val interpretation: SupportProgramConversationResponse?,
    val evidence: SupportProgramEvidenceAnswerResponse?,
    val program: GovAgentProgramResponse?,
    val message: String?,
    val partnerConditions: GovAgentPartnerConditionsResponse?,
) {
    companion object {
        fun from(result: GovAgentResult) = GovAgentMessageResponse(
            result.outcome, result.interpretation?.let(SupportProgramConversationResponse::from),
            result.evidence?.let(SupportProgramEvidenceAnswerResponse::from),
            result.program?.let { GovAgentProgramResponse(it.sourceCode, it.sourceProgramId) }, result.message,
            result.partnerConditions?.let { conditions ->
                GovAgentPartnerConditionsResponse(
                    conditions.seekingRoles.sortedBy { it.ordinal }, conditions.regions.toList(), conditions.keywords,
                    conditions.program?.let { GovAgentProgramResponse(it.sourceCode, it.sourceProgramId) },
                )
            },
        )
    }
}

/** 대화에서 읽은 파트너 모집글 조건입니다. 역할·지역·공고는 거르는 조건, 분야 말은 순서만 올리는 조건입니다. */
data class GovAgentPartnerConditionsResponse(
    val seekingRoles: List<PartnerRole>,
    val regions: List<String>,
    val keywords: List<String>,
    val program: GovAgentProgramResponse?,
)
