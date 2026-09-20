package ai.govbiz.core.supportprogram.domain

/** Catalog가 완전히 게시한 제공처별 공고와 상태를 Core에 반영하는 내부 계약입니다. */
data class CatalogProjectionSnapshot(
    val catalogId: String,
    val revision: Long,
    val status: SupportProgramSyncStatus,
    val programs: List<CatalogSupportProgram>,
)
