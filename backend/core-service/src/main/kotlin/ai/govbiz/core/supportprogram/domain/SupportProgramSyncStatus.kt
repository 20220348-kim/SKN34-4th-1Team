package ai.govbiz.core.supportprogram.domain

import java.time.LocalDateTime

/** 제공처별 동기화 결과와 현재 공개 카탈로그의 검색 색인 준비 상태입니다. */
data class SupportProgramSyncStatus(
    val sourceCode: String,
    val publishedGeneration: Long?,
    val publishedCatalogFingerprint: String?,
    val publishedProgramCount: Int,
    val indexReady: Boolean,
    val lastSuccessfulSyncAt: LocalDateTime?,
    val lastFailedSyncAt: LocalDateTime?,
    val lastSyncOutcome: SupportProgramSyncOutcome,
)

enum class SupportProgramSyncOutcome {
    NONE,
    SUCCESS,
    FAILURE,
}
