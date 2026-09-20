package ai.govbiz.core.supportprogram.controller.dto

import ai.govbiz.core.supportprogram.service.dto.SupportProgramSearchRestoredResult
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Pattern
import jakarta.validation.constraints.Size

data class SupportProgramSearchRestoreRequest(
    @field:NotBlank
    @field:Size(min = 36, max = 36)
    @field:Pattern(regexp = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
    val resultToken: String,
)

data class SupportProgramSearchRestoreResponse(
    val query: String,
    val programs: List<SupportProgramResponse>,
    val totalCount: Int,
    val resultToken: String?,
    val expiresAt: String?,
    val context: SupportProgramConversationContextResponse,
) {
    companion object {
        fun from(restored: SupportProgramSearchRestoredResult): SupportProgramSearchRestoreResponse {
            val result = SupportProgramSearchResponse.from(restored.result)
            return SupportProgramSearchRestoreResponse(
                result.query, result.programs, result.totalCount, result.resultToken, result.expiresAt,
                SupportProgramConversationContextResponse.from(restored.context),
            )
        }
    }
}
