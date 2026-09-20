package ai.govbiz.core.supportprogram.controller.dto

import ai.govbiz.core.supportprogram.domain.SupportProgramConversationContext
import ai.govbiz.core.supportprogram.domain.SupportProgramConversationField
import ai.govbiz.core.supportprogram.domain.SupportProgramConversationStatus
import ai.govbiz.core.supportprogram.service.dto.SupportProgramConversationResult

data class SupportProgramConversationResponse(
    val status: SupportProgramConversationStatus,
    val proposedContext: SupportProgramConversationContextResponse,
    val clarificationQuestion: String?,
    val changedFields: List<SupportProgramConversationField>,
    val answer: String?,
) {
    companion object {
        fun from(result: SupportProgramConversationResult) = SupportProgramConversationResponse(
            result.status,
            SupportProgramConversationContextResponse.from(result.proposedContext),
            result.clarificationQuestion,
            java.util.List.copyOf(result.changedFields),
            result.answer,
        )
    }
}

data class SupportProgramConversationContextResponse(
    val query: String?,
    val acceptingOnly: Boolean,
    val companyConditions: SupportProgramConversationCompanyConditionsResponse,
) {
    companion object {
        fun from(context: SupportProgramConversationContext) = SupportProgramConversationContextResponse(
            context.query,
            context.acceptingOnly,
            context.companyConditions.let {
                SupportProgramConversationCompanyConditionsResponse(it.region, it.industry, it.establishedOn?.toString(), it.supportPurpose, it.foundedYear)
            },
        )
    }
}

data class SupportProgramConversationCompanyConditionsResponse(
    val region: String?,
    val industry: String?,
    val establishedOn: String?,
    val supportPurpose: String?,
    @get:com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
    val foundedYear: Int? = null,
)
