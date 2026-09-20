package ai.govbiz.core.supportprogram.service.dto

import java.time.OffsetDateTime

/** 현재 공개 카탈로그와 그 검색 색인이 사용자 검색에 사용할 수 있는지 나타내는 결과입니다. */
data class SupportProgramSearchReadinessResult(
    val searchState: SupportProgramSearchState,
    val programCount: Int,
    val indexReady: Boolean,
    val lastSuccessfulSyncAt: OffsetDateTime?,
    val lastFailedSyncAt: OffsetDateTime?,
    val sources: List<SupportProgramSourceReadinessResult>,
)

/** 한 제공처의 공개 공고 수와 준비·동기화 결과입니다. */
data class SupportProgramSourceReadinessResult(
    val sourceCode: String,
    val sourceName: String,
    val searchState: SupportProgramSearchState,
    val programCount: Int,
    val indexReady: Boolean,
    val lastSuccessfulSyncAt: OffsetDateTime?,
    val lastFailedSyncAt: OffsetDateTime?,
)

enum class SupportProgramSearchState {
    PREPARING,
    SEARCHABLE,
    SEARCHABLE_WITH_SYNC_FAILURE,
    SEARCHABLE_WITH_PARTIAL_SOURCES,
    UNAVAILABLE,
}
