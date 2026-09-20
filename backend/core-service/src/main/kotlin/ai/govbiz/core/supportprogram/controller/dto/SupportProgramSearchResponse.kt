package ai.govbiz.core.supportprogram.controller.dto

import ai.govbiz.core.supportprogram.service.dto.SupportProgramSearchPreviewResult

data class SupportProgramSearchResponse(
    val query: String,
    val programs: List<SupportProgramResponse>,
    val totalCount: Int,
    val resultToken: String?,
    val expiresAt: String?,
) {
    companion object {
        fun from(result: SupportProgramSearchPreviewResult) = SupportProgramSearchResponse(
            result.query, java.util.List.copyOf(result.programs.map(SupportProgramResponse::from)),
            result.totalCount, result.resultToken, result.expiresAt?.toString(),
        )
    }
}
