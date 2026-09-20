package ai.govbiz.core.supportprogram.repository.mapper

import java.time.LocalDateTime

/** 제공처별 최근 동기화 결과와 현재 검색 색인 준비 상태를 담는 MySQL 행입니다. */
data class SupportProgramSyncStatusDbRow(
    var sourceCode: String = "",
    var publishedGeneration: Long? = null,
    var publishedCatalogFingerprint: String? = null,
    var publishedProgramCount: Int = 0,
    var indexReady: Boolean = false,
    var lastSuccessfulSyncAt: LocalDateTime? = null,
    var lastFailedSyncAt: LocalDateTime? = null,
    var lastSyncOutcome: String = "NONE",
)
