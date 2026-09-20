package ai.govbiz.core.supportprogram.controller.dto

import ai.govbiz.core.supportprogram.service.dto.SupportProgramSearchReadinessResult
import ai.govbiz.core.supportprogram.service.dto.SupportProgramSearchState
import ai.govbiz.core.supportprogram.service.dto.SupportProgramSourceReadinessResult
import java.time.format.DateTimeFormatter

data class SupportProgramSearchReadinessResponse(
    val searchState: SupportProgramSearchState,
    val programCount: Int,
    val indexReady: Boolean,
    val lastSuccessfulSyncAt: String?,
    val lastFailedSyncAt: String?,
    val sources: List<SupportProgramSourceReadinessResponse>,
) {
    companion object {
        fun from(result: SupportProgramSearchReadinessResult): SupportProgramSearchReadinessResponse =
            SupportProgramSearchReadinessResponse(
                searchState = result.searchState,
                programCount = result.programCount,
                indexReady = result.indexReady,
                lastSuccessfulSyncAt = result.lastSuccessfulSyncAt?.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME),
                lastFailedSyncAt = result.lastFailedSyncAt?.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME),
                sources = result.sources.map(SupportProgramSourceReadinessResponse::from),
            )
    }
}

data class SupportProgramSourceReadinessResponse(
    val sourceCode: String,
    val sourceName: String,
    val searchState: SupportProgramSearchState,
    val programCount: Int,
    val indexReady: Boolean,
    val lastSuccessfulSyncAt: String?,
    val lastFailedSyncAt: String?,
) {
    companion object {
        fun from(result: SupportProgramSourceReadinessResult) = SupportProgramSourceReadinessResponse(
            sourceCode = result.sourceCode,
            sourceName = result.sourceName,
            searchState = result.searchState,
            programCount = result.programCount,
            indexReady = result.indexReady,
            lastSuccessfulSyncAt = result.lastSuccessfulSyncAt?.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME),
            lastFailedSyncAt = result.lastFailedSyncAt?.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME),
        )
    }
}
