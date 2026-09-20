package ai.govbiz.core.supportprogram.service.dto

import ai.govbiz.core.supportprogram.domain.SupportProgramConversationContext
import ai.govbiz.core.supportprogram.domain.SupportProgramConversationField
import ai.govbiz.core.supportprogram.domain.SupportProgramConversationStatus

data class SupportProgramConversationResult(
    val status: SupportProgramConversationStatus,
    val proposedContext: SupportProgramConversationContext,
    val clarificationQuestion: String?,
    val changedFields: List<SupportProgramConversationField>,
    val answer: String? = null,
)
