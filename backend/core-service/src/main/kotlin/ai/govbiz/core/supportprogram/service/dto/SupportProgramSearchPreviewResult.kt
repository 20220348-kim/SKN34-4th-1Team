package ai.govbiz.core.supportprogram.service.dto

import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramConversationContext
import java.time.Instant

data class SupportProgramSearchPreviewResult(
    val query: String,
    val programs: List<SupportProgram>,
    val totalCount: Int,
    val resultToken: String? = null,
    val expiresAt: Instant? = null,
)

data class SupportProgramSearchRestoredResult(
    val result: SupportProgramSearchPreviewResult,
    val context: SupportProgramConversationContext,
)
