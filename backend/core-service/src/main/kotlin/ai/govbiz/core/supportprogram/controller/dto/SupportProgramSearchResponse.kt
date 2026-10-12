package ai.govbiz.core.supportprogram.controller.dto

import ai.govbiz.core.supportprogram.domain.SupportProgramRankingExclusions
import ai.govbiz.core.supportprogram.service.dto.SupportProgramSearchPreviewResult

data class SupportProgramSearchResponse(
    val query: String,
    val programs: List<SupportProgramResponse>,
    val totalCount: Int,
    val resultToken: String?,
    val expiresAt: String?,
    val exclusionCounts: SupportProgramExclusionCountsResponse?,
) {
    companion object {
        fun from(result: SupportProgramSearchPreviewResult) = SupportProgramSearchResponse(
            result.query, java.util.List.copyOf(result.programs.map(SupportProgramResponse::from)),
            result.totalCount, result.resultToken, result.expiresAt?.toString(),
            result.exclusionCounts?.let(SupportProgramExclusionCountsResponse::from),
        )
    }
}

/** 순위 매기기에 보낸 후보 수와 사유별로 추천에서 뺀 후보 수입니다. */
data class SupportProgramExclusionCountsResponse(
    val candidateCount: Int,
    val lowRelevance: Int,
    val target: Int,
    val region: Int,
) {
    companion object {
        fun from(exclusions: SupportProgramRankingExclusions) = SupportProgramExclusionCountsResponse(
            exclusions.candidateCount, exclusions.lowRelevance, exclusions.target, exclusions.region,
        )
    }
}
